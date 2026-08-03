import { createHash, createPublicKey, verify } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { z } from "zod";
import { CoordinationError } from "./coordination.js";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SAFE_CHILD = /^[A-Za-z0-9.][A-Za-z0-9._:-]{0,191}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const MANIFEST_NAME = "pm-actor-origins.json";

export const PmActorOriginSelectorSchema = z.object({
  origin_id: z.string().regex(SAFE_REF),
  record_id: z.string().regex(SAFE_REF),
}).strict();
export type PmActorOriginSelector = z.infer<typeof PmActorOriginSelectorSchema>;

const CapabilitySchema = z.object({
  id: z.string().regex(SAFE_REF),
  rank: z.number().int().nonnegative(),
}).strict();
const OriginSchema = z.object({
  origin_id: z.string().regex(SAFE_REF),
  record_root: z.string().min(1).max(4096).refine((value) => path.isAbsolute(value), "record root must be absolute"),
  key_id: z.string().regex(SAFE_REF),
  public_key_pem: z.string().min(1).max(8192).refine((value) =>
    value.startsWith("-----BEGIN PUBLIC KEY-----\n") && value.trimEnd().endsWith("-----END PUBLIC KEY-----"),
  "public key must be PEM SPKI"),
}).strict();
const ManifestSchema = z.object({
  schema_version: z.literal(1),
  origins: z.array(OriginSchema).max(64),
}).strict().superRefine((value, ctx) => {
  const ids = value.origins.map((origin) => origin.origin_id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "origin ids must be unique" });
});
const RecordSchema = z.object({
  schema_version: z.literal(1),
  origin_id: z.string().regex(SAFE_REF),
  record_id: z.string().regex(SAFE_REF),
  key_id: z.string().regex(SAFE_REF),
  assurance: z.literal("authenticated_install"),
  role: z.enum(["worker", "reviewer"]),
  subject: z.string().regex(SAFE_REF),
  run_id: z.string().regex(SAFE_REF),
  session_id: z.string().regex(SAFE_REF),
  capability: CapabilitySchema.optional(),
  goal_id: z.string().regex(SAFE_REF),
  parent_id: z.string().regex(SAFE_REF),
  ticket_id: z.string().regex(SAFE_REF),
  prepare_receipt_id: z.string().regex(/^pm-[0-9a-f]{32}$/),
  claim_id: z.string().regex(/^pmc-[0-9a-f]{32}$/),
  payload: z.unknown(),
  payload_sha256: z.string().regex(SHA256),
}).strict().superRefine((value, ctx) => {
  if (value.role === "worker" && !value.capability) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "worker capability is required" });
  }
  if (value.role === "reviewer" && value.capability) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reviewer capability is forbidden" });
  }
});
const PluginMarkerSchema = z.object({
  name: z.literal("ycm-harness"), displayName: z.string(), description: z.string(),
  version: z.string(), license: z.string(), skills: z.literal("./skills/"), hooks: z.literal("./hooks/hooks-cursor.json"),
}).strict();

export interface TrustedPmActorOriginReadback {
  schema_version: 1;
  origin_id: string;
  record_id: string;
  key_id: string;
  assurance: "authenticated_install" | "manual_local_double";
  role: "worker" | "reviewer";
  subject: string;
  run_id: string;
  session_id: string;
  capability?: { id: string; rank: number };
  goal_id: string;
  parent_id: string;
  ticket_id: string;
  prepare_receipt_id: string;
  claim_id: string;
  payload: unknown;
  payload_sha256: string;
  record_sha256: string;
}

interface FileIdentity { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number }
interface DirectoryIdentity { dev: number; ino: number }
interface PinnedSupport { noFollow: number; directory: number }
type FileHandle = Awaited<ReturnType<typeof fs.open>>;
interface PinnedDirectory {
  handle: FileHandle;
  logicalPath: string;
  descriptorPath: string;
  identity: DirectoryIdentity;
}
export interface PmActorOriginReadHooks {
  forcePlatformUnsupported?: boolean;
  forceNoFollowUnsupported?: boolean;
  forceDirectoryUnsupported?: boolean;
  forceDescriptorUnsupported?: boolean;
  afterPrecheck?: (file: string) => Promise<void> | void;
}

function fail(code: string, message: string): never { throw new CoordinationError(code, message); }
function fileIdentity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}
function directoryIdentity(stat: Stats): DirectoryIdentity { return { dev: stat.dev, ino: stat.ino }; }
function sameFile(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}
function sameDirectory(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
async function requireSupport(hooks: PmActorOriginReadHooks): Promise<PinnedSupport> {
  if (hooks.forcePlatformUnsupported || process.platform !== "linux") {
    return fail("pm_actor_origin_unsupported", "actor origin reads require Linux descriptor-relative filesystem support");
  }
  const noFollow = fsConstants.O_NOFOLLOW;
  const directory = fsConstants.O_DIRECTORY;
  if (hooks.forceNoFollowUnsupported || typeof noFollow !== "number" || noFollow === 0) {
    return fail("pm_actor_origin_unsupported", "actor origin reads require O_NOFOLLOW");
  }
  if (hooks.forceDirectoryUnsupported || typeof directory !== "number" || directory === 0) {
    return fail("pm_actor_origin_unsupported", "actor origin reads require O_DIRECTORY");
  }
  if (hooks.forceDescriptorUnsupported || !(await fs.stat("/proc/self/fd").catch(() => undefined))?.isDirectory()) {
    return fail("pm_actor_origin_unsupported", "actor origin reads require /proc/self/fd");
  }
  return { noFollow, directory };
}
function child(directory: PinnedDirectory, ref: string): string {
  if (!SAFE_CHILD.test(ref) || ref === "." || ref === "..") fail("pm_actor_origin_unsafe", "actor origin child is unsafe");
  return `${directory.descriptorPath}/${ref}`;
}
async function pinOpened(
  openPath: string,
  logicalPath: string,
  before: Stats,
  support: PinnedSupport,
  hooks: PmActorOriginReadHooks,
  allowMissing: boolean,
): Promise<PinnedDirectory | undefined> {
  let handle: FileHandle;
  try { handle = await fs.open(openPath, fsConstants.O_RDONLY | support.directory | support.noFollow); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return undefined;
    return fail("pm_actor_origin_unsafe", "actor origin directory changed before pinning");
  }
  try {
    const opened = await handle.stat().catch(() => undefined);
    if (!opened?.isDirectory() || !sameDirectory(directoryIdentity(before), directoryIdentity(opened))) {
      return fail("pm_actor_origin_unsafe", "actor origin directory identity changed");
    }
    const descriptorPath = `/proc/self/fd/${handle.fd}`;
    const descriptor = await fs.stat(descriptorPath).catch(() => undefined);
    if (!descriptor?.isDirectory() || !sameDirectory(directoryIdentity(opened), directoryIdentity(descriptor))) {
      return fail("pm_actor_origin_unsupported", "actor origin directory descriptor is unavailable");
    }
    try { await hooks.afterPrecheck?.(logicalPath); }
    catch { fail("pm_actor_origin_tampered", "actor origin changed after pinning"); }
    return { handle, logicalPath, descriptorPath, identity: directoryIdentity(opened) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}
async function pinAbsolute(
  directory: string,
  support: PinnedSupport,
  hooks: PmActorOriginReadHooks,
  allowMissing: boolean,
): Promise<PinnedDirectory | undefined> {
  const resolved = path.resolve(directory);
  let stat: Stats;
  try { stat = await fs.lstat(resolved); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return undefined;
    return fail("pm_actor_origin_unsafe", "actor origin directory is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("pm_actor_origin_unsafe", "actor origin directory is unsafe");
  if (await fs.realpath(resolved).catch(() => "") !== resolved) fail("pm_actor_origin_unsafe", "actor origin directory traverses a symlink");
  return pinOpened(resolved, resolved, stat, support, hooks, allowMissing);
}
async function pinChild(
  parent: PinnedDirectory,
  ref: string,
  support: PinnedSupport,
  hooks: PmActorOriginReadHooks,
  allowMissing: boolean,
): Promise<PinnedDirectory | undefined> {
  const openPath = child(parent, ref);
  const logicalPath = path.join(parent.logicalPath, ref);
  let stat: Stats;
  try { stat = await fs.lstat(openPath); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return undefined;
    return fail("pm_actor_origin_unsafe", "actor origin child directory is unavailable");
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("pm_actor_origin_unsafe", "actor origin child directory is unsafe");
  return pinOpened(openPath, logicalPath, stat, support, hooks, allowMissing);
}
async function close(directory: PinnedDirectory | undefined): Promise<void> { await directory?.handle.close().catch(() => undefined); }
async function readOnce(
  directory: PinnedDirectory,
  ref: string,
  maxBytes: number,
  support: PinnedSupport,
  hooks: PmActorOriginReadHooks,
  allowMissing: boolean,
): Promise<{ data: Buffer; identity: FileIdentity } | undefined> {
  let handle: FileHandle;
  const file = child(directory, ref);
  const logical = path.join(directory.logicalPath, ref);
  try { handle = await fs.open(file, fsConstants.O_RDONLY | support.noFollow); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return undefined;
    return fail(allowMissing ? "pm_actor_origin_unsafe" : "pm_actor_origin_tampered", "actor origin file is unsafe");
  }
  try {
    const beforeStat = await handle.stat().catch(() => undefined);
    if (!beforeStat?.isFile() || beforeStat.size > maxBytes) fail("pm_actor_origin_unsafe", "actor origin file is not bounded regular data");
    const before = fileIdentity(beforeStat);
    try { await hooks.afterPrecheck?.(logical); }
    catch { fail("pm_actor_origin_tampered", "actor origin changed after precheck"); }
    const allocation = Buffer.alloc(maxBytes + 1);
    let offset = 0;
    while (offset < allocation.byteLength) {
      const read = await handle.read(allocation, offset, allocation.byteLength - offset, null)
        .catch(() => fail("pm_actor_origin_tampered", "actor origin read raced with a change"));
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    const afterStat = await handle.stat().catch(() => undefined);
    if (!afterStat || offset > maxBytes || offset !== afterStat.size || !sameFile(before, fileIdentity(afterStat))) {
      fail("pm_actor_origin_tampered", "actor origin file changed during read");
    }
    return { data: allocation.subarray(0, offset), identity: fileIdentity(afterStat) };
  } finally { await handle.close().catch(() => undefined); }
}
async function readTwice(
  directory: PinnedDirectory,
  ref: string,
  maxBytes: number,
  support: PinnedSupport,
  hooks: PmActorOriginReadHooks,
): Promise<Buffer | undefined> {
  const first = await readOnce(directory, ref, maxBytes, support, hooks, true);
  if (!first) return undefined;
  const second = await readOnce(directory, ref, maxBytes, support, hooks, false);
  if (!second || !sameFile(first.identity, second.identity) || !first.data.equals(second.data)) {
    fail("pm_actor_origin_tampered", "actor origin file changed between authenticated reads");
  }
  return second.data;
}
function parseJson(raw: Buffer, code: string): unknown {
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)) as unknown; }
  catch { return fail(code, "actor origin data is not UTF-8 JSON"); }
}
function signature(raw: Buffer): Buffer {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw).trim(); }
  catch { return fail("pm_actor_origin_tampered", "actor signature is not base64"); }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) fail("pm_actor_origin_tampered", "actor signature is not canonical base64");
  const value = Buffer.from(text, "base64");
  if (value.byteLength !== 64 || value.toString("base64") !== text) fail("pm_actor_origin_tampered", "actor signature is not Ed25519 output");
  return value;
}
async function readPinned(
  installation: PinnedDirectory,
  selector: PmActorOriginSelector,
  hooks: PmActorOriginReadHooks,
  support: PinnedSupport,
): Promise<TrustedPmActorOriginReadback | undefined> {
  const config = await pinChild(installation, "config", support, hooks, true);
  if (!config) return undefined;
  try {
    const manifestRaw = await readTwice(config, MANIFEST_NAME, MAX_MANIFEST_BYTES, support, hooks);
    if (!manifestRaw) return undefined;
    const manifest = ManifestSchema.safeParse(parseJson(manifestRaw, "pm_actor_origin_manifest_invalid"));
    if (!manifest.success) fail("pm_actor_origin_manifest_invalid", "actor origin manifest is malformed");
    const origin = manifest.data.origins.find((candidate) => candidate.origin_id === selector.origin_id);
    if (!origin) return undefined;
    const root = await pinAbsolute(origin.record_root, support, hooks, false);
    if (!root) fail("pm_actor_origin_unsafe", "actor record root is unavailable");
    try {
      const recordRaw = await readTwice(root, `${selector.record_id}.json`, MAX_RECORD_BYTES, support, hooks);
      if (!recordRaw) return undefined;
      const signatureRaw = await readTwice(root, `${selector.record_id}.sig`, MAX_SIGNATURE_BYTES, support, hooks);
      if (!signatureRaw) fail("pm_actor_origin_tampered", "actor record signature is missing");
      let key: ReturnType<typeof createPublicKey>;
      try { key = createPublicKey(origin.public_key_pem); }
      catch { return fail("pm_actor_origin_manifest_invalid", "actor origin public key is invalid"); }
      if (key.asymmetricKeyType !== "ed25519") fail("pm_actor_origin_manifest_invalid", "actor origin key must be Ed25519");
      if (!verify(null, recordRaw, key, signature(signatureRaw))) fail("pm_actor_origin_tampered", "actor record signature failed");
      const confirmedRecord = await readTwice(root, `${selector.record_id}.json`, MAX_RECORD_BYTES, support, hooks);
      const confirmedSignature = await readTwice(root, `${selector.record_id}.sig`, MAX_SIGNATURE_BYTES, support, hooks);
      if (!confirmedRecord?.equals(recordRaw) || !confirmedSignature?.equals(signatureRaw)) {
        fail("pm_actor_origin_tampered", "actor record or signature changed after verification");
      }
      const parsed = RecordSchema.safeParse(parseJson(recordRaw, "pm_actor_origin_tampered"));
      if (!parsed.success) fail("pm_actor_origin_tampered", "actor record is malformed");
      const record = parsed.data;
      if (!recordRaw.equals(Buffer.from(JSON.stringify(record), "utf8"))) fail("pm_actor_origin_tampered", "actor record is not canonical JSON");
      if (record.origin_id !== selector.origin_id || record.record_id !== selector.record_id || record.key_id !== origin.key_id) {
        fail("pm_actor_origin_mismatch", "actor record does not match its installed origin");
      }
      if (createHash("sha256").update(JSON.stringify(record.payload)).digest("hex") !== record.payload_sha256) {
        fail("pm_actor_origin_tampered", "actor payload commitment is invalid");
      }
      return {
        schema_version: record.schema_version, origin_id: record.origin_id, record_id: record.record_id,
        key_id: record.key_id, assurance: record.assurance, role: record.role, subject: record.subject,
        run_id: record.run_id, session_id: record.session_id, ...(record.capability ? { capability: record.capability } : {}),
        goal_id: record.goal_id, parent_id: record.parent_id, ticket_id: record.ticket_id,
        prepare_receipt_id: record.prepare_receipt_id, claim_id: record.claim_id,
        payload: record.payload, payload_sha256: record.payload_sha256,
        record_sha256: createHash("sha256").update(recordRaw).digest("hex"),
      };
    } finally { await close(root); }
  } finally { await close(config); }
}

export async function readPmActorOriginFromInstallation(
  installationRoot: string,
  rawSelector: PmActorOriginSelector,
  hooks: PmActorOriginReadHooks = {},
): Promise<TrustedPmActorOriginReadback | undefined> {
  const selector = PmActorOriginSelectorSchema.safeParse(rawSelector);
  if (!selector.success) fail("pm_actor_origin_invalid", "actor origin selector is invalid");
  const support = await requireSupport(hooks);
  const installation = await pinAbsolute(installationRoot, support, hooks, true);
  if (!installation) return undefined;
  try { return await readPinned(installation, selector.data, hooks, support); }
  finally { await close(installation); }
}

async function nearestPackageRoot(moduleFile: string): Promise<string> {
  let current = path.dirname(moduleFile);
  for (;;) {
    const marker = path.join(current, "package.json");
    try {
      const stat = await fs.lstat(marker);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("pm_actor_origin_unsafe", "actor runtime package marker is unsafe");
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) fail("pm_actor_origin_unsafe", "actor runtime has no package root");
    current = parent;
  }
}
async function projectedRoot(support: PinnedSupport): Promise<PinnedDirectory> {
  const packageRoot = await nearestPackageRoot(fileURLToPath(import.meta.url));
  const parentPath = path.dirname(packageRoot);
  const parent = await pinAbsolute(parentPath, support, {}, false);
  if (parent) {
    const markerDir = await pinChild(parent, ".cursor-plugin", support, {}, true);
    if (markerDir) {
      try {
        const raw = await readTwice(markerDir, "plugin.json", MAX_MARKER_BYTES, support, {});
        if (raw && PluginMarkerSchema.safeParse(parseJson(raw, "pm_actor_origin_unsafe")).success) return parent;
      } finally { await close(markerDir); }
    }
    await close(parent);
  }
  const source = await pinAbsolute(packageRoot, support, {}, false);
  if (!source) fail("pm_actor_origin_unsafe", "actor source package is unavailable");
  try {
    const plugin = await pinChild(source, "plugin", support, {}, false);
    if (!plugin) fail("pm_actor_origin_unsafe", "actor source plugin is unavailable");
    return plugin;
  } finally { await close(source); }
}

/** Reads only the manifest shipped in the source package or installed plugin projection. */
export async function readProjectedPmActorOrigin(
  rawSelector: PmActorOriginSelector,
): Promise<TrustedPmActorOriginReadback | undefined> {
  const selector = PmActorOriginSelectorSchema.safeParse(rawSelector);
  if (!selector.success) fail("pm_actor_origin_invalid", "actor origin selector is invalid");
  const support = await requireSupport({});
  const installation = await projectedRoot(support);
  try { return await readPinned(installation, selector.data, {}, support); }
  finally { await close(installation); }
}

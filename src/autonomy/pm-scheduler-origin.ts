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
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_SIGNATURE_BYTES = 1024;
const MAX_MARKER_BYTES = 16 * 1024;
const MANIFEST_NAME = "pm-scheduler-origins.json";

export const PmSchedulerOriginSelectorSchema = z.object({
  origin_id: z.string().regex(SAFE_REF),
  record_id: z.string().regex(SAFE_REF),
}).strict();

export type PmSchedulerOriginSelector = z.infer<typeof PmSchedulerOriginSelectorSchema>;

const OriginSchema = z.object({
  origin_id: z.string().regex(SAFE_REF),
  record_root: z.string().min(1).max(4096).refine((value) => path.isAbsolute(value), "record root must be absolute"),
  key_id: z.string().regex(SAFE_REF),
  public_key_pem: z.string().min(1).max(8192).refine((value) =>
    value.startsWith("-----BEGIN PUBLIC KEY-----\n") && value.trimEnd().endsWith("-----END PUBLIC KEY-----"),
  "public key must be PEM SPKI"),
  timezone: z.string().min(1).max(128),
  prepare_local_time: z.literal("09:00"),
  review_local_time: z.literal("17:00"),
}).strict();

const ManifestSchema = z.object({
  schema_version: z.literal(1),
  origins: z.array(OriginSchema).max(32),
}).strict().superRefine((value, ctx) => {
  const ids = value.origins.map((origin) => origin.origin_id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "origin ids must be unique" });
});

const RecordSchema = z.object({
  schema_version: z.literal(1),
  origin_id: z.string().regex(SAFE_REF),
  record_id: z.string().regex(SAFE_REF),
  key_id: z.string().regex(SAFE_REF),
  timezone: z.string().min(1).max(128),
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  prepare_local_time: z.literal("09:00"),
  review_local_time: z.literal("17:00"),
  artifact: z.unknown(),
}).strict();

const PluginMarkerSchema = z.object({
  name: z.literal("ycm-harness"),
  displayName: z.string().min(1).max(256),
  description: z.string().min(1).max(2048),
  version: z.string().min(1).max(64),
  license: z.string().min(1).max(64),
  skills: z.literal("./skills/"),
  hooks: z.literal("./hooks/hooks-cursor.json"),
}).strict();

export interface TrustedPmSchedulerOriginReadback {
  origin: "scheduler_record";
  origin_id: string;
  record_id: string;
  record_sha256: string;
  schedule: {
    timezone: string;
    local_date: string;
    prepare_local_time: "09:00";
    review_local_time: "17:00";
  };
  artifact: unknown;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface PinnedSupport {
  noFollow: number;
  directory: number;
}

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

interface PinnedDirectory {
  handle: FileHandle;
  logicalPath: string;
  descriptorPath: string;
  identity: DirectoryIdentity;
}

export interface PmSchedulerOriginReadHooks {
  /** Test/platform seams that can only force a less-capable, fail-closed platform. */
  forcePlatformUnsupported?: boolean;
  forceNoFollowUnsupported?: boolean;
  forceDirectoryUnsupported?: boolean;
  forceDescriptorUnsupported?: boolean;
  /** Deterministic filesystem-race seam; the projected CLI never supplies it. */
  afterPrecheck?: (file: string) => Promise<void> | void;
}

interface SafeReadCodes {
  unsafe: string;
  changed: string;
}

function fail(code: string, message: string): never {
  throw new CoordinationError(code, message);
}

function identity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function directoryIdentity(stat: Stats): DirectoryIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function requirePinnedSupport(hooks: PmSchedulerOriginReadHooks): Promise<PinnedSupport> {
  if (hooks.forcePlatformUnsupported || process.platform !== "linux") {
    return fail("pm_status_scheduler_origin_unsupported", "trusted scheduler reads require Linux descriptor-relative filesystem support");
  }
  const noFollow = fsConstants.O_NOFOLLOW;
  if (hooks.forceNoFollowUnsupported || typeof noFollow !== "number" || noFollow === 0) {
    return fail("pm_status_scheduler_origin_unsupported", "trusted scheduler reads require O_NOFOLLOW");
  }
  const directory = fsConstants.O_DIRECTORY;
  if (hooks.forceDirectoryUnsupported || typeof directory !== "number" || directory === 0) {
    return fail("pm_status_scheduler_origin_unsupported", "trusted scheduler reads require O_DIRECTORY");
  }
  if (hooks.forceDescriptorUnsupported) {
    return fail("pm_status_scheduler_origin_unsupported", "trusted scheduler reads require /proc/self/fd");
  }
  const procStat = await fs.stat("/proc/self/fd").catch(() => undefined);
  if (!procStat?.isDirectory()) {
    return fail("pm_status_scheduler_origin_unsupported", "trusted scheduler reads require /proc/self/fd");
  }
  return { noFollow, directory };
}

function descriptorChild(directory: PinnedDirectory, ref: string): string {
  if (!SAFE_CHILD.test(ref) || ref === "." || ref === "..") {
    return fail("pm_status_scheduler_origin_unsafe", "trusted scheduler child reference is unsafe");
  }
  return `${directory.descriptorPath}/${ref}`;
}

async function openedPinnedDirectory(
  openPath: string,
  logicalPath: string,
  beforeStat: Stats,
  support: PinnedSupport,
  codes: SafeReadCodes,
  hooks: PmSchedulerOriginReadHooks,
  allowMissing: boolean,
): Promise<PinnedDirectory | undefined> {
  let handle: FileHandle;
  try {
    handle = await fs.open(openPath, fsConstants.O_RDONLY | support.directory | support.noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && allowMissing) return undefined;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
      return fail("pm_status_scheduler_origin_unsupported", "descriptor-pinned directory opens are unavailable");
    }
    return fail(codes.changed, "trusted scheduler directory changed before it could be pinned");
  }
  try {
    const openedStat = await handle.stat().catch(() => undefined);
    if (!openedStat?.isDirectory()
      || !sameDirectoryIdentity(directoryIdentity(beforeStat), directoryIdentity(openedStat))) {
      return fail(codes.changed, "trusted scheduler directory identity changed while it was pinned");
    }
    const descriptorPath = `/proc/self/fd/${handle.fd}`;
    const descriptorStat = await fs.stat(descriptorPath).catch(() => undefined);
    if (!descriptorStat?.isDirectory()
      || !sameDirectoryIdentity(directoryIdentity(openedStat), directoryIdentity(descriptorStat))) {
      return fail("pm_status_scheduler_origin_unsupported", "trusted scheduler directory descriptor cannot be authenticated");
    }
    try {
      await hooks.afterPrecheck?.(logicalPath);
    } catch {
      return fail(codes.changed, "trusted scheduler directory changed after it was pinned");
    }
    return {
      handle,
      logicalPath,
      descriptorPath,
      identity: directoryIdentity(openedStat),
    };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function pinAbsoluteDirectory(
  directory: string,
  support: PinnedSupport,
  codes: SafeReadCodes,
  hooks: PmSchedulerOriginReadHooks,
  allowMissing: boolean,
): Promise<PinnedDirectory | undefined> {
  const resolved = path.resolve(directory);
  let beforeStat: Stats;
  try {
    beforeStat = await fs.lstat(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return undefined;
    return fail(codes.unsafe, "trusted scheduler directory is unavailable");
  }
  if (!beforeStat.isDirectory() || beforeStat.isSymbolicLink()) {
    return fail(codes.unsafe, "trusted scheduler directory must be a real directory");
  }
  const real = await fs.realpath(resolved)
    .catch(() => fail(codes.changed, "trusted scheduler directory changed during authentication"));
  if (real !== resolved) return fail(codes.unsafe, "trusted scheduler directory must not traverse a symlink");
  return openedPinnedDirectory(resolved, resolved, beforeStat, support, codes, hooks, allowMissing);
}

async function pinChildDirectory(
  parent: PinnedDirectory,
  ref: string,
  support: PinnedSupport,
  codes: SafeReadCodes,
  hooks: PmSchedulerOriginReadHooks,
  allowMissing: boolean,
): Promise<PinnedDirectory | undefined> {
  const openPath = descriptorChild(parent, ref);
  const logicalPath = path.join(parent.logicalPath, ref);
  let beforeStat: Stats;
  try {
    beforeStat = await fs.lstat(openPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && allowMissing) return undefined;
    return fail(codes.unsafe, "trusted scheduler child directory is unavailable");
  }
  if (!beforeStat.isDirectory() || beforeStat.isSymbolicLink()) {
    return fail(codes.unsafe, "trusted scheduler child directory must be a real directory");
  }
  return openedPinnedDirectory(openPath, logicalPath, beforeStat, support, codes, hooks, allowMissing);
}

async function closePinned(directory: PinnedDirectory | undefined): Promise<void> {
  await directory?.handle.close().catch(() => undefined);
}

async function readOnce(
  directory: PinnedDirectory,
  ref: string,
  maxBytes: number,
  codes: SafeReadCodes,
  hooks: PmSchedulerOriginReadHooks,
  support: PinnedSupport,
  allowMissing: boolean,
): Promise<{ data: Buffer; identity: FileIdentity } | undefined> {
  const file = descriptorChild(directory, ref);
  const logicalFile = path.join(directory.logicalPath, ref);
  let handle: FileHandle;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | support.noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" && allowMissing) return undefined;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") {
      return fail("pm_status_scheduler_origin_unsupported", "O_NOFOLLOW is unavailable for trusted scheduler reads");
    }
    return fail(allowMissing ? codes.unsafe : codes.changed, "trusted scheduler file cannot be opened safely");
  }
  try {
    let beforeStat: Stats;
    try { beforeStat = await handle.stat(); }
    catch { return fail(codes.unsafe, "trusted scheduler file identity cannot be authenticated"); }
    const before = identity(beforeStat);
    if (!beforeStat.isFile() || before.size > maxBytes) {
      return fail(codes.unsafe, "trusted scheduler file must be one bounded regular file");
    }
    try { await hooks.afterPrecheck?.(logicalFile); }
    catch { return fail(codes.changed, "trusted scheduler file changed after precheck"); }

    const allocation = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    try {
      while (offset < allocation.byteLength) {
        const { bytesRead } = await handle.read(allocation, offset, allocation.byteLength - offset, null);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
    } catch {
      return fail(codes.changed, "trusted scheduler file read raced with a filesystem change");
    }
    let afterStat: Stats;
    try { afterStat = await handle.stat(); }
    catch { return fail(codes.changed, "trusted scheduler file identity changed after read"); }
    const after = identity(afterStat);
    if (offset > maxBytes || !sameIdentity(before, after) || offset !== after.size) {
      return fail(codes.changed, "trusted scheduler file changed during bounded read");
    }
    return { data: allocation.subarray(0, offset), identity: after };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function readBoundedRegularTwice(
  directory: PinnedDirectory,
  ref: string,
  maxBytes: number,
  codes: SafeReadCodes,
  hooks: PmSchedulerOriginReadHooks,
  support: PinnedSupport,
): Promise<Buffer | undefined> {
  const first = await readOnce(directory, ref, maxBytes, codes, hooks, support, true);
  if (!first) return undefined;
  const second = await readOnce(directory, ref, maxBytes, codes, hooks, support, false);
  if (!second || !sameIdentity(first.identity, second.identity) || !first.data.equals(second.data)) {
    return fail(codes.changed, "trusted scheduler file changed between authenticated reads");
  }
  return second.data;
}

function parseJson(raw: Buffer, code: string, label: string): unknown {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return JSON.parse(text) as unknown;
  } catch {
    return fail(code, `${label} is not canonical UTF-8 JSON`);
  }
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(new Date(0));
  } catch {
    fail("pm_status_scheduler_origin_manifest_invalid", "scheduler origin timezone is not an IANA zone");
  }
}

function decodeSignature(raw: Buffer): Buffer {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw).trim(); }
  catch { return fail("pm_status_scheduler_origin_tampered", "scheduler signature is not UTF-8 base64"); }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    return fail("pm_status_scheduler_origin_tampered", "scheduler signature is not canonical base64");
  }
  const signature = Buffer.from(text, "base64");
  if (signature.toString("base64") !== text || signature.byteLength !== 64) {
    return fail("pm_status_scheduler_origin_tampered", "scheduler signature is not canonical Ed25519 output");
  }
  return signature;
}

async function readFromPinnedInstallation(
  installation: PinnedDirectory,
  selector: PmSchedulerOriginSelector,
  hooks: PmSchedulerOriginReadHooks,
  support: PinnedSupport,
): Promise<TrustedPmSchedulerOriginReadback | undefined> {
  const manifestCodes = {
    unsafe: "pm_status_scheduler_origin_manifest_invalid",
    changed: "pm_status_scheduler_origin_manifest_invalid",
  };
  const config = await pinChildDirectory(installation, "config", support, manifestCodes, hooks, true);
  if (!config) return undefined;
  try {
    const manifestRaw = await readBoundedRegularTwice(
      config,
      MANIFEST_NAME,
      MAX_MANIFEST_BYTES,
      manifestCodes,
      hooks,
      support,
    );
    if (!manifestRaw) return undefined;
    const parsedManifest = ManifestSchema.safeParse(parseJson(
      manifestRaw,
      "pm_status_scheduler_origin_manifest_invalid",
      "scheduler origin manifest",
    ));
    if (!parsedManifest.success) return fail("pm_status_scheduler_origin_manifest_invalid", "scheduler origin manifest is malformed");
    const origin = parsedManifest.data.origins.find((candidate) => candidate.origin_id === selector.origin_id);
    if (!origin) return undefined;
    validateTimezone(origin.timezone);

    const recordRoot = await pinAbsoluteDirectory(
      origin.record_root,
      support,
      { unsafe: "pm_status_scheduler_origin_unsafe", changed: "pm_status_scheduler_origin_unsafe" },
      hooks,
      false,
    );
    if (!recordRoot) return fail("pm_status_scheduler_origin_unsafe", "configured scheduler record root is unavailable");
    try {
      const recordRaw = await readBoundedRegularTwice(recordRoot, `${selector.record_id}.json`, MAX_RECORD_BYTES, {
        unsafe: "pm_status_scheduler_origin_unsafe", changed: "pm_status_scheduler_origin_tampered",
      }, hooks, support);
      if (!recordRaw) return undefined;
      const signatureRaw = await readBoundedRegularTwice(recordRoot, `${selector.record_id}.sig`, MAX_SIGNATURE_BYTES, {
        unsafe: "pm_status_scheduler_origin_unsafe", changed: "pm_status_scheduler_origin_tampered",
      }, hooks, support);
      if (!signatureRaw) return fail("pm_status_scheduler_origin_tampered", "scheduler record signature is missing");
      let key: ReturnType<typeof createPublicKey>;
      try {
        key = createPublicKey(origin.public_key_pem);
      } catch {
        return fail("pm_status_scheduler_origin_manifest_invalid", "scheduler origin public key is invalid");
      }
      if (key.asymmetricKeyType !== "ed25519") {
        return fail("pm_status_scheduler_origin_manifest_invalid", "scheduler origin key must be Ed25519");
      }
      if (!verify(null, recordRaw, key, decodeSignature(signatureRaw))) {
        return fail("pm_status_scheduler_origin_tampered", "scheduler record signature verification failed");
      }
      const parsedRecord = RecordSchema.safeParse(parseJson(
        recordRaw,
        "pm_status_scheduler_origin_tampered",
        "scheduler record",
      ));
      if (!parsedRecord.success) return fail("pm_status_scheduler_origin_tampered", "scheduler record is malformed");
      const record = parsedRecord.data;
      if (record.origin_id !== selector.origin_id || record.record_id !== selector.record_id
        || record.key_id !== origin.key_id || record.timezone !== origin.timezone
        || record.prepare_local_time !== origin.prepare_local_time || record.review_local_time !== origin.review_local_time) {
        return fail("pm_status_scheduler_origin_mismatch", "signed scheduler record does not exactly match its configured origin");
      }
      return {
        origin: "scheduler_record", origin_id: record.origin_id, record_id: record.record_id,
        record_sha256: createHash("sha256").update(recordRaw).digest("hex"),
        schedule: { timezone: record.timezone, local_date: record.local_date,
          prepare_local_time: record.prepare_local_time, review_local_time: record.review_local_time },
        artifact: record.artifact,
      };
    } finally {
      await closePinned(recordRoot);
    }
  } finally {
    await closePinned(config);
  }
}

/**
 * Reads one scheduler record under an installation-owned manifest. The caller
 * selects only opaque IDs; it cannot supply roots, keys, hashes, zones, or slots.
 */
export async function readPmSchedulerOriginFromInstallation(
  installationRoot: string,
  rawSelector: PmSchedulerOriginSelector,
  hooks: PmSchedulerOriginReadHooks = {},
): Promise<TrustedPmSchedulerOriginReadback | undefined> {
  const selector = PmSchedulerOriginSelectorSchema.safeParse(rawSelector);
  if (!selector.success) return fail("pm_status_scheduler_origin_invalid", "scheduler origin selector is invalid");
  const support = await requirePinnedSupport(hooks);
  const installation = await pinAbsoluteDirectory(
    installationRoot,
    support,
    { unsafe: "pm_status_scheduler_origin_manifest_invalid", changed: "pm_status_scheduler_origin_manifest_invalid" },
    hooks,
    true,
  );
  if (!installation) return undefined;
  try {
    return await readFromPinnedInstallation(installation, selector.data, hooks, support);
  } finally {
    await closePinned(installation);
  }
}

async function nearestPackageRoot(moduleFile: string): Promise<string> {
  let current = path.dirname(moduleFile);
  for (;;) {
    const packageFile = path.join(current, "package.json");
    try {
      const stat = await fs.lstat(packageFile);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        return fail("pm_status_scheduler_origin_unsafe", "scheduler runtime package marker is unsafe");
      }
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return fail("pm_status_scheduler_origin_unsafe", "scheduler runtime package root cannot be authenticated");
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return fail("pm_status_scheduler_origin_unsafe", "scheduler runtime has no package root");
    }
    current = parent;
  }
}

async function installedProjectionRoot(
  packageRoot: string,
  support: PinnedSupport,
): Promise<PinnedDirectory | undefined> {
  const parentPath = path.dirname(packageRoot);
  if (parentPath === packageRoot) return undefined;
  const codes = { unsafe: "pm_status_scheduler_origin_unsafe", changed: "pm_status_scheduler_origin_unsafe" };
  const parent = await pinAbsoluteDirectory(parentPath, support, codes, {}, false);
  if (!parent) return undefined;
  try {
    const markerDirectory = await pinChildDirectory(parent, ".cursor-plugin", support, codes, {}, true);
    if (!markerDirectory) {
      await closePinned(parent);
      return undefined;
    }
    try {
      const markerRaw = await readBoundedRegularTwice(
        markerDirectory,
        "plugin.json",
        MAX_MARKER_BYTES,
        codes,
        {},
        support,
      );
      if (!markerRaw) {
        await closePinned(parent);
        return undefined;
      }
      const marker = PluginMarkerSchema.safeParse(parseJson(
        markerRaw,
        "pm_status_scheduler_origin_unsafe",
        "cursor plugin marker",
      ));
      if (!marker.success) {
        await closePinned(parent);
        return undefined;
      }
      return parent;
    } finally {
      await closePinned(markerDirectory);
    }
  } catch (error) {
    await closePinned(parent);
    throw error;
  }
}

async function projectedInstallationRoot(support: PinnedSupport): Promise<PinnedDirectory> {
  const packageRoot = await nearestPackageRoot(fileURLToPath(import.meta.url));
  const installed = await installedProjectionRoot(packageRoot, support);
  if (installed) return installed;

  const codes = { unsafe: "pm_status_scheduler_origin_unsafe", changed: "pm_status_scheduler_origin_unsafe" };
  const sourcePackage = await pinAbsoluteDirectory(packageRoot, support, codes, {}, false);
  if (!sourcePackage) return fail("pm_status_scheduler_origin_unsafe", "scheduler source package root is unavailable");
  try {
    const plugin = await pinChildDirectory(sourcePackage, "plugin", support, codes, {}, false);
    if (!plugin) return fail("pm_status_scheduler_origin_unsafe", "scheduler source plugin root is unavailable");
    return plugin;
  } finally {
    await closePinned(sourcePackage);
  }
}

/** Fixed source/installed-plugin reader; it never consults request or environment paths. */
export async function readProjectedPmSchedulerOrigin(
  rawSelector: PmSchedulerOriginSelector,
): Promise<TrustedPmSchedulerOriginReadback | undefined> {
  const selector = PmSchedulerOriginSelectorSchema.safeParse(rawSelector);
  if (!selector.success) return fail("pm_status_scheduler_origin_invalid", "scheduler origin selector is invalid");
  const support = await requirePinnedSupport({});
  const installation = await projectedInstallationRoot(support);
  try {
    return await readFromPinnedInstallation(installation, selector.data, {}, support);
  } finally {
    await closePinned(installation);
  }
}

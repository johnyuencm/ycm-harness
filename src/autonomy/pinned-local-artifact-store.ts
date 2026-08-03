import { createHash } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import type { PmExecutionStore } from "./pm.js";

const SAFE_CHILD = /^[A-Za-z0-9.][A-Za-z0-9._:-]{0,191}$/;
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_ARTIFACT_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_ARTIFACT_COUNT = 64;

type FileHandle = Awaited<ReturnType<typeof fs.open>>;

interface DirectoryIdentity {
  dev: number;
  ino: number;
}

interface FileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface PinnedSupport {
  noFollow: number;
  directory: number;
}

interface PinnedDirectory {
  handle: FileHandle;
  logicalPath: string;
  descriptorPath: string;
  identity: DirectoryIdentity;
}

export interface PinnedLocalArtifactStoreHooks {
  /** Test-only seams that can only remove required platform capability. */
  forcePlatformUnsupported?: boolean;
  forceNoFollowUnsupported?: boolean;
  forceDirectoryUnsupported?: boolean;
  forceDescriptorUnsupported?: boolean;
  /** Deterministic race seams; production callers never supply them. */
  afterDirectoryPrecheck?: (directory: string) => Promise<void> | void;
  afterDirectoryPinned?: (directory: string) => Promise<void> | void;
  afterStorePreflight?: () => Promise<void> | void;
  afterArtifactBatchValidated?: () => Promise<void> | void;
  afterPmPhase?: (phase: "prepare" | "handoff" | "review" | "status") => Promise<void> | void;
  beforeCommitIndex?: () => Promise<void> | void;
  afterCommitIndexPublished?: () => Promise<void> | void;
  beforeArtifactPublish?: (artifactName: string) => Promise<void> | void;
  faultAt?: "during_write" | "before_link" | "after_link" | "before_commit_index";
}

export interface PinnedLocalArtifact {
  name: string;
  content: string | Buffer;
}

function unsupported(): never {
  throw new Error("pm_canary_artifact_unsupported");
}

/** Fail closed before the canary performs any receipt or artifact mutation. */
async function requirePinnedSupport(
  hooks: PinnedLocalArtifactStoreHooks = {},
): Promise<PinnedSupport> {
  if (hooks.forcePlatformUnsupported || process.platform !== "linux") unsupported();
  if (hooks.forceNoFollowUnsupported || typeof fsConstants.O_NOFOLLOW !== "number" || fsConstants.O_NOFOLLOW === 0) unsupported();
  if (hooks.forceDirectoryUnsupported || typeof fsConstants.O_DIRECTORY !== "number" || fsConstants.O_DIRECTORY === 0) unsupported();
  if (hooks.forceDescriptorUnsupported) unsupported();
  const proc = await fs.stat("/proc/self/fd").catch(() => undefined);
  if (!proc?.isDirectory()) unsupported();
  return { noFollow: fsConstants.O_NOFOLLOW, directory: fsConstants.O_DIRECTORY };
}

function unsafe(): never {
  throw new Error("pm_canary_artifact_unsafe");
}

function conflict(): never {
  throw new Error("pm_canary_artifact_conflict");
}

function identity(stat: Stats): DirectoryIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileIdentity(stat: Stats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
}

function sameFileIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function childPath(parent: PinnedDirectory, child: string): string {
  if (!SAFE_CHILD.test(child) || child === "." || child === "..") unsafe();
  return `${parent.descriptorPath}/${child}`;
}

async function openPinnedDirectory(
  openPath: string,
  logicalPath: string,
  before: Stats,
  support: PinnedSupport,
  hooks: PinnedLocalArtifactStoreHooks,
): Promise<PinnedDirectory> {
  try {
    await hooks.afterDirectoryPrecheck?.(logicalPath);
  } catch {
    unsafe();
  }
  let handle: FileHandle;
  try {
    handle = await fs.open(openPath, fsConstants.O_RDONLY | support.directory | support.noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") unsupported();
    unsafe();
  }
  try {
    const opened = await handle.stat().catch(() => undefined);
    if (!opened?.isDirectory() || !sameIdentity(identity(before), identity(opened))) unsafe();
    const descriptorPath = `/proc/self/fd/${handle.fd}`;
    const descriptor = await fs.stat(descriptorPath).catch(() => undefined);
    if (!descriptor?.isDirectory() || !sameIdentity(identity(opened), identity(descriptor))) unsupported();
    try {
      await hooks.afterDirectoryPinned?.(logicalPath);
    } catch {
      unsafe();
    }
    return { handle, logicalPath, descriptorPath, identity: identity(opened) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function pinFilesystemRoot(
  support: PinnedSupport,
  hooks: PinnedLocalArtifactStoreHooks,
): Promise<PinnedDirectory> {
  const logicalPath = path.parse(path.resolve("/")).root;
  const before = await fs.lstat(logicalPath).catch(() => unsafe());
  if (!before.isDirectory() || before.isSymbolicLink()) unsafe();
  return openPinnedDirectory(logicalPath, logicalPath, before, support, hooks);
}

async function pinChildDirectory(
  parent: PinnedDirectory,
  child: string,
  create: boolean,
  support: PinnedSupport,
  hooks: PinnedLocalArtifactStoreHooks,
): Promise<PinnedDirectory> {
  const descriptorPath = childPath(parent, child);
  const logicalPath = path.join(parent.logicalPath, child);
  let before = await fs.lstat(descriptorPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") unsafe();
    return undefined;
  });
  if (!before) {
    if (!create) unsafe();
    try {
      await fs.mkdir(descriptorPath, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") unsafe();
    }
    before = await fs.lstat(descriptorPath).catch(() => unsafe());
  }
  if (!before.isDirectory() || before.isSymbolicLink()) unsafe();
  return openPinnedDirectory(descriptorPath, logicalPath, before, support, hooks);
}

async function revalidatePinnedDirectories(directories: readonly PinnedDirectory[]): Promise<void> {
  for (const directory of directories) {
    const current = await fs.lstat(directory.logicalPath).catch(() => unsafe());
    if (!current.isDirectory() || current.isSymbolicLink()
      || !sameIdentity(directory.identity, identity(current))) unsafe();
    const descriptor = await fs.stat(directory.descriptorPath).catch(() => unsupported());
    if (!descriptor.isDirectory() || !sameIdentity(directory.identity, identity(descriptor))) unsupported();
  }
}

async function withPinnedStore<T>(
  root: string,
  storeSegments: readonly string[],
  hooks: PinnedLocalArtifactStoreHooks,
  operation: (
    projectRoot: PinnedDirectory,
    runRoot: PinnedDirectory,
    support: PinnedSupport,
    revalidate: () => Promise<void>,
    pinFromProject: (segments: readonly string[]) => Promise<PinnedDirectory>,
  ) => Promise<T>,
): Promise<T> {
  const support = await requirePinnedSupport(hooks);
  const resolvedRoot = path.resolve(root);
  if (!path.isAbsolute(resolvedRoot) || path.parse(resolvedRoot).root !== "/") unsupported();
  const rootSegments = resolvedRoot.slice(1).split(path.sep).filter(Boolean);
  if (storeSegments.length === 0) unsafe();
  const pinned: PinnedDirectory[] = [];
  try {
    let current = await pinFilesystemRoot(support, hooks);
    pinned.push(current);
    for (const segment of rootSegments) {
      current = await pinChildDirectory(current, segment, false, support, hooks);
      pinned.push(current);
    }
    const projectRoot = current;
    for (const segment of storeSegments) {
      current = await pinChildDirectory(current, segment, true, support, hooks);
      pinned.push(current);
    }
    await revalidatePinnedDirectories(pinned);
    const pinFromProject = async (segments: readonly string[]): Promise<PinnedDirectory> => {
      let nested = projectRoot;
      for (const segment of segments) {
        nested = await pinChildDirectory(nested, segment, true, support, hooks);
        pinned.push(nested);
      }
      return nested;
    };
    const result = await operation(projectRoot, current, support, async () => revalidatePinnedDirectories(pinned), pinFromProject);
    await revalidatePinnedDirectories(pinned);
    return result;
  } finally {
    for (const directory of [...pinned].reverse()) await directory.handle.close().catch(() => undefined);
  }
}

function artifactRef(name: string): string {
  if (!SAFE_CHILD.test(name) || name === "." || name === "..") unsafe();
  return name;
}

function digest(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function tempRef(name: string, content: Buffer): string {
  return `.pm-artifact-${digest(Buffer.concat([Buffer.from(`${name}\0`, "utf8"), content]))}.stage`;
}

async function readExact(
  handle: FileHandle,
  expected: Buffer,
): Promise<FileIdentity> {
  const beforeStat = await handle.stat().catch(() => unsafe());
  if (!beforeStat.isFile() || beforeStat.size > MAX_ARTIFACT_BYTES) unsafe();
  const before = fileIdentity(beforeStat);
  const bytes = Buffer.allocUnsafe(expected.byteLength + 1);
  let offset = 0;
  try {
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
  } catch {
    unsafe();
  }
  const afterStat = await handle.stat().catch(() => unsafe());
  const after = fileIdentity(afterStat);
  if (!sameFileIdentity(before, after) || offset !== after.size) unsafe();
  if (offset !== expected.byteLength || !bytes.subarray(0, offset).equals(expected)) conflict();
  return after;
}

async function openExistingExact(
  runRoot: PinnedDirectory,
  ref: string,
  expected: Buffer,
  support: PinnedSupport,
): Promise<{ handle: FileHandle; identity: FileIdentity }> {
  let handle: FileHandle;
  try {
    handle = await fs.open(childPath(runRoot, ref), fsConstants.O_RDONLY | support.noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") unsupported();
    unsafe();
  }
  try {
    return { handle, identity: await readExact(handle, expected) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function openPreparedTemp(
  runRoot: PinnedDirectory,
  ref: string,
  content: Buffer,
  support: PinnedSupport,
  hooks: PinnedLocalArtifactStoreHooks,
): Promise<{ handle: FileHandle; identity: FileIdentity }> {
  let handle: FileHandle;
  let created = false;
  try {
    handle = await fs.open(
      childPath(runRoot, ref),
      fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | support.noFollow,
      0o600,
    );
    created = true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") unsupported();
    if (code !== "EEXIST") unsafe();
    try {
      handle = await fs.open(childPath(runRoot, ref), fsConstants.O_RDWR | support.noFollow);
    } catch (openError) {
      const openCode = (openError as NodeJS.ErrnoException).code;
      if (openCode === "EINVAL" || openCode === "ENOTSUP" || openCode === "EOPNOTSUPP") unsupported();
      unsafe();
    }
  }
  try {
    const before = await handle.stat().catch(() => unsafe());
    if (!before.isFile() || before.size > content.byteLength) conflict();
    const prefix = Buffer.alloc(before.size);
    let prefixOffset = 0;
    while (prefixOffset < prefix.byteLength) {
      const read = await handle.read(prefix, prefixOffset, prefix.byteLength - prefixOffset, prefixOffset).catch(() => unsafe());
      if (read.bytesRead <= 0) unsafe();
      prefixOffset += read.bytesRead;
    }
    const afterPrefix = await handle.stat().catch(() => unsafe());
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(afterPrefix))
      || !content.subarray(0, prefix.byteLength).equals(prefix)) conflict();
    let offset = prefix.byteLength;
    if (hooks.faultAt === "during_write") {
      const remaining = content.byteLength - offset;
      const partialLength = remaining > 1 ? Math.floor(remaining / 2) : remaining;
      if (partialLength > 0 && created) {
        const written = await handle.write(content, offset, partialLength, offset).catch(() => unsafe());
        if (written.bytesWritten !== partialLength) unsafe();
      }
      throw new Error("pm_canary_artifact_fault_during_write");
    }
    while (offset < content.byteLength) {
      const written = await handle.write(content, offset, content.byteLength - offset, offset).catch(() => unsafe());
      if (written.bytesWritten <= 0) unsafe();
      offset += written.bytesWritten;
    }
    await handle.sync().catch(() => unsafe());
    return { handle, identity: await readExact(handle, content) };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function publishArtifact(
  runRoot: PinnedDirectory,
  artifact: { name: string; content: Buffer },
  support: PinnedSupport,
  hooks: PinnedLocalArtifactStoreHooks,
): Promise<void> {
  const finalRef = artifactRef(artifact.name);
  const temporaryRef = tempRef(finalRef, artifact.content);
  try {
    await hooks.beforeArtifactPublish?.(finalRef);
  } catch {
    unsafe();
  }
  const temporary = await openPreparedTemp(runRoot, temporaryRef, artifact.content, support, hooks);
  try {
    if (hooks.faultAt === "before_link") throw new Error("pm_canary_artifact_fault_before_link");
    let linked = false;
    try {
      await fs.link(childPath(runRoot, temporaryRef), childPath(runRoot, finalRef));
      linked = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") unsafe();
    }
    if (hooks.faultAt === "after_link") throw new Error("pm_canary_artifact_fault_after_link");
    const final = await openExistingExact(runRoot, finalRef, artifact.content, support);
    try {
      if (linked && (temporary.identity.dev !== final.identity.dev || temporary.identity.ino !== final.identity.ino)) unsafe();
    } finally {
      await final.handle.close().catch(() => undefined);
    }
    await runRoot.handle.sync().catch(() => unsafe());
  } finally {
    await temporary.handle.close().catch(() => undefined);
  }
}

async function existingArtifact(
  runRoot: PinnedDirectory,
  ref: string,
  content: Buffer,
  support: PinnedSupport,
): Promise<{ identity: FileIdentity } | undefined> {
  const stat = await fs.lstat(childPath(runRoot, ref)).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    unsafe();
  });
  if (!stat) return undefined;
  if (!stat.isFile() || stat.isSymbolicLink()) unsafe();
  const opened = await openExistingExact(runRoot, ref, content, support);
  try {
    if (stat.dev !== opened.identity.dev || stat.ino !== opened.identity.ino || stat.size !== opened.identity.size) unsafe();
    return { identity: opened.identity };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
}

async function preflightArtifact(
  runRoot: PinnedDirectory,
  artifact: { name: string; content: Buffer },
  support: PinnedSupport,
): Promise<boolean> {
  const finalRef = artifactRef(artifact.name);
  return (await existingArtifact(runRoot, finalRef, artifact.content, support)) !== undefined;
}

async function revalidateArtifactBatch(
  runRoot: PinnedDirectory,
  artifacts: readonly { name: string; content: Buffer }[],
  support: PinnedSupport,
): Promise<Map<string, { handle: FileHandle; identity: FileIdentity; content: Buffer }>> {
  const retained = new Map<string, { handle: FileHandle; identity: FileIdentity; content: Buffer }>();
  try {
    for (const artifact of artifacts) {
      const final = await openExistingExact(runRoot, artifactRef(artifact.name), artifact.content, support);
      retained.set(artifact.name, { ...final, content: artifact.content });
    }
    return retained;
  } catch (error) {
    for (const artifact of retained.values()) await artifact.handle.close().catch(() => undefined);
    throw error;
  }
}

interface PinnedPmExecutionIdentity {
  goalId: string;
  claimId: string;
}

interface StagedRecordVersion {
  key: string;
  ref: string;
  sha256: string;
  size_bytes: number;
  dev: number;
  ino: number;
}

interface CommitArtifact {
  name: string;
  sha256: string;
  size_bytes: number;
  dev: number;
  ino: number;
}

interface CommitIndexCore {
  schema_version: 1;
  goal_id: string;
  claim_id: string;
  records: StagedRecordVersion[];
  current: Array<{ key: string; ref: string }>;
  artifacts: CommitArtifact[];
}

interface CommitIndex extends CommitIndexCore {
  protected_state_sha256: string;
}

function immutableConflict(code: string): never {
  throw new Error(code);
}

async function writeImmutablePinned(
  directory: PinnedDirectory,
  ref: string,
  content: Buffer,
  support: PinnedSupport,
  conflictCode: string,
): Promise<{ handle: FileHandle; identity: FileIdentity }> {
  let handle: FileHandle;
  try {
    handle = await fs.open(childPath(directory, ref), fsConstants.O_RDWR | fsConstants.O_CREAT | fsConstants.O_EXCL | support.noFollow, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EINVAL" || code === "ENOTSUP" || code === "EOPNOTSUPP") unsupported();
    if (code !== "EEXIST") unsafe();
    try { handle = await fs.open(childPath(directory, ref), fsConstants.O_RDWR | support.noFollow); }
    catch { return immutableConflict(conflictCode); }
  }
  try {
    const before = await handle.stat().catch(() => immutableConflict(conflictCode));
    if (!before.isFile() || before.size > content.byteLength) immutableConflict(conflictCode);
    const prefix = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < prefix.byteLength) {
      const read = await handle.read(prefix, offset, prefix.byteLength - offset, offset).catch(() => immutableConflict(conflictCode));
      if (read.bytesRead <= 0) immutableConflict(conflictCode);
      offset += read.bytesRead;
    }
    const afterPrefix = await handle.stat().catch(() => immutableConflict(conflictCode));
    if (!sameFileIdentity(fileIdentity(before), fileIdentity(afterPrefix))
      || !content.subarray(0, prefix.byteLength).equals(prefix)) immutableConflict(conflictCode);
    while (offset < content.byteLength) {
      const written = await handle.write(content, offset, content.byteLength - offset, offset).catch(() => immutableConflict(conflictCode));
      if (written.bytesWritten <= 0) immutableConflict(conflictCode);
      offset += written.bytesWritten;
    }
    await handle.sync().catch(() => unsafe());
    const identity = await readExact(handle, content);
    await directory.handle.sync().catch(() => unsafe());
    return { handle, identity };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function readStableHandle(
  handle: FileHandle,
  maxBytes: number,
  afterFirstRead?: () => void | Promise<void>,
): Promise<Buffer> {
  const beforeStat = await handle.stat().catch(() => unsafe());
  if (!beforeStat.isFile() || beforeStat.size > maxBytes) unsafe();
  const readOnce = async (): Promise<Buffer> => {
    const bytes = Buffer.alloc(beforeStat.size + 1);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const read = await handle.read(bytes, offset, bytes.byteLength - offset, offset).catch(() => unsafe());
      if (read.bytesRead === 0) break;
      offset += read.bytesRead;
    }
    if (offset !== beforeStat.size) unsafe();
    return bytes.subarray(0, offset);
  };
  const first = await readOnce();
  await afterFirstRead?.();
  const middle = await handle.stat().catch(() => unsafe());
  const second = await readOnce();
  const after = await handle.stat().catch(() => unsafe());
  if (!sameFileIdentity(fileIdentity(beforeStat), fileIdentity(middle))
    || !sameFileIdentity(fileIdentity(middle), fileIdentity(after)) || !first.equals(second)) unsafe();
  return second;
}

function parseCommitIndex(raw: unknown, identity: PinnedPmExecutionIdentity): CommitIndex | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Partial<CommitIndex>;
  if (value.schema_version !== 1 || value.goal_id !== identity.goalId || value.claim_id !== identity.claimId
    || !Array.isArray(value.records) || !Array.isArray(value.current) || !Array.isArray(value.artifacts)
    || typeof value.protected_state_sha256 !== "string") return undefined;
  const { protected_state_sha256, ...core } = value as CommitIndex;
  if (protected_state_sha256 !== digest(JSON.stringify(core))) return undefined;
  return value as CommitIndex;
}

export class PinnedPmExecution implements PmExecutionStore {
  readonly resolved: { root: string; goalId: string };
  private readonly current = new Map<string, { value: unknown; ref: string }>();
  private readonly versions = new Map<string, StagedRecordVersion>();
  private readonly stagedBytes = new Map<string, Buffer>();
  private commitInvalid = false;
  private committed = false;

  constructor(
    private readonly identity: PinnedPmExecutionIdentity,
    private readonly projectRoot: PinnedDirectory,
    private readonly runRoot: PinnedDirectory,
    private readonly records: PinnedDirectory,
    private readonly commits: PinnedDirectory,
    private readonly artifacts: Map<string, { handle: FileHandle; identity: FileIdentity; content: Buffer }>,
    private readonly support: PinnedSupport,
    private readonly revalidate: () => Promise<void>,
    private readonly hooks: PinnedLocalArtifactStoreHooks,
  ) {
    this.resolved = { root: projectRoot.descriptorPath, goalId: identity.goalId };
  }

  private key(file: string): string {
    const relative = path.relative(this.resolved.root, path.resolve(file));
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) unsafe();
    const segments = relative.split(path.sep);
    if (segments.some((segment) => !SAFE_CHILD.test(segment) || segment === "." || segment === "..")) unsafe();
    return segments.join("/");
  }

  private commitRef(): string {
    return `pm-commit-${digest(`${this.identity.goalId}\0${this.identity.claimId}`).slice(0, 32)}.json`;
  }

  private async inventoryRecords(expected: readonly string[], failureCode: string): Promise<void> {
    let entries: Array<{ name: string; isFile(): boolean }>;
    try {
      entries = await fs.readdir(this.records.descriptorPath, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return immutableConflict(failureCode);
    }
    if (entries.some((entry) => !entry.isFile())) immutableConflict(failureCode);
    const actual = entries.map((entry) => entry.name).sort();
    const bound = [...expected].sort();
    if (actual.length !== bound.length || actual.some((name, index) => name !== bound[index])) {
      immutableConflict(failureCode);
    }
  }

  private async authenticateRecord(
    record: StagedRecordVersion,
    failureCode: string,
    expectedBytes?: Buffer,
  ): Promise<unknown> {
    if (typeof record.key !== "string" || record.key.length === 0
      || record.key.split("/").some((segment) => !SAFE_CHILD.test(segment) || segment === "." || segment === "..")
      || typeof record.ref !== "string" || !/^pm-record-[0-9a-f]{32}-[0-9a-f]{64}\.json$/.test(record.ref)
      || typeof record.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(record.sha256)
      || !Number.isSafeInteger(record.size_bytes) || record.size_bytes < 1
      || !Number.isSafeInteger(record.dev) || !Number.isSafeInteger(record.ino)) immutableConflict(failureCode);
    let handle: FileHandle;
    try { handle = await fs.open(childPath(this.records, record.ref), fsConstants.O_RDONLY | this.support.noFollow); }
    catch { return immutableConflict(failureCode); }
    try {
      const bytes = await readStableHandle(handle, MAX_ARTIFACT_BYTES).catch(() => immutableConflict(failureCode));
      const stat = await handle.stat().catch(() => immutableConflict(failureCode));
      if (bytes.byteLength !== record.size_bytes || digest(bytes) !== record.sha256
        || stat.dev !== record.dev || stat.ino !== record.ino
        || record.ref !== `pm-record-${digest(record.key).slice(0, 32)}-${digest(bytes)}.json`
        || (expectedBytes && !bytes.equals(expectedBytes))) immutableConflict(failureCode);
      let value: unknown;
      try {
        value = JSON.parse(bytes.toString("utf8"));
        const canonical = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
        if (!canonical.equals(bytes)) immutableConflict(failureCode);
      } catch {
        return immutableConflict(failureCode);
      }
      return value;
    } finally { await handle.close().catch(() => undefined); }
  }

  private clearAuthenticationState(): void {
    this.current.clear();
    this.versions.clear();
    this.stagedBytes.clear();
    this.commitInvalid = false;
    this.committed = false;
  }

  private invalidateCommitIndex(strict: boolean): void {
    this.clearAuthenticationState();
    this.commitInvalid = true;
    if (strict) immutableConflict("pm_canary_commit_index_tampered");
  }

  async loadCommitted(expectedCommitIdentity?: FileIdentity): Promise<void> {
    this.clearAuthenticationState();
    let handle: FileHandle;
    try { handle = await fs.open(childPath(this.commits, this.commitRef()), fsConstants.O_RDONLY | this.support.noFollow); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      this.invalidateCommitIndex(expectedCommitIdentity !== undefined);
      return;
    }
    try {
      const opened = await handle.stat().catch(() => immutableConflict("pm_canary_commit_index_tampered"));
      if (expectedCommitIdentity && !sameFileIdentity(expectedCommitIdentity, fileIdentity(opened))) {
        immutableConflict("pm_canary_commit_index_tampered");
      }
      const bytes = await readStableHandle(handle, MAX_ARTIFACT_BYTES).catch(() => undefined);
      if (!bytes) {
        this.invalidateCommitIndex(expectedCommitIdentity !== undefined);
        return;
      }
      let raw: unknown;
      try { raw = JSON.parse(bytes.toString("utf8")); }
      catch {
        this.invalidateCommitIndex(expectedCommitIdentity !== undefined);
        return;
      }
      const index = parseCommitIndex(raw, this.identity);
      if (!index || !bytes.equals(Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8"))) {
        this.invalidateCommitIndex(expectedCommitIdentity !== undefined);
        return;
      }
      const refs = index.records.map((record) => record.ref);
      if (new Set(refs).size !== refs.length) throw new Error("pm_canary_commit_index_tampered");
      await this.inventoryRecords(refs, "pm_canary_commit_index_tampered");
      const byRef = new Map<string, { value: unknown; record: StagedRecordVersion }>();
      const loadedVersions = new Map<string, StagedRecordVersion>();
      const loadedCurrent = new Map<string, { value: unknown; ref: string }>();
      for (const record of index.records) {
        const value = await this.authenticateRecord(record, "pm_canary_commit_index_tampered");
        byRef.set(record.ref, { value, record });
        loadedVersions.set(record.ref, record);
      }
      const currentKeys = index.current.map((pointer) => pointer.key);
      if (new Set(currentKeys).size !== currentKeys.length) throw new Error("pm_canary_commit_index_tampered");
      for (const pointer of index.current) {
        const loaded = byRef.get(pointer.ref);
        if (!loaded || loaded.record.key !== pointer.key) throw new Error("pm_canary_commit_index_tampered");
        loadedCurrent.set(pointer.key, { value: loaded.value, ref: pointer.ref });
      }
      await this.verifyArtifacts(index.artifacts).catch(() => immutableConflict("pm_canary_commit_index_tampered"));
      await this.inventoryRecords(refs, "pm_canary_commit_index_tampered");
      for (const [ref, record] of loadedVersions) this.versions.set(ref, record);
      for (const [key, value] of loadedCurrent) this.current.set(key, value);
      this.committed = true;
    } catch (error) {
      this.clearAuthenticationState();
      this.commitInvalid = true;
      throw error;
    } finally { await handle.close().catch(() => undefined); }
  }

  private async verifyArtifacts(expected?: CommitArtifact[]): Promise<CommitArtifact[]> {
    const result: CommitArtifact[] = [];
    for (const [name, retained] of [...this.artifacts].sort(([left], [right]) => left.localeCompare(right))) {
      const reopened = await openExistingExact(this.runRoot, name, retained.content, this.support).catch(() => unsafe());
      try {
        if (reopened.identity.dev !== retained.identity.dev || reopened.identity.ino !== retained.identity.ino) unsafe();
        result.push({ name, sha256: digest(retained.content), size_bytes: retained.content.byteLength,
          dev: reopened.identity.dev, ino: reopened.identity.ino });
      } finally { await reopened.handle.close().catch(() => undefined); }
    }
    if (expected && JSON.stringify(result) !== JSON.stringify(expected)) throw new Error("pm_canary_commit_index_tampered");
    return result;
  }

  async assertPath(target: string, _finalKind: "directory" | "file" | "any", _failureCode: string): Promise<void> {
    this.key(target);
  }

  async assertLease(key: string, failureCode: string): Promise<void> {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(key)) throw new Error(failureCode);
  }

  async withLease<T>(key: string, operation: () => Promise<T>): Promise<T> {
    await this.assertLease(key, "pm_canary_artifact_unsafe");
    return operation();
  }

  async readJson<T>(file: string): Promise<T | undefined> {
    return this.current.get(this.key(file))?.value as T | undefined;
  }

  async writeJson(file: string, value: unknown): Promise<void> {
    if (this.committed) throw new Error("pm_canary_commit_index_conflict");
    const key = this.key(file);
    const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    const ref = `pm-record-${digest(key).slice(0, 32)}-${digest(bytes)}.json`;
    const staged = await writeImmutablePinned(this.records, ref, bytes, this.support, "pm_canary_stage_conflict");
    try {
      const record = { key, ref, sha256: digest(bytes), size_bytes: bytes.byteLength,
        dev: staged.identity.dev, ino: staged.identity.ino };
      this.versions.set(ref, record);
      this.stagedBytes.set(ref, bytes);
      this.current.set(key, { value: JSON.parse(bytes.toString("utf8")), ref });
    } finally { await staged.handle.close().catch(() => undefined); }
  }

  async readArtifact(file: string, maxBytes: number, afterFirstRead?: () => void | Promise<void>): Promise<Buffer> {
    const expectedRunRoot = path.join(this.resolved.root, path.relative(this.projectRoot.logicalPath, this.runRoot.logicalPath));
    const relative = path.relative(expectedRunRoot, path.resolve(file));
    if (!relative || relative.includes(path.sep) || !SAFE_CHILD.test(relative)) unsafe();
    const retained = this.artifacts.get(relative);
    if (!retained || retained.content.byteLength > maxBytes) unsafe();
    return readStableHandle(retained.handle, maxBytes, afterFirstRead);
  }

  listJson(directory: string): string[] {
    const prefix = `${this.key(path.join(directory, ".placeholder"))}`.replace(/\/\.placeholder$/, "/");
    return [...this.current.keys()].filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length)).filter((name) => !name.includes("/")).sort();
  }

  async commit(): Promise<void> {
    if (this.committed) return;
    await this.hooks.beforeCommitIndex?.();
    if (this.hooks.faultAt === "before_commit_index") throw new Error("pm_canary_fault_before_commit_index");
    await this.revalidate();
    const artifacts = await this.verifyArtifacts();
    const records = [...this.versions.values()].sort((a, b) => a.ref.localeCompare(b.ref));
    const refs = records.map((record) => record.ref);
    await this.inventoryRecords(refs, "pm_canary_stage_conflict");
    for (const record of records) {
      const expected = this.stagedBytes.get(record.ref);
      if (!expected) throw new Error("pm_canary_stage_conflict");
      await this.authenticateRecord(record, "pm_canary_stage_conflict", expected);
    }
    await this.inventoryRecords(refs, "pm_canary_stage_conflict");
    const current = [...this.current.entries()].map(([key, value]) => ({ key, ref: value.ref }))
      .sort((a, b) => a.key.localeCompare(b.key));
    const core: CommitIndexCore = { schema_version: 1, goal_id: this.identity.goalId,
      claim_id: this.identity.claimId, records, current, artifacts };
    const index: CommitIndex = { ...core, protected_state_sha256: digest(JSON.stringify(core)) };
    const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf8");
    const staged = await writeImmutablePinned(this.commits, this.commitRef(), bytes, this.support,
      this.commitInvalid ? "pm_canary_commit_index_tampered" : "pm_canary_commit_index_conflict");
    await staged.handle.close().catch(() => undefined);
    await this.hooks.afterCommitIndexPublished?.();
    await this.revalidate();
    await this.loadCommitted(staged.identity);
    if (!this.committed) throw new Error("pm_canary_commit_index_tampered");
  }
}

/** Publish and authenticate exact local artifacts before running the mutation callback. */
export async function persistPinnedLocalArtifacts<T>(
  root: string,
  storeSegments: readonly string[],
  rawArtifacts: readonly PinnedLocalArtifact[],
  afterPublish: (execution?: PinnedPmExecution) => Promise<T>,
  hooks: PinnedLocalArtifactStoreHooks = {},
  executionIdentity?: PinnedPmExecutionIdentity,
  afterCommit?: (execution: PinnedPmExecution, result: T) => Promise<T>,
): Promise<T> {
  const artifacts = rawArtifacts.map(({ name, content }) => ({ name: artifactRef(name), content: Buffer.from(content) }));
  if (artifacts.length === 0 || artifacts.length > MAX_ARTIFACT_COUNT
    || new Set(artifacts.map(({ name }) => name)).size !== artifacts.length) unsafe();
  if (artifacts.some(({ content }) => content.byteLength > MAX_ARTIFACT_BYTES)
    || artifacts.reduce((total, { content }) => total + content.byteLength, 0) > MAX_ARTIFACT_TOTAL_BYTES) unsafe();
  return withPinnedStore(root, storeSegments, hooks, async (projectRoot, runRoot, support, revalidate, pinFromProject) => {
    const sorted = [...artifacts].sort((left, right) => left.name.localeCompare(right.name));
    const existing = new Set<string>();
    for (const artifact of sorted) {
      if (await preflightArtifact(runRoot, artifact, support)) existing.add(artifact.name);
    }
    try {
      await hooks.afterStorePreflight?.();
    } catch {
      unsafe();
    }
    await revalidate();
    for (const artifact of sorted) {
      if (!existing.has(artifact.name)) await publishArtifact(runRoot, artifact, support, hooks);
    }
    const retained = await revalidateArtifactBatch(runRoot, sorted, support);
    let execution: PinnedPmExecution | undefined;
    try {
      await revalidate();
      if (executionIdentity) {
        const records = await pinFromProject([".ycm-harness", "autonomy", "pm", "staging", executionIdentity.claimId, "records"]);
        const commits = await pinFromProject([".ycm-harness", "autonomy", "pm", "commits"]);
        execution = new PinnedPmExecution(executionIdentity, projectRoot, runRoot, records, commits,
          retained, support, revalidate, hooks);
        await execution.loadCommitted();
      }
      await hooks.afterArtifactBatchValidated?.();
      const result = await afterPublish(execution);
      await execution?.commit();
      return execution && afterCommit ? await afterCommit(execution, result) : result;
    } finally {
      for (const artifact of retained.values()) await artifact.handle.close().catch(() => undefined);
    }
  });
}

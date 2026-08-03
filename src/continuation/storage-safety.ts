import { promises as fs } from "node:fs";
import path from "node:path";
import { HARNESS_DIR_NAME } from "../state/paths.js";

export type ContinuationStoragePathKind = "directory" | "file" | "any";

function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Symlink-safe containment check shared by continuation autonomy stores. */
export async function assertSafeContinuationStoragePath(
  root: string,
  target: string,
  finalKind: ContinuationStoragePathKind = "any",
  failureCode = "unsafe_continuation_storage_path",
): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  if (!contains(resolvedRoot, resolvedTarget)) throw new Error(failureCode);
  const rootStat = await fs.lstat(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(failureCode);
  const realRoot = await fs.realpath(resolvedRoot);
  let current = resolvedRoot;
  const segments = path.relative(resolvedRoot, resolvedTarget).split(path.sep).filter(Boolean);
  for (const [index, segment] of segments.entries()) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !contains(realRoot, await fs.realpath(current))) {
      throw new Error(failureCode);
    }
    const final = index === segments.length - 1;
    if (!final && !stat.isDirectory()) throw new Error(failureCode);
    if (final && finalKind === "directory" && !stat.isDirectory()) throw new Error(failureCode);
    if (final && finalKind === "file" && !stat.isFile()) throw new Error(failureCode);
  }
}

/** Preflight the coordinator lease tree before a continuation store acquires it. */
export async function assertSafeContinuationLeaseTree(
  root: string,
  leaseKey: string,
  failureCode = "unsafe_continuation_storage_path",
): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(leaseKey)) {
    throw new Error(failureCode);
  }
  const harness = path.join(root, HARNESS_DIR_NAME);
  const autonomy = path.join(harness, "autonomy");
  const locks = path.join(autonomy, "locks");
  const lease = path.join(locks, `${leaseKey}.lock`);
  await assertSafeContinuationStoragePath(root, harness, "directory", failureCode);
  await assertSafeContinuationStoragePath(root, autonomy, "directory", failureCode);
  await assertSafeContinuationStoragePath(root, locks, "directory", failureCode);
  await assertSafeContinuationStoragePath(root, lease, "directory", failureCode);
  await assertSafeContinuationStoragePath(root, path.join(lease, "owner.json"), "file", failureCode);
  const names = await fs.readdir(locks).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? [] : Promise.reject(error));
  for (const name of names.filter((value) => value.startsWith(`${leaseKey}.lock.`))) {
    await assertSafeContinuationStoragePath(root, path.join(locks, name), "file", failureCode);
  }
}

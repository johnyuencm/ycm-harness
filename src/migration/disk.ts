import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { StateV3, type StateV3T } from "../schema/v3.js";
import { migrateV2ToV3 } from "./v2-to-v3.js";
import { nowIso } from "../state/ids.js";

export type MigrationFault = "archive-write" | "state-write" | "archive-rename" | "state-rename";

export interface MigrationPaths {
  harnessDir: string;
  statePath: string;
  archiveDir: string;
  archiveStatePath: string;
  manifestPath: string;
  tempDir: string;
}

export interface MigrationPreview {
  from_version: number;
  to_version: 3;
  state_path: string;
  archive_state_path: string;
  manifest_path: string;
  goal_count: number;
  ticket_count: number;
  evidence_count: number;
}

export interface MigrationResult {
  applied: boolean;
  already_migrated: boolean;
  preview: MigrationPreview;
  state?: StateV3T;
}

export interface DiskMigrationOptions {
  dryRun?: boolean;
  now?: string;
  /** Test seam for proving cleanup/rollback at each commit boundary. */
  faultAt?: MigrationFault;
}

export function migrationPaths(root: string): MigrationPaths {
  const harnessDir = path.join(root, ".ycm-harness");
  const archiveDir = path.join(harnessDir, "legacy", "v2");
  return {
    harnessDir,
    statePath: path.join(harnessDir, "state.json"),
    archiveDir,
    archiveStatePath: path.join(archiveDir, "state.json"),
    manifestPath: path.join(archiveDir, "manifest.json"),
    tempDir: path.join(harnessDir, ".migration-v3.tmp"),
  };
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function relative(root: string, target: string): string {
  return path.relative(root, target).split(path.sep).join("/");
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function previewFor(root: string, paths: MigrationPaths, state: StateV3T | undefined, raw: unknown): MigrationPreview {
  const old = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const goals = old.goals && typeof old.goals === "object" ? Object.keys(old.goals).length : state ? Object.keys(state.goals).length : 0;
  const tasks = old.tasks && typeof old.tasks === "object" ? Object.keys(old.tasks).length : state ? Object.keys(state.local_tickets).length : 0;
  const evidence = state ? Object.keys(state.evidence).length : 0;
  return {
    from_version: typeof old.version === "number" ? old.version : 0,
    to_version: 3,
    state_path: relative(root, paths.statePath),
    archive_state_path: relative(root, paths.archiveStatePath),
    manifest_path: relative(root, paths.manifestPath),
    goal_count: goals,
    ticket_count: tasks,
    evidence_count: evidence,
  };
}

function maybeFault(options: DiskMigrationOptions, point: MigrationFault): void {
  if (options.faultAt === point) throw new Error(`injected migration failure at ${point}`);
}

/**
 * Migrate the project state with staged writes and rollback on synchronous
 * failures. The original V2 bytes are archived verbatim before StateV3 becomes
 * authoritative. A stale temporary directory is safe to remove on retry.
 */
export async function migrateOnDisk(root: string, options: DiskMigrationOptions = {}): Promise<MigrationResult> {
  const paths = migrationPaths(root);
  const original = await fs.readFile(paths.statePath);
  let raw: unknown;
  try {
    raw = JSON.parse(original.toString("utf8"));
  } catch (error) {
    throw new Error(`Invalid state JSON at ${paths.statePath}: ${String(error)}`);
  }

  const versionValue = raw && typeof raw === "object" ? (raw as Record<string, unknown>).version : undefined;
  const version = typeof versionValue === "number" ? versionValue : 0;
  if (version >= 3) {
    const state = StateV3.parse(raw);
    return {
      applied: false,
      already_migrated: true,
      preview: previewFor(root, paths, state, raw),
      state,
    };
  }
  if (version !== 2 && version !== 1 && version !== 0) {
    throw new Error(`Unsupported state version ${String(version)}; expected V2.`);
  }

  const at = options.now ?? nowIso();
  const digest = sha256(original);
  const archive = {
    version: 2 as const,
    state_path: relative(root, paths.archiveStatePath),
    sha256: digest,
    manifest_path: relative(root, paths.manifestPath),
    archived_at: at,
  };
  const state = migrateV2ToV3(raw, { now: at, archive });
  const preview = previewFor(root, paths, state, raw);
  if (options.dryRun) return { applied: false, already_migrated: false, preview, state };

  await fs.mkdir(paths.harnessDir, { recursive: true });
  // ponytail: one deterministic temp directory is enough; retry cleans it.
  await fs.rm(paths.tempDir, { recursive: true, force: true });
  let archiveCommitted = false;
  let stateCommitted = false;
  let existingArchive = false;
  try {
    const stagedArchiveDir = path.join(paths.tempDir, "legacy", "v2");
    const stagedArchiveState = path.join(stagedArchiveDir, "state.json");
    const stagedManifest = path.join(stagedArchiveDir, "manifest.json");
    const stagedState = path.join(paths.tempDir, "state.json");
    await fs.mkdir(stagedArchiveDir, { recursive: true });
    maybeFault(options, "archive-write");
    await fs.writeFile(stagedArchiveState, original);
    await fs.writeFile(stagedManifest, JSON.stringify({
      version: 2,
      sha256: digest,
      bytes: original.byteLength,
      archived_at: at,
      source: relative(root, paths.statePath),
    }, null, 2) + "\n", "utf8");
    maybeFault(options, "state-write");
    await fs.writeFile(stagedState, JSON.stringify(state, null, 2) + "\n", "utf8");

    if (await exists(paths.archiveDir)) {
      existingArchive = true;
      const oldArchive = await fs.readFile(paths.archiveStatePath);
      if (sha256(oldArchive) !== digest || oldArchive.compare(original) !== 0) {
        throw new Error(`V2 archive already exists with different bytes at ${paths.archiveDir}`);
      }
      if (!(await exists(paths.manifestPath))) {
        throw new Error(`V2 archive is incomplete at ${paths.archiveDir}`);
      }
      try {
        const manifest = JSON.parse(await fs.readFile(paths.manifestPath, "utf8")) as Record<string, unknown>;
        if (manifest.sha256 !== digest) throw new Error("digest mismatch");
      } catch {
        throw new Error(`V2 archive manifest is invalid at ${paths.manifestPath}`);
      }
    } else {
      maybeFault(options, "archive-rename");
      await fs.mkdir(path.dirname(paths.archiveDir), { recursive: true });
      await fs.rename(path.join(paths.tempDir, "legacy", "v2"), paths.archiveDir);
      archiveCommitted = true;
    }

    maybeFault(options, "state-rename");
    await fs.rename(stagedState, paths.statePath);
    stateCommitted = true;
    await fs.rm(paths.tempDir, { recursive: true, force: true });
    return { applied: true, already_migrated: false, preview, state };
  } catch (error) {
    // Roll back every named path changed by this invocation. Existing archives
    // are never touched. If the process is killed, the next invocation removes
    // the deterministic temporary directory before retrying.
    if (stateCommitted) {
      await fs.writeFile(paths.statePath, original);
    }
    if (archiveCommitted && !existingArchive) {
      await fs.rm(paths.archiveDir, { recursive: true, force: true });
    }
    await fs.rm(paths.tempDir, { recursive: true, force: true });
    throw error;
  }
}







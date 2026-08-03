import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { withCoordinationLease } from "./coordination.js";
import { appendJsonl, readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import { HARNESS_DIR_NAME } from "../state/paths.js";

export const ROLLBACK_SURFACES = ["schedules", "scout", "enforcement"] as const;
export type RollbackSurface = (typeof ROLLBACK_SURFACES)[number];

const SURFACE_SET = new Set<string>(ROLLBACK_SURFACES);

const SurfaceMapSchema = z.object({
  schedules: z.boolean(),
  scout: z.boolean(),
  enforcement: z.boolean(),
}).strict();

const ApprovedInstalledVersionSchema = z.object({
  package_name: z.string().min(1).max(191),
  package_version: z.string().min(1).max(64),
  source_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const EvidenceEntrySchema = z.object({
  relative_path: z.string().min(1).max(1024),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

const BaselineSchema = z.object({
  schema_version: z.literal(1),
  baseline_id: z.string().min(1).max(191),
  captured_at: z.string().datetime(),
  approved_installed_version: ApprovedInstalledVersionSchema,
  surfaces: SurfaceMapSchema,
  evidence_inventory: z.array(EvidenceEntrySchema).max(512),
  package_json: z.string().min(2).max(64 * 1024),
}).strict();

const DurableStateSchema = z.object({
  schema_version: z.literal(1),
  surfaces: SurfaceMapSchema,
  active_baseline_id: z.string().min(1).max(191).optional(),
  approved_installed_version: ApprovedInstalledVersionSchema.optional(),
  updated_at: z.string().datetime(),
}).strict();

export type ApprovedInstalledVersion = z.infer<typeof ApprovedInstalledVersionSchema>;
export type RollbackBaseline = z.infer<typeof BaselineSchema>;
export type RollbackDurableState = z.infer<typeof DurableStateSchema>;

export interface RollbackStatus {
  surfaces: z.infer<typeof SurfaceMapSchema>;
  active_baseline_id?: string;
  approved_installed_version?: ApprovedInstalledVersion;
  evidence_retained: boolean;
}

export interface RollbackClock {
  now?: () => string;
}

function sha(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function directory(root: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "enforcement-rollback");
}

function statePath(root: string): string {
  return path.join(directory(root), "state.json");
}

function baselinesDir(root: string): string {
  return path.join(directory(root), "baselines");
}

function baselinePath(root: string, baselineId: string): string {
  return path.join(baselinesDir(root), `${baselineId}.json`);
}

function eventsPath(root: string): string {
  return path.join(directory(root), "events.jsonl");
}

function parseSurface(surface: string): RollbackSurface {
  if (!SURFACE_SET.has(surface)) throw new Error("rollback_surface_invalid");
  return surface as RollbackSurface;
}

function defaultSurfaces(): z.infer<typeof SurfaceMapSchema> {
  return { schedules: true, scout: true, enforcement: true };
}

function defaultState(at: string): RollbackDurableState {
  return {
    schema_version: 1,
    surfaces: defaultSurfaces(),
    updated_at: at,
  };
}

async function readState(root: string, at: string): Promise<RollbackDurableState> {
  const raw = await readJsonIfExists<unknown>(statePath(root));
  if (raw === undefined) return defaultState(at);
  const parsed = DurableStateSchema.safeParse(raw);
  if (!parsed.success) throw new Error("rollback_state_invalid");
  return parsed.data;
}

async function writeState(root: string, state: RollbackDurableState): Promise<void> {
  await writeJsonAtomic(statePath(root), state);
}

async function readBaseline(root: string, baselineId: string): Promise<RollbackBaseline> {
  const raw = await readJsonIfExists<unknown>(baselinePath(root, baselineId));
  const parsed = BaselineSchema.safeParse(raw);
  if (!parsed.success) throw new Error("rollback_baseline_missing");
  return parsed.data;
}

async function writeBaseline(root: string, baseline: RollbackBaseline): Promise<void> {
  await fs.mkdir(baselinesDir(root), { recursive: true });
  await writeJsonAtomic(baselinePath(root, baseline.baseline_id), baseline);
}

const EVIDENCE_GLOBS: ReadonlyArray<{ prefix: string; recursive: boolean }> = [
  { prefix: path.join(HARNESS_DIR_NAME, "autonomy", "missed-slot-watchdog"), recursive: true },
  { prefix: path.join(HARNESS_DIR_NAME, "autonomy", "events"), recursive: true },
  { prefix: path.join(HARNESS_DIR_NAME, "autonomy", "deed-pointers"), recursive: true },
  { prefix: path.join(HARNESS_DIR_NAME, "autonomy", "pm-scheduler-origins"), recursive: true },
];

async function walkFiles(absDir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await fs.readdir(absDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const full = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      out.push(...await walkFiles(full));
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

export async function collectEvidenceInventory(
  root: string,
): Promise<Array<{ relative_path: string; sha256: string }>> {
  const inventory: Array<{ relative_path: string; sha256: string }> = [];
  for (const spec of EVIDENCE_GLOBS) {
    const abs = path.join(root, spec.prefix);
    const files = spec.recursive ? await walkFiles(abs) : [];
    if (!spec.recursive) {
      try {
        const st = await fs.stat(abs);
        if (st.isFile()) files.push(abs);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    for (const file of files) {
      const bytes = await fs.readFile(file);
      inventory.push({
        relative_path: path.relative(root, file).split(path.sep).join("/"),
        sha256: sha(bytes),
      });
    }
  }
  inventory.sort((a, b) => a.relative_path.localeCompare(b.relative_path));
  return inventory;
}

export async function evidenceInventoryRetained(
  root: string,
  expected: Array<{ relative_path: string; sha256: string }>,
): Promise<boolean> {
  const current = await collectEvidenceInventory(root);
  const byPath = new Map(current.map((entry) => [entry.relative_path, entry.sha256]));
  for (const entry of expected) {
    if (byPath.get(entry.relative_path) !== entry.sha256) return false;
  }
  return true;
}

async function readPackageJson(root: string): Promise<{ name: string; version: string; raw: string }> {
  const file = path.join(root, "package.json");
  const raw = await fs.readFile(file, "utf8");
  const parsed = z.object({
    name: z.string().min(1),
    version: z.string().min(1),
  }).passthrough().safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("rollback_package_json_invalid");
  return { name: parsed.data.name, version: parsed.data.version, raw };
}

function fingerprintPackage(name: string, version: string, raw: string): string {
  return sha(`${name}\n${version}\n${raw}`);
}

async function resolveApprovedInstalledVersion(root: string): Promise<{
  approved: ApprovedInstalledVersion;
  package_json: string;
}> {
  const pkg = await readPackageJson(root);
  return {
    approved: {
      package_name: pkg.name,
      package_version: pkg.version,
      source_fingerprint: fingerprintPackage(pkg.name, pkg.version, pkg.raw),
    },
    package_json: pkg.raw,
  };
}

async function restorePackageJson(root: string, packageJson: string): Promise<void> {
  // Preserve exact baseline package.json bytes (not re-serialized).
  const file = path.join(root, "package.json");
  const temp = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temp, packageJson, "utf8");
  await fs.rename(temp, file);
}

function toStatus(
  state: RollbackDurableState,
  evidenceRetained: boolean,
): RollbackStatus {
  return {
    surfaces: { ...state.surfaces },
    ...(state.active_baseline_id ? { active_baseline_id: state.active_baseline_id } : {}),
    ...(state.approved_installed_version
      ? { approved_installed_version: state.approved_installed_version }
      : {}),
    evidence_retained: evidenceRetained,
  };
}

export async function captureRollbackBaseline(
  root: string,
  clock: RollbackClock = {},
): Promise<RollbackBaseline> {
  const at = (clock.now ?? (() => new Date().toISOString()))();
  return withCoordinationLease(root, "enforcement-rollback", async () => {
    const state = await readState(root, at);
    const { approved, package_json } = await resolveApprovedInstalledVersion(root);
    const evidence_inventory = await collectEvidenceInventory(root);
    const baseline: RollbackBaseline = {
      schema_version: 1,
      baseline_id: `baseline-${sha(at).slice(0, 16)}`,
      captured_at: at,
      approved_installed_version: approved,
      surfaces: { ...state.surfaces },
      evidence_inventory,
      package_json,
    };
    await writeBaseline(root, baseline);
    const next: RollbackDurableState = {
      ...state,
      active_baseline_id: baseline.baseline_id,
      approved_installed_version: approved,
      updated_at: at,
    };
    await writeState(root, next);
    await appendJsonl(eventsPath(root), {
      at,
      kind: "baseline",
      baseline_id: baseline.baseline_id,
      approved_installed_version: approved,
    });
    return baseline;
  });
}

async function ensureBaseline(
  root: string,
  state: RollbackDurableState,
  at: string,
): Promise<{ state: RollbackDurableState; baseline: RollbackBaseline }> {
  if (state.active_baseline_id) {
    return { state, baseline: await readBaseline(root, state.active_baseline_id) };
  }
  const { approved, package_json } = await resolveApprovedInstalledVersion(root);
  const evidence_inventory = await collectEvidenceInventory(root);
  const baseline: RollbackBaseline = {
    schema_version: 1,
    baseline_id: `baseline-${sha(at).slice(0, 16)}`,
    captured_at: at,
    approved_installed_version: approved,
    surfaces: { ...state.surfaces },
    evidence_inventory,
    package_json,
  };
  await writeBaseline(root, baseline);
  const next: RollbackDurableState = {
    ...state,
    active_baseline_id: baseline.baseline_id,
    approved_installed_version: approved,
    updated_at: at,
  };
  await writeState(root, next);
  await appendJsonl(eventsPath(root), {
    at,
    kind: "baseline",
    baseline_id: baseline.baseline_id,
    approved_installed_version: approved,
    auto: true,
  });
  return { state: next, baseline };
}

export async function disableRollbackSurface(
  root: string,
  surfaceInput: RollbackSurface,
  clock: RollbackClock = {},
): Promise<RollbackStatus> {
  const surface = parseSurface(surfaceInput);
  const at = (clock.now ?? (() => new Date().toISOString()))();
  return withCoordinationLease(root, "enforcement-rollback", async () => {
    const initial = await readState(root, at);
    const { state, baseline } = await ensureBaseline(root, initial, at);
    const surfaces = { ...state.surfaces, [surface]: false };
    const next: RollbackDurableState = {
      ...state,
      surfaces,
      approved_installed_version: baseline.approved_installed_version,
      updated_at: at,
    };
    await writeState(root, next);
    await appendJsonl(eventsPath(root), {
      at,
      kind: "disable",
      surface,
      baseline_id: baseline.baseline_id,
    });
    const retained = await evidenceInventoryRetained(root, baseline.evidence_inventory);
    return toStatus(next, retained);
  });
}

export async function reEnableRollbackSurface(
  root: string,
  surfaceInput: RollbackSurface,
  clock: RollbackClock = {},
): Promise<RollbackStatus> {
  const surface = parseSurface(surfaceInput);
  const at = (clock.now ?? (() => new Date().toISOString()))();
  return withCoordinationLease(root, "enforcement-rollback", async () => {
    const state = await readState(root, at);
    if (!state.active_baseline_id) throw new Error("rollback_baseline_missing");
    const baseline = await readBaseline(root, state.active_baseline_id);
    await restorePackageJson(root, baseline.package_json);
    const surfaces = {
      ...state.surfaces,
      [surface]: baseline.surfaces[surface],
    };
    const next: RollbackDurableState = {
      ...state,
      surfaces,
      approved_installed_version: baseline.approved_installed_version,
      updated_at: at,
    };
    await writeState(root, next);
    await appendJsonl(eventsPath(root), {
      at,
      kind: "re-enable",
      surface,
      baseline_id: baseline.baseline_id,
      approved_installed_version: baseline.approved_installed_version,
    });
    const retained = await evidenceInventoryRetained(root, baseline.evidence_inventory);
    return toStatus(next, retained);
  });
}

export async function rollbackStatus(root: string, clock: RollbackClock = {}): Promise<RollbackStatus> {
  const at = (clock.now ?? (() => new Date().toISOString()))();
  const state = await readState(root, at);
  let retained = true;
  if (state.active_baseline_id) {
    const baseline = await readBaseline(root, state.active_baseline_id);
    retained = await evidenceInventoryRetained(root, baseline.evidence_inventory);
  }
  return toStatus(state, retained);
}

export async function isRollbackSurfaceEnabled(
  root: string,
  surfaceInput: RollbackSurface,
): Promise<boolean> {
  const surface = parseSurface(surfaceInput);
  const status = await rollbackStatus(root);
  return status.surfaces[surface];
}

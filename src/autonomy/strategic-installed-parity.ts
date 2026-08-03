import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { STRATEGIC_ACTION_SELECTOR_OPERATIONS } from "./strategic-action.js";

const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

export const STRATEGIC_INSTALLED_ASSET_PATHS = [
  "config/strategic-review-profiles.json",
  "config/strategic-review-origins.json",
  "skills/autonomous-harness/SKILL.md",
  "skills/autonomous-harness/references/strategic-review-operator.md",
  "scripts/strategic-installed-canary.mjs",
  "fixtures/strategic-review-canary/pm-normal.json",
  "fixtures/strategic-review-canary/pm-snapshot.json",
  "fixtures/strategic-review-canary/nightly-workspace-normal.json",
  "fixtures/strategic-review-canary/operations-normal.json",
  "fixtures/strategic-review-canary/optional-domain-normal.json",
] as const;

export type StrategicInstalledAssetPath = typeof STRATEGIC_INSTALLED_ASSET_PATHS[number];

const CapabilitySchema = z.enum(STRATEGIC_ACTION_SELECTOR_OPERATIONS);

const ProfileSchema = z.object({
  profile: z.string().min(1),
  domain: z.string().min(1),
  proof: z.string().min(1),
  recurrence_threshold: z.number().int().positive(),
  enabled_by_default: z.boolean(),
  capabilities: z.array(CapabilitySchema).length(5),
}).strict().superRefine((value, context) => {
  const expected = [...STRATEGIC_ACTION_SELECTOR_OPERATIONS];
  if (!expected.every((capability, index) => value.capabilities[index] === capability)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "capabilities must match installation-owned fixed set" });
  }
  if (value.proof !== `strategic-review/v1/${value.profile}/${value.domain}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "proof must match strategic-review/v1/<profile>/<domain>" });
  }
});

const ProfileCatalogSchema = z.object({
  schema_version: z.literal(1),
  profiles: z.array(ProfileSchema).length(4),
  forbidden_capability_expansion: z.literal(true),
  forbidden_operations: z.array(z.string().min(1)).min(1),
}).strict().superRefine((value, context) => {
  const ids = value.profiles.map((profile) => profile.profile);
  if (new Set(ids).size !== ids.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "profiles must be unique" });
  }
  for (const required of ["pm-17:00", "nightly-workspace", "operations-cron-output", "optional-domain"]) {
    if (!ids.includes(required)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `missing required profile ${required}` });
    }
  }
  for (const forbidden of [
    "schedule", "delivery", "provider_lifecycle", "merge", "push", "commit", "history_mutation",
  ]) {
    if (!value.forbidden_operations.includes(forbidden)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: `missing forbidden operation ${forbidden}` });
    }
  }
});

export type StrategicReviewProfileCatalog = z.infer<typeof ProfileCatalogSchema>;
export type StrategicReviewInstalledProfile = z.infer<typeof ProfileSchema>;

export interface StrategicInstalledParityRow {
  relative_path: StrategicInstalledAssetPath;
  source_sha256: string;
  projected_sha256: string;
  match: boolean;
}

export interface StrategicInstalledParityReport {
  ok: boolean;
  reason_code: "INSTALLED_PARITY_OK" | "INSTALLED_PARITY_MISMATCH" | "PROFILE_CATALOG_INVALID";
  rows: StrategicInstalledParityRow[];
  profiles: StrategicReviewInstalledProfile[];
}

async function nearestPackageRoot(startFile: string): Promise<string> {
  let current = path.dirname(startFile);
  for (;;) {
    try {
      const stat = await fs.lstat(path.join(current, "package.json"));
      if (stat.isFile() && !stat.isSymbolicLink()) return current;
    } catch {
      // continue
    }
    const parent = path.dirname(current);
    if (parent === current) throw new Error("strategic_installed_package_root_missing");
    current = parent;
  }
}

/** Resolve the source plugin root (repo `plugin/`) from this module. */
export async function sourcePluginRoot(moduleUrl = import.meta.url): Promise<string> {
  const packageRoot = await nearestPackageRoot(fileURLToPath(moduleUrl));
  const sourcePlugin = path.join(packageRoot, "plugin");
  const stat = await fs.lstat(sourcePlugin);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("strategic_installed_source_plugin_missing");
  return sourcePlugin;
}

/** Resolve an installed/projected plugin root that contains `.cursor-plugin/plugin.json`. */
export async function projectedPluginRoot(candidateRoot: string): Promise<string> {
  const marker = path.join(candidateRoot, ".cursor-plugin", "plugin.json");
  const stat = await fs.lstat(marker);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("strategic_installed_projected_plugin_missing");
  return candidateRoot;
}

export async function loadStrategicReviewProfileCatalog(pluginRoot: string): Promise<StrategicReviewProfileCatalog> {
  const file = path.join(pluginRoot, "config", "strategic-review-profiles.json");
  const raw = await fs.readFile(file, "utf8");
  const parsed = ProfileCatalogSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) throw new Error("PROFILE_CATALOG_INVALID");
  return parsed.data;
}

export async function assertStrategicReviewProfileCapabilities(
  pluginRoot: string,
  profileId: string,
  requested: readonly string[],
): Promise<{ ok: true; profile: StrategicReviewInstalledProfile } | { ok: false; reason_code: "ACTION_NOT_AUTHORIZED" | "PROFILE_NOT_INSTALLED" }> {
  const catalog = await loadStrategicReviewProfileCatalog(pluginRoot);
  const profile = catalog.profiles.find((candidate) => candidate.profile === profileId);
  if (!profile) return { ok: false, reason_code: "PROFILE_NOT_INSTALLED" };
  if (!catalog.forbidden_capability_expansion) return { ok: false, reason_code: "ACTION_NOT_AUTHORIZED" };
  if (requested.length !== profile.capabilities.length
    || !profile.capabilities.every((capability, index) => requested[index] === capability)) {
    return { ok: false, reason_code: "ACTION_NOT_AUTHORIZED" };
  }
  return { ok: true, profile };
}

export async function compareStrategicInstalledParity(
  sourcePlugin: string,
  projectedPlugin: string,
): Promise<StrategicInstalledParityReport> {
  let catalog: StrategicReviewProfileCatalog;
  try {
    catalog = await loadStrategicReviewProfileCatalog(sourcePlugin);
    const projectedCatalog = await loadStrategicReviewProfileCatalog(projectedPlugin);
    if (JSON.stringify(catalog) !== JSON.stringify(projectedCatalog)) {
      return {
        ok: false,
        reason_code: "INSTALLED_PARITY_MISMATCH",
        rows: [],
        profiles: catalog.profiles,
      };
    }
  } catch {
    return { ok: false, reason_code: "PROFILE_CATALOG_INVALID", rows: [], profiles: [] };
  }

  const rows: StrategicInstalledParityRow[] = [];
  for (const relative of STRATEGIC_INSTALLED_ASSET_PATHS) {
    const sourceBytes = await fs.readFile(path.join(sourcePlugin, relative));
    const projectedBytes = await fs.readFile(path.join(projectedPlugin, relative));
    const sourceSha = sha(sourceBytes);
    const projectedSha = sha(projectedBytes);
    rows.push({
      relative_path: relative,
      source_sha256: sourceSha,
      projected_sha256: projectedSha,
      match: sourceSha === projectedSha,
    });
  }
  const ok = rows.every((row) => row.match);
  return {
    ok,
    reason_code: ok ? "INSTALLED_PARITY_OK" : "INSTALLED_PARITY_MISMATCH",
    rows,
    profiles: catalog.profiles,
  };
}

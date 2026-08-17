import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import type { CliContext } from "./context.js";
import { ensureDir, fileExists } from "../state/io.js";
import { PLUGIN_NAME } from "../branding.js";

export type AuditStatus = "ok" | "missing" | "stale" | "n/a";

export interface AuditItem {
  path: string;
  status: AuditStatus;
}

export interface InstallAudit {
  user_skill: AuditItem[];
  project_skill: AuditItem[];
  project_rule?: AuditItem;
  user_agents: AuditItem[];
  project_agents: AuditItem[];
  cursor_plugin: AuditItem[];
  codex_plugin: AuditItem[];
  codex_marketplace: AuditItem;
  codex_plugin_enabled: AuditItem;
  opencode_skill: AuditItem[];
  opencode_config: AuditItem;
  /** Presence of user-installed mattpocock-skills (Claude Code plugin). */
  mattpocock_skills: AuditItem;
  /** Presence of user-installed ralph-loop (Claude Code official plugin). */
  ralph_loop: AuditItem;
  /** Presence of user-installed caveman (JuliusBrussee/caveman Claude Code plugin). */
  caveman: AuditItem;
  /** Presence of user-installed ponytail (DietrichGebert/ponytail Cursor/Claude plugin). */
  ponytail: AuditItem;
}

export interface InstallScopeOptions {
  user?: boolean;
  project?: boolean;
  force?: boolean;
  skillOnly?: boolean;
  ruleOnly?: boolean;
  sourceRoot?: string;
}

export interface ClientSyncOptions {
  cursor?: boolean;
  codex?: boolean;
  opencode?: boolean;
  claude?: boolean;
  /** Prefer GitHub marketplace (johnyuen/harness) over local checkout for Claude. */
  claudeGit?: boolean;
  /** Git ref (branch/tag) when using Claude GitHub marketplace. Defaults to master. */
  claudeRef?: string;
  force?: boolean;
  sourceRoot?: string;
  refreshCodexCache?: boolean;
}

interface ResolvedSource {
  root: string;
  cleanup?: () => Promise<void>;
}

/** Harness-owned skills copied to user/project/opencode skill roots. */
const HARNESS_SKILL_DIRS = [
  "ycm-harness",
  "ycm-harness-design",
  "ycm-harness-work-lite",
  "autonomous-harness",
  "hard-problem-solving",
  "llm-wiki",
  "commander",
  "building-ios-ipa-sideloadly",
  "deploying-to-mumu-emulator",
  "plan-and-advance",
  "pull-tickets",
  "summarizing-goal-achievement",
  "setup-autonomy-p1-p7",
  "run-technical-design-discussion",
  "merge-branches-to-master",
  "create-skill",
  "migrate-multica-to-github-projects",
] as const;

/** Dest skill dir name ??plugin/skills source dir (when they differ). */
const HARNESS_SKILL_SOURCE: Partial<
  Record<(typeof HARNESS_SKILL_DIRS)[number], string>
> = {
  "ycm-harness": "ycm-harness-work",
};

function harnessSkillSourceDir(
  skillDir: (typeof HARNESS_SKILL_DIRS)[number],
): string {
  return HARNESS_SKILL_SOURCE[skillDir] ?? skillDir;
}

/**
 * Formerly vendored Matt Pocock skills. No longer shipped in this repo ??
 * resolve from the user's `mattpocock-skills` Claude Code plugin instead.
 * Sync/install prune stale copies from managed Cursor/OpenCode skill roots.
 */
const EXTERNAL_MATTOCK_SKILL_DIRS = [
  "grill-me",
  "grill-with-docs",
  "grilling",
  "domain-modeling",
  "tdd",
  "improve-codebase-architecture",
  "codebase-design",
  "to-spec",
  "to-tickets",
  "wayfinder",
] as const;

const MATTOCK_PLUGIN_KEY = "mattpocock-skills@mattpocock";
const MATTOCK_MARKETPLACE = "mattpocock";
const MATTOCK_GITHUB = "mattpocock/skills";
const RALPH_PLUGIN_KEY = "ralph-loop@claude-plugins-official";
const RALPH_MARKETPLACE = "claude-plugins-official";
const RALPH_PLUGIN_DIR = "ralph-loop";
/**
 * Formerly vendored JuliusBrussee/caveman skills. No longer shipped ??
 * resolve from the user's `caveman@caveman` Claude Code plugin instead.
 */
const EXTERNAL_CAVEMAN_SKILL_DIRS = [
  "caveman",
  "caveman-commit",
  "caveman-compress",
  "caveman-help",
  "caveman-review",
  "caveman-stats",
  "cavecrew",
] as const;
const CAVEMAN_PLUGIN_KEY = "caveman@caveman";
const CAVEMAN_MARKETPLACE = "caveman";
const CAVEMAN_PLUGIN_DIR = "caveman";
const CAVEMAN_GITHUB = "JuliusBrussee/caveman";
const PONYTAIL_PLUGIN_KEY = "ponytail@ponytail";
const PONYTAIL_MARKETPLACE = "ponytail";
const PONYTAIL_PLUGIN_DIR = "ponytail";
const PONYTAIL_GITHUB = "DietrichGebert/ponytail";

/**
 * Pre-rebrand skill dest folders to prune from managed install trees.
 * Current dest `ycm-harness` (via HARNESS_SKILL_SOURCE) must not be listed here.
 */
const LEGACY_WORK_SKILL_DIRS = [
  "cursor-harness",
  "cursor-harness-work",
  "cursor-harness-design",
  "cursor-harness-work-lite",
] as const;
const LEGACY_AGENT_DIRS = ["cursor-harness"] as const;
const CODEX_MARKETPLACE_NAME = "ycm-harness-local";
const CODEX_PLUGIN_KEY = `${PLUGIN_NAME}@${CODEX_MARKETPLACE_NAME}`;
const OPENCODE_PLUGIN_GIT_REMOTE = `${PLUGIN_NAME}@git+https://github.com/johnyuen/harness.git`;
/** Claude Code marketplace name (must match `.claude-plugin/marketplace.json`). */
const CLAUDE_MARKETPLACE_NAME = "harness";
const CLAUDE_PLUGIN_KEY = `${PLUGIN_NAME}@${CLAUDE_MARKETPLACE_NAME}`;
const CLAUDE_GITHUB_REPO = "johnyuen/harness";
const CLAUDE_DEFAULT_REF = "master";
const RUNTIME_DEPENDENCIES = ["commander", "zod"] as const;

export function packageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..");
}

export function homeDir(): string {
  return (
    process.env.YCM_HARNESS_HOME ??
    process.env.HOME ??
    process.env.USERPROFILE ??
    os.homedir()
  );
}

function cursorHome(): string {
  return path.join(homeDir(), ".cursor");
}

function codexHome(): string {
  return path.join(homeDir(), ".codex");
}

function opencodeHome(): string {
  return path.join(homeDir(), ".config", "opencode");
}

function claudeHome(): string {
  return path.join(homeDir(), ".claude");
}

function claudeSettingsPath(): string {
  return path.join(claudeHome(), "settings.json");
}

export function claudeMarketplaceSource(
  sourceRoot: string,
  opts?: { useGit?: boolean; ref?: string },
): string {
  if (opts?.useGit) {
    const ref = (opts.ref ?? CLAUDE_DEFAULT_REF).trim();
    return ref && ref !== CLAUDE_DEFAULT_REF
      ? `${CLAUDE_GITHUB_REPO}#${ref}`
      : CLAUDE_GITHUB_REPO;
  }
  return path.resolve(sourceRoot);
}

function opencodeConfigPath(): string {
  return path.join(opencodeHome(), "opencode.json");
}

export function opencodePluginSpec(sourceRoot: string): string {
  const normalized = sourceRoot.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) {
    return `${PLUGIN_NAME}@file:${normalized}`;
  }
  return OPENCODE_PLUGIN_GIT_REMOTE;
}

async function opencodePluginSpecForSource(
  sourceRoot: string,
): Promise<string> {
  if (
    await fileExists(
      path.join(sourceRoot, ".opencode", "plugins", "ycm-harness.js"),
    )
  ) {
    return opencodePluginSpec(sourceRoot);
  }
  return OPENCODE_PLUGIN_GIT_REMOTE;
}

function relativeFiles(root: string): Promise<string[]> {
  return collectRelativeFiles(root, "");
}

async function collectRelativeFiles(
  root: string,
  prefix: string,
): Promise<string[]> {
  if (!(await fileExists(root))) return [];
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const rel = prefix ? path.join(prefix, entry.name) : entry.name;
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectRelativeFiles(full, rel)));
      continue;
    }
    files.push(rel);
  }
  return files.sort();
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return left.equals(right);
  } catch {
    return false;
  }
}

async function auditFile(expected: string, actual: string): Promise<AuditItem> {
  if (!(await fileExists(actual))) return { path: actual, status: "missing" };
  return {
    path: actual,
    status: (await sameFile(expected, actual)) ? "ok" : "stale",
  };
}

async function auditTree(
  expectedRoot: string,
  actualRoot: string,
): Promise<AuditItem[]> {
  const files = await relativeFiles(expectedRoot);
  const items: AuditItem[] = [];
  for (const rel of files) {
    items.push(
      await auditFile(path.join(expectedRoot, rel), path.join(actualRoot, rel)),
    );
  }
  return items;
}

function countDrift(items: AuditItem[]): number {
  return items.filter((item) => item.status !== "ok" && item.status !== "n/a")
    .length;
}

async function copyFileManaged(
  src: string,
  dest: string,
  force: boolean,
): Promise<"installed" | "updated" | "skipped"> {
  await ensureDir(path.dirname(dest));
  const exists = await fileExists(dest);
  if (exists) {
    if (await sameFile(src, dest)) return "skipped";
    if (!force) return "skipped";
  }
  await fs.copyFile(src, dest);
  return exists ? "updated" : "installed";
}

async function copyTreeManaged(
  srcRoot: string,
  destRoot: string,
  force: boolean,
): Promise<{ installed: number; updated: number; skipped: number }> {
  const files = await relativeFiles(srcRoot);
  let installed = 0;
  let updated = 0;
  let skipped = 0;
  for (const rel of files) {
    const result = await copyFileManaged(
      path.join(srcRoot, rel),
      path.join(destRoot, rel),
      force,
    );
    if (result === "installed") installed += 1;
    else if (result === "updated") updated += 1;
    else skipped += 1;
  }
  return { installed, updated, skipped };
}

async function copyManagedAgents(
  pluginRoot: string,
  destRoot: string,
  force: boolean,
): Promise<{ installed: number; updated: number; skipped: number }> {
  const srcRoot = path.join(pluginRoot, "agents");
  const result = await copyTreeManaged(srcRoot, destRoot, force);
  if (force) {
    await pruneRetiredFiles(destRoot, new Set(await relativeFiles(srcRoot)));
  }
  return result;
}

async function pruneRetiredFiles(
  destRoot: string,
  expectedFiles: ReadonlySet<string>,
): Promise<void> {
  for (const rel of await relativeFiles(destRoot)) {
    if (!expectedFiles.has(rel)) {
      await fs.rm(path.join(destRoot, rel), { force: true });
    }
  }
}

async function removeManagedSymlinks(root: string): Promise<void> {
  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
  if (rootStat.isSymbolicLink()) {
    await fs.unlink(root);
    return;
  }
  if (!rootStat.isDirectory()) return;
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const target = path.join(root, entry.name);
    if (entry.isSymbolicLink()) {
      await fs.unlink(target);
    } else if (entry.isDirectory()) {
      await removeManagedSymlinks(target);
    }
  }
}

function renderTreeReport(
  label: string,
  result: { installed: number; updated: number; skipped: number },
): string {
  return `${label}: installed ${result.installed}, updated ${result.updated}, skipped ${result.skipped}`;
}

async function pruneLegacyWorkSkillDirs(
  destSkillsRoot: string,
  force: boolean,
): Promise<number> {
  // Dest `ycm-harness` is intentional via HARNESS_SKILL_SOURCE; only prune
  // when the dest is not a current harness skill.
  let removed = 0;
  for (const legacyDir of LEGACY_WORK_SKILL_DIRS) {
    if ((HARNESS_SKILL_DIRS as readonly string[]).includes(legacyDir)) continue;
    const target = path.join(destSkillsRoot, legacyDir);
    if (!(await fileExists(target))) continue;
    if (!force) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function pruneLegacyAgentDirs(
  destAgentsRoot: string,
  force: boolean,
): Promise<number> {
  let removed = 0;
  for (const legacyDir of LEGACY_AGENT_DIRS) {
    const target = path.join(destAgentsRoot, legacyDir);
    if (!(await fileExists(target))) continue;
    if (!force) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

async function reportLegacyAgentPrunes(
  label: string,
  destAgentsRoot: string,
  force: boolean,
): Promise<string[]> {
  const removed = await pruneLegacyAgentDirs(destAgentsRoot, force);
  return removed > 0 ? [`${label} legacy agents pruned: ${removed}`] : [];
}

/** Doctor --repair: remove leftover pre-rebrand agent dirs even when project force is off. */
export async function repairLegacyAgentDirs(cwd: string): Promise<string[]> {
  return [
    ...(await reportLegacyAgentPrunes(
      "cursor user",
      path.join(cursorHome(), "agents"),
      true,
    )),
    ...(await reportLegacyAgentPrunes(
      "project",
      path.join(cwd, ".cursor", "agents"),
      true,
    )),
  ];
}

async function staleLegacyAgentItems(
  destAgentsRoot: string,
): Promise<AuditItem[]> {
  const items: AuditItem[] = [];
  for (const legacyDir of LEGACY_AGENT_DIRS) {
    const target = path.join(destAgentsRoot, legacyDir);
    if (await fileExists(target)) {
      items.push({ path: target, status: "stale" });
    }
  }
  return items;
}

async function pruneStalePluginWorkSkillDir(
  pluginInstallRoot: string,
  force: boolean,
): Promise<number> {
  let removed = 0;
  for (const legacyDir of LEGACY_WORK_SKILL_DIRS) {
    const target = path.join(pluginInstallRoot, "skills", legacyDir);
    if (!(await fileExists(target))) continue;
    if (!force) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Remove formerly-vendored Matt Pocock skill dirs from a managed skills root. */
async function pruneExternalMattPocockSkillDirs(
  destSkillsRoot: string,
  force: boolean,
): Promise<number> {
  let removed = 0;
  for (const skillDir of EXTERNAL_MATTOCK_SKILL_DIRS) {
    const target = path.join(destSkillsRoot, skillDir);
    if (!(await fileExists(target))) continue;
    if (!force) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Remove formerly-vendored Caveman skill dirs from a managed skills root. */
async function pruneExternalCavemanSkillDirs(
  destSkillsRoot: string,
  force: boolean,
): Promise<number> {
  let removed = 0;
  for (const skillDir of EXTERNAL_CAVEMAN_SKILL_DIRS) {
    const target = path.join(destSkillsRoot, skillDir);
    if (!(await fileExists(target))) continue;
    if (!force) continue;
    await fs.rm(target, { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/**
 * Locate the user's mattpocock-skills Claude Code plugin (cache or marketplace clone).
 * Returns the plugin root that contains `skills/engineering/` and `skills/productivity/`.
 */
export async function resolveMattPocockSkillsRoot(
  home = homeDir(),
): Promise<string | undefined> {
  const cacheRoot = path.join(home, ".claude", "plugins", "cache", MATTOCK_MARKETPLACE);
  if (await fileExists(cacheRoot)) {
    try {
      const plugins = await fs.readdir(cacheRoot, { withFileTypes: true });
      for (const entry of plugins) {
        if (!entry.isDirectory()) continue;
        const versions = await fs.readdir(path.join(cacheRoot, entry.name), {
          withFileTypes: true,
        });
        const versionDirs = versions
          .filter((v) => v.isDirectory())
          .map((v) => v.name)
          .sort()
          .reverse();
        for (const ver of versionDirs) {
          const candidate = path.join(cacheRoot, entry.name, ver);
          if (
            await fileExists(path.join(candidate, "skills", "engineering"))
          ) {
            return candidate;
          }
        }
      }
    } catch {
      /* fall through */
    }
  }

  const marketplace = path.join(
    home,
    ".claude",
    "plugins",
    "marketplaces",
    MATTOCK_MARKETPLACE,
  );
  if (await fileExists(path.join(marketplace, "skills", "engineering"))) {
    return marketplace;
  }
  return undefined;
}

export async function auditMattPocockSkills(
  home = homeDir(),
): Promise<AuditItem> {
  const root = await resolveMattPocockSkillsRoot(home);
  if (root) {
    return { path: root, status: "ok" };
  }
  const expected = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    MATTOCK_MARKETPLACE,
    "mattpocock-skills",
  );
  const claudePresent = await fileExists(path.join(home, ".claude"));
  return {
    path: expected,
    status: claudePresent ? "missing" : "n/a",
  };
}

export function mattPocockInstallHint(): string {
  return (
    `Matt Pocock skills are NOT bundled. Install the Claude Code plugin: ` +
    `claude plugin marketplace add ${MATTOCK_GITHUB} && ` +
    `claude plugin install ${MATTOCK_PLUGIN_KEY} ` +
    `(or /plugin marketplace add ${MATTOCK_GITHUB} then install mattpocock-skills). ` +
    `Then run /setup-matt-pocock-skills once.`
  );
}

export async function resolveRalphLoopRoot(
  home = homeDir(),
): Promise<string | undefined> {
  const cache = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    RALPH_MARKETPLACE,
    RALPH_PLUGIN_DIR,
  );
  if (await fileExists(cache)) {
    try {
      const versions = await fs.readdir(cache, { withFileTypes: true });
      const versionDirs = versions
        .filter((v) => v.isDirectory())
        .map((v) => v.name)
        .sort()
        .reverse();
      for (const ver of versionDirs) {
        const candidate = path.join(cache, ver);
        if (
          (await fileExists(path.join(candidate, "commands", "ralph-loop.md"))) ||
          (await fileExists(path.join(candidate, ".claude-plugin", "plugin.json")))
        ) {
          return candidate;
        }
      }
    } catch {
      /* fall through */
    }
  }
  const marketplace = path.join(
    home,
    ".claude",
    "plugins",
    "marketplaces",
    RALPH_MARKETPLACE,
    "plugins",
    RALPH_PLUGIN_DIR,
  );
  if (
    (await fileExists(path.join(marketplace, "commands", "ralph-loop.md"))) ||
    (await fileExists(path.join(marketplace, ".claude-plugin", "plugin.json")))
  ) {
    return marketplace;
  }
  return undefined;
}

export async function auditRalphLoop(home = homeDir()): Promise<AuditItem> {
  const root = await resolveRalphLoopRoot(home);
  if (root) return { path: root, status: "ok" };
  const expected = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    RALPH_MARKETPLACE,
    RALPH_PLUGIN_DIR,
  );
  const claudePresent = await fileExists(path.join(home, ".claude"));
  return {
    path: expected,
    status: claudePresent ? "missing" : "n/a",
  };
}

export function ralphLoopInstallHint(): string {
  return (
    `Ralph is NOT bundled. Install the Claude Code plugin: ` +
    `claude plugin install ${RALPH_PLUGIN_KEY} ` +
    `(from anthropics/claude-plugins-official). Then use /ralph-loop during harness execute.`
  );
}

/**
 * Locate the user's caveman Claude Code plugin (cache or marketplace clone).
 * Returns the plugin root that contains `skills/caveman/`.
 */
export async function resolveCavemanRoot(
  home = homeDir(),
): Promise<string | undefined> {
  const cache = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    CAVEMAN_MARKETPLACE,
    CAVEMAN_PLUGIN_DIR,
  );
  if (await fileExists(cache)) {
    try {
      const versions = await fs.readdir(cache, { withFileTypes: true });
      const versionDirs = versions
        .filter((v) => v.isDirectory())
        .map((v) => v.name)
        .sort()
        .reverse();
      for (const ver of versionDirs) {
        const candidate = path.join(cache, ver);
        if (
          (await fileExists(path.join(candidate, "skills", "caveman"))) ||
          (await fileExists(
            path.join(candidate, ".claude-plugin", "plugin.json"),
          ))
        ) {
          return candidate;
        }
      }
    } catch {
      /* fall through */
    }
  }
  const marketplace = path.join(
    home,
    ".claude",
    "plugins",
    "marketplaces",
    CAVEMAN_MARKETPLACE,
  );
  if (
    (await fileExists(path.join(marketplace, "skills", "caveman"))) ||
    (await fileExists(
      path.join(marketplace, ".claude-plugin", "plugin.json"),
    ))
  ) {
    return marketplace;
  }
  return undefined;
}

export async function auditCaveman(home = homeDir()): Promise<AuditItem> {
  const root = await resolveCavemanRoot(home);
  if (root) return { path: root, status: "ok" };
  const expected = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    CAVEMAN_MARKETPLACE,
    CAVEMAN_PLUGIN_DIR,
  );
  const claudePresent = await fileExists(path.join(home, ".claude"));
  return {
    path: expected,
    status: claudePresent ? "missing" : "n/a",
  };
}

export function cavemanInstallHint(): string {
  return (
    `Caveman skills are NOT bundled. Install the Claude Code plugin: ` +
    `claude plugin marketplace add ${CAVEMAN_GITHUB} && ` +
    `claude plugin install ${CAVEMAN_PLUGIN_KEY} ` +
    `(or /plugin marketplace add ${CAVEMAN_GITHUB} then install caveman). ` +
    `For Cursor: npx skills add ${CAVEMAN_GITHUB} -a cursor.`
  );
}

async function isPonytailPluginRoot(candidate: string): Promise<boolean> {
  return (
    (await fileExists(path.join(candidate, "skills", "ponytail", "SKILL.md"))) ||
    (await fileExists(path.join(candidate, ".claude-plugin", "plugin.json")))
  );
}

/** Walk cache roots that are either version dirs or marketplace/plugin/version. */
async function findNewestValidPluginRoot(
  cacheRoot: string,
  isValid: (candidate: string) => Promise<boolean>,
): Promise<string | undefined> {
  if (!(await fileExists(cacheRoot))) return undefined;
  if (await isValid(cacheRoot)) return cacheRoot;
  let entries: { name: string; isDirectory(): boolean }[];
  try {
    entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  } catch {
    return undefined;
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  for (const name of dirs) {
    const candidate = path.join(cacheRoot, name);
    if (await isValid(candidate)) return candidate;
  }
  for (const name of dirs) {
    const nestedRoot = path.join(cacheRoot, name);
    let nested: { name: string; isDirectory(): boolean }[];
    try {
      nested = await fs.readdir(nestedRoot, { withFileTypes: true });
    } catch {
      continue;
    }
    const versionDirs = nested
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
    for (const ver of versionDirs) {
      const candidate = path.join(nestedRoot, ver);
      if (await isValid(candidate)) return candidate;
    }
  }
  return undefined;
}

/**
 * Locate ponytail in Cursor plugin cache, Claude plugin cache/marketplace,
 * or Cursor rules/skills fallbacks.
 */
export async function resolvePonytailRoot(
  home = homeDir(),
): Promise<string | undefined> {
  const cursorCache = path.join(
    home,
    ".cursor",
    "plugins",
    "cache",
    PONYTAIL_MARKETPLACE,
  );
  const fromCursor = await findNewestValidPluginRoot(
    cursorCache,
    isPonytailPluginRoot,
  );
  if (fromCursor) return fromCursor;

  const claudeCache = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    PONYTAIL_MARKETPLACE,
  );
  const fromClaude = await findNewestValidPluginRoot(
    claudeCache,
    isPonytailPluginRoot,
  );
  if (fromClaude) return fromClaude;

  const marketplace = path.join(
    home,
    ".claude",
    "plugins",
    "marketplaces",
    PONYTAIL_MARKETPLACE,
  );
  if (await isPonytailPluginRoot(marketplace)) return marketplace;
  const marketplacePlugin = path.join(marketplace, "plugins", PONYTAIL_PLUGIN_DIR);
  if (await isPonytailPluginRoot(marketplacePlugin)) return marketplacePlugin;

  const cursorSkill = path.join(home, ".cursor", "skills", "ponytail");
  if (await fileExists(path.join(cursorSkill, "SKILL.md"))) return cursorSkill;

  const cursorRule = path.join(home, ".cursor", "rules", "ponytail.mdc");
  if (await fileExists(cursorRule)) return cursorRule;

  return undefined;
}

export async function auditPonytail(home = homeDir()): Promise<AuditItem> {
  const root = await resolvePonytailRoot(home);
  if (root) return { path: root, status: "ok" };
  const expected = path.join(
    home,
    ".cursor",
    "plugins",
    "cache",
    PONYTAIL_MARKETPLACE,
    PONYTAIL_PLUGIN_DIR,
  );
  const hostPresent =
    (await fileExists(path.join(home, ".cursor"))) ||
    (await fileExists(path.join(home, ".claude")));
  return {
    path: expected,
    status: hostPresent ? "missing" : "n/a",
  };
}

export function ponytailInstallHint(): string {
  return (
    `Ponytail is NOT bundled. Claude Code: ` +
    `claude plugin marketplace add ${PONYTAIL_GITHUB} && ` +
    `claude plugin install ${PONYTAIL_PLUGIN_KEY}. ` +
    `Cursor: install the ponytail plugin from the marketplace ` +
    `(or copy .cursor/rules/ponytail.mdc from ${PONYTAIL_GITHUB}).`
  );
}

async function copyHarnessSkills(
  pluginRoot: string,
  destSkillsRoot: string,
  force: boolean,
): Promise<{ installed: number; updated: number; skipped: number }> {
  const totals = { installed: 0, updated: 0, skipped: 0 };
  for (const skillDir of HARNESS_SKILL_DIRS) {
    const result = await copyTreeManaged(
      path.join(pluginRoot, "skills", harnessSkillSourceDir(skillDir)),
      path.join(destSkillsRoot, skillDir),
      force,
    );
    totals.installed += result.installed;
    totals.updated += result.updated;
    totals.skipped += result.skipped;
  }
  await pruneLegacyWorkSkillDirs(destSkillsRoot, force);
  await pruneExternalMattPocockSkillDirs(destSkillsRoot, force);
  await pruneExternalCavemanSkillDirs(destSkillsRoot, force);
  return totals;
}

async function auditHarnessSkills(
  pluginRoot: string,
  destSkillsRoot: string,
): Promise<AuditItem[]> {
  const items: AuditItem[] = [];
  for (const skillDir of HARNESS_SKILL_DIRS) {
    items.push(
      ...(await auditTree(
        path.join(pluginRoot, "skills", harnessSkillSourceDir(skillDir)),
        path.join(destSkillsRoot, skillDir),
      )),
    );
  }
  for (const legacyDir of LEGACY_WORK_SKILL_DIRS) {
    if ((HARNESS_SKILL_DIRS as readonly string[]).includes(legacyDir)) continue;
    const legacyPath = path.join(destSkillsRoot, legacyDir);
    if (await fileExists(legacyPath)) {
      items.push({ path: legacyPath, status: "stale" });
    }
  }
  for (const skillDir of EXTERNAL_MATTOCK_SKILL_DIRS) {
    const stalePath = path.join(destSkillsRoot, skillDir);
    if (await fileExists(stalePath)) {
      items.push({ path: stalePath, status: "stale" });
    }
  }
  for (const skillDir of EXTERNAL_CAVEMAN_SKILL_DIRS) {
    const stalePath = path.join(destSkillsRoot, skillDir);
    if (await fileExists(stalePath)) {
      items.push({ path: stalePath, status: "stale" });
    }
  }
  return items;
}

async function runtimeDependencyRoot(sourceRoot: string, dependency: string): Promise<string> {
  const require = createRequire(path.join(sourceRoot, "package.json"));
  let current = path.dirname(require.resolve(dependency));
  while (path.dirname(current) !== current) {
    try {
      const pkg = JSON.parse(await fs.readFile(path.join(current, "package.json"), "utf8")) as { name?: string };
      if (pkg.name === dependency) return current;
    } catch {
      // Keep walking to the dependency package root.
    }
    current = path.dirname(current);
  }
  throw new Error(`Cannot locate runtime dependency ${dependency}`);
}

async function runtimeSourceRoot(sourceRoot: string): Promise<string> {
  const candidates = [sourceRoot, packageRoot()];
  for (const root of candidates) {
    if (!(await fileExists(path.join(root, "dist", "cli", "index.js")))) continue;
    try {
      await Promise.all(RUNTIME_DEPENDENCIES.map((dependency) => runtimeDependencyRoot(root, dependency)));
      return root;
    } catch {
      // Try the next candidate that still has a built CLI.
    }
  }
  throw new Error(
    "ycm-harness dist/cli is missing; run npm run build before install/sync",
  );
}

async function installPluginProjection(
  sourceRoot: string,
  destRoot: string,
  force: boolean,
): Promise<{ installed: number; updated: number; skipped: number }> {
  if (force) {
    // Protect an idle managed tree; an adversary racing path replacement during
    // the subsequent copy remains outside this installer's safety claim.
    await removeManagedSymlinks(destRoot);
  }
  const pluginSource = path.join(sourceRoot, "plugin");
  const totals = await copyTreeManaged(pluginSource, destRoot, force);
  const runtimeSource = await runtimeSourceRoot(sourceRoot);
  const runtimeRoot = path.join(destRoot, "runtime");
  const runtimeTrees = [
    [path.join(runtimeSource, "dist"), path.join(runtimeRoot, "dist")],
    ...await Promise.all(RUNTIME_DEPENDENCIES.map(async (dependency) => [
      await runtimeDependencyRoot(runtimeSource, dependency),
      path.join(runtimeRoot, "node_modules", dependency),
    ] as const)),
  ] as const;
  for (const [source, dest] of runtimeTrees) {
    const result = await copyTreeManaged(source, dest, force);
    totals.installed += result.installed;
    totals.updated += result.updated;
    totals.skipped += result.skipped;
  }
  const pkg = await copyFileManaged(
    path.join(runtimeSource, "package.json"),
    path.join(runtimeRoot, "package.json"),
    force,
  );
  totals[pkg] += 1;
  if (force) {
    const expectedFiles = new Set(await relativeFiles(pluginSource));
    for (const [source, dest] of runtimeTrees) {
      const prefix = path.relative(destRoot, dest);
      for (const rel of await relativeFiles(source)) {
        expectedFiles.add(path.join(prefix, rel));
      }
    }
    expectedFiles.add(path.join("runtime", "package.json"));
    await pruneRetiredFiles(destRoot, expectedFiles);
  }
  return totals;
}

async function auditPluginProjection(sourceRoot: string, destRoot: string): Promise<AuditItem[]> {
  const runtimeSource = await runtimeSourceRoot(sourceRoot);
  const runtimeRoot = path.join(destRoot, "runtime");
  const items = [
    ...(await auditTree(path.join(sourceRoot, "plugin"), destRoot)),
    ...(await auditTree(path.join(runtimeSource, "dist"), path.join(runtimeRoot, "dist"))),
    await auditFile(path.join(runtimeSource, "package.json"), path.join(runtimeRoot, "package.json")),
  ];
  for (const dependency of RUNTIME_DEPENDENCIES) {
    items.push(...(await auditTree(
      await runtimeDependencyRoot(runtimeSource, dependency),
      path.join(runtimeRoot, "node_modules", dependency),
    )));
  }
  return items;
}

function codexInstallRoot(): string {
  return path.join(codexHome(), "marketplaces", PLUGIN_NAME);
}

function codexMarketplaceConfigRoot(): string {
  return path.join(codexInstallRoot(), ".agents", "plugins");
}

function codexInstalledPluginRoot(): string {
  return path.join(codexInstallRoot(), "plugins", PLUGIN_NAME);
}

function cursorInstallRoot(): string {
  return path.join(cursorHome(), "plugins", PLUGIN_NAME);
}

function codexConfigPath(): string {
  return path.join(codexHome(), "config.toml");
}

function tomlLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function marketplaceBlock(pluginRoot: string): string {
  return [
    `[marketplaces.${CODEX_MARKETPLACE_NAME}]`,
    `source_type = "local"`,
    `source = ${tomlLiteral(pluginRoot)}`,
    "",
  ].join("\n");
}

function pluginEnabledBlock(): string {
  return [`[plugins."${CODEX_PLUGIN_KEY}"]`, "enabled = true", ""].join("\n");
}

function installedCodexMarketplaceManifest(): string {
  return `${JSON.stringify(
    {
      name: CODEX_MARKETPLACE_NAME,
      interface: { displayName: "YCM Harness Local Plugins" },
      plugins: [
        {
          name: PLUGIN_NAME,
          source: {
            source: "local",
            path: "./plugins/ycm-harness",
          },
          policy: {
            installation: "AVAILABLE",
            authentication: "ON_INSTALL",
          },
          category: "Developer Tools",
        },
      ],
    },
    null,
    2,
  )}\n`;
}

async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function upsertTomlSection(raw: string, header: string, block: string): string {
  const normalized = raw.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  const headerLine = `[${header}]`;
  const start = lines.findIndex((line) => line.trim() === headerLine);

  if (start >= 0) {
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (lines[i]?.startsWith("[") === true) {
        end = i;
        break;
      }
    }
    const nextLines = [
      ...lines.slice(0, start),
      ...block.trimEnd().split("\n"),
      ...lines.slice(end),
    ];
    return `${nextLines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
  }

  const suffix =
    normalized.length > 0 && !normalized.endsWith("\n")
      ? "\n\n"
      : normalized.length > 0
        ? "\n"
        : "";
  return `${normalized}${suffix}${block}`;
}

async function ensureCodexConfig(pluginRoot: string): Promise<string[]> {
  const configPath = codexConfigPath();
  await ensureDir(path.dirname(configPath));
  const original = (await readTextIfExists(configPath)) ?? "";
  const withMarketplace = upsertTomlSection(
    original,
    `marketplaces.${CODEX_MARKETPLACE_NAME}`,
    marketplaceBlock(pluginRoot),
  );
  const next = upsertTomlSection(
    withMarketplace,
    `plugins."${CODEX_PLUGIN_KEY}"`,
    pluginEnabledBlock(),
  );
  if (next !== original) {
    await fs.writeFile(configPath, next, "utf8");
    return [`codex config: updated ${configPath}`];
  }
  return [`codex config: already up to date (${configPath})`];
}

async function runCodexPluginCommand(args: string[]): Promise<void> {
  const codexBin = process.env.CODEX_CLI_PATH || "codex";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(codexBin, args, {
      stdio: "ignore",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        HOME: homeDir(),
        USERPROFILE: homeDir(),
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`codex ${args.join(" ")} exited with code ${code ?? -1}`),
        );
    });
  });
}

async function installCodexPluginFromMarketplace(): Promise<string> {
  try {
    await runCodexPluginCommand(["plugin", "add", CODEX_PLUGIN_KEY]);
    return "codex plugin add: installed/enabled via Codex CLI";
  } catch (err) {
    return `codex plugin add: skipped (${err instanceof Error ? err.message : String(err)})`;
  }
}

async function refreshCodexPluginCache(): Promise<string[]> {
  const reports: string[] = [];
  try {
    await runCodexPluginCommand(["plugin", "remove", CODEX_PLUGIN_KEY]);
    reports.push("codex plugin remove: removed existing cache entry");
  } catch (err) {
    reports.push(
      `codex plugin remove: skipped (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  reports.push(await installCodexPluginFromMarketplace());
  return reports;
}

async function runOpenCodePluginCommand(args: string[]): Promise<void> {
  const opencodeBin = process.env.OPENCODE_CLI_PATH || "opencode";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(opencodeBin, args, {
      stdio: "ignore",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        HOME: homeDir(),
        USERPROFILE: homeDir(),
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `opencode ${args.join(" ")} exited with code ${code ?? -1}`,
          ),
        );
    });
  });
}

async function installOpenCodePlugin(spec: string): Promise<string> {
  try {
    await runOpenCodePluginCommand(["plugin", spec, "-g", "-f"]);
    return `opencode plugin: installed/refreshed ${spec}`;
  } catch (err) {
    return `opencode plugin: skipped (${err instanceof Error ? err.message : String(err)})`;
  }
}

async function ensureOpenCodeConfig(pluginSpec: string): Promise<string[]> {
  const configPath = opencodeConfigPath();
  await ensureDir(path.dirname(configPath));
  const original = (await readTextIfExists(configPath)) ?? "{}";
  let parsed: { plugin?: unknown; $schema?: string };
  try {
    parsed = JSON.parse(original) as { plugin?: unknown; $schema?: string };
  } catch {
    parsed = {};
  }

  const plugins = Array.isArray(parsed.plugin) ? [...parsed.plugin] : [];
  const normalized = plugins
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
      return "";
    })
    .filter(Boolean);

  const withoutHarness = normalized.filter(
    (entry) => !entry.startsWith(`${PLUGIN_NAME}@`),
  );
  if (
    normalized.includes(pluginSpec) &&
    normalized.filter((entry) => entry.startsWith(`${PLUGIN_NAME}@`))
      .length === 1
  ) {
    return [`opencode config: already up to date (${configPath})`];
  }

  parsed.plugin = [...withoutHarness, pluginSpec];
  if (!parsed.$schema) {
    parsed.$schema = "https://opencode.ai/config.json";
  }
  await fs.writeFile(
    configPath,
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
  return [`opencode config: updated ${configPath}`];
}

async function auditOpenCodeConfig(expectedSpec: string): Promise<AuditItem> {
  const configPath = opencodeConfigPath();
  const raw = await readTextIfExists(configPath);
  if (raw === undefined) {
    return {
      path: configPath,
      status: (await fileExists(opencodeHome())) ? "missing" : "n/a",
    };
  }
  try {
    const parsed = JSON.parse(raw) as { plugin?: unknown };
    const plugins = Array.isArray(parsed.plugin) ? parsed.plugin : [];
    const hasSpec = plugins.some((entry) => {
      if (typeof entry === "string") return entry === expectedSpec;
      if (Array.isArray(entry) && typeof entry[0] === "string")
        return entry[0] === expectedSpec;
      return false;
    });
    return { path: configPath, status: hasSpec ? "ok" : "stale" };
  } catch {
    return { path: configPath, status: "stale" };
  }
}

async function runClaudePluginCommand(args: string[]): Promise<void> {
  const claudeBin = process.env.CLAUDE_CLI_PATH || "claude";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(claudeBin, args, {
      stdio: "ignore",
      shell: process.platform === "win32",
      env: {
        ...process.env,
        HOME: homeDir(),
        USERPROFILE: homeDir(),
      },
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(`claude ${args.join(" ")} exited with code ${code ?? -1}`),
        );
    });
  });
}

async function ensureClaudeAutoUpdate(
  marketplaceSource: string,
  useGit: boolean,
): Promise<string> {
  if (!useGit) {
    return "claude autoUpdate: skipped (local marketplace ??use sync --claude to refresh)";
  }
  const settingsPath = claudeSettingsPath();
  await ensureDir(path.dirname(settingsPath));
  const original = (await readTextIfExists(settingsPath)) ?? "{}";
  let parsed: {
    extraKnownMarketplaces?: Record<
      string,
      { source?: unknown; autoUpdate?: boolean }
    >;
    enabledPlugins?: Record<string, boolean>;
  };
  try {
    parsed = JSON.parse(original) as typeof parsed;
  } catch {
    parsed = {};
  }

  const marketplaces = { ...(parsed.extraKnownMarketplaces ?? {}) };
  const refMatch = /^([^#]+)#(.+)$/.exec(marketplaceSource);
  const repo = refMatch?.[1] ?? marketplaceSource;
  const ref = refMatch?.[2];
  const githubSource: { source: "github"; repo: string; ref?: string } = {
    source: "github",
    repo,
  };
  if (ref) githubSource.ref = ref;

  const existing = marketplaces[CLAUDE_MARKETPLACE_NAME];
  const next = {
    source: githubSource,
    autoUpdate: true,
  };
  const unchanged =
    existing &&
    JSON.stringify(existing.source) === JSON.stringify(next.source) &&
    existing.autoUpdate === true;

  marketplaces[CLAUDE_MARKETPLACE_NAME] = next;
  parsed.extraKnownMarketplaces = marketplaces;
  parsed.enabledPlugins = {
    ...(parsed.enabledPlugins ?? {}),
    [CLAUDE_PLUGIN_KEY]: true,
  };

  if (unchanged) {
    return `claude settings: already up to date (${settingsPath})`;
  }
  await fs.writeFile(
    settingsPath,
    `${JSON.stringify(parsed, null, 2)}\n`,
    "utf8",
  );
  return `claude settings: enabled autoUpdate for ${CLAUDE_MARKETPLACE_NAME} (${settingsPath})`;
}

async function syncClaudeMarketplace(
  sourceRoot: string,
  opts: { useGit?: boolean; ref?: string },
): Promise<string[]> {
  const reports: string[] = [];
  const marketplaceManifest = path.join(
    sourceRoot,
    ".claude-plugin",
    "marketplace.json",
  );
  const pluginManifest = path.join(
    sourceRoot,
    "plugin",
    ".claude-plugin",
    "plugin.json",
  );
  if (!(await fileExists(marketplaceManifest))) {
    reports.push(
      `claude marketplace: missing ${marketplaceManifest} (cannot sync)`,
    );
    return reports;
  }
  if (!(await fileExists(pluginManifest))) {
    reports.push(`claude plugin: missing ${pluginManifest} (cannot sync)`);
    return reports;
  }

  const useGit = !!opts.useGit;
  const marketplaceSource = claudeMarketplaceSource(sourceRoot, {
    useGit,
    ref: opts.ref,
  });

  try {
    await runClaudePluginCommand([
      "plugin",
      "marketplace",
      "add",
      marketplaceSource,
    ]);
    reports.push(`claude marketplace add: ${marketplaceSource}`);
  } catch (err) {
    reports.push(
      `claude marketplace add: skipped (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  try {
    await runClaudePluginCommand(["plugin", "install", CLAUDE_PLUGIN_KEY]);
    reports.push(`claude plugin install: ${CLAUDE_PLUGIN_KEY}`);
  } catch (err) {
    reports.push(
      `claude plugin install: skipped (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  reports.push(await ensureClaudeAutoUpdate(marketplaceSource, useGit));
  return reports;
}

async function reportPluginSkillPrunes(
  label: string,
  pluginInstallRoot: string,
  force: boolean,
): Promise<string[]> {
  const reports: string[] = [];
  const pruned = await pruneStalePluginWorkSkillDir(pluginInstallRoot, force);
  if (pruned > 0) {
    reports.push(`${label}: pruned ${pruned} legacy work-skill folder(s)`);
  }
  const prunedMatt = await pruneExternalMattPocockSkillDirs(
    path.join(pluginInstallRoot, "skills"),
    force,
  );
  if (prunedMatt > 0) {
    reports.push(
      `${label}: pruned ${prunedMatt} formerly-vendored Matt Pocock skill folder(s)`,
    );
  }
  const prunedCaveman = await pruneExternalCavemanSkillDirs(
    path.join(pluginInstallRoot, "skills"),
    force,
  );
  if (prunedCaveman > 0) {
    reports.push(
      `${label}: pruned ${prunedCaveman} formerly-vendored Caveman skill folder(s)`,
    );
  }
  return reports;
}

async function auditCodexConfig(): Promise<{
  marketplace: AuditItem;
  plugin: AuditItem;
}> {
  const configPath = codexConfigPath();
  const raw = await readTextIfExists(configPath);
  if (raw === undefined) {
    return {
      marketplace: {
        path: configPath,
        status: (await fileExists(codexHome())) ? "missing" : "n/a",
      },
      plugin: {
        path: configPath,
        status: (await fileExists(codexHome())) ? "missing" : "n/a",
      },
    };
  }

  const pluginRoot = codexInstallRoot();
  const marketplaceOk = raw.includes(marketplaceBlock(pluginRoot).trim());
  const pluginOk = raw.includes(pluginEnabledBlock().trim());
  return {
    marketplace: { path: configPath, status: marketplaceOk ? "ok" : "stale" },
    plugin: { path: configPath, status: pluginOk ? "ok" : "stale" },
  };
}

export async function resolveSourceRoot(
  sourceRoot?: string,
  ref?: string,
): Promise<ResolvedSource> {
  if (!sourceRoot) return { root: packageRoot() };
  const candidate = path.resolve(sourceRoot);
  if (await fileExists(candidate)) return { root: candidate };

  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "ycm-harness-sync-"),
  );
  const args = ["clone", "--depth", "1"];
  if (ref) args.push("--branch", ref);
  args.push(sourceRoot, tempRoot);
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", args, { stdio: "ignore" });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git clone failed for ${sourceRoot}`));
    });
  });
  return {
    root: tempRoot,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
  };
}

export async function runInstallScopes(
  ctx: CliContext,
  opts: InstallScopeOptions,
): Promise<string[]> {
  const sourceRoot = opts.sourceRoot ?? packageRoot();
  const pluginRoot = path.join(sourceRoot, "plugin");
  const force = !!opts.force;
  const reports: string[] = [];

  if (opts.user) {
    if (!opts.ruleOnly) {
      reports.push(
        renderTreeReport(
          "cursor user skills",
          await copyHarnessSkills(
            pluginRoot,
            path.join(cursorHome(), "skills"),
            force,
          ),
        ),
      );
      reports.push(
        renderTreeReport(
          "cursor user agents",
          await copyManagedAgents(
            pluginRoot,
            path.join(cursorHome(), "agents", PLUGIN_NAME),
            force,
          ),
        ),
      );
      reports.push(
        ...(await reportLegacyAgentPrunes(
          "cursor user",
          path.join(cursorHome(), "agents"),
          force,
        )),
      );
    }

    reports.push(
      renderTreeReport(
        "cursor plugin",
        await installPluginProjection(sourceRoot, cursorInstallRoot(), force),
      ),
    );
    reports.push(
      ...(await reportPluginSkillPrunes(
        "cursor plugin",
        cursorInstallRoot(),
        force,
      )),
    );
  }

  if (opts.project) {
    if (!opts.ruleOnly) {
      reports.push(
        renderTreeReport(
          "project skills",
          await copyHarnessSkills(
            pluginRoot,
            path.join(ctx.cwd, ".cursor", "skills"),
            force,
          ),
        ),
      );
      reports.push(
        renderTreeReport(
          "project agents",
          await copyManagedAgents(
            pluginRoot,
            path.join(ctx.cwd, ".cursor", "agents", PLUGIN_NAME),
            force,
          ),
        ),
      );
      reports.push(
        ...(await reportLegacyAgentPrunes(
          "project",
          path.join(ctx.cwd, ".cursor", "agents"),
          force,
        )),
      );
    }

    if (!opts.skillOnly) {
      const ruleResult = await copyFileManaged(
        path.join(pluginRoot, "rules", "ycm-harness.mdc"),
        path.join(ctx.cwd, ".cursor", "rules", "ycm-harness.mdc"),
        force,
      );
      reports.push(`project rule: ${ruleResult}`);
    }
  }

  return reports;
}

export async function runClientSync(
  opts: ClientSyncOptions,
): Promise<string[]> {
  const sourceRoot = opts.sourceRoot ?? packageRoot();
  const pluginRoot = path.join(sourceRoot, "plugin");
  const force = opts.force ?? true;
  const reports: string[] = [];

  if (opts.cursor) {
    reports.push(
      renderTreeReport(
        "cursor plugin",
        await installPluginProjection(sourceRoot, cursorInstallRoot(), force),
      ),
    );
    reports.push(
      ...(await reportPluginSkillPrunes(
        "cursor plugin",
        cursorInstallRoot(),
        force,
      )),
    );
    reports.push(
      renderTreeReport(
        "cursor user skills",
        await copyHarnessSkills(
          pluginRoot,
          path.join(cursorHome(), "skills"),
          force,
        ),
      ),
    );
    reports.push(
      renderTreeReport(
        "cursor user agents",
        await copyManagedAgents(
          pluginRoot,
          path.join(cursorHome(), "agents", PLUGIN_NAME),
          force,
        ),
      ),
    );
    reports.push(
      ...(await reportLegacyAgentPrunes(
        "cursor user",
        path.join(cursorHome(), "agents"),
        force,
      )),
    );
  }

  if (opts.codex) {
    const installedMarketplaceManifest = path.join(
      codexMarketplaceConfigRoot(),
      "marketplace.json",
    );
    await ensureDir(path.dirname(installedMarketplaceManifest));
    const existingMarketplace = await readTextIfExists(
      installedMarketplaceManifest,
    );
    const nextMarketplace = installedCodexMarketplaceManifest();
    let marketplaceResult: "installed" | "updated" | "skipped" = "skipped";
    if (existingMarketplace === undefined) {
      await fs.writeFile(installedMarketplaceManifest, nextMarketplace, "utf8");
      marketplaceResult = "installed";
    } else if (existingMarketplace !== nextMarketplace && force) {
      await fs.writeFile(installedMarketplaceManifest, nextMarketplace, "utf8");
      marketplaceResult = "updated";
    }
    reports.push(
      renderTreeReport(
        "codex plugin",
        await installPluginProjection(sourceRoot, codexInstalledPluginRoot(), force),
      ),
    );
    reports.push(
      ...(await reportPluginSkillPrunes(
        "codex plugin",
        codexInstalledPluginRoot(),
        force,
      )),
    );
    reports.push(`codex marketplace manifest: ${marketplaceResult}`);
    reports.push(...(await ensureCodexConfig(codexInstallRoot())));
    if (opts.refreshCodexCache) {
      reports.push(...(await refreshCodexPluginCache()));
    } else {
      reports.push(await installCodexPluginFromMarketplace());
    }
  }

  if (opts.opencode) {
    const pluginSpec = await opencodePluginSpecForSource(sourceRoot);
    reports.push(
      renderTreeReport(
        "opencode skills",
        await copyHarnessSkills(
          pluginRoot,
          path.join(opencodeHome(), "skills"),
          force,
        ),
      ),
    );
    const usingGithubSrc = path.join(pluginRoot, "skills", "using-github-issues");
    if (await fileExists(usingGithubSrc)) {
      reports.push(
        renderTreeReport(
          "opencode using-github-issues skill",
          await copyTreeManaged(
            usingGithubSrc,
            path.join(opencodeHome(), "skills", "using-github-issues"),
            force,
          ),
        ),
      );
    }
    reports.push(...(await ensureOpenCodeConfig(pluginSpec)));
    reports.push(await installOpenCodePlugin(pluginSpec));
  }

  if (opts.claude) {
    reports.push(
      ...(await syncClaudeMarketplace(sourceRoot, {
        useGit: !!opts.claudeGit,
        ref: opts.claudeRef,
      })),
    );
  }

  const matt = await auditMattPocockSkills();
  if (matt.status === "ok") {
    reports.push(`mattpocock-skills: ok (${matt.path})`);
  } else if (matt.status === "missing") {
    reports.push(`mattpocock-skills: MISSING — ${mattPocockInstallHint()}`);
  } else {
    reports.push(`mattpocock-skills: n/a (Claude Code home not detected)`);
  }

  const ralph = await auditRalphLoop();
  if (ralph.status === "ok") {
    reports.push(`ralph-loop: ok (${ralph.path})`);
  } else if (ralph.status === "missing") {
    reports.push(`ralph-loop: MISSING — ${ralphLoopInstallHint()}`);
  } else {
    reports.push(`ralph-loop: n/a (Claude Code home not detected)`);
  }

  const caveman = await auditCaveman();
  if (caveman.status === "ok") {
    reports.push(`caveman: ok (${caveman.path})`);
  } else if (caveman.status === "missing") {
    reports.push(`caveman: MISSING — ${cavemanInstallHint()}`);
  } else {
    reports.push(`caveman: n/a (Claude Code home not detected)`);
  }

  const ponytail = await auditPonytail();
  if (ponytail.status === "ok") {
    reports.push(`ponytail: ok (${ponytail.path})`);
  } else if (ponytail.status === "missing") {
    reports.push(`ponytail: MISSING — ${ponytailInstallHint()}`);
  } else {
    reports.push(`ponytail: n/a (Cursor/Claude home not detected)`);
  }

  return reports;
}

function anyDrift(...groups: (AuditItem | AuditItem[] | undefined)[]): boolean {
  for (const group of groups) {
    if (!group) continue;
    if (Array.isArray(group)) {
      if (countDrift(group) > 0) return true;
      continue;
    }
    if (group.status !== "ok" && group.status !== "n/a") return true;
  }
  return false;
}

export async function auditInstall(
  cwd: string,
  sourceRoot = packageRoot(),
): Promise<{ audit: InstallAudit; needs_sync: boolean }> {
  const root = sourceRoot;
  const pluginRoot = path.join(root, "plugin");
  const codexDetected = await fileExists(codexHome());
  const opencodeDetected = await fileExists(opencodeHome());
  const opencodeSpec = await opencodePluginSpecForSource(root);

  const audit: InstallAudit = {
    user_skill: await auditHarnessSkills(
      pluginRoot,
      path.join(cursorHome(), "skills"),
    ),
    project_skill: await auditHarnessSkills(
      pluginRoot,
      path.join(cwd, ".cursor", "skills"),
    ),
    project_rule: await auditFile(
      path.join(pluginRoot, "rules", "ycm-harness.mdc"),
      path.join(cwd, ".cursor", "rules", "ycm-harness.mdc"),
    ),
    user_agents: [
      ...(await auditTree(
        path.join(pluginRoot, "agents"),
        path.join(cursorHome(), "agents", PLUGIN_NAME),
      )),
      ...(await staleLegacyAgentItems(path.join(cursorHome(), "agents"))),
    ],
    project_agents: [
      ...(await auditTree(
        path.join(pluginRoot, "agents"),
        path.join(cwd, ".cursor", "agents", PLUGIN_NAME),
      )),
      ...(await staleLegacyAgentItems(path.join(cwd, ".cursor", "agents"))),
    ],
    cursor_plugin: [
      ...(await auditPluginProjection(root, cursorInstallRoot())),
      ...(await Promise.all(
        LEGACY_WORK_SKILL_DIRS.map(async (legacyDir) => {
          const legacyPath = path.join(
            cursorInstallRoot(),
            "skills",
            legacyDir,
          );
          return (await fileExists(legacyPath))
            ? [{ path: legacyPath, status: "stale" as AuditStatus }]
            : [];
        }),
      )).flat(),
      ...(await Promise.all(
        EXTERNAL_MATTOCK_SKILL_DIRS.map(async (skillDir) => {
          const stalePath = path.join(
            cursorInstallRoot(),
            "skills",
            skillDir,
          );
          return (await fileExists(stalePath))
            ? [{ path: stalePath, status: "stale" as AuditStatus }]
            : [];
        }),
      )).flat(),
      ...(await Promise.all(
        EXTERNAL_CAVEMAN_SKILL_DIRS.map(async (skillDir) => {
          const stalePath = path.join(
            cursorInstallRoot(),
            "skills",
            skillDir,
          );
          return (await fileExists(stalePath))
            ? [{ path: stalePath, status: "stale" as AuditStatus }]
            : [];
        }),
      )).flat(),
    ],
    codex_plugin: codexDetected
      ? await auditPluginProjection(root, codexInstalledPluginRoot())
      : [{ path: codexInstalledPluginRoot(), status: "n/a" }],
    codex_marketplace: { path: codexConfigPath(), status: "n/a" },
    codex_plugin_enabled: { path: codexConfigPath(), status: "n/a" },
    opencode_skill: opencodeDetected
      ? await auditHarnessSkills(
          pluginRoot,
          path.join(opencodeHome(), "skills"),
        )
      : [
          {
            path: path.join(opencodeHome(), "skills", PLUGIN_NAME),
            status: "n/a",
          },
        ],
    opencode_config: { path: opencodeConfigPath(), status: "n/a" },
    mattpocock_skills: await auditMattPocockSkills(),
    ralph_loop: await auditRalphLoop(),
    caveman: await auditCaveman(),
    ponytail: await auditPonytail(),
  };

  if (codexDetected) {
    audit.codex_plugin = [
      ...(await auditPluginProjection(root, codexInstalledPluginRoot())),
      {
        path: path.join(codexMarketplaceConfigRoot(), "marketplace.json"),
        status:
          (await readTextIfExists(
            path.join(codexMarketplaceConfigRoot(), "marketplace.json"),
          )) === installedCodexMarketplaceManifest()
            ? "ok"
            : (await fileExists(
                  path.join(codexMarketplaceConfigRoot(), "marketplace.json"),
                ))
              ? "stale"
              : "missing",
      },
    ];
    const configAudit = await auditCodexConfig();
    audit.codex_marketplace = configAudit.marketplace;
    audit.codex_plugin_enabled = configAudit.plugin;
  }

  if (opencodeDetected) {
    audit.opencode_config = await auditOpenCodeConfig(opencodeSpec);
  }

  return {
    audit,
    needs_sync: anyDrift(
      audit.user_skill,
      audit.project_skill,
      audit.project_rule,
      audit.user_agents,
      audit.project_agents,
      audit.cursor_plugin,
      audit.codex_plugin,
      audit.codex_marketplace,
      audit.codex_plugin_enabled,
      audit.opencode_skill,
      audit.opencode_config,
    ),
  };
}

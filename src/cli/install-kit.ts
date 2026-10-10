import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import type { Stats } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { ensureDir, fileExists } from "../state/io.js";
import { PLUGIN_NAME } from "../branding.js";
import {
  cursorGithubPluginRoot,
  cursorLocalInstallRoot,
  listPinnedClaudePluginRoots,
  listPinnedCursorPluginRoots,
  resolveClaudeGithubRepo,
  resolvePluginProjectRoot,
  syncCursorGithubClone,
} from "./cursor-github-plugin.js";

export type AuditStatus = "ok" | "missing" | "stale" | "n/a";

export interface AuditItem {
  path: string;
  status: AuditStatus;
}

export interface InstallAudit {
  user_skill: AuditItem[];
  user_agents: AuditItem[];
  /** Identical harness copies that the removed per-project install left under <cwd>/.cursor. */
  project_leftovers: AuditItem[];
  /** Same-named project paths that differ from the plugin source; doctor keeps them. */
  project_leftovers_kept: AuditItem[];
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

export interface ClientSyncOptions {
  cursor?: boolean;
  codex?: boolean;
  opencode?: boolean;
  claude?: boolean;
  /** Prefer GitHub marketplace (autoUpdate) over local checkout for Claude. */
  claudeGit?: boolean;
  /** Git ref (branch/tag) when using Claude GitHub marketplace. Defaults to master. */
  claudeRef?: string;
  force?: boolean;
  sourceRoot?: string;
  refreshCodexCache?: boolean;
}

/** Harness-owned skills copied to user/project/opencode skill roots. */
const HARNESS_SKILL_DIRS = [
  "ycm-harness",
  "ycm-harness-design",
  "ycm-harness-work-lite",
  "autonomous-harness",
  "hard-problem-solving",
  "llm-wiki",
  "building-ios-ipa-sideloadly",
  "deploying-to-mumu-emulator",
  "plan-and-advance",
  "pull-tickets",
  "summarizing-goal-achievement",
  "setup-autonomy-p1-p7",
  "run-technical-design-discussion",
  "merge-branches-to-master",
  "review-past-commits",
  "create-skill",
  "migrate-multica-to-github-projects",
  "integrating-google-adsense",
  "explainer",
  "eli5",
] as const;

/** Plugin-native skills: not copied to ~/.cursor/skills; they update with the plugin. */
const PLUGIN_NATIVE_SKILL_DIRS = ["commander"] as const;

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
const OPENCODE_PLUGIN_GIT_REMOTE = `${PLUGIN_NAME}@git+https://github.com/johnyuencm/ycm-harness.git`;
/** Claude Code marketplace name (must match `.claude-plugin/marketplace.json`). */
const CLAUDE_MARKETPLACE_NAME = "harness";
const CLAUDE_PLUGIN_KEY = `${PLUGIN_NAME}@${CLAUDE_MARKETPLACE_NAME}`;
const CLAUDE_GITHUB_REPO = "johnyuencm/ycm-harness";
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
  opts?: { useGit?: boolean; ref?: string; githubRepo?: string },
): string {
  if (opts?.useGit) {
    const repo = opts.githubRepo ?? CLAUDE_GITHUB_REPO;
    const ref = (opts.ref ?? CLAUDE_DEFAULT_REF).trim();
    return ref && ref !== CLAUDE_DEFAULT_REF ? `${repo}#${ref}` : repo;
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

/** Byte-equal by default. Leftover matching may ignore CRLF on text (no NUL). */
async function sameFile(
  a: string,
  b: string,
  options?: { ignoreCrlf?: boolean },
): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([fs.readFile(a), fs.readFile(b)]);
    return sameBytes(left, right, options?.ignoreCrlf === true);
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

function relKey(rel: string): string {
  return rel.split(path.sep).join("/");
}

async function copyManagedTree(
  srcRoot: string,
  destRoot: string,
  force: boolean,
): Promise<{ installed: number; updated: number; skipped: number }> {
  const result = await copyTreeManaged(srcRoot, destRoot, force);
  if (force) {
    await pruneRetiredFiles(destRoot, new Set(await relativeFiles(srcRoot)));
  }
  return result;
}

async function copyManagedAgents(
  pluginRoot: string,
  destRoot: string,
  force: boolean,
): Promise<{ installed: number; updated: number; skipped: number }> {
  return copyManagedTree(path.join(pluginRoot, "agents"), destRoot, force);
}

async function pruneEmptyDirs(root: string): Promise<void> {
  if (!(await fileExists(root))) return;
  const entries = await fs.readdir(root, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(root, entry.name);
    await pruneEmptyDirs(full);
    const leftover = await fs.readdir(full);
    if (leftover.length === 0) await fs.rmdir(full);
  }
}

async function pruneRetiredFiles(
  destRoot: string,
  expectedFiles: ReadonlySet<string>,
): Promise<void> {
  const expected = new Set([...expectedFiles].map(relKey));
  for (const rel of await relativeFiles(destRoot)) {
    if (!expected.has(relKey(rel))) {
      await fs.rm(path.join(destRoot, rel), { force: true });
    }
  }
  await pruneEmptyDirs(destRoot);
}

async function auditUnexpectedFiles(
  expectedRoot: string,
  actualRoot: string,
): Promise<AuditItem[]> {
  if (!(await fileExists(actualRoot))) return [];
  const expected = new Set((await relativeFiles(expectedRoot)).map(relKey));
  const extras: AuditItem[] = [];
  for (const rel of await relativeFiles(actualRoot)) {
    if (!expected.has(relKey(rel))) {
      extras.push({ path: path.join(actualRoot, rel), status: "stale" });
    }
  }
  return extras;
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

async function prunePluginNativeSkillDirs(
  destSkillsRoot: string,
  force: boolean,
): Promise<number> {
  let removed = 0;
  for (const name of PLUGIN_NATIVE_SKILL_DIRS) {
    const target = path.join(destSkillsRoot, name);
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

/** Doctor --repair: remove leftover pre-rebrand agent dirs at the user level. */
export async function repairLegacyAgentDirs(): Promise<string[]> {
  return reportLegacyAgentPrunes(
    "cursor user",
    path.join(cursorHome(), "agents"),
    true,
  );
}

/** Same directory by identity, so symlinks, junctions and path case cannot hide it. */
async function sameDirectory(a: string, b: string): Promise<boolean> {
  try {
    const [left, right] = await Promise.all([
      fs.stat(a, { bigint: true }),
      fs.stat(b, { bigint: true }),
    ]);
    return left.dev === right.dev && left.ino === right.ino;
  } catch {
    return false;
  }
}

/** Byte compare that treats CRLF and LF as the same, as the leftover review did. */
function normalizeCrlf(buf: Buffer): Buffer {
  if (!buf.includes(0x0d)) return buf;
  const out = Buffer.allocUnsafe(buf.length);
  let n = 0;
  for (let i = 0; i < buf.length; i++) {
    const current = buf[i];
    if (current === undefined) continue;
    if (current === 0x0d && buf[i + 1] === 0x0a) continue;
    out[n++] = current;
  }
  return out.subarray(0, n);
}

function sameBytes(left: Buffer, right: Buffer, ignoreCrlf: boolean): boolean {
  // Binary (NUL in either buffer) always compares strictly.
  if (ignoreCrlf && !left.includes(0) && !right.includes(0)) {
    return normalizeCrlf(left).equals(normalizeCrlf(right));
  }
  return left.equals(right);
}

async function isFollowedDirectory(target: string): Promise<boolean> {
  const stat = await fs.stat(target).catch(() => undefined);
  return stat?.isDirectory() === true;
}

/**
 * True only when `actual` is a harness copy of `expected`: every file under
 * it matches (CRLF-insensitive on text) and there are no extra files. Missing
 * source files are allowed so a truncated copy is still removable.
 *
 * Total: never throws. Any stat/read error (including EACCES on an unreadable
 * nested dir) returns false (differs, keep). A FIFO, socket, device, or any
 * other leaf that is not a regular file or symlink also returns false.
 * Symlinks are compared through the link when the followed target is a
 * regular file — `fs.rm` later removes the link only, not the target.
 */
export async function leftoverMatchesHarnessCopy(
  actual: string,
  expected: string,
): Promise<boolean> {
  try {
    if (!(await fileExists(expected))) return false;
    const actualDir = await isFollowedDirectory(actual);
    const expectedDir = await isFollowedDirectory(expected);
    if (actualDir !== expectedDir) return false;
    if (!actualDir) return await leftoverLeafMatches(actual, expected);
    const expectedByKey = new Map(
      (await relativeFiles(expected)).map((rel) => [relKey(rel), rel] as const),
    );
    return await leftoverDirMatches(actual, expected, expectedByKey, "");
  } catch {
    return false;
  }
}

/** Read through a symlink only when it points at a regular file; never open specials. */
async function leftoverLeafIsRegularFile(
  target: string,
  st: Stats,
): Promise<boolean> {
  if (st.isFile()) return true;
  if (!st.isSymbolicLink()) return false;
  try {
    return (await fs.stat(target)).isFile();
  } catch {
    return false;
  }
}

async function leftoverLeafMatches(
  actual: string,
  expected: string,
): Promise<boolean> {
  try {
    const st = await fs.lstat(actual);
    if (!(await leftoverLeafIsRegularFile(actual, st))) return false;
    return await sameFile(expected, actual, { ignoreCrlf: true });
  } catch {
    return false;
  }
}

async function leftoverDirMatches(
  actualRoot: string,
  expectedRoot: string,
  expectedByKey: Map<string, string>,
  prefix: string,
): Promise<boolean> {
  try {
    const entries = await fs.readdir(actualRoot, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix ? path.join(prefix, entry.name) : entry.name;
      const full = path.join(actualRoot, entry.name);
      const st = await fs.lstat(full);
      if (st.isDirectory()) {
        if (!(await leftoverDirMatches(full, expectedRoot, expectedByKey, rel))) {
          return false;
        }
        continue;
      }
      if (!(await leftoverLeafIsRegularFile(full, st))) return false;
      const expectedRel = expectedByKey.get(relKey(rel));
      if (expectedRel === undefined) return false;
      if (
        !(await sameFile(path.join(expectedRoot, expectedRel), full, {
          ignoreCrlf: true,
        }))
      ) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

function leftoverExpectedPath(
  kind: "skills" | "agents" | "rules",
  name: string,
  pluginRoot: string,
): string {
  if (kind === "skills") {
    return path.join(
      pluginRoot,
      "skills",
      harnessSkillSourceDir(name as (typeof HARNESS_SKILL_DIRS)[number]),
    );
  }
  if (kind === "agents") return path.join(pluginRoot, "agents");
  return path.join(pluginRoot, "rules", name);
}

/**
 * Paths the removed per-project install wrote under <cwd>/.cursor.
 * Removable leftovers are identical harness copies (no extra files).
 * Same-named paths that differ are kept.
 */
async function classifyProjectLeftovers(
  cwd: string,
  sourceRoot = packageRoot(),
): Promise<{ removable: string[]; kept: string[] }> {
  const cursor = path.join(cwd, ".cursor");
  // From the home directory, <cwd>/.cursor is the global Cursor home: its
  // harness dirs are the user-level install, never leftovers to delete.
  if (await sameDirectory(cursor, cursorHome())) {
    return { removable: [], kept: [] };
  }
  const pluginRoot = path.join(sourceRoot, "plugin");
  const groups: Array<["skills" | "agents" | "rules", readonly string[]]> = [
    ["skills", HARNESS_SKILL_DIRS],
    ["agents", [PLUGIN_NAME]],
    ["rules", ["ycm-harness.mdc"]],
  ];
  const removable: string[] = [];
  const kept: string[] = [];
  for (const [dir, names] of groups) {
    const parent = path.join(cursor, dir);
    // A linked skills/agents/rules dir (symlink or junction) points outside
    // this project, for example at ~/.cursor/skills. Deleting through it
    // would remove the target's files, so such a dir has no leftovers.
    const stat = await fs.lstat(parent).catch(() => undefined);
    if (!stat?.isDirectory()) continue;
    for (const name of names) {
      const target = path.join(parent, name);
      if (!(await fileExists(target))) continue;
      const expected = leftoverExpectedPath(dir, name, pluginRoot);
      if (await leftoverMatchesHarnessCopy(target, expected)) {
        removable.push(target);
      } else {
        kept.push(target);
      }
    }
  }
  removable.sort();
  kept.sort();
  return { removable, kept };
}

export interface LeftoverRepairError {
  path: string;
  code: string;
}

async function leftoverChildCount(target: string): Promise<number | undefined> {
  try {
    return (await fs.readdir(target)).length;
  } catch {
    return undefined;
  }
}

/** Doctor --repair: remove leftover per-project copies; other .cursor files stay. */
export async function removeProjectLeftovers(
  cwd: string,
  sourceRoot = packageRoot(),
): Promise<{ reports: string[]; errors: LeftoverRepairError[] }> {
  const { removable } = await classifyProjectLeftovers(cwd, sourceRoot);
  const reports: string[] = [];
  const errors: LeftoverRepairError[] = [];
  for (const target of removable) {
    // Compare-then-rm is a TOCTOU window; risk is low because --repair is an
    // explicit operator action on same-named .cursor harness paths.
    // A leaf that is a link (symlink or junction) is removed as a link only;
    // fs.rm does not follow links inside a removed tree.
    const beforeCount = await leftoverChildCount(target);
    try {
      await fs.rm(target, { recursive: true, force: true });
      reports.push(`project leftover removed: ${target}`);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code ?? "ERR";
      errors.push({ path: target, code });
      let phrase = "not removed";
      if (await fileExists(target)) {
        const afterCount = await leftoverChildCount(target);
        if (
          beforeCount !== undefined &&
          afterCount !== undefined &&
          afterCount < beforeCount
        ) {
          phrase = "not fully removed";
        }
      }
      reports.push(`project leftover ${phrase}: ${target} (${code})`);
    }
  }
  return { reports, errors };
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
    const result = await copyManagedTree(
      path.join(pluginRoot, "skills", harnessSkillSourceDir(skillDir)),
      path.join(destSkillsRoot, skillDir),
      force,
    );
    totals.installed += result.installed;
    totals.updated += result.updated;
    totals.skipped += result.skipped;
  }
  await pruneLegacyWorkSkillDirs(destSkillsRoot, force);
  await prunePluginNativeSkillDirs(destSkillsRoot, force);
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
    const src = path.join(pluginRoot, "skills", harnessSkillSourceDir(skillDir));
    const dest = path.join(destSkillsRoot, skillDir);
    items.push(...(await auditTree(src, dest)));
    items.push(...(await auditUnexpectedFiles(src, dest)));
  }
  for (const legacyDir of LEGACY_WORK_SKILL_DIRS) {
    if ((HARNESS_SKILL_DIRS as readonly string[]).includes(legacyDir)) continue;
    const legacyPath = path.join(destSkillsRoot, legacyDir);
    if (await fileExists(legacyPath)) {
      items.push({ path: legacyPath, status: "stale" });
    }
  }
  for (const skillDir of PLUGIN_NATIVE_SKILL_DIRS) {
    const stalePath = path.join(destSkillsRoot, skillDir);
    if (await fileExists(stalePath)) {
      items.push({ path: stalePath, status: "stale" });
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

async function auditPinnedCursorPlugins(pluginRoot: string): Promise<AuditItem[]> {
  const items: AuditItem[] = [];
  const sourceRule = path.join(pluginRoot, "rules", "ycm-harness.mdc");
  const sourceSkill = path.join(
    pluginRoot,
    "skills",
    "ycm-harness-work",
    "SKILL.md",
  );
  const dests = uniquePaths([
    cursorLocalInstallRoot(),
    ...(await listPinnedCursorPluginRoots()),
    ...(await listPinnedClaudePluginRoots()),
  ]);
  for (const dest of dests) {
    items.push(
      await auditFile(sourceRule, path.join(dest, "rules", "ycm-harness.mdc")),
    );
    items.push(
      await auditFile(
        sourceSkill,
        path.join(dest, "skills", "ycm-harness-work", "SKILL.md"),
      ),
    );
    for (const retired of ["spec_reviewer.md", "uiux.md", "combined_reviewer.md"]) {
      const retiredPath = path.join(dest, "agents", retired);
      if (await fileExists(retiredPath)) {
        items.push({ path: retiredPath, status: "stale" });
      }
    }
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

function uniquePaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths) {
    const key = path.resolve(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(candidate);
  }
  return out;
}

const RETIRED_PLUGIN_AGENTS = [
  "spec_reviewer.md",
  "uiux.md",
  "combined_reviewer.md",
] as const;

export async function listCursorPluginDestinations(): Promise<string[]> {
  return uniquePaths([
    cursorInstallRoot(),
    cursorLocalInstallRoot(),
    ...(await listPinnedCursorPluginRoots()),
  ]);
}

export async function listManagedPluginDestinations(): Promise<string[]> {
  return uniquePaths([
    ...(await listCursorPluginDestinations()),
    ...(await listPinnedClaudePluginRoots()),
  ]);
}

async function hostManagedPluginDestSet(): Promise<Set<string>> {
  return new Set(
    [
      ...(await listPinnedCursorPluginRoots()),
      ...(await listPinnedClaudePluginRoots()),
    ].map((dir) => path.resolve(dir)),
  );
}

async function pruneRetiredPluginAgents(dest: string): Promise<void> {
  for (const retired of RETIRED_PLUGIN_AGENTS) {
    const retiredPath = path.join(dest, "agents", retired);
    if (await fileExists(retiredPath)) {
      await fs.rm(retiredPath, { force: true });
    }
  }
}

function cursorDestLabel(dest: string): string {
  if (path.resolve(dest) === path.resolve(cursorLocalInstallRoot())) {
    return "cursor local plugin";
  }
  if (path.resolve(dest) === path.resolve(cursorInstallRoot())) {
    return "cursor plugin";
  }
  const normalized = dest.replace(/\\/g, "/");
  if (normalized.includes("/.claude/")) {
    return `claude pinned plugin (${path.basename(path.dirname(dest))}/${path.basename(dest)})`;
  }
  return `cursor pinned plugin (${path.basename(path.dirname(dest))}/${path.basename(dest)})`;
}

async function installHostManagedPluginDest(
  pluginSource: string,
  dest: string,
  force: boolean,
): Promise<string> {
  const label = cursorDestLabel(dest);
  const report = renderTreeReport(
    label,
    await copyTreeManaged(pluginSource, dest, force),
  );
  await pruneRetiredPluginAgents(dest);
  return report;
}

async function installCursorPluginDestinations(
  sourceRoot: string,
  force: boolean,
): Promise<string[]> {
  const reports: string[] = [];
  const pinned = await hostManagedPluginDestSet();
  const pluginSource = path.join(sourceRoot, "plugin");
  for (const dest of await listCursorPluginDestinations()) {
    if (pinned.has(path.resolve(dest))) {
      reports.push(await installHostManagedPluginDest(pluginSource, dest, force));
      continue;
    }
    const label = cursorDestLabel(dest);
    reports.push(
      renderTreeReport(
        label,
        await installPluginProjection(sourceRoot, dest, force),
      ),
    );
    reports.push(...(await reportPluginSkillPrunes(label, dest, force)));
  }
  return reports;
}

async function installClaudePluginDestinations(
  sourceRoot: string,
  force: boolean,
): Promise<string[]> {
  const pluginSource = path.join(sourceRoot, "plugin");
  const reports: string[] = [];
  for (const dest of await listPinnedClaudePluginRoots()) {
    reports.push(await installHostManagedPluginDest(pluginSource, dest, force));
  }
  return reports;
}

export async function refreshCursorPluginAssets(
  sourceRoot: string,
  force = true,
): Promise<string[]> {
  const nested = path.join(sourceRoot, "plugin");
  const pluginSource = (await fileExists(nested)) ? nested : sourceRoot;
  const reports: string[] = [];
  for (const dest of await listManagedPluginDestinations()) {
    const totals = await copyTreeManaged(pluginSource, dest, force);
    // Do not pruneRetiredFiles here: unmanaged dests also hold runtime/ from
    // installPluginProjection. Plugin-only expected sets would delete the CLI.
    await pruneRetiredPluginAgents(dest);
    reports.push(renderTreeReport(cursorDestLabel(dest), totals));
  }
  return reports;
}

export async function refreshCursorPluginsFromGithub(opts: {
  sourceRoot: string;
  force?: boolean;
  timeoutMs?: number;
}): Promise<string[]> {
  if (
    process.env.NODE_TEST_CONTEXT &&
    process.env.YCM_HARNESS_GITHUB_PLUGIN !== "1"
  ) {
    return ["cursor github refresh: skipped (test isolation)"];
  }
  const cloned = await syncCursorGithubClone({
    sourceRoot: opts.sourceRoot,
    timeoutMs: opts.timeoutMs,
  });
  const reports = [...cloned.reports];
  const clonePlugin = cloned.root
    ? await cursorGithubPluginRoot(cloned.root)
    : undefined;
  let projectRoot: string | undefined;
  if (clonePlugin) {
    projectRoot =
      path.basename(clonePlugin) === "plugin" ? cloned.root! : clonePlugin;
  } else if (process.env.YCM_HARNESS_SKIP_GITHUB_PLUGIN === "1") {
    reports.push("cursor github refresh: skipped dest copy (local overlay)");
    return reports;
  } else {
    projectRoot = await resolvePluginProjectRoot(opts.sourceRoot);
    if (projectRoot) {
      reports.push(
        "cursor github refresh: clone unavailable; using checkout plugin",
      );
    }
  }
  if (!projectRoot) {
    reports.push("cursor github refresh: skipped dest copy (no plugin source)");
    return reports;
  }
  reports.push(
    ...(await refreshCursorPluginAssets(projectRoot, opts.force ?? true)),
  );
  return reports;
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

// Only table boundaries and string/container state, not a TOML value parser.
// Keeping offsets lets sync splice owned tables without reformatting foreign data.
function tomlTableHeader(line: string): { key: string; array: boolean } | undefined {
  const token = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\r\n]|\\.)*"|'[^'\r\n]*')`;
  const match = new RegExp(`^[ \\t]*(\\[\\[?)[ \\t]*(${token}(?:[ \\t]*\\.[ \\t]*${token})*)[ \\t]*(\\]\\]?)[ \\t]*(?:#.*)?$`).exec(line);
  if (!match || match[1]!.length !== match[3]!.length) return undefined;
  const keys = match[2]!.match(new RegExp(token, "g"))!.map((key) => {
    if (key.startsWith("'")) return key.slice(1, -1);
    if (!key.startsWith('"')) return key;
    const escapes: Record<string, string> = { b: "\b", t: "\t", n: "\n", f: "\f", r: "\r", '"': '"', "\\": "\\" };
    return key.slice(1, -1).replace(/\\(u[\da-fA-F]{4}|U[\da-fA-F]{8}|.)/g, (_, escape: string) => {
      if (escape in escapes) return escapes[escape]!;
      if (/^[uU][\da-fA-F]+$/.test(escape)) {
        const code = Number.parseInt(escape.slice(1), 16);
        if (code <= 0x10ffff && (code < 0xd800 || code > 0xdfff)) return String.fromCodePoint(code);
      }
      throw new Error("Invalid TOML table key escape");
    });
  });
  return { key: JSON.stringify(keys), array: match[1] === "[[" };
}

function tomlSections(raw: string): { key: string; array: boolean; start: number; end: number }[] {
  const sections: { key: string; array: boolean; start: number; end: number }[] = [];
  let quote = "";
  let depth = 0;
  let offset = 0;
  let trivia: number | undefined;
  for (const fullLine of raw.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!fullLine) continue;
    const line = fullLine.replace(/\r?\n$/, "");
    if (!quote && depth === 0) {
      if (/^[ \t]*(?:#.*)?$/.test(line)) {
        trivia ??= offset;
        offset += fullLine.length;
        continue;
      }
      if (/^[ \t]*\[/.test(line)) {
        const header = tomlTableHeader(line);
        if (!header) throw new Error("Malformed TOML table header; config left unchanged");
        const previous = sections.at(-1);
        if (previous) previous.end = trivia ?? offset;
        sections.push({ ...header, start: offset, end: raw.length });
        trivia = undefined;
        offset += fullLine.length;
        continue;
      }
      trivia = undefined;
    }
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i]!;
      if (quote) {
        if (quote[0] === '"' && ch === "\\") { i += 1; continue; }
        if (line.startsWith(quote, i)) {
          let end = i + quote.length;
          // Four/five quotes close a multiline string with one/two quote data characters.
          if (quote.length === 3) while (line[end] === quote[0]) end += 1;
          i = end - 1;
          quote = "";
        }
      } else if (ch === "#") {
        break;
      } else if (ch === '"' || ch === "'") {
        quote = line.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
        i += quote.length - 1;
      } else if (ch === "[" || ch === "{") {
        depth += 1;
      } else if (ch === "]" || ch === "}") {
        depth -= 1;
      }
    }
    if (quote.length === 1 || depth < 0) throw new Error("Malformed TOML value; config left unchanged");
    offset += fullLine.length;
  }
  if (quote || depth) throw new Error("Unclosed TOML value; config left unchanged");
  const last = sections.at(-1);
  if (last) last.end = trivia ?? raw.length;
  return sections;
}

export function upsertTomlSection(raw: string, header: string, block: string): string {
  const key = tomlTableHeader(`[${header}]`)!.key;
  const owned = tomlSections(raw).filter((section) => section.key === key);
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const replacement = block.trimEnd().replace(/\r?\n/g, eol) + eol;
  if (owned.length === 0) {
    const suffix = raw.length === 0 ? "" : raw.endsWith("\n") ? eol : eol + eol;
    return raw + suffix + replacement;
  }
  // Replace the first owned table and remove any duplicate, preserving all gaps.
  let next = "";
  let from = 0;
  for (const [index, section] of owned.entries()) {
    next += raw.slice(from, section.start) + (index === 0 ? replacement : "");
    from = section.end;
  }
  return next + raw.slice(from);
}

function tomlSectionMatches(raw: string, header: string, block: string): boolean {
  try {
    const key = tomlTableHeader(`[${header}]`)!.key;
    const owned = tomlSections(raw).filter((section) => section.key === key);
    if (owned.length !== 1 || owned[0]!.array) return false;
    const section = owned[0]!;
    return raw.slice(section.start, section.end).replace(/\r\n/g, "\n").trim() === block.trim();
  } catch {
    return false;
  }
}

async function ensureCodexConfig(pluginRoot: string): Promise<string[]> {
  const configPath = codexConfigPath();
  await ensureDir(path.dirname(configPath));
  const original = (await readTextIfExists(configPath)) ?? "";
  const source = codexConfigSource(pluginRoot, configPath);
  const withMarketplace = upsertTomlSection(
    original,
    `marketplaces.${CODEX_MARKETPLACE_NAME}`,
    codexMarketplaceBlock(pluginRoot, configPath),
  );
  const next = upsertTomlSection(
    withMarketplace,
    `plugins."${CODEX_PLUGIN_KEY}"`,
    pluginEnabledBlock(),
  );
  const reports: string[] = [];
  if (next !== original) {
    await fs.writeFile(configPath, next, "utf8");
    reports.push(`codex config: updated ${configPath}`);
  } else {
    reports.push(`codex config: already up to date (${configPath})`);
  }
  if (source !== pluginRoot) {
    reports.push(
      `codex config: source rewritten to the Windows path ${source} for a native Codex home`,
    );
  }
  return reports;
}

/**
 * Pick the marketplace `source` path a native Codex process will read. When the
 * CLI runs under WSL and the Codex home that receives config.toml is a Windows
 * home under `/mnt/<drive>/`, the WSL path is unreachable from Windows, so write
 * the equivalent `C:\...` path instead (finding 3).
 */
/** The marketplace block sync writes and doctor audits; both must agree on `source`. */
export function codexMarketplaceBlock(pluginRoot: string, configPath: string): string {
  return marketplaceBlock(codexConfigSource(pluginRoot, configPath));
}

export function codexConfigSource(pluginRoot: string, configPath: string): string {
  if (!isWsl()) return pluginRoot;
  if (!/^\/mnt\/[A-Za-z]\//.test(configPath)) return pluginRoot;
  return wslPathToWindows(pluginRoot) ?? pluginRoot;
}

function isWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  if (process.platform !== "linux") return false;
  try {
    return fsSync.readFileSync("/proc/version", "utf8").toLowerCase().includes("microsoft");
  } catch {
    return false;
  }
}

/** Pure `/mnt/<drive>/...` -> `X:\...` mapping; returns undefined when not under /mnt. */
export function wslPathToWindows(posixPath: string): string | undefined {
  const match = /^\/mnt\/([A-Za-z])(\/.*)?$/.exec(posixPath);
  if (!match) return undefined;
  const rest = (match[2] ?? "").replace(/\//g, "\\");
  return `${match[1]!.toUpperCase()}:${rest || "\\"}`;
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
    return "claude autoUpdate: skipped (local marketplace; omit --claude-local for git autoUpdate)";
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
  const githubRepo = useGit
    ? await resolveClaudeGithubRepo(sourceRoot)
    : undefined;
  const marketplaceSource = claudeMarketplaceSource(sourceRoot, {
    useGit,
    ref: opts.ref,
    githubRepo,
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
  const marketplaceOk = tomlSectionMatches(raw, `marketplaces.${CODEX_MARKETPLACE_NAME}`, codexMarketplaceBlock(pluginRoot, configPath));
  const pluginOk = tomlSectionMatches(raw, `plugins."${CODEX_PLUGIN_KEY}"`, pluginEnabledBlock());
  return {
    marketplace: { path: configPath, status: marketplaceOk ? "ok" : "stale" },
    plugin: { path: configPath, status: pluginOk ? "ok" : "stale" },
  };
}

export async function runClientSync(
  opts: ClientSyncOptions,
): Promise<string[]> {
  const sourceRoot = opts.sourceRoot ?? packageRoot();
  const pluginRoot = path.join(sourceRoot, "plugin");
  const force = opts.force ?? true;
  const reports: string[] = [];

  if (opts.cursor) {
    reports.push(...(await installCursorPluginDestinations(sourceRoot, force)));
    reports.push(...(await syncCursorGithubClone({ sourceRoot })).reports);
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
    reports.push(...(await installClaudePluginDestinations(sourceRoot, force)));
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

  const classifiedLeftovers = await classifyProjectLeftovers(cwd, root);
  const audit: InstallAudit = {
    user_skill: await auditHarnessSkills(
      pluginRoot,
      path.join(cursorHome(), "skills"),
    ),
    user_agents: [
      ...(await auditTree(
        path.join(pluginRoot, "agents"),
        path.join(cursorHome(), "agents", PLUGIN_NAME),
      )),
      ...(await staleLegacyAgentItems(path.join(cursorHome(), "agents"))),
    ],
    project_leftovers: classifiedLeftovers.removable.map((target) => ({
      path: target,
      status: "stale" as AuditStatus,
    })),
    // Kept leftovers stay status "ok" so they do not count toward needs_sync
    // (`anyDrift` ignores "ok"/"n/a"). JSON still lists them separately as
    // project_leftovers_kept; adding a new AuditStatus would break consumers.
    project_leftovers_kept: classifiedLeftovers.kept.map((target) => ({
      path: target,
      status: "ok" as AuditStatus,
    })),
    cursor_plugin: [
      ...(await auditPluginProjection(root, cursorInstallRoot())),
      ...(await auditPinnedCursorPlugins(pluginRoot)),
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
      audit.user_agents,
      audit.project_leftovers,
      audit.cursor_plugin,
      audit.codex_plugin,
      audit.codex_marketplace,
      audit.codex_plugin_enabled,
      audit.opencode_skill,
      audit.opencode_config,
    ),
  };
}

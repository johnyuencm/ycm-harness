import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PLUGIN_NAME } from "../branding.js";
import { fileExists } from "../state/io.js";

const DEFAULT_GITHUB_REPO = "johnyuen/harness";
const DEFAULT_REF = "master";
const FETCH_TIMEOUT_MS = 8_000;

function harnessHome(): string {
  return (
    process.env.YCM_HARNESS_HOME ??
    process.env.HOME ??
    process.env.USERPROFILE ??
    os.homedir()
  );
}

function cursorHome(): string {
  return path.join(harnessHome(), ".cursor");
}

export function cursorLocalInstallRoot(): string {
  return path.join(cursorHome(), "plugins", "local", PLUGIN_NAME);
}

export function cursorGitCloneRoot(): string {
  return path.join(cursorHome(), "plugins", "git", PLUGIN_NAME);
}

export function allowGithubPluginNetwork(): boolean {
  if (process.env.YCM_HARNESS_SKIP_GITHUB_PLUGIN === "1") return false;
  if (process.env.YCM_HARNESS_GITHUB_PLUGIN === "0") return false;
  if (
    process.env.NODE_TEST_CONTEXT &&
    process.env.YCM_HARNESS_GITHUB_PLUGIN !== "1"
  ) {
    return false;
  }
  return true;
}

export function parseGithubOwnerRepo(remote: string): string | undefined {
  const trimmed = remote.trim();
  const hosted = /github\.com[:/]([^/]+)\/([^/.]+?)(?:\.git)?(?:\/)?$/i.exec(
    trimmed.replace(/\\/g, "/"),
  );
  if (hosted) return `${hosted[1]}/${hosted[2]}`;
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) return trimmed;
  return undefined;
}

export function githubCloneUrl(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed.startsWith("-")) {
    return `https://github.com/${DEFAULT_GITHUB_REPO}.git`;
  }
  const ownerRepo = parseGithubOwnerRepo(trimmed);
  if (ownerRepo && !/github\.com/i.test(trimmed) && !/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.startsWith("/")) {
    return `https://github.com/${ownerRepo}.git`;
  }
  return trimmed;
}

async function runGit(
  args: string[],
  cwd?: string,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return await new Promise((resolve) => {
    const child = spawn("git", args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, stdout, stderr: err.message });
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, stdout, stderr });
    });
  });
}

async function gitOrigin(sourceRoot: string): Promise<string | undefined> {
  const result = await runGit(
    ["-C", sourceRoot, "remote", "get-url", "origin"],
    undefined,
    3_000,
  );
  const url = result.stdout.trim();
  return result.ok && url ? url : undefined;
}

async function packageRepositoryUrl(sourceRoot: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(path.join(sourceRoot, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { repository?: { url?: string } | string };
    if (typeof parsed.repository === "string") return parsed.repository;
    return parsed.repository?.url;
  } catch {
    return undefined;
  }
}

export async function resolveGithubRemote(sourceRoot: string): Promise<string> {
  const fromEnv = process.env.YCM_HARNESS_GITHUB_REMOTE?.trim();
  if (fromEnv) return githubCloneUrl(fromEnv);
  const origin = await gitOrigin(sourceRoot);
  if (origin) return origin;
  const pkg = await packageRepositoryUrl(sourceRoot);
  if (pkg) return githubCloneUrl(pkg);
  return githubCloneUrl(DEFAULT_GITHUB_REPO);
}

export async function resolveClaudeGithubRepo(sourceRoot: string): Promise<string> {
  const ownerRepo = parseGithubOwnerRepo(await resolveGithubRemote(sourceRoot));
  return ownerRepo ?? DEFAULT_GITHUB_REPO;
}

async function pluginManifestName(file: string): Promise<string | undefined> {
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as {
      name?: string;
    };
    return parsed.name;
  } catch {
    return undefined;
  }
}

export async function isHarnessPluginRoot(dir: string): Promise<boolean> {
  return (
    (await pluginManifestName(
      path.join(dir, ".cursor-plugin", "plugin.json"),
    )) === PLUGIN_NAME ||
    (await pluginManifestName(
      path.join(dir, ".claude-plugin", "plugin.json"),
    )) === PLUGIN_NAME
  );
}

/** Repo root (has `plugin/`) or a plugin root itself. Never a CLI `runtime/` tree. */
export async function resolvePluginProjectRoot(
  dir: string,
): Promise<string | undefined> {
  if (await isHarnessPluginRoot(path.join(dir, "plugin"))) return dir;
  if (await isHarnessPluginRoot(dir)) return dir;
  return undefined;
}

function claudeHome(): string {
  return path.join(harnessHome(), ".claude");
}

async function subdirs(dir: string): Promise<string[]> {
  if (!(await fileExists(dir))) return [];
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

/**
 * Cursor GitHub marketplace installs pin a SHA under plugins/cache.
 * Those folders are what the agent actually loads (marketplace wins over
 * ~/.cursor/plugins/ycm-harness).
 */
export async function listPinnedCursorPluginRoots(): Promise<string[]> {
  const found: string[] = [];
  const cacheRoot = path.join(cursorHome(), "plugins", "cache");
  for (const publisher of await subdirs(cacheRoot)) {
    for (const pluginDir of await subdirs(publisher)) {
      if (path.basename(pluginDir) !== PLUGIN_NAME) continue;
      for (const shaDir of await subdirs(pluginDir)) {
        if (await isHarnessPluginRoot(shaDir)) found.push(shaDir);
      }
    }
  }
  return found;
}

/**
 * Claude Code GitHub/directory marketplace installs pin a SHA (or short SHA)
 * under ~/.claude/plugins/cache/<marketplace>/ycm-harness/<id>/.
 */
export async function listPinnedClaudePluginRoots(): Promise<string[]> {
  const found: string[] = [];
  const cacheRoot = path.join(claudeHome(), "plugins", "cache");
  for (const marketplace of await subdirs(cacheRoot)) {
    for (const pluginDir of await subdirs(marketplace)) {
      if (path.basename(pluginDir) !== PLUGIN_NAME) continue;
      for (const shaDir of await subdirs(pluginDir)) {
        if (await isHarnessPluginRoot(shaDir)) found.push(shaDir);
      }
    }
  }
  return found;
}

export async function syncCursorGithubClone(opts: {
  sourceRoot: string;
  ref?: string;
  timeoutMs?: number;
}): Promise<{ root?: string; reports: string[] }> {
  const reports: string[] = [];
  if (!allowGithubPluginNetwork()) {
    reports.push("cursor github clone: skipped (tests/network disabled)");
    return { reports };
  }
  const cloneRoot = cursorGitCloneRoot();
  const remote = await resolveGithubRemote(opts.sourceRoot);
  const ref = (opts.ref ?? DEFAULT_REF).trim() || DEFAULT_REF;
  const timeoutMs = opts.timeoutMs ?? FETCH_TIMEOUT_MS;
  await fs.mkdir(path.dirname(cloneRoot), { recursive: true });

  const cloneRef = ref.startsWith("-") ? DEFAULT_REF : ref;

  if (await fileExists(path.join(cloneRoot, ".git"))) {
    const fetch = await runGit(
      ["fetch", "--depth", "1", "--", "origin", cloneRef],
      cloneRoot,
      timeoutMs,
    );
    if (!fetch.ok) {
      reports.push(
        `cursor github clone: fetch failed (${fetch.stderr.trim() || "git error"})`,
      );
      return { reports };
    }
    const reset = await runGit(
      ["reset", "--hard", "FETCH_HEAD"],
      cloneRoot,
      timeoutMs,
    );
    if (!reset.ok) {
      reports.push(
        `cursor github clone: reset failed (${reset.stderr.trim() || "git error"})`,
      );
      return { reports };
    }
    reports.push(`cursor github clone: updated ${cloneRoot} (${cloneRef})`);
    return { root: cloneRoot, reports };
  }

  if (await fileExists(cloneRoot)) {
    reports.push("cursor github clone: removing incomplete clone dest");
    await fs.rm(cloneRoot, { recursive: true, force: true });
  }

  const cloneUrl = githubCloneUrl(remote);
  const tmpRoot = `${cloneRoot}.${process.pid}.tmp`;
  await fs.rm(tmpRoot, { recursive: true, force: true });
  const clone = await runGit(
    ["clone", "--depth", "1", "--branch", cloneRef, "--", cloneUrl, tmpRoot],
    undefined,
    timeoutMs,
  );
  if (!clone.ok) {
    await fs.rm(tmpRoot, { recursive: true, force: true });
    reports.push(
      `cursor github clone: clone failed (${clone.stderr.trim() || "git error"})`,
    );
    return { reports };
  }
  await fs.rm(cloneRoot, { recursive: true, force: true });
  await fs.rename(tmpRoot, cloneRoot);
  reports.push(`cursor github clone: cloned ${cloneUrl}#${cloneRef}`);
  return { root: cloneRoot, reports };
}

export async function cursorGithubPluginRoot(
  cloneRoot: string,
): Promise<string | undefined> {
  const nested = path.join(cloneRoot, "plugin");
  if (await isHarnessPluginRoot(nested)) return nested;
  if (await isHarnessPluginRoot(cloneRoot)) return cloneRoot;
  return undefined;
}

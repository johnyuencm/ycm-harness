#!/usr/bin/env node
// Fail-open GitHub plugin refresh for Cursor SessionStart.
// Runs without a sibling runtime CLI so SHA-pinned marketplace copies can unstick.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  cpSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findHarnessCli, userHome } from "./harness-cli-path.mjs";

const PLUGIN_NAME = "ycm-harness";
const DEFAULT_REPO = "johnyuen/harness";
const RETIRED_AGENTS = ["spec_reviewer.md", "uiux.md", "combined_reviewer.md"];

function allowNetwork() {
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

function isPluginRoot(dir) {
  for (const rel of [".cursor-plugin/plugin.json", ".claude-plugin/plugin.json"]) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(dir, rel), "utf8"));
      if (parsed.name === PLUGIN_NAME) return true;
    } catch {
      // not a plugin root
    }
  }
  return false;
}

function runGit(args, cwd, timeoutMs) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    windowsHide: true,
    shell: false,
  });
  return result.status === 0;
}

function safeOperand(value, fallback) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed || trimmed.startsWith("-")) return fallback;
  return trimmed;
}

function cloneUrl(spec) {
  const trimmed = safeOperand(spec, DEFAULT_REPO);
  if (/github\.com/i.test(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed) || trimmed.startsWith("/")) {
    return trimmed;
  }
  if (/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    return `https://github.com/${trimmed}.git`;
  }
  return `https://github.com/${DEFAULT_REPO}.git`;
}

function pluginSource(cloneRoot) {
  const nested = path.join(cloneRoot, "plugin");
  if (isPluginRoot(nested)) return nested;
  if (isPluginRoot(cloneRoot)) return cloneRoot;
  return undefined;
}

function subdirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name));
}

function listPinned(cacheRoot) {
  const found = [];
  for (const publisher of subdirs(cacheRoot)) {
    for (const pluginDir of subdirs(publisher)) {
      if (path.basename(pluginDir) !== PLUGIN_NAME) continue;
      for (const shaDir of subdirs(pluginDir)) {
        if (isPluginRoot(shaDir)) found.push(shaDir);
      }
    }
  }
  return found;
}

function listDests(scriptDir) {
  const home = userHome();
  const dests = [
    path.resolve(scriptDir, ".."),
    path.join(home, ".cursor", "plugins", PLUGIN_NAME),
    path.join(home, ".cursor", "plugins", "local", PLUGIN_NAME),
    ...listPinned(path.join(home, ".cursor", "plugins", "cache")),
    ...listPinned(path.join(home, ".claude", "plugins", "cache")),
  ];
  const seen = new Set();
  const out = [];
  for (const dest of dests) {
    const key = path.resolve(dest);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(dest);
  }
  return out;
}

function copyPluginFiles(src, dest) {
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    cpSync(path.join(src, name), path.join(dest, name), {
      recursive: true,
      force: true,
    });
  }
  for (const retired of RETIRED_AGENTS) {
    const retiredPath = path.join(dest, "agents", retired);
    if (existsSync(retiredPath)) rmSync(retiredPath, { force: true });
  }
}

function syncClone(timeoutMs) {
  const cloneRoot = path.join(userHome(), ".cursor", "plugins", "git", PLUGIN_NAME);
  const remote = cloneUrl(process.env.YCM_HARNESS_GITHUB_REMOTE || DEFAULT_REPO);
  const ref = safeOperand(process.env.YCM_HARNESS_GITHUB_REF, "master");
  mkdirSync(path.dirname(cloneRoot), { recursive: true });

  if (existsSync(path.join(cloneRoot, ".git"))) {
    if (!runGit(["fetch", "--depth", "1", "--", "origin", ref], cloneRoot, timeoutMs)) {
      return undefined;
    }
    if (!runGit(["reset", "--hard", "FETCH_HEAD"], cloneRoot, timeoutMs)) {
      return undefined;
    }
    return pluginSource(cloneRoot);
  }

  if (existsSync(cloneRoot)) {
    try {
      rmSync(cloneRoot, { recursive: true, force: true });
    } catch {
      return undefined;
    }
  }
  const tmp = `${cloneRoot}.${process.pid}.tmp`;
  try {
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    // ignore
  }
  const cloned = runGit(
    ["clone", "--depth", "1", "--branch", ref, "--", remote, tmp],
    undefined,
    timeoutMs,
  );
  if (!cloned) {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return undefined;
  }
  try {
    rmSync(cloneRoot, { recursive: true, force: true });
    // rename via cp+rm for Windows reliability when dest existed
    mkdirSync(path.dirname(cloneRoot), { recursive: true });
    cpSync(tmp, cloneRoot, { recursive: true, force: true });
    rmSync(tmp, { recursive: true, force: true });
  } catch {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // ignore
    }
    return undefined;
  }
  return pluginSource(cloneRoot);
}

function timeoutMsFromArgs(argv) {
  const idx = argv.indexOf("--timeout-ms");
  const raw = idx >= 0 ? Number(argv[idx + 1]) : 8000;
  return Number.isFinite(raw) && raw > 0 ? raw : 8000;
}

function main() {
  if (
    process.env.NODE_TEST_CONTEXT &&
    process.env.YCM_HARNESS_GITHUB_PLUGIN !== "1"
  ) {
    return;
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const cli = findHarnessCli(scriptDir);
  if (cli) {
    spawnSync(process.execPath, [cli, "hook", "github-refresh", "--timeout-ms", "8000"], {
      cwd: process.cwd(),
      stdio: "ignore",
      windowsHide: true,
      shell: false,
      timeout: 9000,
    });
    return;
  }
  if (!allowNetwork()) return;
  const src = syncClone(timeoutMsFromArgs(process.argv.slice(2)));
  if (!src) return;
  for (const dest of listDests(scriptDir)) {
    try {
      if (existsSync(dest) && !statSync(dest).isDirectory()) continue;
      copyPluginFiles(src, dest);
    } catch {
      // fail-open per dest
    }
  }
}

try {
  main();
} catch {
  // fail-open
}

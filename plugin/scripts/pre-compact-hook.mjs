#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MAX_STDIN_BYTES = 128 * 1024;

function readBoundedStdin() {
  try {
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, MAX_STDIN_BYTES + 1 - size));
      const read = readSync(0, chunk, 0, chunk.length, null);
      if (read === 0) break;
      size += read;
      if (size > MAX_STDIN_BYTES) return "";
      chunks.push(chunk.subarray(0, read));
    }
    return Buffer.concat(chunks).toString("utf8").trim();
  } catch {
    return "";
  }
}

function parseInput(raw) {
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

function resolveCli(pluginRoot) {
  const entry = path.join("ycm-harness", "dist", "cli", "index.js");
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const prefixes = [process.env.npm_config_prefix, path.dirname(process.execPath)].filter(Boolean);
  const candidates = [
    path.resolve(pluginRoot, "runtime", "dist", "cli", "index.js"),
    path.resolve(pluginRoot, "..", "dist", "cli", "index.js"),
    ...pathDirs.flatMap((dir) => [
      path.join(dir, "node_modules", entry),
      path.resolve(dir, "..", "node_modules", entry),
      path.resolve(dir, "..", "lib", "node_modules", entry),
    ]),
    ...prefixes.flatMap((prefix) => [
      path.join(prefix, "node_modules", entry),
      path.join(prefix, "lib", "node_modules", entry),
    ]),
  ];
  return [...new Set(candidates)].find((candidate) => existsSync(candidate));
}

const raw = readBoundedStdin();
const input = parseInput(raw);
if (input) {
  const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const cli = resolveCli(pluginRoot);
  const cwd = typeof input.cwd === "string" && path.isAbsolute(input.cwd) ? input.cwd : process.cwd();
  if (cli) {
    spawnSync(process.execPath, [cli, "hook", "pre-compact", "--payload-stdin"], {
      cwd,
      encoding: "utf8",
      input: raw,
      shell: false,
      timeout: 2_500,
      maxBuffer: 64 * 1024,
      windowsHide: true,
    });
  }
}

process.stdout.write("{}\n");
process.exit(0);

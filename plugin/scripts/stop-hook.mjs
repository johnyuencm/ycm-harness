#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const input = (() => {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
})();
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  path.resolve(pluginRoot, "runtime", "dist", "cli", "index.js"),
  path.resolve(pluginRoot, "..", "dist", "cli", "index.js"),
];

for (const cli of candidates) {
  const result = spawnSync(process.execPath, [cli, "hook", "stop"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input,
    shell: false,
    windowsHide: true,
  });
  if (!result.error && result.status === 0 && result.stdout) {
    process.stdout.write(result.stdout);
    process.exit(0);
  }
}

// The tracker/CLI is unavailable. Do not make an optional hook a universal
// blocker; the live CLI applies high-assurance enforcement when available.
process.stdout.write("{}\n");

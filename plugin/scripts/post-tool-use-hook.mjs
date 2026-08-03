#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const input = (() => {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
})();
const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.resolve(pluginRoot, "runtime", "dist", "cli", "index.js");
const sourceCli = path.resolve(pluginRoot, "..", "dist", "cli", "index.js");
const local = spawnSync(process.execPath, [cli, "hook", "post-tool-use"], {
  cwd: process.cwd(),
  encoding: "utf8",
  input,
  shell: false,
  windowsHide: true,
});
if (local.error || local.status !== 0) {
  spawnSync(process.execPath, [sourceCli, "hook", "post-tool-use"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input,
    shell: false,
    windowsHide: true,
  });
}

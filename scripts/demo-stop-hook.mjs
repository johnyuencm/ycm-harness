#!/usr/bin/env node
// Demo: feed the real Stop hook two fake turns and print what the agent sees.
// Run: node scripts/demo-stop-hook.mjs
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin", "scripts", "stop-hook.mjs");
const dir = mkdtempSync(path.join(os.tmpdir(), "ycm-demo-"));

const user = (text) => ({ type: "user", message: { content: text } });
const tool = (name, input) => ({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });

const turns = {
  "read-only turn (no check)": [user("What does main.ts do?"), tool("Read", { file_path: "src/main.ts" })],
  "turn that edits and pushes (check fires)": [
    user("Fix the back button"),
    tool("Edit", { file_path: "src/nav.ts" }),
    tool("Bash", { command: "git commit -am 'fix(nav): one back press' && git push" }),
  ],
};

for (const [label, entries] of Object.entries(turns)) {
  const transcript = path.join(dir, `${label.length}.jsonl`);
  writeFileSync(transcript, entries.map((e) => JSON.stringify(e)).join("\n"));
  const payload = JSON.stringify({ hook_event_name: "Stop", session_id: "demo", cwd: dir, transcript_path: transcript });
  // YCM_HARNESS_CLI points nowhere, so only the self-contained notes check runs.
  const run = spawnSync(process.execPath, [hook], { input: payload, encoding: "utf8", cwd: dir, env: { ...process.env, YCM_HARNESS_CLI: path.join(dir, "none") } });
  const out = JSON.parse(run.stdout || "{}");
  console.log(`\n▶ ${label}`);
  console.log(out.decision === "block" ? `  agent is stopped and told:\n  "${out.reason}"` : "  agent stops normally (no output)");
}
rmSync(dir, { recursive: true, force: true });

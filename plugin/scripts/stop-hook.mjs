#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findHarnessCli } from "./harness-cli-path.mjs";

const input = (() => {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
})();
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const payload = (() => {
  try { return JSON.parse(input); } catch { return undefined; }
})();
// Cursor sends `stop` with conversation_id/workspace_roots/loop_count and reads
// `followup_message`. Claude Code and Codex send `Stop` and read decision/reason.
const isCursor = payload?.hook_event_name === "stop";
const continued = isCursor ? Number(payload?.loop_count ?? 0) > 0 : payload?.stop_hook_active === true;

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "StrReplace", "Delete", "EditNotebook", "apply_patch"]);
const SHELL_TOOLS = new Set(["Bash", "Shell"]);
// `git -C <dir> push` is a write; `git merge-base` is a read.
const DURABLE_SHELL = /\bgit\s+(?:-[Cc]\s+\S+\s+)*(commit|push|merge|tag)(?![\w-])|\bgh\s+(pr|issue)\s+(create|comment|edit|merge|close|reopen)\b/;
const CODEX_CALLS = new Set(["function_call", "custom_tool_call", "local_shell_call"]);
const NOTES_REASON = "Notes check: this turn changed files or the tracker. Before you stop, confirm that everything "
  + "you would tell the user is recorded durably, not only in chat: findings, decisions, deferrals, hand-offs, next "
  + "steps and environment facts. Use the project's own places (run record or wiki, docs, journal; committed and "
  + "pushed), issue and PR comments for hand-offs, and the machine journal or memory for environment facts. Record "
  + "anything missing now. If everything is recorded, say where in one line and stop.";

/** One transcript line → whether it starts a user turn, and its tool calls as { name, text }. */
function readEntry(entry) {
  if (!entry || typeof entry !== "object" || entry.isSidechain) return { calls: [] };
  // Codex rollout: each task starts with event_msg task_started; calls are response_items.
  if (entry.type === "event_msg") {
    return { turnStart: entry.payload?.type === "task_started" || entry.payload?.type === "user_message", calls: [] };
  }
  if (entry.type === "response_item") {
    const item = entry.payload ?? {};
    if (!CODEX_CALLS.has(item.type)) return { calls: [] };
    const text = JSON.stringify(item.arguments ?? item.input ?? item.action ?? "");
    const name = item.type === "local_shell_call" ? "Shell" : String(item.name ?? "");
    return { calls: [{ name, text, codex: true }] };
  }
  // Claude Code (`type`) and Cursor (`role`) share message.content blocks.
  const role = entry.type ?? entry.role;
  const content = entry.message?.content;
  const isToolResult = Array.isArray(content) && content.some((block) => block?.type === "tool_result");
  if (role === "user" && !entry.isMeta && !isToolResult) return { turnStart: true, calls: [] };
  if (role !== "assistant" || !Array.isArray(content)) return { calls: [] };
  return {
    calls: content
      .filter((block) => block?.type === "tool_use")
      .map((block) => ({ name: String(block.name ?? ""), text: String(block.input?.command ?? "") })),
  };
}

function isDurable({ name, text, codex }) {
  if (WRITE_TOOLS.has(name)) return true;
  if (SHELL_TOOLS.has(name)) return DURABLE_SHELL.test(text);
  // Codex wraps shell and patches in exec/function calls, so read the call text.
  return codex === true && (DURABLE_SHELL.test(text) || /\*\*\* (Begin Patch|Add File|Update File|Delete File)/.test(text));
}

/**
 * Ask once per turn for a notes check when the turn made durable changes (file
 * writes, git or tracker writes). Fails open: no transcript, an unreadable one,
 * or YCM_NOTES_CHECK=off means no check. A continued turn (Claude/Codex
 * stop_hook_active, Cursor loop_count > 0) is never asked again, so it never loops.
 */
function notesCheck() {
  if (/^(off|0|false)$/i.test(process.env.YCM_NOTES_CHECK ?? "")) return false;
  if (continued || typeof payload?.transcript_path !== "string") return false;
  let lines;
  try { lines = readFileSync(payload.transcript_path, "utf8").split("\n"); } catch { return false; }
  let changed = false;
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const { turnStart, calls } = readEntry(entry);
    if (turnStart) changed = false;
    if (calls.some(isDurable)) changed = true;
  }
  return changed;
}

/** Cursor's payload has no session_id/cwd; give the CLI the Stop shape it validates. */
function cliInput() {
  if (!isCursor) return input;
  return JSON.stringify({
    session_id: String(payload.conversation_id ?? payload.generation_id ?? "cursor"),
    cwd: String(payload.workspace_roots?.[0] ?? process.cwd()),
    hook_event_name: "Stop",
    stop_hook_active: continued,
    last_assistant_message: "",
    ...(typeof payload.transcript_path === "string" ? { transcript_path: payload.transcript_path } : {}),
  });
}

function runCli() {
  const cli = findHarnessCli(scriptDir);
  if (!cli || payload === undefined) return undefined;
  const result = spawnSync(process.execPath, [cli, "hook", "stop"], {
    cwd: process.cwd(),
    encoding: "utf8",
    input: cliInput(),
    shell: false,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !result.stdout) return undefined;
  try { return JSON.parse(result.stdout); } catch { return undefined; }
}

function emit(reason) {
  const output = reason === undefined ? {} : isCursor ? { followup_message: reason } : { decision: "block", reason };
  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(0);
}

// A harness block (unverified high-assurance work) wins over the notes check.
const cli = runCli();
if (cli?.decision === "block") {
  if (!isCursor) {
    process.stdout.write(`${JSON.stringify(cli)}\n`);
    process.exit(0);
  }
  emit(String(cli.reason ?? cli.systemMessage ?? ""));
}
// Without the tracker/CLI, do not make an optional hook a universal blocker;
// the live CLI applies high-assurance enforcement when available.
emit(notesCheck() ? NOTES_REASON : undefined);

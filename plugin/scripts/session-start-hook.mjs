#!/usr/bin/env node
// Session-start adapter for Cursor, Claude Code, and Codex.
// The core CLI owns state; this adapter normalizes the host envelope.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findHarnessCli } from "./harness-cli-path.mjs";

const FALLBACK_CONTEXT =
  "ycm-harness is configured but the CLI is not available. Install it (npm i -g ycm-harness) or run 'ycm-harness init' inside this project.";
const MAX_STDIN_BYTES = 128 * 1024;
const CLI_TIMEOUT_MS = 3_500;

function readStdin() {
  try {
    const chunks = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.allocUnsafe(Math.min(16 * 1024, MAX_STDIN_BYTES + 1 - size));
      const read = readSync(0, chunk, 0, chunk.length, null);
      if (read === 0) break;
      size += read;
      if (size > MAX_STDIN_BYTES) return { stdin: "", oversized: true };
      chunks.push(chunk.subarray(0, read));
    }
    return { stdin: Buffer.concat(chunks).toString("utf8").trim(), oversized: false };
  } catch {
    return { stdin: "", oversized: false };
  }
}

function parseHookInput(stdin) {
  if (!stdin) return null;
  try {
    return JSON.parse(stdin);
  } catch {
    return null;
  }
}

function extractAdditionalContext(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object") {
      const nested = parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput === "object"
        ? parsed.hookSpecificOutput.additionalContext
        : undefined;
      const direct = parsed.additional_context ?? parsed.additionalContext ?? nested;
      if (typeof direct === "string") return direct.trim();
      return "";
    }
  } catch {
    // Treat non-JSON stdout as plain context text.
  }
  return trimmed;
}

function tryHarness(cwd, stdin) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const runtimeDir = path.resolve(scriptDir, "..", "runtime");
  const cli = findHarnessCli(scriptDir);
  if (!cli) {
    // Broken installed projection (runtime tree present, CLI missing) is actionable.
    // Source checkout without a build, or isolated empty HOME, stays silent.
    return { kind: existsSync(runtimeDir) ? "broken-install" : "absent" };
  }
  const result = spawnSync(process.execPath, [cli, "hook", "session-start", "--payload-stdin"], {
    cwd,
    encoding: "utf8",
    shell: false,
    input: stdin || undefined,
    timeout: CLI_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  return {
    kind: "ran",
    stdout: result.status === 0 && result.stdout?.trim() ? result.stdout : null,
  };
}

function isCursorSessionStart() {
  if (process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_ENV_FILE) return false;
  const pluginRoot = process.env.PLUGIN_ROOT;
  if (typeof pluginRoot === "string" && /(?:^|[\\/])\.codex[\\/]/i.test(pluginRoot)) {
    return false;
  }
  return true;
}

function refreshCursorGithubPlugin(cwd) {
  if (!isCursorSessionStart()) return;
  if (
    process.env.NODE_TEST_CONTEXT &&
    process.env.YCM_HARNESS_GITHUB_PLUGIN !== "1"
  ) {
    return;
  }
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const refreshScript = path.join(scriptDir, "github-refresh.mjs");
  if (!existsSync(refreshScript)) return;
  // Cursor already loaded this session's rules; refresh is for the next chat.
  // Spawn the sibling script so SHA-pinned marketplace copies (no runtime/) still refresh.
  try {
    const child = spawn(process.execPath, [refreshScript, "--timeout-ms", "8000"], {
      cwd,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      shell: false,
    });
    child.unref();
  } catch {
    // GitHub plugin refresh is fail-open.
  }
}

function usesNativeSessionStartEnvelope(hookInput) {
  if (process.env.CLAUDE_PLUGIN_ROOT || process.env.CLAUDE_ENV_FILE) return true;
  const pluginRoot = process.env.PLUGIN_ROOT;
  // Codex plugin hooks set PLUGIN_ROOT under ~/.codex; Cursor does not.
  if (typeof pluginRoot === "string" && /(?:^|[\\/])\.codex[\\/]/i.test(pluginRoot)) return true;
  if (!hookInput || typeof hookInput !== "object" || Array.isArray(hookInput)) return false;
  const event = hookInput.hook_event_name ?? hookInput.hookEventName;
  return event === "SessionStart" && typeof hookInput.source === "string";
}

function emitOutput(context, hookInput) {
  if (usesNativeSessionStartEnvelope(hookInput)) {
    const hookSpecificOutput = { hookEventName: "SessionStart" };
    if (context) hookSpecificOutput.additionalContext = context;
    process.stdout.write(JSON.stringify({ hookSpecificOutput }) + "\n");
    return;
  }
  if (!context) {
    process.stdout.write("{}\n");
    return;
  }
  process.stdout.write(JSON.stringify({ additional_context: context }) + "\n");
}

let hookInput = null;
try {
  const read = readStdin();
  hookInput = parseHookInput(read.stdin);
  try {
    refreshCursorGithubPlugin(process.cwd());
  } catch {
    // GitHub plugin refresh is fail-open.
  }
  const harness = tryHarness(process.cwd(), hookInput ? read.stdin : "");
  // absent CLI in source / unbuilt tree → silent; broken install or failed CLI → warn.
  const context =
    harness.kind === "absent"
      ? null
      : harness.kind === "broken-install" || harness.stdout === null
        ? FALLBACK_CONTEXT
        : extractAdditionalContext(harness.stdout);
  emitOutput(context, hookInput);
} catch {
  emitOutput(null, hookInput);
}

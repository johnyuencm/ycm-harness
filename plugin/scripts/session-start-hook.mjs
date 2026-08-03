#!/usr/bin/env node
// Session-start adapter for Cursor and OpenCode-compatible hosts.
// The core CLI owns state; this adapter only normalizes the Cursor envelope.

import { spawnSync } from "node:child_process";
import { existsSync, readSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FALLBACK_CONTEXT =
  "ycm-harness is configured but the CLI is not available. Install it (npm i -g ycm-harness) or run 'ycm-harness init' inside this project.";
const MAX_STDIN_BYTES = 128 * 1024;

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
      const direct = parsed.additional_context ?? parsed.additionalContext;
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
  const runtimeCli = path.join(runtimeDir, "dist", "cli", "index.js");
  const sourceCli = path.resolve(scriptDir, "..", "..", "dist", "cli", "index.js");
  const cli = [runtimeCli, sourceCli].find((candidate) => existsSync(candidate));
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
  });
  return {
    kind: "ran",
    stdout: result.status === 0 && result.stdout?.trim() ? result.stdout : null,
  };
}

function emitOutput(context) {
  if (!context) {
    process.stdout.write("{}\n");
    return;
  }
  process.stdout.write(JSON.stringify({ additional_context: context }) + "\n");
}

const read = readStdin();
const hookInput = parseHookInput(read.stdin);
const harness = tryHarness(process.cwd(), hookInput ? read.stdin : "");
// absent CLI in source / unbuilt tree → silent; broken install or failed CLI → warn.
const context =
  harness.kind === "absent"
    ? null
    : harness.kind === "broken-install" || harness.stdout === null
      ? FALLBACK_CONTEXT
      : extractAdditionalContext(harness.stdout);
emitOutput(context);

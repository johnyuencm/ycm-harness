#!/usr/bin/env node
import { Command } from "commander";
import { statSync } from "node:fs";
import path from "node:path";
import { createContext } from "./context.js";
import { consoleOutput } from "./output.js";
import { registerInit } from "./commands/init.js";
import { registerStatus } from "./commands/status.js";
import { registerNext } from "./commands/next.js";
import { registerGoal } from "./commands/goal.js";
import { registerPhase } from "./commands/phase.js";
import { registerCheckpoint } from "./commands/checkpoint.js";
import { registerHook } from "./commands/hook.js";
import { registerInstall } from "./commands/install.js";
import { registerDoctor } from "./commands/doctor.js";
import { registerSync } from "./commands/sync.js";
import { registerPlugin } from "./commands/plugin.js";
import { registerWiki } from "./commands/wiki.js";
import { registerUserWiki } from "./commands/user-wiki.js";
import { registerReview } from "./commands/review.js";
import { registerSession } from "./commands/session.js";
import { registerCaveman } from "./commands/caveman.js";
import { registerRitual } from "./commands/ritual.js";
import { registerArtifact } from "./commands/artifact.js";
import { registerCommit } from "./commands/commit.js";
import { registerAutonomy } from "./commands/autonomy.js";
import { registerMigrate } from "./commands/migrate.js";
import { registerTicket } from "./commands/ticket.js";
import { registerVerify } from "./commands/verify.js";
import { CoordinationError } from "../autonomy/coordination.js";

export function buildProgram(cwd?: string): Command {
  const ctx = createContext(cwd);
  const out = consoleOutput();
  const program = new Command();
  program
    .name("ycm-harness")
    .description(
      "Lean Cursor/OpenCode coordination kernel: goals, tickets, checkpoints, verification evidence, and project knowledge.",
    )
    .option("--cwd <path>", "Override working directory");

  registerInit(program, ctx, out);
  registerStatus(program, ctx, out);
  registerNext(program, ctx, out);
  registerGoal(program, ctx, out);
  registerPhase(program, ctx, out);
  registerCheckpoint(program, ctx, out);
  registerHook(program, ctx, out);
  registerInstall(program, ctx, out);
  registerDoctor(program, ctx, out);
  registerSync(program, ctx, out);
  registerPlugin(program, ctx, out);
  registerWiki(program, ctx, out);
  registerUserWiki(program, ctx, out);
  registerReview(program, ctx, out);
  registerSession(program, ctx, out);
  registerCaveman(program, ctx, out);
  registerRitual(program, ctx, out);
  registerArtifact(program, ctx, out);
  registerCommit(program, ctx, out);
  registerAutonomy(program, ctx, out);
  registerMigrate(program, ctx, out);
  registerTicket(program, ctx, out);
  registerVerify(program, ctx, out);
  return program;
}

function cwdFromArgv(argv: string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--cwd") {
      value = argv[i + 1];
      if (!value || value.startsWith("-")) throw new Error("option '--cwd <path>' argument missing");
      i += 1;
    } else if (arg.startsWith("--cwd=")) {
      value = arg.slice("--cwd=".length);
      if (!value) throw new Error("option '--cwd <path>' argument missing");
    }
  }
  if (!value) return undefined;
  const resolved = path.resolve(value);
  try {
    if (!statSync(resolved).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Error("--cwd must name an existing directory: " + resolved);
  }
  return resolved;
}

function withoutGlobalCwd(argv: string[]): string[] {
  const kept: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--cwd") {
      i += 1;
    } else if (!arg.startsWith("--cwd=")) {
      kept.push(arg);
    }
  }
  return kept;
}
export async function runCli(argv: string[]): Promise<number> {
  try {
    const program = buildProgram(cwdFromArgv(argv));
    await program.parseAsync(withoutGlobalCwd(argv), { from: "user" });
    return 0;
  } catch (err) {
    const exitCode = (err as { exitCode?: unknown }).exitCode;
    if (typeof exitCode === "number") return exitCode;
    if (err instanceof CoordinationError) {
      process.stderr.write(JSON.stringify({ ok: false, reason_code: err.code, details: err.safeDetails ?? {} }) + "\n");
      return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);
    return 1;
  }
}

const isDirectRun = (() => {
  try {
    if (typeof process === "undefined" || !process.argv[1]) return false;
    const entry = process.argv[1].replace(/\\/g, "/");
    return entry.endsWith("/ycm-harness/dist/cli/index.js")
      || entry.endsWith("/ycm-harness/src/cli/index.ts")
      // Local checkout folder may still be named cursor-harness until orchestrator renames it.
      || entry.endsWith("/cursor-harness/dist/cli/index.js")
      || entry.endsWith("/cursor-harness/src/cli/index.ts")
      || entry.endsWith("cli/index.js")
      || entry.endsWith("cli/index.ts");
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  runCli(process.argv.slice(2)).then((code) => {
    if (code !== 0) process.exit(code);
  });
}

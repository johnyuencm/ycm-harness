import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { tempProject, cleanup, satisfyExploreGate, satisfyDiscussGate, satisfyDesignGate, satisfyPlanGate, runSmokePass } from "./helpers.js";
import { createContext } from "../src/cli/context.js";
import type { CliOutput } from "../src/cli/output.js";
import { registerInit } from "../src/cli/commands/init.js";
import { registerGoal } from "../src/cli/commands/goal.js";
import { registerPhase } from "../src/cli/commands/phase.js";
import { registerTask } from "../src/cli/commands/task.js";
import { registerCheckpoint } from "../src/cli/commands/checkpoint.js";
import { registerSmoke } from "../src/cli/commands/smoke.js";
import { registerRitual } from "../src/cli/commands/ritual.js";
import { registerArtifact } from "../src/cli/commands/artifact.js";
import { registerCommit } from "../src/cli/commands/commit.js";
import { registerNext } from "../src/cli/commands/next.js";

interface CapturedOutput extends CliOutput {
  stdout: string[];
  jsons: unknown[];
}

function captureOutput(): CapturedOutput {
  const stdout: string[] = [];
  const jsons: unknown[] = [];
  return {
    out(t) {
      stdout.push(t);
    },
    err(t) {
      stdout.push(t);
    },
    json(v) {
      jsons.push(v);
      stdout.push(JSON.stringify(v));
    },
    stdout,
    stderr: [],
    jsons,
  };
}

function buildProgram(cwd: string, out: CliOutput): Command {
  const ctx = createContext(cwd);
  const p = new Command();
  p.exitOverride();
  registerInit(p, ctx, out);
  registerGoal(p, ctx, out);
  registerPhase(p, ctx, out);
  registerTask(p, ctx, out);
  registerCheckpoint(p, ctx, out);
  registerSmoke(p, ctx, out);
  registerRitual(p, ctx, out);
  registerArtifact(p, ctx, out);
  registerCommit(p, ctx, out);
  registerNext(p, ctx, out);
  return p;
}

async function run(cwd: string, out: CapturedOutput, args: string[]): Promise<void> {
  await buildProgram(cwd, out).parseAsync(args, { from: "user" });
}

function lastTaskId(lines: string[]): string {
  for (const raw of lines) {
    const m = raw.match(/\((task_[^)]+)\)/);
    if (m) return m[1];
  }
  throw new Error(`no task id in: ${lines.join("|")}`);
}

test("execute gate blocks validate without commit record for smoke-required done task", async () => {
  const root = await tempProject("ch-v8-commit-");
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "V8 commit gate"]);
    await run(root, out, ["phase", "start", "explore"]);
    await satisfyExploreGate(root, async (a) => run(root, out, a));
    await run(root, out, ["phase", "start", "discuss"]);
    await satisfyDiscussGate(root, async (a) => run(root, out, a));
    await run(root, out, ["phase", "start", "design"]);
    await satisfyDesignGate(root, async (a) => run(root, out, a));
    await run(root, out, ["phase", "start", "plan"]);
    await run(root, out, ["task", "create", "Ship commits"]);
    await satisfyPlanGate(root, async (a) => run(root, out, a));
    await run(root, out, ["phase", "start", "execute"]);
    out.stdout.length = 0;
    await run(root, out, ["task", "list"]);
    const taskId = lastTaskId(out.stdout);
    await run(root, out, ["task", "start", taskId]);
    await runSmokePass(root, async (a) => run(root, out, a), {
      task: taskId,
      command: process.platform === "win32" ? "cmd /c exit 0" : "true",
    });
    await run(root, out, ["task", "done", taskId]);
    await assert.rejects(run(root, out, ["phase", "start", "validate"]), /commit/);
    await run(root, out, [
      "commit",
      "record",
      "--task",
      taskId,
      "--sha",
      "cafebabecafebabe",
      "--summary",
      "shipped",
    ]);
    const fs = await import("node:fs/promises");
    await fs.writeFile(`${root}/uw.md`, "uw");
    await fs.writeFile(`${root}/rp.md`, "ralph");
    await run(root, out, [
      "ritual",
      "record",
      "--kind",
      "ultrawork",
      "--evidence-file",
      `${root}/uw.md`,
      "--summary",
      "uw",
    ]);
    await run(root, out, [
      "ritual",
      "record",
      "--kind",
      "ralph",
      "--evidence-file",
      `${root}/rp.md`,
      "--summary",
      "ralph",
    ]);
    await run(root, out, ["phase", "start", "validate"]);
  } finally {
    await cleanup(root);
  }
});

test("goal status --json exposes blocking_gates", async () => {
  const root = await tempProject("ch-v8-status-");
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "V8 status json"]);
    await run(root, out, ["phase", "start", "explore"]);
    out.jsons.length = 0;
    await run(root, out, ["goal", "status", "--json"]);
    const status = out.jsons.at(-1) as { blocking_gates?: string[] };
    assert.ok(Array.isArray(status.blocking_gates));
    assert.ok(status.blocking_gates!.length > 0);
  } finally {
    await cleanup(root);
  }
});

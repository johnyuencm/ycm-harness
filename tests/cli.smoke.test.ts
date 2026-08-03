import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  tempProject,
  cleanup,
  withTempUserHome,
  satisfyExploreGate,
  satisfyDiscussGate,
  satisfyDesignGate,
  satisfyPlanGate,
  runSmokePass,
  passReviewSession,
  submitReviewVerdict,
  writeReviewEvidence,
} from "./helpers.js";
import { createContext } from "../src/cli/context.js";
import type { CliOutput } from "../src/cli/output.js";
import { registerInit } from "../src/cli/commands/init.js";
import { registerStatus } from "../src/cli/commands/status.js";
import { registerNext } from "../src/cli/commands/next.js";
import { registerGoal } from "../src/cli/commands/goal.js";
import { registerPhase } from "../src/cli/commands/phase.js";
import { registerTask } from "../src/cli/commands/task.js";
import { registerCheckpoint } from "../src/cli/commands/checkpoint.js";
import { registerSmoke } from "../src/cli/commands/smoke.js";
import { registerHook } from "../src/cli/commands/hook.js";
import { registerReview } from "../src/cli/commands/review.js";
import { registerRitual } from "../src/cli/commands/ritual.js";
import { registerArtifact } from "../src/cli/commands/artifact.js";
import { registerCommit } from "../src/cli/commands/commit.js";

interface CapturedOutput extends CliOutput {
  stdout: string[];
  stderr: string[];
  jsons: unknown[];
}

function captureOutput(): CapturedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const jsons: unknown[] = [];
  return {
    out(text) {
      stdout.push(text);
    },
    err(text) {
      stderr.push(text);
    },
    json(value) {
      jsons.push(value);
      stdout.push(JSON.stringify(value));
    },
    stdout,
    stderr,
    jsons,
  };
}

function buildScopedProgram(cwd: string, out: CliOutput): Command {
  const ctx = createContext(cwd);
  const program = new Command();
  program.name("ycm-harness").exitOverride();
  registerInit(program, ctx, out);
  registerStatus(program, ctx, out);
  registerNext(program, ctx, out);
  registerGoal(program, ctx, out);
  registerPhase(program, ctx, out);
  registerTask(program, ctx, out);
  registerCheckpoint(program, ctx, out);
  registerSmoke(program, ctx, out);
  registerHook(program, ctx, out);
  registerReview(program, ctx, out);
  registerRitual(program, ctx, out);
  registerArtifact(program, ctx, out);
  registerCommit(program, ctx, out);
  return program;
}

async function advanceToDiscuss(root: string, out: CapturedOutput): Promise<void> {
  await run(root, out, ["phase", "start", "explore"]);
  await satisfyExploreGate(root, async (args) => run(root, out, args));
  await run(root, out, ["phase", "start", "discuss"]);
}

async function run(cwd: string, out: CapturedOutput, args: string[]): Promise<void> {
  const program = buildScopedProgram(cwd, out);
  await program.parseAsync(args, { from: "user" });
}

function lastTaskIdFromList(lines: string[]): string {
  for (const raw of lines) {
    const m = raw.match(/\((task_[^)]+)\)/);
    if (m && m[1].startsWith("task_")) return m[1];
  }
  throw new Error(`Could not find task id in output: ${lines.join("\n")}`);
}

async function evidence(root: string, name: string): Promise<string> {
  const file = path.join(root, `${name}.md`);
  await fs.writeFile(file, `${name} evidence`, "utf8");
  return file;
}

async function recordRitual(
  root: string,
  out: CapturedOutput,
  kind: string,
  meta: string[] = [],
): Promise<void> {
  const args = [
    "ritual",
    "record",
    "--kind",
    kind,
    "--evidence-file",
    await evidence(root, `ritual-${kind}`),
    "--summary",
    `${kind} complete`,
  ];
  for (const m of meta) args.push("--meta", m);
  await run(root, out, args);
}

async function currentPhaseId(root: string, out: CapturedOutput): Promise<string> {
  out.jsons.length = 0;
  await run(root, out, ["next", "--json"]);
  const next = out.jsons.at(-1) as { phase_id?: string };
  assert.ok(next.phase_id, "expected active phase id");
  return next.phase_id;
}

async function advanceToPlan(root: string, out: CapturedOutput): Promise<void> {
  await advanceToDiscuss(root, out);
  await satisfyDiscussGate(root, async (args) => run(root, out, args));
  await run(root, out, ["phase", "start", "design"]);
  await satisfyDesignGate(root, async (args) => run(root, out, args));
  await run(root, out, ["phase", "start", "plan"]);
}

async function satisfyExecute(root: string, out: CapturedOutput): Promise<void> {
  await recordRitual(root, out, "ultrawork");
  await recordRitual(root, out, "ralph");
}

async function satisfyValidate(root: string, out: CapturedOutput): Promise<void> {
  const phaseId = await currentPhaseId(root, out);
  await runSmokePass(root, async (args) => run(root, out, args), { phase: phaseId });
  out.stdout.length = 0;
  await run(root, out, ["review", "start", "--target", "phase", "--id", phaseId]);
  const sessionId = out.stdout.find((l) => l.startsWith("Review session opened: "))
    ?.slice("Review session opened: ".length)
    .trim();
  assert.ok(sessionId, "expected review session id");
  await passReviewSession(root, async (args) => run(root, out, args), sessionId);
  await recordRitual(root, out, "review-gate");
}

async function satisfyFinish(root: string, out: CapturedOutput): Promise<void> {
  const prog = await evidence(root, "progress-final");
  await run(root, out, [
    "artifact",
    "register",
    "--kind",
    "progress",
    "--path",
    prog,
    "--summary",
    "final progress",
  ]);
  await recordRitual(root, out, "project-wiki-update");
  await run(root, out, ["checkpoint", "manual", "Goal closed"]);
}

test("task created in plan phase migrates into execute when activated", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "Migration goal"]);
    await advanceToPlan(root, out);
    await run(root, out, ["task", "create", "Drafted in plan", "--smoke", "not_applicable"]);
    await satisfyPlanGate(root, async (args) => run(root, out, args));
    out.stdout.length = 0;
    await run(root, out, ["task", "list"]);
    const planTaskId = lastTaskIdFromList(out.stdout);
    await run(root, out, ["phase", "start", "execute"]);
    await run(root, out, ["task", "start", planTaskId]);
    out.jsons.length = 0;
    await run(root, out, ["status", "--json"]);
    const json = out.jsons.at(-1) as Record<string, unknown>;
    assert.equal(json.task_status, "active");
    assert.equal(json.task_title, "Drafted in plan");
    assert.equal(json.phase_kind, "execute");
  } finally {
    await cleanup(root);
  }
});

test("CLI golden path: init -> goal -> discuss -> plan -> execute task with smoke -> validate -> finish", async () => {
  await withTempUserHome(async () => {
    const root = await tempProject();
    try {
      const out = captureOutput();

      await run(root, out, ["init"]);
      assert.ok(
        await fs
          .stat(path.join(root, ".ycm-harness", "state.json"))
          .then(() => true)
          .catch(() => false),
      );

      await run(root, out, ["goal", "create", "Demo goal", "-d", "End-to-end smoke run"]);
      await advanceToPlan(root, out);
      await run(root, out, ["task", "create", "Implement first feature"]);
      await satisfyPlanGate(root, async (args) => run(root, out, args));
      await run(root, out, ["phase", "start", "execute"]);

      out.stdout.length = 0;
      await run(root, out, ["task", "list"]);
      const taskId = lastTaskIdFromList(out.stdout);

      await run(root, out, ["task", "start", taskId]);

      await assert.rejects(
        () => run(root, out, ["task", "done", taskId]),
        /requires smoke evidence/,
      );

      await runSmokePass(root, async (args) => run(root, out, args), {
        task: taskId,
        command: 'node -e "console.log(\'hi\')"',
      });

      await run(root, out, ["task", "done", taskId]);
      await run(root, out, [
        "commit",
        "record",
        "--task",
        taskId,
        "--sha",
        "deadbeef00000000",
        "--summary",
        "implemented first feature",
      ]);
      await satisfyExecute(root, out);

      await run(root, out, ["phase", "start", "validate"]);
      await satisfyValidate(root, out);

      out.stdout.length = 0;
      await run(root, out, ["phase", "list"]);
      const validatePhaseLine = out.stdout.find((l) => /\bvalidate\b/.test(l));
      assert.ok(validatePhaseLine, "validate phase should be listed");
      const validatePhaseId = (() => {
        // grab phase line with status active
        // phase ids are not printed by phase list; use status JSON instead
        return undefined;
      })();
      assert.equal(validatePhaseId, undefined);

      out.stdout.length = 0;
      await run(root, out, ["status", "--json"]);
      const statusJson = out.jsons.at(-1) as Record<string, unknown>;
      assert.equal(statusJson.phase_kind, "validate");

      await run(root, out, ["phase", "complete"]);
      await run(root, out, ["phase", "start", "finish"]);
      await satisfyFinish(root, out);

      out.jsons.length = 0;
      await run(root, out, ["hook", "session-start"]);
      const hookOut = out.jsons.at(-1) as { additional_context: string };
      assert.match(hookOut.additional_context, /Demo goal/);
      assert.match(hookOut.additional_context, /Next action/);
    } finally {
      await cleanup(root);
    }
  });
});

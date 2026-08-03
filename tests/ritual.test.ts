import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  tempProject,
  cleanup,
  satisfyExploreGate,
  satisfyDiscussGate,
  satisfyDesignGate,
  satisfyPlanGate,
} from "./helpers.js";
import { createContext } from "../src/cli/context.js";
import type { CliOutput } from "../src/cli/output.js";
import { registerInit } from "../src/cli/commands/init.js";
import { registerGoal } from "../src/cli/commands/goal.js";
import { registerPhase } from "../src/cli/commands/phase.js";
import { registerCheckpoint } from "../src/cli/commands/checkpoint.js";
import { registerTask } from "../src/cli/commands/task.js";
import { registerRitual } from "../src/cli/commands/ritual.js";
import { registerArtifact } from "../src/cli/commands/artifact.js";

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

function buildProgram(cwd: string, out: CliOutput): Command {
  const ctx = createContext(cwd);
  const program = new Command();
  program.name("ycm-harness").exitOverride();
  registerInit(program, ctx, out);
  registerGoal(program, ctx, out);
  registerPhase(program, ctx, out);
  registerCheckpoint(program, ctx, out);
  registerTask(program, ctx, out);
  registerRitual(program, ctx, out);
  registerArtifact(program, ctx, out);
  return program;
}

async function advanceToDiscuss(root: string, out: CapturedOutput): Promise<void> {
  await run(root, out, ["phase", "start", "explore"]);
  await satisfyExploreGate(root, async (args) => run(root, out, args));
  await run(root, out, ["phase", "start", "discuss"]);
}

async function advanceToPlan(root: string, out: CapturedOutput): Promise<void> {
  await advanceToDiscuss(root, out);
  await satisfyDiscussGate(root, async (args) => run(root, out, args));
  await run(root, out, ["phase", "start", "design"]);
  await satisfyDesignGate(root, async (args) => run(root, out, args));
  await run(root, out, ["phase", "start", "plan"]);
}

async function run(cwd: string, out: CapturedOutput, args: string[]): Promise<void> {
  const program = buildProgram(cwd, out);
  await program.parseAsync(args, { from: "user" });
}

async function evidence(root: string, name: string): Promise<string> {
  const file = path.join(root, `${name}.md`);
  await fs.writeFile(file, `${name} evidence`, "utf8");
  return file;
}

async function ritual(
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
    await evidence(root, `ritual-${kind}-${meta.join("-") || "plain"}`),
    "--summary",
    `${kind} complete`,
  ];
  for (const m of meta) args.push("--meta", m);
  await run(root, out, args);
}

test("V4 discuss gate requires grill-me ritual and a decision checkpoint", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "V4 gate test"]);
    await advanceToDiscuss(root, out);

    await assert.rejects(
      run(root, out, ["phase", "start", "design"]),
      /user-story|grill-me|prd/,
    );

    await satisfyDiscussGate(root, async (args) => run(root, out, args));
    await run(root, out, ["phase", "start", "design"]);
  } finally {
    await cleanup(root);
  }
});

test("V4 plan gate enforces writing-plans metadata and conditional ralplan", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "V4 plan gate"]);
    await advanceToPlan(root, out);
    await run(root, out, ["task", "create", "Planned task"]);

    await assert.rejects(
      run(root, out, ["phase", "start", "execute"]),
      /writing-plans ritual/,
    );

    await satisfyPlanGate(root, async (args) => run(root, out, args));
    await run(root, out, ["phase", "start", "execute"]);
  } finally {
    await cleanup(root);
  }
});

test("ritual record requires an existing evidence file", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "Missing evidence"]);
    await run(root, out, ["phase", "start", "explore"]);
    await assert.rejects(
      run(root, out, [
        "ritual",
        "record",
        "--kind",
        "grill-me",
        "--evidence-file",
        path.join(root, "does-not-exist.md"),
        "--summary",
        "bad",
      ]),
      /ENOENT/,
    );
  } finally {
    await cleanup(root);
  }
});

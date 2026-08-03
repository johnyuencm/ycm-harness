import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import { tempProject, cleanup, satisfyExploreGate, satisfyDiscussGate, satisfyDesignGate } from "./helpers.js";
import { createContext } from "../src/cli/context.js";
import type { CliOutput } from "../src/cli/output.js";
import { registerInit } from "../src/cli/commands/init.js";
import { registerGoal } from "../src/cli/commands/goal.js";
import { registerPhase } from "../src/cli/commands/phase.js";
import { registerArtifact } from "../src/cli/commands/artifact.js";
import { registerRitual } from "../src/cli/commands/ritual.js";
import { registerCheckpoint } from "../src/cli/commands/checkpoint.js";
import { PHASE_ORDER } from "../src/workflow/transitions.js";

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
  registerArtifact(p, ctx, out);
  registerRitual(p, ctx, out);
  registerCheckpoint(p, ctx, out);
  return p;
}

async function run(cwd: string, out: CapturedOutput, args: string[]): Promise<void> {
  await buildProgram(cwd, out).parseAsync(args, { from: "user" });
}

test("PHASE_ORDER includes design between discuss and plan", () => {
  assert.deepEqual(PHASE_ORDER, [
    "explore",
    "discuss",
    "design",
    "plan",
    "execute",
    "validate",
    "finish",
  ]);
});

test("scaffold creates product doc templates", async () => {
  const root = await tempProject("ch-v6-scaffold-");
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "V6 scaffold"]);
    await run(root, out, ["goal", "scaffold-artifacts"]);
    const goalDir = `${root}/.ycm-harness/goals`;
    const entries = await import("node:fs/promises").then((fs) => fs.readdir(goalDir));
    const goalFolder = entries.find((e) => e.startsWith("goal_"));
    assert.ok(goalFolder);
    const files = await import("node:fs/promises").then((fs) =>
      fs.readdir(`${goalDir}/${goalFolder}`),
    );
    assert.ok(files.includes("user-story.md"));
    assert.ok(files.includes("design.md"));
    assert.ok(files.includes("progress.md"));
  } finally {
    await cleanup(root);
  }
});

test("discuss gate requires user-story and prd artifacts", async () => {
  const root = await tempProject("ch-v6-discuss-");
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "V6 discuss gate"]);
    await run(root, out, ["phase", "start", "explore"]);
    await satisfyExploreGate(root, async (a) => run(root, out, a));
    await run(root, out, ["phase", "start", "discuss"]);
    await assert.rejects(run(root, out, ["phase", "start", "design"]), /user-story|prd/);
    await satisfyDiscussGate(root, async (a) => run(root, out, a));
    await run(root, out, ["phase", "start", "design"]);
  } finally {
    await cleanup(root);
  }
});

test("design gate requires design artifact", async () => {
  const root = await tempProject("ch-v6-design-");
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "V6 design gate"]);
    await run(root, out, ["phase", "start", "explore"]);
    await satisfyExploreGate(root, async (a) => run(root, out, a));
    await run(root, out, ["phase", "start", "discuss"]);
    await satisfyDiscussGate(root, async (a) => run(root, out, a));
    await run(root, out, ["phase", "start", "design"]);
    await assert.rejects(run(root, out, ["phase", "start", "plan"]), /design artifact/);
    await satisfyDesignGate(root, async (a) => run(root, out, a));
    await run(root, out, ["phase", "start", "plan"]);
  } finally {
    await cleanup(root);
  }
});

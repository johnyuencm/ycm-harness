import { test } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";
import {
  tempProject,
  cleanup,
  trivialSmokeCommand,
  runSmokePass,
  submitReviewVerdict,
  passReviewSession,
} from "./helpers.js";
import { createContext } from "../src/cli/context.js";
import type { CliOutput } from "../src/cli/output.js";
import { registerInit } from "../src/cli/commands/init.js";
import { registerGoal } from "../src/cli/commands/goal.js";
import { registerPhase } from "../src/cli/commands/phase.js";
import { registerTask } from "../src/cli/commands/task.js";
import { registerSmoke } from "../src/cli/commands/smoke.js";
import { registerReview } from "../src/cli/commands/review.js";
import { registerArtifact } from "../src/cli/commands/artifact.js";

interface CapturedOutput extends CliOutput {
  stdout: string[];
}

function captureOutput(): CapturedOutput & { jsons: unknown[] } {
  const stdout: string[] = [];
  const jsons: unknown[] = [];
  return {
    out(text) {
      stdout.push(text);
    },
    err(text) {},
    json(value) {
      jsons.push(value);
      stdout.push(JSON.stringify(value));
    },
    stdout,
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
  registerTask(program, ctx, out);
  registerSmoke(program, ctx, out);
  registerReview(program, ctx, out);
  registerArtifact(program, ctx, out);
  return program;
}

async function run(cwd: string, out: CapturedOutput, args: string[]): Promise<void> {
  await buildProgram(cwd, out).parseAsync(args, { from: "user" });
}

test("strict mode blocks manual pass smoke", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "smoke strict"]);
    await run(root, out, ["phase", "start", "explore"]);
    await assert.rejects(
      run(root, out, [
        "smoke",
        "record",
        "--phase",
        "phase_explore_x",
        "--outcome",
        "pass",
      ]),
      /Manual pass smoke is disabled/,
    );
  } finally {
    await cleanup(root);
  }
});

test("smoke run executes command and records executed evidence", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "smoke run"]);
    await run(root, out, ["phase", "start", "explore"]);
    out.stdout.length = 0;
    await run(root, out, ["phase", "list"]);
    const phaseLine = out.stdout.find((l) => l.includes("explore"));
    assert.ok(phaseLine);
    const phaseId = phaseLine!.split(/\s+/).pop()!.replace(/[^\w].*$/, "");
    // phase list format: "00 explore [active] explore" - extract id from state instead
    const { readFile } = await import("node:fs/promises");
    const state = JSON.parse(await readFile(`${root}/.ycm-harness/state.json`, "utf8"));
    const explorePhase = Object.values(state.phases as Record<string, { kind: string; id: string }>).find(
      (p) => p.kind === "explore",
    );
    assert.ok(explorePhase);
    await runSmokePass(root, async (a) => run(root, out, a), {
      phase: explorePhase!.id,
      command: trivialSmokeCommand(),
    });
    const stateAfter = JSON.parse(await readFile(`${root}/.ycm-harness/state.json`, "utf8"));
    const smoke = Object.values(stateAfter.smoke as Record<string, { recording_mode: string; log_file?: string }>)[0];
    assert.equal(smoke.recording_mode, "executed");
    assert.ok(smoke.log_file);
  } finally {
    await cleanup(root);
  }
});

test("strict mode blocks orchestrator review verdict without evidence file", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "review strict"]);
    await run(root, out, ["phase", "start", "explore"]);
    const { readFile } = await import("node:fs/promises");
    const state = JSON.parse(await readFile(`${root}/.ycm-harness/state.json`, "utf8"));
    const explorePhase = Object.values(state.phases as Record<string, { kind: string; id: string }>).find(
      (p) => p.kind === "explore",
    );
    out.stdout.length = 0;
    await run(root, out, ["review", "start", "--target", "phase", "--id", explorePhase!.id]);
    const sessionId = out.stdout.find((l) => l.startsWith("Review session opened: "))!.slice(23).trim();
    await assert.rejects(
      run(root, out, ["review", "verdict", "--session", sessionId, "--reviewer", "combined_reviewer", "--score", "99"]),
      /Strict mode requires --evidence-file/,
    );
  } finally {
    await cleanup(root);
  }
});

test("orchestrator-sourced evidence is rejected", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "orch block"]);
    await run(root, out, ["phase", "start", "explore"]);
    const { readFile, writeFile } = await import("node:fs/promises");
    const state = JSON.parse(await readFile(`${root}/.ycm-harness/state.json`, "utf8"));
    const explorePhase = Object.values(state.phases as Record<string, { kind: string; id: string }>).find(
      (p) => p.kind === "explore",
    );
    out.stdout.length = 0;
    await run(root, out, ["review", "start", "--target", "phase", "--id", explorePhase!.id]);
    const sessionId = out.stdout.find((l) => l.startsWith("Review session opened: "))!.slice(23).trim();
    const bad = {
      schema_version: 1,
      session_id: sessionId,
      reviewer: "combined_reviewer",
      score: 99,
      reviewer_source: "orchestrator",
      subagent_kind: "orchestrator",
      reviewed_at: new Date().toISOString(),
      checks_performed: ["self"],
      findings: [],
      ack_zero_findings_reason: "I looked at it myself and it is fine trust me.",
    };
    const path = `${root}/bad-review.json`;
    await writeFile(path, JSON.stringify(bad));
    await assert.rejects(
      run(root, out, [
        "review",
        "verdict",
        "--session",
        sessionId,
        "--reviewer",
        "combined_reviewer",
        "--evidence-file",
        path,
      ]),
      /orchestrator self-review blocked/,
    );
  } finally {
    await cleanup(root);
  }
});

test("passReviewSession requires one independent combined reviewer", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "combined review"]);
    await run(root, out, ["phase", "start", "explore"]);
    const { readFile } = await import("node:fs/promises");
    const state = JSON.parse(await readFile(`${root}/.ycm-harness/state.json`, "utf8"));
    const explorePhase = Object.values(state.phases as Record<string, { kind: string; id: string }>).find(
      (p) => p.kind === "explore",
    );
    out.stdout.length = 0;
    await run(root, out, ["review", "start", "--target", "phase", "--id", explorePhase!.id]);
    const sessionId = out.stdout.find((l) => l.startsWith("Review session opened: "))!.slice(23).trim();
    await assert.rejects(
      run(root, out, [
        "review",
        "evidence-init",
        "--session",
        sessionId,
        "--reviewer",
        "tech_lead",
        "--subagent",
        "tech_lead",
        "--out",
        "legacy.json",
      ]),
      /--reviewer must be one of combined_reviewer/,
    );
    await passReviewSession(root, async (a) => run(root, out, a), sessionId);
    out.jsons.length = 0;
    await run(root, out, ["review", "status", sessionId, "--json"]);
    // status outputs json via out.json in captureOutput - need json capture
    const statusLine = out.stdout.find((l) => l.startsWith("{"));
    assert.ok(statusLine);
    const status = JSON.parse(statusLine!) as { gate: string };
    assert.equal(status.gate, "passed");
    out.stdout.length = 0;
    await run(root, out, ["review", "status", sessionId]);
    assert.ok(out.stdout.some((line) => /reviewers: 1\/1/.test(line)));
  } finally {
    await cleanup(root);
  }
});

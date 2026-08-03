import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { tempProject, cleanup, evidenceFile, satisfyExploreGate } from "./helpers.js";
import { createContext } from "../src/cli/context.js";
import type { CliOutput } from "../src/cli/output.js";
import { registerInit } from "../src/cli/commands/init.js";
import { registerGoal } from "../src/cli/commands/goal.js";
import { registerPhase } from "../src/cli/commands/phase.js";
import { registerRitual } from "../src/cli/commands/ritual.js";
import { registerArtifact } from "../src/cli/commands/artifact.js";
import { HarnessStore } from "../src/state/store.js";
import { State, emptyState, migrateStateIfNeeded } from "../src/schema/state.js";

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
  registerRitual(program, ctx, out);
  registerArtifact(program, ctx, out);
  return program;
}

async function run(cwd: string, out: CapturedOutput, args: string[]): Promise<void> {
  await buildProgram(cwd, out).parseAsync(args, { from: "user" });
}

function gitAvailable(cwd: string): boolean {
  const probe = spawnSync("git", ["--version"], { cwd, stdio: "ignore" });
  return probe.status === 0;
}

function initBareGitRepo(cwd: string): void {
  const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd, stdio: "ignore" });
  if (init.status !== 0) throw new Error("git init failed");
  spawnSync("git", ["config", "user.email", "test@example.com"], { cwd, stdio: "ignore" });
  spawnSync("git", ["config", "user.name", "Tester"], { cwd, stdio: "ignore" });
  spawnSync("git", ["commit", "--allow-empty", "-q", "-m", "init"], { cwd, stdio: "ignore" });
}

test("V5 schema: State.emptyState has version 2 and empty artifacts map", () => {
  const blank = emptyState("2026-05-25T00:00:00.000Z");
  const parsed = State.parse(blank);
  assert.equal(parsed.version, 2);
  assert.deepEqual(parsed.artifacts, {});
});

test("V5 migration: V1-shape state migrates additively to V2", () => {
  const legacy = {
    version: 1,
    created_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
    goals: {
      g1: {
        id: "g1",
        title: "Old goal",
        status: "active",
        created_at: "2026-05-25T00:00:00.000Z",
        updated_at: "2026-05-25T00:00:00.000Z",
      },
    },
    phases: {},
    tasks: {},
    checkpoints: {},
    smoke: {},
    sessions: {},
    wiki: { initialized: false, pages: {}, sources: {}, log: [] },
    reviews: {},
    rituals: {},
    session_nudge: { user_msgs_since_wiki_write: 0 },
  };
  const migrated = migrateStateIfNeeded(legacy) as Record<string, unknown>;
  assert.equal(migrated.version, 2);
  const goals = migrated.goals as Record<string, Record<string, unknown>>;
  assert.equal(goals.g1.worktree_status, "pending");
  const parsed = State.parse(migrated);
  assert.equal(parsed.version, 2);
  assert.equal(parsed.goals["g1"]?.worktree_status, "pending");
  assert.deepEqual(parsed.artifacts, {});
});

test("V5 artifact CLI: register + list + status JSON", async () => {
  const root = await tempProject("ch-v5-artifact-");
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "Artifact CLI smoke"]);
    const evi = await evidenceFile(root, "synthesis");
    await run(root, out, [
      "artifact",
      "register",
      "--kind",
      "explore-synthesis",
      "--path",
      evi,
      "--summary",
      "synthesis ok",
    ]);
    out.jsons.length = 0;
    await run(root, out, ["artifact", "status"]);
    const payload = out.jsons.at(-1) as { artifacts: { kind: string }[]; count: number };
    assert.equal(payload.count, 1);
    assert.equal(payload.artifacts[0].kind, "explore-synthesis");
    await assert.rejects(
      run(root, out, [
        "artifact",
        "register",
        "--kind",
        "explore-report",
        "--path",
        path.join(root, "missing.md"),
        "--summary",
        "x",
      ]),
      /ENOENT/,
    );
  } finally {
    await cleanup(root);
  }
});

test("V5 explore gate: rejects until synthesis + 2 reports + 2 rituals are present", async () => {
  const root = await tempProject("ch-v5-gate-");
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "Explore gate"]);
    await run(root, out, ["phase", "start", "explore"]);
    await assert.rejects(
      run(root, out, ["phase", "start", "discuss"]),
      /explore-synthesis/,
    );
    await satisfyExploreGate(root, async (args) => run(root, out, args));
    await run(root, out, ["phase", "start", "discuss"]);
  } finally {
    await cleanup(root);
  }
});

test("V5 worktree CLI: init creates a worktree in a temp git repo and updates goal state", async (t) => {
  const root = await tempProject("ch-v5-worktree-");
  try {
    if (!gitAvailable(root)) {
      t.skip("git is not available on PATH");
      return;
    }
    initBareGitRepo(root);
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "Worktree smoke", "-d", "Bind a goal-scoped worktree"]);
    await run(root, out, ["goal", "worktree", "init"]);

    const store = new HarnessStore(root);
    const state = await store.readState();
    const goal = state.goals[state.active_goal_id!];
    assert.ok(goal, "goal must exist");
    assert.equal(goal.worktree_status, "active");
    assert.match(goal.worktree_path ?? "", /worktrees/);
    assert.match(goal.branch ?? "", /^harness\//);

    const wtAbs = path.join(root, goal.worktree_path!);
    const stat = await fs.stat(wtAbs);
    assert.ok(stat.isDirectory(), "worktree path must exist as a directory");

    out.jsons.length = 0;
    await run(root, out, ["goal", "worktree", "status", "--json"]);
    const status = out.jsons.at(-1) as { worktree_status: string; branch?: string };
    assert.equal(status.worktree_status, "active");
    assert.match(status.branch ?? "", /^harness\//);
  } finally {
    await cleanup(root);
  }
});

test("V5 worktree CLI: refuses outside a git repo with an actionable error", async () => {
  const root = await tempProject("ch-v5-no-git-");
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "No git here"]);
    await assert.rejects(
      run(root, out, ["goal", "worktree", "init"]),
      /not inside a git work tree/,
    );
  } finally {
    await cleanup(root);
  }
});

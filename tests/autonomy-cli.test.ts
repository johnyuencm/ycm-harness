import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HarnessStore } from "../src/state/store.js";
import { cleanup, tempProject } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(repoRoot, "dist", "cli", "index.js");

async function activeHarness(): Promise<string> {
  const root = await tempProject("ch-autonomy-cli-");
  const store = new HarnessStore(root);
  await store.init();
  await store.update((state) => {
    state.goals.goal = {
      id: "goal",
      title: "CLI goal",
      status: "active",
      worktree_status: "active",
      created_at: state.created_at,
      updated_at: state.updated_at,
    };
    state.active_goal_id = "goal";
    return state;
  });
  return root;
}

function run(root: string, args: string[], input = "") {
  return spawnSync(process.execPath, [cli, "--cwd", root, "autonomy", ...args], {
    cwd: root,
    encoding: "utf8",
    input,
  });
}

const request = {
  title: "Durable follow-up",
  source_class: "operator",
  source: "CLI test",
  problem: "Keep the request",
  impact_scope: "One task",
  owner_control: "Bound coordinator",
  acceptance: ["Task exists"],
  verification: ["Live readback"],
  dependencies: [],
  safety_blockers: [],
  cost_class: "bounded",
  evidence_horizon: "Before finish",
  rollback: "Leave open",
  status: "todo",
  priority: "medium",
};

test("autonomy operator commands expose bounded JSON surfaces and stable reason codes", async () => {
  const root = await activeHarness();
  try {
    const file = path.join(root, "request.json");
    await fs.writeFile(file, JSON.stringify(request), "utf8");

    for (const args of [["ensure", "--file", file], ["ensure"]] as string[][]) {
      const result = run(root, args, args.length === 1 ? JSON.stringify(request) : "");
      assert.equal(result.status, 1);
      assert.equal(JSON.parse(result.stderr).reason_code, "binding_missing");
    }

    for (const name of ["continuation", "continuations"]) {
      const unknown = run(root, [name, "--help"]);
      assert.equal(unknown.status, 1);
      assert.match(unknown.stderr, new RegExp(`unknown command '${name}'`));
    }

    const supported = run(root, ["status", "--help"]);
    assert.equal(supported.status, 0, supported.stderr);
    assert.match(supported.stdout, /Live-verify binding/);

    const ensureHelp = run(root, ["ensure", "--help"]);
    assert.equal(ensureHelp.status, 0, ensureHelp.stderr);
    assert.match(ensureHelp.stdout, /Required JSON fields: title, source_class, source, problem, impact_scope/);
    assert.match(ensureHelp.stdout, /status="todo", priority="medium"/);

    const retry = run(root, ["retry", "--limit", "1"]);
    assert.equal(retry.status, 0, retry.stderr);
    assert.deepEqual(JSON.parse(retry.stdout), []);

    const status = run(root, ["status", "--limit", "1"]);
    assert.equal(status.status, 1);
    assert.equal(JSON.parse(status.stderr).reason_code, "binding_missing");

    const post = run(root, ["verify-payload"], JSON.stringify({
      session_id: "session",
      turn_id: "turn",
      cwd: root,
      hook_event_name: "PostToolUse",
      model: "test",
      tool_name: "apply_patch",
      tool_input: { patch: "PRIVATE" },
      tool_response: { success: true },
      tool_use_id: "tool",
    }));
    assert.equal(post.status, 0, post.stderr);
    assert.equal(JSON.parse(post.stdout).mode, "local");

    const stop = run(root, ["verify-payload"], JSON.stringify({
      session_id: "session",
      cwd: root,
      hook_event_name: "Stop",
      last_assistant_message: "Follow-ups:\n- Must not mutate remotely",
    }));
    assert.equal(stop.status, 0, stop.stderr);
    const dry = JSON.parse(stop.stdout);
    assert.equal(dry.mode, "dry");
    assert.equal(dry.result.ordinary.stopReason, "cursor_harness_no_phase");
    assert.equal(dry.result.follow_ups[0].item, "Must not mutate remotely");
    assert.equal(dry.result.follow_ups[0].request.title, "Must not mutate remotely");
  } finally {
    await cleanup(root);
  }
});

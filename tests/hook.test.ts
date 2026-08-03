import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHookOutput, buildSessionDigest } from "../src/hooks/session-start.js";
import { buildStopHookOutput } from "../src/hooks/stop.js";
import { emptyState } from "../src/schema/state.js";

const NOW = "2026-05-25T00:00:00.000Z";

function activeGoalState(
  title: string,
  goalStatus: "active" | "blocked" | "done" | "abandoned" = "active",
) {
  const state = emptyState(NOW);
  state.goals.g1 = {
    id: "g1",
    title,
    status: goalStatus,
    worktree_status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
  state.active_goal_id = "g1";
  return state;
}

test("session digest with no state explains how to initialize", () => {
  const digest = buildSessionDigest(undefined);
  assert.equal(digest.has_state, false);
  assert.match(digest.next_action, /init/);
  const out = buildHookOutput(digest);
  assert.match(out.additional_context, /not initialized/);
});

test("session digest reports goal/phase/task and a next command", () => {
  const state = emptyState(NOW);
  state.goals["g1"] = {
    id: "g1",
    title: "Demo Goal",
    status: "active",
    worktree_status: "active",
    worktree_path: ".worktrees/demo",
    branch: "harness/g1",
    created_at: NOW,
    updated_at: NOW,
  };
  state.active_goal_id = "g1";
  state.phases["p1"] = {
    id: "p1",
    goal_id: "g1",
    kind: "execute",
    title: "exec",
    status: "active",
    order: 0,
    created_at: NOW,
    updated_at: NOW,
  };
  state.tasks["t1"] = {
    id: "t1",
    phase_id: "p1",
    title: "Implement first feature",
    status: "active",
    smoke: "required",
    smoke_evidence_ids: [],
    order: 0,
    created_at: NOW,
    updated_at: NOW,
  };

  const digest = buildSessionDigest(state);
  assert.equal(digest.goal_title, "Demo Goal");
  assert.equal(digest.phase_kind, "execute");
  assert.equal(digest.task_title, "Implement first feature");
  assert.match(digest.next_command ?? "", /smoke --task t1/);

  const hook = buildHookOutput(digest);
  assert.match(hook.additional_context, /Demo Goal/);
  assert.match(hook.additional_context, /Next action/);
});

test("stop hook blocks active non-discuss harness work", () => {
  const state = emptyState(NOW);
  state.goals.g1 = {
    id: "g1",
    title: "Long Goal",
    status: "active",
    worktree_status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
  state.active_goal_id = "g1";
  state.phases.p1 = {
    id: "p1",
    goal_id: "g1",
    kind: "execute",
    title: "Execute",
    status: "active",
    order: 4,
    created_at: NOW,
    updated_at: NOW,
  };

  const output = buildStopHookOutput(state);
  assert.equal(output?.decision, "block");
  assert.equal(output?.stopReason, "cursor_harness_execute");
  assert.match(output?.systemMessage ?? "", /continue/i);
  assert.match(output?.systemMessage ?? "", /validate and finish/i);
});

test("stop hook allows deliberate discuss/user-interview pause", () => {
  const state = emptyState(NOW);
  state.goals.g1 = {
    id: "g1",
    title: "Discuss Goal",
    status: "active",
    worktree_status: "active",
    created_at: NOW,
    updated_at: NOW,
  };
  state.active_goal_id = "g1";
  state.phases.p1 = {
    id: "p1",
    goal_id: "g1",
    kind: "discuss",
    title: "Discuss",
    status: "active",
    order: 1,
    created_at: NOW,
    updated_at: NOW,
  };

  assert.equal(buildStopHookOutput(state), null);
});

test("stop hook allows completed finish", () => {
  const state = activeGoalState("Done Goal");
  state.phases.p1 = {
    id: "p1",
    goal_id: "g1",
    kind: "finish",
    title: "Finish",
    status: "complete",
    order: 6,
    created_at: NOW,
    updated_at: NOW,
  };

  assert.equal(buildStopHookOutput(state), null);
});

test("stop hook allows missing state", () => {
  assert.equal(buildStopHookOutput(undefined), null);
});

test("stop hook allows goals already marked terminal", () => {
  for (const status of ["done", "blocked", "abandoned"] as const) {
    const state = activeGoalState(`Terminal Goal ${status}`, status);
    assert.equal(buildStopHookOutput(state), null);
  }
});

test("stop hook allows blocked phases", () => {
  const state = activeGoalState("Blocked Goal");
  state.phases.p1 = {
    id: "p1",
    goal_id: "g1",
    kind: "execute",
    title: "Execute",
    status: "blocked",
    order: 4,
    created_at: NOW,
    updated_at: NOW,
  };

  assert.equal(buildStopHookOutput(state), null);
});

test("stop hook blocks when finish exists but is not complete", () => {
  const state = activeGoalState("Almost Done Goal");
  state.phases.p1 = {
    id: "p1",
    goal_id: "g1",
    kind: "finish",
    title: "Finish",
    status: "pending",
    order: 6,
    created_at: NOW,
    updated_at: NOW,
  };

  const output = buildStopHookOutput(state);
  assert.equal(output?.decision, "block");
  assert.equal(output?.stopReason, "cursor_harness_finish");
  assert.match(output?.systemMessage ?? "", /Continue through validate and finish before stopping/i);
});

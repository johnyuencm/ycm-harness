import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHookOutput, buildSessionDigest, renderSessionContext } from "../src/hooks/session-start.js";
import { buildStopHookOutput } from "../src/hooks/stop.js";
import { emptyStateV3, type StateV3T } from "../src/schema/v3.js";

const NOW = "2026-07-15T00:00:00.000Z";

function state(goal: Partial<StateV3T["goals"]["x"]> = {}, ticket: Partial<StateV3T["local_tickets"]["x"]> = {}): StateV3T {
  const base = emptyStateV3(NOW);
  base.goals.g = {
    id: "g",
    title: "Lean goal",
    status: "active",
    assurance: "standard",
    backend: { kind: "local" },
    worktree_status: "pending",
    stop_enforcement: false,
    created_at: NOW,
    updated_at: NOW,
    ...goal,
  };
  base.active_goal_id = "g";
  base.local_tickets.t = {
    id: "t",
    goal_id: "g",
    title: "First ticket",
    acceptance: ["it works"],
    blocked_by: [],
    status: "todo",
    code_changed: true,
    order: 0,
    created_at: NOW,
    updated_at: NOW,
    ...ticket,
  };
  return base;
}

test("lean SessionStart is silent without state or an active goal", () => {
  assert.deepEqual(buildHookOutput(buildSessionDigest(undefined)), {});
  const inactive = state({ status: "done" });
  delete inactive.active_goal_id;
  assert.deepEqual(buildHookOutput(buildSessionDigest(inactive)), {});
});

test("lean SessionStart emits a bounded resume card and stale marker", () => {
  const current = state({
    backend: {
      kind: "github",
      owner: "johnyuencm",
      repo: "harness",
      project_owner: "johnyuencm",
      project_number: 1,
      parent_issue_number: 42,
    },
  });
  const digest = buildSessionDigest(current);
  const context = renderSessionContext(digest);
  assert.ok(context.split("\n").length <= 20);
  assert.match(context, /Lean goal/);
  assert.match(context, /First ticket/);
  assert.match(context, /Tracker: stale/);
});

test("Stop only blocks explicitly enforced high assurance work", () => {
  assert.equal(buildStopHookOutput(state()), null);
  const high = state({ assurance: "high", stop_enforcement: true });
  assert.equal(buildStopHookOutput(high)?.decision, "block");
  assert.equal(buildStopHookOutput(state({ assurance: "high", stop_enforcement: false })), null);
  assert.equal(buildStopHookOutput(state({ assurance: "high", stop_enforcement: true, status: "blocked" })), null);
});

test("Stop allows tracker outage and verified terminal work", () => {
  const unavailable = state({
    assurance: "high",
    stop_enforcement: true,
    backend: {
      kind: "github",
      owner: "johnyuencm",
      repo: "harness",
      project_owner: "johnyuencm",
      project_number: 1,
      parent_issue_number: 42,
    },
  });
  assert.equal(buildStopHookOutput(unavailable), null);
  const done = state({ assurance: "high", stop_enforcement: true }, { status: "done" });
  done.evidence.e = {
    id: "e",
    goal_id: "g",
    ticket_id: "t",
    kind: "verification",
    outcome: "pass",
    provenance: {},
    recorded_at: NOW,
  };
  assert.equal(buildStopHookOutput(done), null);
});

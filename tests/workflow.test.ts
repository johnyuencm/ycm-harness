import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluatePhaseTransition, PHASE_ORDER } from "../src/workflow/transitions.js";
import { computeNextAction } from "../src/workflow/next-action.js";
import { emptyState } from "../src/schema/state.js";

const NOW = "2026-05-25T00:00:00.000Z";

test("phase transition: must start at explore (V5)", () => {
  assert.deepEqual(evaluatePhaseTransition({ target: "explore" }), { allowed: true });
  const bad = evaluatePhaseTransition({ target: "execute" });
  assert.equal(bad.allowed, false);
  const skipDiscuss = evaluatePhaseTransition({ target: "discuss" });
  assert.equal(skipDiscuss.allowed, false);
});

test("phase transition: cannot skip phases forward", () => {
  const skip = evaluatePhaseTransition({ current: "discuss", target: "execute" });
  assert.equal(skip.allowed, false);
});

test("phase transition: forward by one is allowed; rollback is allowed with a warning reason", () => {
  for (let i = 0; i < PHASE_ORDER.length - 1; i++) {
    const decision = evaluatePhaseTransition({
      current: PHASE_ORDER[i],
      target: PHASE_ORDER[i + 1] as never,
    });
    assert.equal(decision.allowed, true);
  }
  const back = evaluatePhaseTransition({ current: "execute", target: "discuss" });
  assert.equal(back.allowed, true);
  assert.match(back.reason ?? "", /Rolling back/);
});

test("computeNextAction handles empty state", () => {
  const next = computeNextAction(emptyState(NOW));
  assert.match(next.message, /No active goal/);
  assert.match(next.command ?? "", /goal create/);
});

test("computeNextAction nudges goal worktree init when goal lacks a worktree", () => {
  const state = emptyState(NOW);
  state.goals["g1"] = {
    id: "g1",
    title: "Test",
    status: "active",
    worktree_status: "pending",
    created_at: NOW,
    updated_at: NOW,
  };
  state.active_goal_id = "g1";
  const next = computeNextAction(state);
  assert.match(next.command ?? "", /goal worktree init/);
});

test("computeNextAction suggests starting explore when goal worktree is active and there are no phases", () => {
  const state = emptyState(NOW);
  state.goals["g1"] = {
    id: "g1",
    title: "Test",
    status: "active",
    worktree_status: "active",
    worktree_path: ".worktrees/test",
    branch: "harness/g1",
    created_at: NOW,
    updated_at: NOW,
  };
  state.active_goal_id = "g1";
  const next = computeNextAction(state);
  assert.match(next.command ?? "", /phase start explore/);
});

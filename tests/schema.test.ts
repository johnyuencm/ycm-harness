import { test } from "node:test";
import assert from "node:assert/strict";
import { Goal } from "../src/schema/goal.js";
import { Phase } from "../src/schema/phase.js";
import { Task } from "../src/schema/task.js";
import { SmokeEvidence } from "../src/schema/smoke.js";
import { State, emptyState } from "../src/schema/state.js";

const NOW = "2026-05-25T00:00:00.000Z";

test("Goal schema accepts a minimal valid goal", () => {
  const g = Goal.parse({
    id: "goal_demo",
    title: "Demo",
    status: "active",
    created_at: NOW,
    updated_at: NOW,
  });
  assert.equal(g.id, "goal_demo");
});

test("Goal schema rejects bad ids", () => {
  assert.throws(() =>
    Goal.parse({
      id: "Bad ID",
      title: "x",
      status: "active",
      created_at: NOW,
      updated_at: NOW,
    }),
  );
});

test("Phase schema rejects unknown kinds", () => {
  assert.throws(() =>
    Phase.parse({
      id: "p1",
      goal_id: "g1",
      kind: "review",
      title: "x",
      status: "active",
      order: 0,
      created_at: NOW,
      updated_at: NOW,
    }),
  );
});

test("Task schema defaults smoke=required and empty evidence ids", () => {
  const t = Task.parse({
    id: "task_demo",
    phase_id: "phase_x",
    title: "demo",
    status: "pending",
    order: 0,
    created_at: NOW,
    updated_at: NOW,
  });
  assert.equal(t.smoke, "required");
  assert.deepEqual(t.smoke_evidence_ids, []);
});

test("SmokeEvidence accepts pass with minimal fields", () => {
  const s = SmokeEvidence.parse({
    id: "smoke_a",
    task_id: "task_demo",
    outcome: "pass",
    recorded_at: NOW,
  });
  assert.equal(s.outcome, "pass");
});

test("State.emptyState round-trips through parse (V2)", () => {
  const blank = emptyState(NOW);
  const parsed = State.parse(blank);
  assert.equal(parsed.version, 2);
  assert.equal(Object.keys(parsed.goals).length, 0);
  assert.deepEqual(parsed.artifacts, {});
});

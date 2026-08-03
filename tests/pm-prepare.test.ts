import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { HarnessStore } from "../src/state/store.js";
import {
  preparePm,
  multicaPmProvider,
  pmPrepareReceiptPath,
  readPmPrepareReceipt,
  type PmCandidate,
  type PmProvider,
} from "../src/autonomy/pm.js";
import type { CoordinationBinding, MulticaInvocation } from "../src/autonomy/coordination.js";
import { cleanup, tempProject } from "./helpers.js";

async function activeHarness(): Promise<string> {
  const root = await tempProject("ch-pm-prepare-");
  const store = new HarnessStore(root);
  await store.init();
  await store.update((state) => {
    state.goals.goal = {
      id: "goal",
      title: "PM goal",
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

const base = {
  active: true,
  material: true,
  concrete_acceptance: true,
  dependencies_satisfied: true,
  safe_authority: true,
  clear: true,
} as const;

const candidates: PmCandidate[] = [
  { ...base, id: "A", root_key: "root-1", priority: "high", updated_at: "2026-07-15T08:00:00.000Z" },
  { ...base, id: "B", root_key: "root-2", priority: "medium", updated_at: "2026-07-15T07:00:00.000Z" },
  { ...base, id: "C", root_key: "root-1", priority: "high", updated_at: "2026-07-15T09:00:00.000Z" },
  { ...base, id: "D", root_key: "root-3", priority: "urgent", updated_at: "2026-07-15T06:00:00.000Z", safe_authority: false },
];

const request = {
  cwd: "",
  goal: "goal",
  producer_slot: "daily-0900",
  invocation_key: "2026-07-15",
  run_id: "run-1",
  session_id: "session-1",
  brief: {
    objective: "Complete the selected bounded task.",
    non_goals: ["No schedule mutation."],
    acceptance: ["Targeted tests pass."],
    evidence: ["Inspect the selected ticket live."],
    first_steps: ["Read instructions.", "Inspect the ticket.", "Run a focused test."],
    verification: ["npm test -- tests/pm-prepare.test.ts"],
    capability_cost_rationale: "Use one bounded local implementation run.",
    safety_rollback: "Stop before unsafe authority; disable PM mutation on rollback.",
    risks: ["Provider readback can fail."],
    handoff_contract: "Return files, commands, evidence, risks, and status.",
  },
};

test("prepare stops at pm_loop_paused before provider access or receipt advancement", async () => {
  const root = await activeHarness();
  let providerCalls = 0;
  const provider: PmProvider = {
    async listCandidates() { providerCalls += 1; return candidates; },
    async annotate() { providerCalls += 1; throw new Error("must not annotate while paused"); },
  };
  try {
    await assert.rejects(
      preparePm({ ...request, cwd: root }, {
        provider,
        readInstalledLoopState: async () => ({ profile: "pm-17:00", loop_id: "pm-17-00-loop", paused: true }),
      }),
      /pm_loop_paused/,
    );
    assert.equal(providerCalls, 0);
    assert.equal(await readPmPrepareReceipt(root, "goal", request.producer_slot, request.invocation_key), undefined);
  } finally {
    await cleanup(root);
  }
});

test("prepare deterministically selects A and persists the complete brief before annotation", async () => {
  for (const ordered of [candidates, [...candidates].reverse()]) {
    const root = await activeHarness();
    let annotationCalls = 0;
    const provider: PmProvider = {
      async listCandidates() { return ordered; },
      async annotate(candidateId, key, content) {
        annotationCalls += 1;
        const receipt = await readPmPrepareReceipt(root, "goal", request.producer_slot, request.invocation_key);
        assert.equal(receipt?.decision.selected_id, "A");
        assert.equal(receipt?.brief.objective, request.brief.objective);
        assert.equal(receipt?.state, "prepared");
        return { id: "comment-1", issue_id: candidateId, key, content };
      },
    };
    try {
      const result = await preparePm({ ...request, cwd: root }, { provider });
      assert.equal(result.decision.selected_id, "A");
      assert.equal(result.state, "claimed");
      assert.equal(result.claim_authorized, true);
      assert.equal(annotationCalls, 1);
    } finally {
      await cleanup(root);
    }
  }
});

test("prepare durably distinguishes no selection from unsafe or blocked candidates", async () => {
  for (const scenario of [
    { rows: [] as PmCandidate[], outcome: "no_selection", reason: "PM_NO_CANDIDATES" },
    { rows: [candidates[3]!], outcome: "blocked", reason: "PM_PREPARE_BLOCKED" },
  ]) {
    const root = await activeHarness();
    let mutationCount = 0;
    const provider: PmProvider = {
      async listCandidates() { return scenario.rows; },
      async annotate() { mutationCount += 1; throw new Error("must not annotate"); },
    };
    try {
      const result = await preparePm({ ...request, cwd: root }, { provider });
      assert.equal(result.decision.outcome, scenario.outcome);
      assert.equal(result.decision.reason_code, scenario.reason);
      assert.equal(result.claim_authorized, false);
      assert.equal(mutationCount, 0);
      assert.deepEqual(
        await readPmPrepareReceipt(root, "goal", request.producer_slot, request.invocation_key),
        result,
      );
    } finally {
      await cleanup(root);
    }
  }
});

test("prepare replay converges across provenance, rejects conflicts, and recovers every crash boundary", async () => {
  const faultCases = ["before_write", "after_write_before_mutation", "after_mutation_before_finalize"] as const;
  for (const faultAt of faultCases) {
    const root = await activeHarness();
    const annotations = new Map<string, { id: string; issue_id: string; key: string; content: string }>();
    let actualMutations = 0;
    const provider: PmProvider = {
      async listCandidates() { return candidates; },
      async annotate(candidateId, key, content) {
        const prior = annotations.get(key);
        if (prior) return prior;
        actualMutations += 1;
        const created = { id: "comment-1", issue_id: candidateId, key, content };
        annotations.set(key, created);
        return created;
      },
    };
    try {
      await assert.rejects(
        preparePm({ ...request, cwd: root }, { provider, faultAt }),
        new RegExp(`pm_fault_${faultAt}`),
      );
      const afterFault = await readPmPrepareReceipt(root, "goal", request.producer_slot, request.invocation_key);
      assert.equal(afterFault === undefined, faultAt === "before_write");

      const replay = await preparePm({
        ...request,
        cwd: root,
        run_id: "run-2",
        session_id: "session-2",
      }, { provider });
      assert.equal(replay.state, "claimed");
      assert.equal(replay.observed_provenance.length, faultAt === "before_write" ? 1 : 2);
      assert.equal(actualMutations, 1);

      await assert.rejects(
        preparePm({
          ...request,
          cwd: root,
          run_id: "run-3",
          session_id: "session-3",
          brief: { ...request.brief, objective: "A conflicting objective." },
        }, { provider }),
        /pm_prepare_conflict/,
      );
      assert.equal(actualMutations, 1);
    } finally {
      await cleanup(root);
    }
  }
});

test("prepare replay reuses its canonical snapshot when provider annotation changes live update time", async () => {
  const root = await activeHarness();
  let lists = 0;
  const provider: PmProvider = {
    async listCandidates() {
      lists += 1;
      return lists === 1
        ? candidates
        : candidates.map((candidate) => ({ ...candidate, updated_at: "2026-07-15T12:00:00.000Z" }));
    },
    async annotate(candidateId, key, content) {
      return { id: "comment-1", issue_id: candidateId, key, content };
    },
  };
  try {
    const first = await preparePm({ ...request, cwd: root }, { provider });
    const replay = await preparePm({
      ...request,
      cwd: root,
      run_id: "run-after-restart",
      session_id: "session-after-restart",
    }, { provider });
    assert.equal(replay.receipt_id, first.receipt_id);
    assert.equal(replay.candidate_snapshot_sha256, first.candidate_snapshot_sha256);
    assert.equal(replay.observed_provenance.length, 2);
    assert.equal(lists, 1);
  } finally {
    await cleanup(root);
  }
});

test("Multica PM annotation uses supported list/add/readback argv and adds exactly once", async () => {
  const binding: CoordinationBinding = {
    schema_version: 1,
    goal_id: "goal",
    credential_mode: "profile",
    profile: "test-profile",
    server_origin: "http://localhost:3000",
    workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    parent_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2",
    parent_identifier: "AUT-6",
    project_source: "parent",
    issue_prefix: "AUT",
    verified_at: "2026-07-15T00:00:00.000Z",
  };
  const issueId = "11111111-1111-4111-8111-111111111111";
  const comment = { id: "22222222-2222-4222-8222-222222222222", issue_id: issueId, content: "stable receipt marker" };
  const calls: MulticaInvocation[] = [];
  let created = false;
  const provider = multicaPmProvider(binding, async (call) => {
    calls.push(call);
    if (call.argv.includes("add")) {
      created = true;
      return { stdout: JSON.stringify(comment) };
    }
    return { stdout: JSON.stringify(created ? [comment] : []) };
  }, {});

  const first = await provider.annotate(issueId, "pm-stable-key", comment.content);
  const replay = await provider.annotate(issueId, "pm-stable-key", comment.content);
  assert.deepEqual(replay, first);
  assert.equal(calls.filter((call) => call.argv.includes("add")).length, 1);
  const add = calls.find((call) => call.argv.includes("add"))!;
  assert.deepEqual(add.argv.slice(-7), ["issue", "comment", "add", issueId, "--content-stdin", "--output", "json"]);
  assert.equal(add.argv.includes("--idempotency-key"), false);
});

test("prepare rejects a symlinked receipt before outside read, provider calls, or lease mutation", async () => {
  const root = await activeHarness();
  const outside = await tempProject("ch-pm-outside-");
  const outsideFile = path.join(outside, "receipt.json");
  const file = pmPrepareReceiptPath(root, "goal", request.producer_slot, request.invocation_key);
  let providerCalls = 0;
  const provider: PmProvider = {
    async listCandidates() { providerCalls += 1; return candidates; },
    async annotate() { providerCalls += 1; throw new Error("must not annotate"); },
  };
  try {
    await fs.writeFile(outsideFile, "outside sentinel", "utf8");
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.symlink(outsideFile, file);
    await assert.rejects(preparePm({ ...request, cwd: root }, { provider }), /unsafe_pm_storage_path/);
    assert.equal(providerCalls, 0);
    assert.equal(await fs.readFile(outsideFile, "utf8"), "outside sentinel");
    await assert.rejects(fs.access(path.join(root, ".ycm-harness", "autonomy", "locks")));
  } finally {
    await cleanup(root);
    await cleanup(outside);
  }
});

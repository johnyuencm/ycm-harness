import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  handoffPm, multicaPmProvider, pmReviewerActorPayload, pmWorkerActorPayload, pmWorkerClaimId, pmWorkerRunRoot, preparePm, readPmReviewReceipt, reviewPm,
  type HandoffPmInput, type PmCandidate, type PmCorrectionRequest, type PmProvider, type ReviewPmInput,
} from "../src/autonomy/pm.js";
import type { CanonicalContinuationVerdict } from "../src/continuation/shadow.js";
import { HarnessStore } from "../src/state/store.js";
import { cleanup, tempProject } from "./helpers.js";
import { actorBinding, actorRegistry, reviewerSelector, testArtifactManifest, testReviewer, testWorker, workerSelector } from "./pm-actor-fixture.js";

const candidate: PmCandidate = {
  id: "ticket-1", root_key: "root-1", priority: "high", updated_at: "2026-07-15T08:00:00.000Z",
  active: true, material: true, concrete_acceptance: true, dependencies_satisfied: true,
  safe_authority: true, clear: true,
};
const brief = {
  objective: "Complete the selected bounded task.", non_goals: ["No schedule mutation."],
  acceptance: ["Targeted tests pass."], evidence: ["Inspect the selected ticket live."],
  first_steps: ["Read instructions."], verification: ["npm test -- tests/pm-review.test.ts"],
  capability_cost_rationale: "Use one bounded implementation run.",
  safety_rollback: "Stop before unsafe authority.", risks: ["Live readback can fail."],
  handoff_contract: "Return files, commands, evidence, risks, and status.",
};

async function activeHarness(): Promise<string> {
  const root = await tempProject("ch-pm-review-");
  const store = new HarnessStore(root);
  await store.init();
  await store.update((state) => {
    state.goals.goal = { id: "goal", title: "PM goal", status: "active", worktree_status: "active", created_at: state.created_at, updated_at: state.updated_at };
    state.active_goal_id = "goal";
    return state;
  });
  return root;
}

function makeProvider() {
  const annotations = new Map<string, { id: string; issue_id: string; key: string; content: string }>();
  const corrections = new Map<string, { reference_id: string; key: string; root_cause_key: string; strength: "equal" | "stronger"; required_capability: { id: string; rank: number } }>();
  let correctionCreations = 0;
  const provider: PmProvider = {
    async listCandidates() { return [candidate]; },
    async annotate(candidateId, key, content) {
      const prior = annotations.get(key);
      if (prior) { assert.equal(prior.content, content); return prior; }
      const value = { id: annotations.size === 0 ? "comment-1" : `comment-${annotations.size + 1}`, issue_id: candidateId, key, content };
      annotations.set(key, value);
      return value;
    },
    async readTicketProof(id) {
      return { ticket_id: id, configured_parent_id: "parent-1", parent_id: "parent-1", status: "in_review" as const,
        content_strings: ["Selected bounded task", "Targeted tests pass."],
        evidence_reference_ids: id === "ticket-1"
          ? [...annotations.values()].filter((annotation) => annotation.issue_id === id).map((annotation) => annotation.id).sort()
          : ["follow-up-evidence"],
        readback_at: "2026-07-15T17:00:00.000Z" };
    },
    async ensureCorrection(_ticketId, key, request: PmCorrectionRequest) {
      const prior = corrections.get(key);
      if (prior) return prior;
      correctionCreations += 1;
      const value = { reference_id: "correction-1", key, root_cause_key: request.root_cause_key,
        strength: request.strength, required_capability: request.required_capability };
      corrections.set(key, value);
      return value;
    },
  };
  return { provider, annotations, corrections, correctionCreations: () => correctionCreations };
}

async function handedOff(root: string, provider: PmProvider, outcome: "completed" | "crashed" = "completed") {
  const prepared = await preparePm({ cwd: root, goal: "goal", producer_slot: "daily-0900", invocation_key: "2026-07-15",
    run_id: "prepare-run", session_id: "prepare-session", brief }, { provider });
  const actors = actorRegistry();
  const request: Omit<HandoffPmInput, "cwd"> = {
    goal: "goal", producer_slot: "daily-0900", invocation_key: "2026-07-15", prepare_receipt_id: prepared.receipt_id,
    claim: { claim_id: pmWorkerClaimId("goal", prepared, testWorker), ticket_id: "ticket-1", provider_annotation_id: prepared.provider_annotation!.id },
    worker_origin: workerSelector,
    artifacts: { prompt: "prompt.txt", output: "output.txt", exit_status: "exit-status.txt", meaningful_log: "meaningful.log" }, outcome,
    handoff: {
      acceptance_checklist: [{ criterion: "Targeted tests pass.", status: outcome === "completed" ? "pass" : "not_run", evidence: outcome === "completed" ? ["test-output"] : [] }],
      remaining_risks: outcome === "completed" ? [] : ["Worker crashed."], severity_self_assessment: outcome === "completed" ? "None" : "High",
      changed_files: ["src/autonomy/pm.ts", "tests/pm-review.test.ts"], evidence: ["test-output"],
      commands: [{ command: "npm test -- tests/pm-review.test.ts", result: outcome === "completed" ? "pass" : "crashed" }],
      follow_up: { ids: [], suggestions: ["Independent review"] },
    },
  };
  const runRoot = pmWorkerRunRoot(root, "goal", request.claim.claim_id);
  await fs.mkdir(runRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(runRoot, "prompt.txt"), "Implement only the bounded PM work.", "utf8"),
    fs.writeFile(path.join(runRoot, "output.txt"), "Implementation completed.", "utf8"),
    fs.writeFile(path.join(runRoot, "exit-status.txt"), outcome === "completed" ? "0\n" : "137\n", "utf8"),
    fs.writeFile(path.join(runRoot, "meaningful.log"), "targeted execution evidence\n", "utf8"),
  ]);
  const manifest = testArtifactManifest([
    { kind: "prompt", relative_path: "prompt.txt", content: "Implement only the bounded PM work." },
    { kind: "output", relative_path: "output.txt", content: "Implementation completed." },
    { kind: "exit_status", relative_path: "exit-status.txt", content: outcome === "completed" ? "0\n" : "137\n" },
    { kind: "meaningful_log", relative_path: "meaningful.log", content: "targeted execution evidence\n" },
  ]);
  const workerPayload = pmWorkerActorPayload({ goal_id: "goal", parent_id: actorBinding.parent_id,
    ticket_id: request.claim.ticket_id, prepare_receipt_id: prepared.receipt_id, claim_id: request.claim.claim_id,
    producer_slot: request.producer_slot, invocation_key: request.invocation_key, outcome, manifest, handoff: request.handoff });
  const workerRecord = actors.addWorker({ ticketId: request.claim.ticket_id, prepareReceiptId: prepared.receipt_id,
    claimId: request.claim.claim_id, payload: workerPayload });
  const receipt = await handoffPm({ ...request, cwd: root }, actors.deps);
  const ticketProof = await provider.readTicketProof!(request.claim.ticket_id);
  if (!ticketProof) throw new Error("missing review fixture proof");
  return { prepared, request, receipt, actors, workerRecord, ticketProof };
}

const passClosure: CanonicalContinuationVerdict = { verdict: "PASS", reasons: [], proof_id: "a".repeat(64), surface: "ticket-completion" };
const failClosure: CanonicalContinuationVerdict = { verdict: "FAIL", reasons: ["POLICY_FAILED"], proof_id: "a".repeat(64), surface: "ticket-completion",
  failure_id: "b".repeat(64), correction_reservation_id: "c".repeat(64) };

function reviewRequest(chain: Awaited<ReturnType<typeof handedOff>>): Omit<ReviewPmInput, "cwd"> {
  return {
    goal: "goal", producer_slot: "daily-0900", invocation_key: "2026-07-15", prepare_receipt_id: chain.prepared.receipt_id, claim_id: chain.request.claim.claim_id,
    reviewer_origin: reviewerSelector,
    phase4_proof: { proof_id: "a".repeat(64), parent_id: "parent-1", run_id: "p4-run", session_id: "p4-session" }, verdict: "PASS", findings: [],
  };
}

function executeReview(
  root: string,
  chain: Awaited<ReturnType<typeof handedOff>>,
  request: Omit<ReviewPmInput, "cwd">,
  provider: PmProvider,
  closure: CanonicalContinuationVerdict = passClosure,
  deps: Parameters<typeof reviewPm>[1] = {},
  identity: typeof testReviewer = testReviewer,
  mutate?: (record: ReturnType<typeof chain.actors.addReviewer>) => void,
) {
  const canonicalClosure: CanonicalContinuationVerdict = {
    verdict: closure.verdict, reasons: closure.reasons,
    ...(closure.failure_id ? { failure_id: closure.failure_id } : {}),
    ...(closure.correction_reservation_id ? { correction_reservation_id: closure.correction_reservation_id } : {}),
    ...(closure.audit_reference ? { audit_reference: closure.audit_reference } : {}),
    proof_id: closure.proof_id, surface: closure.surface,
  };
  const payload = pmReviewerActorPayload({ goal_id: "goal", parent_id: actorBinding.parent_id,
    ticket_id: chain.request.claim.ticket_id, prepare_receipt_id: chain.prepared.receipt_id,
    claim_id: chain.request.claim.claim_id, handoff_receipt_id: chain.receipt.receipt_id,
    worker_record_sha256: chain.workerRecord.record_sha256, manifest: chain.receipt.manifest,
    ticket_proof: chain.ticketProof, phase4_proof: request.phase4_proof, phase4: canonicalClosure,
    verdict: request.verdict, findings: request.findings,
    ...(request.high_disposition ? { high_disposition: request.high_disposition } : {}) });
  const record = chain.actors.addReviewer({ selector: request.reviewer_origin, identity,
    ticketId: chain.request.claim.ticket_id, prepareReceiptId: chain.prepared.receipt_id,
    claimId: chain.request.claim.claim_id, payload });
  mutate?.(record);
  return reviewPm({ ...request, cwd: root }, { ...chain.actors.deps, provider,
    loadContinuationClosureVerdict: async () => closure, ...deps });
}

test("review authenticates the full chain, distinct provenance, live proof, artifacts, and Phase 4 PASS", async () => {
  const root = await activeHarness();
  try {
    const fixture = makeProvider(); const chain = await handedOff(root, fixture.provider);
    const receipt = await executeReview(root, chain, reviewRequest(chain), fixture.provider);
    assert.equal(receipt.state, "reviewed"); assert.equal(receipt.verdict, "PASS"); assert.equal(receipt.phase4.verdict, "PASS");
    assert.equal(receipt.phase4.failure_id, undefined); assert.equal(receipt.phase4.correction_reservation_id, undefined);
    assert.deepEqual(receipt.authenticated_manifest, chain.receipt.manifest);
    assert.deepEqual(receipt.worker_origin, chain.receipt.worker_origin);
    assert.equal(receipt.reviewer_origin.assurance, "authenticated_install");
    assert.deepEqual(await readPmReviewReceipt(root, "goal", chain.request.claim.claim_id), receipt);
    assert.equal(fixture.correctionCreations(), 0);
  } finally { await cleanup(root); }
});

test("review stops at pm_loop_paused before provider, correction, annotation, or receipt advancement", async () => {
  const root = await activeHarness();
  try {
    const fixture = makeProvider();
    const chain = await handedOff(root, fixture.provider);
    let providerCalls = 0;
    const pausedProvider: PmProvider = {
      async listCandidates() { providerCalls += 1; return [candidate]; },
      async annotate() { providerCalls += 1; throw new Error("must not annotate while paused"); },
      async readTicketProof() { providerCalls += 1; throw new Error("must not read provider while paused"); },
      async ensureCorrection() { providerCalls += 1; throw new Error("must not correct while paused"); },
    };
    await assert.rejects(
      executeReview(root, chain, reviewRequest(chain), pausedProvider, passClosure, {
        readInstalledLoopState: async () => ({ profile: "pm-17:00", loop_id: "pm-17-00-loop", paused: true }),
      }),
      /pm_loop_paused/,
    );
    assert.equal(providerCalls, 0);
    assert.equal(await readPmReviewReceipt(root, "goal", chain.request.claim.claim_id), undefined);
  } finally { await cleanup(root); }
});

test("review rejects caller-authored reviewer identity, evidence, and selector metadata", async () => {
  const root = await activeHarness();
  try {
    const fixture = makeProvider(); const chain = await handedOff(root, fixture.provider); const request = reviewRequest(chain);
    const legacy = { ...request, reviewer: testReviewer, review_evidence: { reviewer_source: "caller" } };
    delete (legacy as Partial<typeof legacy>).reviewer_origin;
    await assert.rejects(reviewPm({ ...legacy, cwd: root } as unknown as ReviewPmInput, chain.actors.deps), /pm_invalid_review_request/);
    for (const field of ["record_path", "public_key", "record_sha256", "signed_at", "reader_module"] as const) {
      const forged = { ...request, reviewer_origin: { ...reviewerSelector, [field]: "caller-controlled" } };
      await assert.rejects(reviewPm({ ...forged, cwd: root } as unknown as ReviewPmInput, chain.actors.deps), /pm_invalid_review_request/);
    }
    assert.equal(await readPmReviewReceipt(root, "goal", chain.request.claim.claim_id), undefined);
  } finally { await cleanup(root); }
});

test("review rejects normalized identity or record reuse, signed payload mismatch, artifact tamper, and missing live proof", async () => {
  for (const hazard of ["alias", "run", "run_alias", "session", "session_alias", "record", "payload", "artifact", "proof"] as const) {
    const root = await activeHarness();
    try {
      const fixture = makeProvider(); const chain = await handedOff(root, fixture.provider); const request = reviewRequest(chain);
      const identity = { ...testReviewer };
      if (hazard === "alias") identity.subject = "WORKER_1";
      if (hazard === "run") identity.run_id = testWorker.run_id;
      if (hazard === "run_alias") identity.run_id = "WORKER_RUN_1";
      if (hazard === "session") identity.session_id = testWorker.session_id;
      if (hazard === "session_alias") identity.session_id = "WORKER_SESSION_1";
      if (hazard === "artifact") await fs.writeFile(path.join(pmWorkerRunRoot(root, "goal", chain.request.claim.claim_id), "output.txt"), "tampered", "utf8");
      const provider = hazard === "proof" ? { ...fixture.provider, async readTicketProof() { return undefined; } } : fixture.provider;
      await assert.rejects(executeReview(root, chain, request, provider, passClosure, {}, identity, (record) => {
        if (hazard === "record") record.record_sha256 = chain.workerRecord.record_sha256;
        if (hazard === "payload") record.payload_sha256 = "f".repeat(64);
      }), /pm_review_(?:provenance_invalid|origin_payload_invalid|artifact_tampered|live_proof_invalid)/);
      assert.equal(await readPmReviewReceipt(root, "goal", chain.request.claim.claim_id), undefined);
    } finally { await cleanup(root); }
  }
});

test("Phase 4 FAIL reuses its exact pair while ordinary High findings converge to one correction across crash replay", async () => {
  for (const phase4Fail of [true, false]) {
    const root = await activeHarness();
    try {
      const fixture = makeProvider(); const chain = await handedOff(root, fixture.provider); const request = reviewRequest(chain);
      request.verdict = "FAIL";
      request.findings = [
        { id: "finding-a", severity: "High", root_cause_key: "root-review", summary: "The live result needs correction.", evidence: ["live ticket and output mismatch"] },
        { id: "finding-b", severity: "High", root_cause_key: "root-review", summary: "A second symptom has the same root.", evidence: ["same root cause"] },
      ];
      if (!phase4Fail) request.high_disposition = { kind: "correction", strength: "stronger",
        required_capability: { id: "implementation", rank: 2 }, title: "Correct the authenticated PM result",
        acceptance: ["Re-run independent live verification."], verification: ["Targeted review passes."], rollback: "Retain the failed review and stop correction execution." };
      const closure = phase4Fail ? failClosure : passClosure;
      if (!phase4Fail) await assert.rejects(executeReview(root, chain, request, fixture.provider, closure,
        { faultAt: "after_disposition_before_finalize" }), /pm_fault_after_review_disposition/);
      const receipt = await executeReview(root, chain, request, fixture.provider, closure);
      if (phase4Fail) {
        assert.deepEqual(receipt.phase4, failClosure); assert.equal(receipt.high_disposition?.kind, "phase4_pair");
        assert.equal(receipt.high_disposition?.failure_id, failClosure.failure_id);
        assert.equal(receipt.high_disposition?.correction_reservation_id, failClosure.correction_reservation_id); assert.equal(fixture.correctionCreations(), 0);
      } else {
        assert.equal(receipt.high_disposition?.kind, "correction"); assert.equal(receipt.high_disposition?.reference_id, "correction-1");
        assert.equal(fixture.correctionCreations(), 1);
        assert.deepEqual(await executeReview(root, chain, request, fixture.provider, closure), receipt);
        assert.equal(fixture.correctionCreations(), 1);
      }
    } finally { await cleanup(root); }
  }
});

test("Medium and Low findings require durable dispositions; incomplete handoff requires High", async () => {
  const root = await activeHarness();
  try {
    const fixture = makeProvider(); const chain = await handedOff(root, fixture.provider); const request = reviewRequest(chain);
    request.verdict = "PARTIAL";
    request.findings = [
      { id: "medium-a", severity: "Medium", root_cause_key: "root-medium", summary: "Track a bounded follow-up.", evidence: ["review output"], disposition: { kind: "follow_up", reference_id: "follow-up-1" } },
      { id: "low-a", severity: "Low", root_cause_key: "root-low", summary: "The residual is negligible.", evidence: ["review output"], disposition: { kind: "not_worth_doing", rationale: "Cost exceeds the bounded residual impact." } },
    ];
    const receipt = await executeReview(root, chain, request, fixture.provider);
    assert.equal(receipt.findings.length, 2); assert.ok(receipt.findings.every((finding) => finding.disposition?.provider_annotation));
    const incompleteRoot = await activeHarness();
    try {
      const incompleteFixture = makeProvider(); const incomplete = await handedOff(incompleteRoot, incompleteFixture.provider, "crashed");
      const invalid = reviewRequest(incomplete); invalid.verdict = "PARTIAL";
      await assert.rejects(executeReview(incompleteRoot, incomplete, invalid, incompleteFixture.provider), /pm_review_incomplete_requires_high/);
    } finally { await cleanup(incompleteRoot); }
  } finally { await cleanup(root); }
});

test("blocker plus Medium and Low dispositions replay after mutation without duplicate provider records", async () => {
  const root = await activeHarness();
  try {
    const fixture = makeProvider(); const chain = await handedOff(root, fixture.provider); const request = reviewRequest(chain);
    request.verdict = "BLOCKED";
    request.findings = [
      { id: "high-blocker", severity: "High", root_cause_key: "root-blocked", summary: "External authority blocks completion.", evidence: ["live blocker proof"] },
      { id: "medium-follow-up", severity: "Medium", root_cause_key: "root-medium", summary: "Track a bounded follow-up.", evidence: ["review output"], disposition: { kind: "follow_up", reference_id: "follow-up-1" } },
      { id: "low-noop", severity: "Low", root_cause_key: "root-low", summary: "The residual is negligible.", evidence: ["review output"], disposition: { kind: "not_worth_doing", rationale: "Cost exceeds the bounded residual impact." } },
    ];
    request.high_disposition = { kind: "blocker", reason: "Required authority is outside the bounded PM scope." };
    await assert.rejects(executeReview(root, chain, request, fixture.provider, passClosure,
      { faultAt: "after_disposition_before_finalize" }), /pm_fault_after_review_disposition/);
    const mutationCount = fixture.annotations.size;
    const receipt = await executeReview(root, chain, request, fixture.provider);
    assert.equal(fixture.annotations.size, mutationCount);
    assert.equal(receipt.high_disposition?.kind, "blocker");
    if (receipt.high_disposition?.kind === "blocker") {
      assert.equal(receipt.high_disposition.reference_id, receipt.high_disposition.provider_annotation.id);
    }
  } finally { await cleanup(root); }
});

test("correction capability is same-class and equal-or-stronger with truthful strength labeling", async () => {
  const cases = [
    { id: "implementation", rank: 0, strength: "stronger" as const, accepted: false },
    { id: "implementation", rank: 2, strength: "equal" as const, accepted: false },
    { id: "review", rank: 2, strength: "stronger" as const, accepted: false },
    { id: "implementation", rank: 1, strength: "equal" as const, accepted: true },
    { id: "implementation", rank: 2, strength: "stronger" as const, accepted: true },
  ];
  for (const row of cases) {
    const root = await activeHarness();
    try {
      const fixture = makeProvider(); const chain = await handedOff(root, fixture.provider); const request = reviewRequest(chain);
      request.verdict = "FAIL";
      request.findings = [{ id: "high-capability", severity: "High", root_cause_key: "root-capability",
        summary: "A correction is required.", evidence: ["authenticated failure"] }];
      request.high_disposition = { kind: "correction", strength: row.strength,
        required_capability: { id: row.id, rank: row.rank }, title: "Correct the PM result",
        acceptance: ["Independent verification passes."], verification: ["Run targeted review."], rollback: "Keep the failed receipt." };
      const action = executeReview(root, chain, request, fixture.provider);
      if (!row.accepted) {
        await assert.rejects(action, /pm_review_capability_invalid/);
        assert.equal(fixture.correctionCreations(), 0);
      } else {
        const receipt = await action;
        assert.equal(receipt.high_disposition?.kind, "correction");
        if (receipt.high_disposition?.kind === "correction") {
          assert.deepEqual(receipt.high_disposition.required_capability, { id: row.id, rank: row.rank });
        }
      }
    } finally { await cleanup(root); }
  }
});

test("Multica PM proof treats only the exact requested issue 404 as missing", async () => {
  const binding = {
    schema_version: 1 as const, goal_id: "goal", credential_mode: "profile" as const, profile: "test",
    server_origin: "http://localhost:3000", workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    parent_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", parent_identifier: "AUT-6",
    project_source: "parent" as const, issue_prefix: "AUT", verified_at: "2026-07-15T00:00:00.000Z",
  };
  const requested = "ticket-1";
  const exact = `resolve issue: GET /api/issues/${requested} returned 404: {"error":"issue not found"}`;
  const exactProvider = multicaPmProvider(binding, async () => { throw new Error(exact); }, {});
  assert.equal(await exactProvider.readTicketProof!(requested), undefined);
  for (const message of [
    `resolve workspace: GET /api/workspaces/${binding.workspace_id} returned 404: {"error":"workspace not found"}`,
    "proxy returned 404",
    `resolve issue: GET /api/issues/other-ticket returned 404: {"error":"issue not found"}`,
  ]) {
    const provider = multicaPmProvider(binding, async () => { throw new Error(message); }, {});
    await assert.rejects(() => provider.readTicketProof!(requested), (error: unknown) => {
      assert.equal((error as Error).message, message);
      return true;
    });
  }
});

test("Multica correction lookup rejects marker suffixes and rank prefix collisions but reuses one exact record", async () => {
  const binding = {
    schema_version: 1 as const, goal_id: "goal", credential_mode: "profile" as const, profile: "test",
    server_origin: "http://localhost:3000", workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
    parent_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2", parent_identifier: "AUT-6",
    project_source: "parent" as const, issue_prefix: "AUT", verified_at: "2026-07-15T00:00:00.000Z",
  };
  const key = "pmc-exact-key";
  const request: PmCorrectionRequest = {
    root_cause_key: "root-exact", strength: "equal", required_capability: { id: "implementation", rank: 1 },
    title: "Correct the exact result", acceptance: ["Exact correction passes."],
    verification: ["Run exact verification."], rollback: "Keep the failed receipt.",
  };
  const description = (values: { key: string; ticket: string; root: string; strength: string; capability: string; rank: string }) => [
    `PM-Correction-Key: ${values.key}`,
    `PM-Source-Ticket: ${values.ticket}`,
    `PM-Root-Cause: ${values.root}`,
    `PM-Strength: ${values.strength}`,
    `PM-Required-Capability: ${values.capability}`,
    `PM-Required-Capability-Rank: ${values.rank}`,
  ].join("\n");
  const rows = [
    { id: "suffix-collision", parent_issue_id: binding.parent_id, description: description({
      key: `${key}-suffix`, ticket: "ticket-1-suffix", root: `${request.root_cause_key}-suffix`,
      strength: `${request.strength}-suffix`, capability: `${request.required_capability.id}-suffix`, rank: "10",
    }) },
    { id: "rank-collision", parent_issue_id: binding.parent_id, description: description({
      key, ticket: "ticket-1", root: request.root_cause_key, strength: request.strength,
      capability: request.required_capability.id, rank: "10",
    }) },
  ];
  let creates = 0;
  const provider = multicaPmProvider(binding, async (call) => {
    const args = call.argv.slice(call.argv.indexOf("issue"));
    if (args[1] === "list") return { stdout: JSON.stringify({ issues: rows }) };
    if (args[1] === "create") {
      creates += 1;
      const row = { id: "exact-correction", parent_issue_id: binding.parent_id, description: call.stdin };
      rows.push(row);
      return { stdout: JSON.stringify(row) };
    }
    if (args[1] === "get") {
      const row = rows.find((candidate) => candidate.id === args[2]);
      if (row) return { stdout: JSON.stringify(row) };
    }
    throw new Error(`unexpected call: ${args.join(" ")}`);
  }, {});
  const first = await provider.ensureCorrection!("ticket-1", key, request);
  const replay = await provider.ensureCorrection!("ticket-1", key, request);
  assert.equal(first.reference_id, "exact-correction");
  assert.deepEqual(replay, first);
  assert.equal(creates, 1);
});

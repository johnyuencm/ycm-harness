import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  handoffPm, pmGapReceiptPath, pmReviewerActorPayload, pmWorkerActorPayload, pmWorkerClaimId, pmWorkerRunRoot, preparePm, readPmGapReceipt,
  reviewPm, statusPm, type HandoffPmInput, type PmCandidate, type PmProvider, type ReviewPmInput,
} from "../src/autonomy/pm.js";
import type { CoordinationBinding } from "../src/autonomy/coordination.js";
import type { CanonicalContinuationVerdict } from "../src/continuation/shadow.js";
import { emptyStateV3 } from "../src/schema/v3.js";
import { HarnessStore } from "../src/state/store.js";
import { cleanup, tempProject } from "./helpers.js";
import { actorRegistry, reviewerSelector, testArtifactManifest, testWorker, workerSelector } from "./pm-actor-fixture.js";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const candidate: PmCandidate = {
  id: "ticket-1", root_key: "root-1", priority: "high", updated_at: "2026-07-15T08:00:00.000Z",
  active: true, material: true, concrete_acceptance: true, dependencies_satisfied: true, safe_authority: true, clear: true,
};
const brief = {
  objective: "Complete the selected bounded task.", non_goals: ["No schedule mutation."],
  acceptance: ["Targeted tests pass."], evidence: ["Inspect the selected ticket live."],
  first_steps: ["Read instructions."], verification: ["npm test -- tests/pm-status.test.ts"],
  capability_cost_rationale: "Use one bounded implementation run.", safety_rollback: "Stop before unsafe authority.",
  risks: ["Live readback can fail."], handoff_contract: "Return files, commands, evidence, risks, and status.",
};
const binding: CoordinationBinding = {
  schema_version: 1, goal_id: "goal", credential_mode: "profile", profile: "test",
  server_origin: "http://localhost:3000", workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  parent_id: "parent-1", parent_identifier: "AUT-6", project_source: "parent", issue_prefix: "AUT",
  verified_at: "2026-07-15T00:00:00.000Z",
};
const passClosure: CanonicalContinuationVerdict = {
  verdict: "PASS", reasons: [], proof_id: "a".repeat(64), surface: "ticket-completion",
};

async function activeHarness(): Promise<string> {
  const root = await tempProject("ch-pm-status-");
  const store = new HarnessStore(root); await store.init();
  const now = "2026-07-15T00:00:00.000Z";
  const state = emptyStateV3(now);
  state.goals.goal = {
    id: "goal", title: "PM goal", status: "active", worktree_status: "active",
    created_at: now, updated_at: now,
  };
  state.active_goal_id = "goal";
  await store.writeStateV3(state);
  return root;
}

function providerFixture(candidateRows: PmCandidate[] = [candidate]) {
  const annotations = new Map<string, { id: string; issue_id: string; key: string; content: string }>();
  const corrections = new Map<string, { reference_id: string; key: string; root_cause_key: string; strength: "equal" | "stronger";
    required_capability: { id: string; rank: number }; request: unknown }>();
  let mutations = 0; let reads = 0; let omitEvidence = false;
  const provider: PmProvider = {
    async listCandidates() { reads += 1; return candidateRows; },
    async annotate(candidateId, key, content) {
      const prior = annotations.get(key); if (prior) return prior;
      mutations += 1;
      const value = { id: `comment-${annotations.size + 1}`, issue_id: candidateId, key, content };
      annotations.set(key, value); return value;
    },
    async readAnnotation(candidateId, key, content) {
      return [...annotations.values()].find((row) => row.issue_id === candidateId && row.key === key && row.content === content);
    },
    async ensureCorrection(_ticketId, key, request) {
      const prior = corrections.get(key); if (prior) {
        const { request: _request, ...reference } = prior; return reference;
      }
      mutations += 1;
      const value = { reference_id: `correction-${corrections.size + 1}`, key, root_cause_key: request.root_cause_key,
        strength: request.strength, required_capability: request.required_capability, request };
      corrections.set(key, value); const { request: _request, ...reference } = value; return reference;
    },
    async readCorrection(_ticketId, key, request) {
      reads += 1; const value = corrections.get(key);
      if (!value || JSON.stringify(value.request) !== JSON.stringify(request)) return undefined;
      const { request: _request, ...reference } = value; return reference;
    },
    async readTicketProof(id) {
      reads += 1;
      return { ticket_id: id, configured_parent_id: binding.parent_id, parent_id: binding.parent_id,
        status: "in_review" as const, content_strings: ["Selected bounded task", "Targeted tests pass."],
        evidence_reference_ids: id === candidate.id && !omitEvidence
          ? [...annotations.values()].filter((row) => row.issue_id === id).map((row) => row.id).sort()
          : [], readback_at: "2026-07-15T17:00:00.000Z" };
    },
  };
  return { provider, annotations, corrections, mutations: () => mutations, reads: () => reads,
    reset: () => { mutations = 0; reads = 0; }, omitEvidence: (value: boolean) => { omitEvidence = value; } };
}

async function reviewedChain(root: string, provider: PmProvider, verdict: ReviewPmInput["verdict"] = "PASS") {
  const prepared = await preparePm({ cwd: root, goal: "goal", producer_slot: "daily-0900", invocation_key: "2026-07-15",
    run_id: "prepare-run", session_id: "prepare-session", brief }, { provider });
  const actors = actorRegistry(binding);
  const handoffRequest: Omit<HandoffPmInput, "cwd"> = {
    goal: "goal", producer_slot: "daily-0900", invocation_key: "2026-07-15", prepare_receipt_id: prepared.receipt_id,
    claim: { claim_id: pmWorkerClaimId("goal", prepared, testWorker), ticket_id: candidate.id,
      provider_annotation_id: prepared.provider_annotation!.id }, worker_origin: workerSelector,
    artifacts: { prompt: "prompt.txt", output: "output.txt", exit_status: "exit-status.txt", meaningful_log: "meaningful.log" },
    outcome: "completed", handoff: {
      acceptance_checklist: [{ criterion: brief.acceptance[0], status: "pass", evidence: ["test-output"] }],
      remaining_risks: [], severity_self_assessment: "None", changed_files: ["src/autonomy/pm.ts"],
      evidence: ["test-output"], commands: [{ command: "npm test", result: "pass" }],
      follow_up: { ids: [], suggestions: ["Independent review"] },
    },
  };
  const runRoot = pmWorkerRunRoot(root, "goal", handoffRequest.claim.claim_id); await fs.mkdir(runRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(runRoot, "prompt.txt"), "Implement bounded PM status.", "utf8"),
    fs.writeFile(path.join(runRoot, "output.txt"), "Implementation completed.", "utf8"),
    fs.writeFile(path.join(runRoot, "exit-status.txt"), "0\n", "utf8"),
    fs.writeFile(path.join(runRoot, "meaningful.log"), "targeted evidence\n", "utf8"),
  ]);
  const manifest = testArtifactManifest([
    { kind: "prompt", relative_path: "prompt.txt", content: "Implement bounded PM status." },
    { kind: "output", relative_path: "output.txt", content: "Implementation completed." },
    { kind: "exit_status", relative_path: "exit-status.txt", content: "0\n" },
    { kind: "meaningful_log", relative_path: "meaningful.log", content: "targeted evidence\n" },
  ]);
  const workerPayload = pmWorkerActorPayload({ goal_id: "goal", parent_id: binding.parent_id,
    ticket_id: candidate.id, prepare_receipt_id: prepared.receipt_id, claim_id: handoffRequest.claim.claim_id,
    producer_slot: handoffRequest.producer_slot, invocation_key: handoffRequest.invocation_key,
    outcome: "completed", manifest, handoff: handoffRequest.handoff });
  const workerRecord = actors.addWorker({ ticketId: candidate.id, prepareReceiptId: prepared.receipt_id,
    claimId: handoffRequest.claim.claim_id, payload: workerPayload });
  const handoff = await handoffPm({ ...handoffRequest, cwd: root }, actors.deps);
  const reviewRequest: Omit<ReviewPmInput, "cwd"> = {
    goal: "goal", producer_slot: "daily-0900", invocation_key: "2026-07-15", prepare_receipt_id: prepared.receipt_id,
    claim_id: handoffRequest.claim.claim_id,
    reviewer_origin: reviewerSelector,
    phase4_proof: { proof_id: "a".repeat(64), parent_id: binding.parent_id, run_id: "p4-run", session_id: "p4-session" },
    verdict, findings: [],
  };
  const ticketProof = await provider.readTicketProof!(candidate.id);
  if (!ticketProof) throw new Error("missing status fixture proof");
  const reviewPayload = pmReviewerActorPayload({ goal_id: "goal", parent_id: binding.parent_id,
    ticket_id: candidate.id, prepare_receipt_id: prepared.receipt_id, claim_id: handoffRequest.claim.claim_id,
    handoff_receipt_id: handoff.receipt_id, worker_record_sha256: workerRecord.record_sha256,
    manifest: handoff.manifest, ticket_proof: ticketProof, phase4_proof: reviewRequest.phase4_proof,
    phase4: passClosure, verdict, findings: [] });
  actors.addReviewer({ ticketId: candidate.id, prepareReceiptId: prepared.receipt_id,
    claimId: handoffRequest.claim.claim_id, payload: reviewPayload });
  const review = await reviewPm({ ...reviewRequest, cwd: root }, { ...actors.deps, provider,
    loadContinuationClosureVerdict: async () => passClosure });
  actorDepsByProvider.set(provider, actors.deps);
  return { prepared, handoff, review, reviewRequest, claimId: handoffRequest.claim.claim_id,
    actors, workerRecord, ticketProof };
}

const statusRequest = (root: string, claimId: string) => ({
  cwd: root, goal: "goal", workspace_id: binding.workspace_id, parent_id: binding.parent_id,
  producer_slot: "daily-0900", invocation_key: "2026-07-15", claim_id: claimId,
  evidence_requirement: "manual" as const, record_gap: false,
});
const actorDepsByProvider = new WeakMap<PmProvider, ReturnType<typeof actorRegistry>["deps"]>();
const statusDeps = (provider: PmProvider) => ({ binding, ...actorDepsByProvider.get(provider), provider,
  loadContinuationClosureVerdict: async () => passClosure });

function executeReplacementReview(
  root: string,
  chain: Awaited<ReturnType<typeof reviewedChain>>,
  request: Omit<ReviewPmInput, "cwd">,
  provider: PmProvider,
  deps: Parameters<typeof reviewPm>[1] = {},
) {
  const reviewPayload = pmReviewerActorPayload({ goal_id: "goal", parent_id: binding.parent_id,
    ticket_id: candidate.id, prepare_receipt_id: chain.prepared.receipt_id, claim_id: chain.claimId,
    handoff_receipt_id: chain.handoff.receipt_id, worker_record_sha256: chain.workerRecord.record_sha256,
    manifest: chain.handoff.manifest, ticket_proof: chain.ticketProof, phase4_proof: request.phase4_proof,
    phase4: passClosure, verdict: request.verdict, findings: request.findings,
    ...(request.high_disposition ? { high_disposition: request.high_disposition } : {}) });
  chain.actors.addReviewer({ selector: request.reviewer_origin, ticketId: candidate.id,
    prepareReceiptId: chain.prepared.receipt_id, claimId: chain.claimId, payload: reviewPayload });
  return reviewPm({ ...request, cwd: root }, { ...chain.actors.deps, provider,
    loadContinuationClosureVerdict: async () => passClosure, ...deps });
}

async function treeSnapshot(root: string): Promise<string[]> {
  const rows: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name); const stat = await fs.lstat(file);
      rows.push(`${path.relative(root, file)}:${stat.mtimeMs}:${stat.size}`);
      if (entry.isDirectory()) await walk(file);
    }
  };
  await walk(root); return rows;
}

test("status authenticates and reports a complete chain byte-equivalently without mutation", async () => {
  const root = await activeHarness();
  try {
    const fixture = providerFixture(); const chain = await reviewedChain(root, fixture.provider); fixture.reset();
    const before = await treeSnapshot(root);
    const first = await statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider));
    const second = await statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider));
    assert.equal(JSON.stringify(first), JSON.stringify(second)); assert.deepEqual(await treeSnapshot(root), before);
    assert.equal(first.state, "manual_evidence"); assert.equal(first.producer.slot, "daily-0900");
    assert.deepEqual(first.worker, chain.handoff.worker); assert.deepEqual(first.reviewer, chain.review.reviewer);
    assert.deepEqual(first.artifact_hashes, chain.handoff.manifest); assert.equal(first.phase4?.verdict, "PASS");
    assert.equal(first.provider_references.prepare_annotation_id, chain.prepared.provider_annotation!.id);
    assert.equal(fixture.mutations(), 0); assert.ok(fixture.reads() > 0);
  } finally { await cleanup(root); }
});

test("status rereads both actor origins and rejects disappearance or post-review record changes", async () => {
  for (const hazard of ["worker_missing", "worker_hash", "reviewer_missing", "reviewer_payload"] as const) {
    const root = await activeHarness();
    try {
      const fixture = providerFixture(); const chain = await reviewedChain(root, fixture.provider);
      const workerKey = `${workerSelector.origin_id}\0${workerSelector.record_id}`;
      const reviewerKey = `${reviewerSelector.origin_id}\0${reviewerSelector.record_id}`;
      if (hazard === "worker_missing") chain.actors.records.delete(workerKey);
      if (hazard === "reviewer_missing") chain.actors.records.delete(reviewerKey);
      if (hazard === "worker_hash") chain.actors.records.get(workerKey)!.record_sha256 = "e".repeat(64);
      if (hazard === "reviewer_payload") chain.actors.records.get(reviewerKey)!.payload_sha256 = "e".repeat(64);
      await assert.rejects(statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider)),
        /pm_status_(?:worker_origin_invalid|reviewer_origin_invalid|chain_invalid)/);
    } finally { await cleanup(root); }
  }
});

test("Phase 5 gate exhaustively reduces authenticated review verdict and evidence class", async () => {
  const verdicts = ["BLOCKED", "FAIL", "PARTIAL", "PASS"] as const;
  const evidenceClasses = ["manual", "synthetic", "missing_natural", "verified_natural"] as const;
  for (const verdict of verdicts) {
    const root = await activeHarness();
    try {
      const fixture = providerFixture(); const chain = await reviewedChain(root, fixture.provider, verdict); fixture.reset();
      const artifactFile = path.join(root, "scheduler-matrix.json");
      const artifactCore = {
        schema_version: 1 as const, evidence_class: "natural_scheduler" as const, source: "external_scheduler" as const,
        goal_id: "goal", workspace_id: binding.workspace_id, parent_id: binding.parent_id,
        producer_slot: "daily-0900", invocation_key: "2026-07-15", ticket_id: candidate.id,
        review_receipt_id: chain.review.receipt_id, review_protected_state_sha256: chain.review.protected_state_sha256,
        scheduler_id: "scheduler-matrix", run_id: `scheduler-${verdict.toLowerCase()}`,
        scheduled_at: "2026-07-15T09:00:00.000Z", started_at: "2026-07-15T09:00:01.000Z",
        completed_at: "2026-07-15T17:00:00.000Z", timezone: "UTC", local_date: "2026-07-15",
        prepare_local_time: "09:00" as const, review_local_time: "17:00" as const,
        trigger: "scheduled" as const, manual_trigger: false, delivery: "local_no_delivery" as const,
      };
      for (const evidenceClass of evidenceClasses) {
        let request = statusRequest(root, chain.claimId);
        let deps: Parameters<typeof statusPm>[1] = statusDeps(fixture.provider);
        let naturalDigest: string | undefined;
        if (evidenceClass !== "manual") request = { ...request, evidence_requirement: "natural" as const };
        if (evidenceClass === "synthetic" || evidenceClass === "verified_natural") {
          const core = evidenceClass === "synthetic"
            ? { ...artifactCore, evidence_class: "synthetic_fixture" as const, trigger: "synthetic" as const }
            : artifactCore;
          const raw = JSON.stringify({ ...core, protected_state_sha256: sha(JSON.stringify(core)) });
          naturalDigest = sha(raw); await fs.writeFile(artifactFile, raw, "utf8");
          request = evidenceClass === "verified_natural"
            ? { ...request, scheduler_origin: { origin_id: "daily-pm", record_id: `record-${verdict.toLowerCase()}` } }
            : { ...request, scheduler_artifact: { path: artifactFile, sha256: naturalDigest } };
          if (evidenceClass === "verified_natural") deps = {
            ...deps, async readTrustedSchedulerArtifact() {
              return { origin: "scheduler_record", origin_id: "daily-pm", record_id: `record-${verdict.toLowerCase()}`,
                record_sha256: naturalDigest!, schedule: {
                timezone: core.timezone, local_date: core.local_date,
                prepare_local_time: core.prepare_local_time, review_local_time: core.review_local_time,
              }, artifact: JSON.parse(raw) as unknown };
            },
          };
        }
        const before = await treeSnapshot(root); const report = await statusPm(request, deps);
        assert.deepEqual(await treeSnapshot(root), before, `${verdict} x ${evidenceClass} mutated local state`);
        const expected = verdict === "BLOCKED"
          ? { verdict: "BLOCKED", reason_code: "PM_REVIEW_BLOCKED", evidence_reference: chain.review.receipt_id }
          : verdict === "FAIL"
            ? { verdict: "FAIL", reason_code: "PM_REVIEW_FAILED", evidence_reference: chain.review.receipt_id }
            : verdict === "PARTIAL"
              ? { verdict: "PARTIAL", reason_code: "PM_REVIEW_PARTIAL", evidence_reference: chain.review.receipt_id }
              : evidenceClass === "verified_natural"
                ? { verdict: "PASS", reason_code: "PM_NATURAL_EVIDENCE_VERIFIED", evidence_reference: naturalDigest! }
                : { verdict: "PARTIAL", reason_code: "PM_NATURAL_EVIDENCE_MISSING", evidence_reference: chain.review.receipt_id };
        assert.deepEqual(report.phase5_gate, { phase: "P5-E", ...expected }, `${verdict} x ${evidenceClass}`);
        assert.equal(fixture.mutations(), 0, `${verdict} x ${evidenceClass} mutated provider state`);
      }
    } finally { await cleanup(root); }
  }
});

test("natural evidence stays read-only, synthetic cannot promote, and one gap receipt replays", async () => {
  const root = await activeHarness();
  try {
    const fixture = providerFixture(); const chain = await reviewedChain(root, fixture.provider); fixture.reset();
    const naturalRequest = { ...statusRequest(root, chain.claimId), evidence_requirement: "natural" as const };
    const before = await treeSnapshot(root);
    const missing = await statusPm(naturalRequest, statusDeps(fixture.provider));
    assert.equal(missing.state, "missing_natural_evidence"); assert.deepEqual(await treeSnapshot(root), before);
    const gap1 = await statusPm({ ...naturalRequest, record_gap: true }, statusDeps(fixture.provider));
    const gap2 = await statusPm({ ...naturalRequest, record_gap: true }, statusDeps(fixture.provider));
    assert.deepEqual(gap2.evidence.gap_receipt, gap1.evidence.gap_receipt);
    const gap = gap1.evidence.gap_receipt!; assert.deepEqual(await readPmGapReceipt(root, gap.receipt_id), gap);
    assert.equal(path.basename(pmGapReceiptPath(root, gap.receipt_id)), `${gap.receipt_id}.json`);
    assert.deepEqual(gap1.phase5_gate, { phase: "P5-E", verdict: "PARTIAL",
      reason_code: "PM_NATURAL_EVIDENCE_MISSING", evidence_reference: gap.receipt_id });

    const artifactCore = {
      schema_version: 1 as const, evidence_class: "synthetic_fixture" as const, source: "external_scheduler" as const,
      goal_id: "goal", workspace_id: binding.workspace_id, parent_id: binding.parent_id,
      producer_slot: "daily-0900", invocation_key: "2026-07-15", ticket_id: candidate.id,
      review_receipt_id: chain.review.receipt_id, review_protected_state_sha256: chain.review.protected_state_sha256,
      scheduler_id: "scheduler-1", run_id: "scheduler-run-1", scheduled_at: "2026-07-15T09:00:00.000Z",
      started_at: "2026-07-15T09:00:01.000Z", completed_at: "2026-07-15T17:00:00.000Z",
      timezone: "UTC", local_date: "2026-07-15", prepare_local_time: "09:00" as const, review_local_time: "17:00" as const,
      trigger: "synthetic" as const, manual_trigger: false, delivery: "local_no_delivery" as const,
    };
    const artifactFile = path.join(root, "scheduler-artifact.json");
    const writeArtifact = async (core: typeof artifactCore): Promise<string> => {
      const raw = JSON.stringify({ ...core, protected_state_sha256: sha(JSON.stringify(core)) });
      await fs.writeFile(artifactFile, raw, "utf8"); return sha(raw);
    };
    let digest = await writeArtifact(artifactCore); const artifactMtime = (await fs.stat(artifactFile)).mtimeMs;
    await assert.rejects(statusPm({ ...naturalRequest, scheduler_artifact: { path: artifactFile, sha256: "0".repeat(64) } },
      statusDeps(fixture.provider)), /pm_status_scheduler_artifact_tampered/);
    const synthetic = await statusPm({ ...naturalRequest, scheduler_artifact: { path: artifactFile, sha256: digest } }, statusDeps(fixture.provider));
    assert.equal(synthetic.state, "missing_natural_evidence"); assert.equal(synthetic.evidence.classification, "synthetic");
    const naturalCore = { ...artifactCore, evidence_class: "natural_scheduler" as const, trigger: "scheduled" as const };
    digest = await writeArtifact(naturalCore); const naturalMtime = (await fs.stat(artifactFile)).mtimeMs;
    const adversarial = await statusPm({ ...naturalRequest, scheduler_artifact: { path: artifactFile, sha256: digest } }, {
      ...statusDeps(fixture.provider), async readTrustedSchedulerArtifact() { throw new Error("legacy path reached trusted reader"); },
    });
    assert.equal(adversarial.state, "missing_natural_evidence"); assert.equal(adversarial.evidence.classification, "synthetic");
    let trustedReads = 0;
    const naturalSelector = { origin_id: "daily-pm", record_id: "record-2026-07-15" };
    const natural = await statusPm({ ...naturalRequest, scheduler_origin: naturalSelector }, {
      ...statusDeps(fixture.provider), async readTrustedSchedulerArtifact(selector) { trustedReads += 1;
        assert.deepEqual(selector, naturalSelector);
        return { origin: "scheduler_record", ...naturalSelector, record_sha256: digest, schedule: { timezone: naturalCore.timezone,
          local_date: naturalCore.local_date, prepare_local_time: naturalCore.prepare_local_time, review_local_time: naturalCore.review_local_time },
          artifact: { ...naturalCore, protected_state_sha256: sha(JSON.stringify(naturalCore)) } }; },
    });
    assert.equal(natural.state, "verified_natural_evidence"); assert.equal(natural.evidence.classification, "verified_natural");
    assert.deepEqual(natural.phase5_gate, { phase: "P5-E", verdict: "PASS",
      reason_code: "PM_NATURAL_EVIDENCE_VERIFIED", evidence_reference: digest });
    assert.equal(trustedReads, 1); assert.ok(naturalMtime >= artifactMtime);
    assert.equal((await fs.stat(artifactFile)).mtimeMs, naturalMtime); assert.equal(fixture.mutations(), 0);
    const unconfigured = await statusPm({ ...naturalRequest, scheduler_origin: { origin_id: "unconfigured", record_id: "missing" } }, {
      ...statusDeps(fixture.provider), async readTrustedSchedulerArtifact() { return undefined; },
    });
    assert.equal(unconfigured.state, "missing_natural_evidence");
    assert.deepEqual(unconfigured.phase5_gate, { phase: "P5-E", verdict: "PARTIAL",
      reason_code: "PM_NATURAL_EVIDENCE_MISSING", evidence_reference: chain.review.receipt_id });
    await assert.rejects(statusPm({ ...naturalRequest, scheduler_origin: naturalSelector }, {
      ...statusDeps(fixture.provider), async readTrustedSchedulerArtifact() { return {
        origin: "scheduler_record", origin_id: "wrong-origin", record_id: naturalSelector.record_id,
        record_sha256: digest, schedule: { timezone: naturalCore.timezone, local_date: naturalCore.local_date,
          prepare_local_time: naturalCore.prepare_local_time, review_local_time: naturalCore.review_local_time },
        artifact: { ...naturalCore, protected_state_sha256: sha(JSON.stringify(naturalCore)) },
      }; },
    }), /pm_status_scheduler_origin_mismatch/);
    for (const invalidCore of [
      { ...naturalCore, scheduled_at: "2026-07-15T10:00:00.000Z", started_at: "2026-07-15T10:00:01.000Z", completed_at: "2026-07-15T10:01:00.000Z" },
      { ...naturalCore, started_at: "2026-07-15T08:59:59.000Z" },
      { ...naturalCore, scheduled_at: "2099-07-15T09:00:00.000Z", started_at: "2099-07-15T09:00:01.000Z",
        completed_at: "2099-07-15T17:00:00.000Z", local_date: "2099-07-15" },
      { ...naturalCore, timezone: "Asia/Hong_Kong" },
      { ...naturalCore, local_date: "2026-07-16" },
      { ...naturalCore, prepare_local_time: "10:00" },
    ]) {
      const invalidRaw = JSON.stringify({ ...invalidCore, protected_state_sha256: sha(JSON.stringify(invalidCore)) });
      const invalidDigest = sha(invalidRaw); await fs.writeFile(artifactFile, invalidRaw, "utf8");
      await assert.rejects(statusPm({ ...naturalRequest, scheduler_origin: naturalSelector }, {
        ...statusDeps(fixture.provider), async readTrustedSchedulerArtifact() { return { origin: "scheduler_record", ...naturalSelector,
          record_sha256: invalidDigest, schedule: { timezone: invalidCore.timezone, local_date: invalidCore.local_date,
            prepare_local_time: invalidCore.prepare_local_time as "09:00", review_local_time: invalidCore.review_local_time },
          artifact: JSON.parse(invalidRaw) as unknown }; },
      }), /pm_status_scheduler_artifact_(?:invalid|mismatch)/);
    }
    for (const evidence_class of ["synthetic_fixture", "manual"] as const) {
      const nonNaturalCore = { ...naturalCore, evidence_class, trigger: evidence_class === "manual" ? "manual" as const : "synthetic" as const };
      const nonNaturalRaw = JSON.stringify({ ...nonNaturalCore, protected_state_sha256: sha(JSON.stringify(nonNaturalCore)) });
      const nonNaturalDigest = sha(nonNaturalRaw); await fs.writeFile(artifactFile, nonNaturalRaw, "utf8");
      const nonNatural = await statusPm({ ...naturalRequest, scheduler_origin: naturalSelector }, {
        ...statusDeps(fixture.provider), async readTrustedSchedulerArtifact() { return { origin: "scheduler_record", ...naturalSelector,
          record_sha256: nonNaturalDigest, schedule: { timezone: nonNaturalCore.timezone, local_date: nonNaturalCore.local_date,
            prepare_local_time: nonNaturalCore.prepare_local_time, review_local_time: nonNaturalCore.review_local_time },
          artifact: JSON.parse(nonNaturalRaw) as unknown }; },
      });
      assert.equal(nonNatural.state, "missing_natural_evidence"); assert.equal(nonNatural.evidence.classification, "synthetic");
    }
    await assert.rejects(statusPm({ ...naturalRequest, scheduler_origin: naturalSelector,
      scheduler_artifact: { path: artifactFile, sha256: digest } }, statusDeps(fixture.provider)), /pm_invalid_status_request/);
    const forgedGapId = `pmg-${"f".repeat(32)}`; const gapFile = pmGapReceiptPath(root, gap.receipt_id);
    const forgedGap = JSON.parse(await fs.readFile(gapFile, "utf8")) as Record<string, unknown>;
    delete forgedGap.protected_state_sha256; forgedGap.receipt_id = forgedGapId;
    forgedGap.protected_state_sha256 = sha(JSON.stringify(forgedGap));
    await fs.writeFile(pmGapReceiptPath(root, forgedGapId), JSON.stringify(forgedGap), "utf8");
    await assert.rejects(readPmGapReceipt(root, forgedGapId), /pm_status_identity_invalid/);
  } finally { await cleanup(root); }
});

test("status fails closed for destination, digest, provenance, and provider-reference mismatches", async () => {
  const root = await activeHarness();
  try {
    const fixture = providerFixture(); const chain = await reviewedChain(root, fixture.provider);
    await assert.rejects(statusPm({ ...statusRequest(root, chain.claimId), workspace_id: "11111111-1111-4111-8111-111111111111" },
      { binding, provider: fixture.provider }), /pm_status_destination_mismatch/);
    await assert.rejects(statusPm({ ...statusRequest(root, chain.claimId), parent_id: "parent-other" },
      { binding, provider: fixture.provider }), /pm_status_destination_mismatch/);
    fixture.omitEvidence(true);
    await assert.rejects(statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider)), /pm_status_evidence_reference_invalid/);
    fixture.omitEvidence(false);
    await assert.rejects(statusPm(statusRequest(root, chain.claimId), { ...statusDeps(fixture.provider),
      loadContinuationClosureVerdict: async () => ({ ...passClosure, proof_id: "b".repeat(64) }) }), /pm_status_phase4_invalid/);
    const reviewFile = path.join(root, ".ycm-harness", "autonomy", "pm", "review", `${chain.review.receipt_id}.json`);
    const original = JSON.parse(await fs.readFile(reviewFile, "utf8")) as Record<string, unknown>;
    const tampered = { ...original, reviewer: { subject: "worker-1", run_id: "worker-run-1", session_id: "worker-session-1" } };
    await fs.writeFile(reviewFile, JSON.stringify(tampered), "utf8");
    await assert.rejects(statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider)), /pm_review_receipt_tampered/);
    const { protected_state_sha256: _protected, ...reprovenanced } = tampered;
    await fs.writeFile(reviewFile, JSON.stringify({ ...reprovenanced, protected_state_sha256: sha(JSON.stringify(reprovenanced)) }), "utf8");
    await assert.rejects(statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider)), /pm_status_chain_invalid/);
  } finally { await cleanup(root); }
});

test("status exposes remote review mutation without finalization and never repairs it", async () => {
  const root = await activeHarness();
  try {
    const fixture = providerFixture(); const chain = await reviewedChain(root, fixture.provider);
    const reviewFile = path.join(root, ".ycm-harness", "autonomy", "pm", "review", `${chain.review.receipt_id}.json`);
    await fs.rm(reviewFile);
    const request = structuredClone(chain.reviewRequest);
    request.verdict = "PARTIAL";
    request.findings = [{ id: "medium-1", severity: "Medium", root_cause_key: "root-medium",
      summary: "Record a resolved finding.", evidence: ["review output"], disposition: { kind: "resolved", resolution: "Resolved locally." } }];
    await assert.rejects(executeReplacementReview(root, chain, request, fixture.provider,
      { faultAt: "after_disposition_before_finalize" }), /pm_fault_after_review_disposition/);
    fixture.reset(); const before = await treeSnapshot(root);
    const report = await statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider));
    assert.equal(report.state, "mutation_uncommitted"); assert.equal(report.recovery?.owning_command, "autonomy pm review");
    assert.match(report.recovery!.instruction, /original producer slot and invocation key.*exact provider readback/i);
    assert.deepEqual(await treeSnapshot(root), before); assert.equal(fixture.mutations(), 0);
    await executeReplacementReview(root, chain, request, fixture.provider);
    const finalized = await statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider));
    assert.equal(finalized.state, "manual_evidence");
    const findingAnnotation = [...fixture.annotations.values()].find((row) => row.key.startsWith("pmd-"))!;
    fixture.annotations.set(findingAnnotation.key, { ...findingAnnotation, content: `${findingAnnotation.content}\nforged` });
    await assert.rejects(statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider)), /pm_status_evidence_reference_invalid/);
  } finally { await cleanup(root); }
});

test("an unrelated new provider ID cannot impersonate an uncommitted review mutation", async () => {
  const root = await activeHarness();
  try {
    const fixture = providerFixture(); const chain = await reviewedChain(root, fixture.provider);
    await fs.rm(path.join(root, ".ycm-harness", "autonomy", "pm", "review", `${chain.review.receipt_id}.json`));
    const request = structuredClone(chain.reviewRequest); request.verdict = "PARTIAL";
    request.findings = [{ id: "medium-pending", severity: "Medium", root_cause_key: "root-pending",
      summary: "Pending exact mutation.", evidence: ["review output"], disposition: { kind: "resolved", resolution: "Resolve exactly." } }];
    await assert.rejects(executeReplacementReview(root, chain, request, fixture.provider,
      { faultAt: "after_write_before_disposition" }), /pm_fault_after_review_write/);
    await fixture.provider.annotate(candidate.id, "unrelated-key", "unrelated provider content"); fixture.reset();
    const report = await statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider));
    assert.equal(report.state, "incomplete"); assert.equal(report.reason_code, "PM_REVIEW_NOT_FINALIZED");
    assert.equal(report.recovery, undefined); assert.equal(fixture.mutations(), 0);
  } finally { await cleanup(root); }
});

test("finalized correction references require exact read-only correction content", async () => {
  const root = await activeHarness();
  try {
    const fixture = providerFixture(); const chain = await reviewedChain(root, fixture.provider);
    await fs.rm(path.join(root, ".ycm-harness", "autonomy", "pm", "review", `${chain.review.receipt_id}.json`));
    const request = structuredClone(chain.reviewRequest); request.verdict = "FAIL";
    request.findings = [{ id: "high-correction", severity: "High", root_cause_key: "root-correction",
      summary: "Exact correction required.", evidence: ["authenticated failure"] }];
    request.high_disposition = { kind: "correction", strength: "stronger", required_capability: { id: "implementation", rank: 2 },
      title: "Correct exact PM output", acceptance: ["Exact independent review passes."], verification: ["Run exact status."],
      rollback: "Retain the failed receipt." };
    await executeReplacementReview(root, chain, request, fixture.provider);
    assert.equal((await statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider))).state, "manual_evidence");
    const stored = [...fixture.corrections.values()][0]!; stored.request = { ...(stored.request as Record<string, unknown>), title: "forged" };
    await assert.rejects(statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider)), /pm_status_evidence_reference_invalid/);
  } finally { await cleanup(root); }
});

test("finalized blocker references require the exact annotation identity and content", async () => {
  const root = await activeHarness();
  try {
    const fixture = providerFixture(); const chain = await reviewedChain(root, fixture.provider);
    await fs.rm(path.join(root, ".ycm-harness", "autonomy", "pm", "review", `${chain.review.receipt_id}.json`));
    const request = structuredClone(chain.reviewRequest); request.verdict = "FAIL";
    request.findings = [{ id: "high-blocker", severity: "High", root_cause_key: "root-blocker",
      summary: "Exact blocker required.", evidence: ["authenticated external blocker"] }];
    request.high_disposition = { kind: "blocker", reason: "External authority is unavailable." };
    const receipt = await executeReplacementReview(root, chain, request, fixture.provider);
    const report = await statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider));
    assert.equal(report.state, "blocked");
    assert.deepEqual(report.phase5_gate, { phase: "P5-E", verdict: "BLOCKED", reason_code: "PM_REVIEW_BLOCKED",
      evidence_reference: receipt.receipt_id });
    assert.equal(receipt.high_disposition?.kind, "blocker");
    if (receipt.high_disposition?.kind !== "blocker") throw new Error("blocker receipt required");
    const annotation = receipt.high_disposition.provider_annotation;
    fixture.annotations.set(annotation.key, { ...annotation, content: `${annotation.content}\nforged` });
    await assert.rejects(statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider)), /pm_status_evidence_reference_invalid/);
  } finally { await cleanup(root); }
});

test("status identifies an exact remote prepare mutation and delegates reconciliation to prepare", async () => {
  const root = await activeHarness();
  try {
    const fixture = providerFixture();
    await assert.rejects(preparePm({ cwd: root, goal: "goal", producer_slot: "daily-0900", invocation_key: "2026-07-15",
      run_id: "prepare-run", session_id: "prepare-session", brief },
    { provider: fixture.provider, faultAt: "after_mutation_before_finalize" }), /pm_fault_after_mutation_before_finalize/);
    fixture.reset(); const before = await treeSnapshot(root);
    const report = await statusPm({ cwd: root, goal: "goal", workspace_id: binding.workspace_id, parent_id: binding.parent_id,
      producer_slot: "daily-0900", invocation_key: "2026-07-15", evidence_requirement: "manual", record_gap: false },
    { binding, provider: fixture.provider });
    assert.equal(report.state, "mutation_uncommitted"); assert.equal(report.recovery?.owning_command, "autonomy pm prepare");
    assert.deepEqual(await treeSnapshot(root), before); assert.equal(fixture.mutations(), 0);
  } finally { await cleanup(root); }
});

test("status canonically distinguishes incomplete and blocked chains", async () => {
  for (const blocked of [false, true]) {
    const root = await activeHarness();
    try {
      const fixture = providerFixture(blocked ? [{ ...candidate, safe_authority: false }] : [candidate]);
      const prepared = await preparePm({ cwd: root, goal: "goal", producer_slot: "daily-0900", invocation_key: "2026-07-15",
        run_id: "prepare-run", session_id: "prepare-session", brief }, { provider: fixture.provider });
      const report = await statusPm({ ...statusRequest(root, "unused"), claim_id: undefined }, { binding, provider: fixture.provider });
      assert.equal(report.state, blocked ? "blocked" : "incomplete");
      assert.equal(prepared.state, blocked ? "blocked" : "claimed");
    } finally { await cleanup(root); }
  }
});

test("reprotected noncanonical prepare, claim, handoff, and review identities fail closed", async () => {
  const cases = [
    { directory: "prepare", field: "receipt_id", value: `pm-${"f".repeat(32)}`, error: /pm_status_identity_invalid/ },
    { directory: "claims", field: "claim_receipt_id", value: `pmcr-${"f".repeat(32)}`, error: /pm_status_identity_invalid/ },
    { directory: "handoff", field: "receipt_id", value: `pmh-${"f".repeat(32)}`, error: /pm_status_identity_invalid/ },
    { directory: "review", field: "receipt_id", value: `pmr-${"f".repeat(32)}`, error: /pm_status_identity_invalid/ },
  ];
  for (const row of cases) {
    const root = await activeHarness();
    try {
      const fixture = providerFixture(); const chain = await reviewedChain(root, fixture.provider);
      const name = row.directory === "prepare" ? `${chain.prepared.receipt_id}.json`
        : row.directory === "claims" ? `${chain.prepared.receipt_id}.json`
          : row.directory === "handoff" ? `${chain.handoff.receipt_id}.json` : `${chain.review.receipt_id}.json`;
      const file = path.join(root, ".ycm-harness", "autonomy", "pm", row.directory, name);
      const receipt = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
      delete receipt.protected_state_sha256; receipt[row.field] = row.value;
      receipt.protected_state_sha256 = sha(JSON.stringify(receipt)); await fs.writeFile(file, JSON.stringify(receipt), "utf8");
      await assert.rejects(statusPm(statusRequest(root, chain.claimId), statusDeps(fixture.provider)), row.error);
    } finally { await cleanup(root); }
  }
});

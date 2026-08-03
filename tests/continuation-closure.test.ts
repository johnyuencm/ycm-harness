import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  continuationClosureGate,
  loadContinuationClosureVerdict,
} from "../src/continuation/closure.js";
import { defaultExecutionPolicy, type ExecutionPolicyInput } from "../src/continuation/cost-policy.js";
import {
  finalizeScheduledResponse,
  continuationAuditCommitment,
  ContinuationShadowRecordSchema,
  continuationRawSha,
  continuationShadowProtectedSha,
  readContinuationShadowRecords,
  type CanonicalContinuationVerdict,
  type ContinuationClosureSurface,
  type ScheduledResponseShadowContext,
} from "../src/continuation/shadow.js";
import { ContinuationAuditRecordSchema, persistContinuationAudit, readContinuationAudits } from "../src/continuation/audit.js";
import { runCli } from "../src/cli/index.js";
import { emptyStateV3, type TicketT } from "../src/schema/v3.js";
import { HarnessStore } from "../src/state/store.js";
import { submissionDigest } from "../src/tickets/evidence.js";
import { cleanup, tempProject, trivialSmokeCommand } from "./helpers.js";

const NOW = "2026-07-16T06:07:08.000Z";
const EMPTY = `\`\`\`continuation-ledger\n${JSON.stringify({ items: [] })}\n\`\`\``;
const SURFACES: ContinuationClosureSurface[] = [
  "scheduled-finalization",
  "verification-completion",
  "ticket-completion",
  "goal-completion",
];

function llmPolicy(): ExecutionPolicyInput {
  return {
    stages: [
      { stage: "no_agent", outcome: "inapplicable", reason: "model_output", evidence_reference: "route", observation_count: 1 },
      { stage: "script", outcome: "insufficient", reason: "semantic_output", evidence_reference: "script", observation_count: 1 },
      { stage: "targeted_read", outcome: "insufficient", reason: "semantic_output", evidence_reference: "read", observation_count: 1 },
      { stage: "reuse_reference", outcome: "insufficient", reason: "semantic_output", evidence_reference: "reuse", observation_count: 1 },
      { stage: "model", outcome: "sufficient" },
    ],
    required_capabilities: ["synthesis"],
    model_roster: [{ model_id: "bounded", tier: "bounded", cost_rank: 1, capabilities: ["synthesis"] }],
    model_invocations: [{ role: "executor", model_id: "bounded", required_capabilities: ["synthesis"], recursive: false }],
  };
}

function scheduledContext(root: string, runId = "proof-run"): ScheduledResponseShadowContext {
  return {
    root,
    parentId: "proof-parent",
    runId,
    sessionId: "proof-session",
    scheduleId: "proof-schedule",
    trigger: "scheduled",
    enabled: true,
    routing: "LLM",
    executionPolicy: llmPolicy(),
  };
}

async function passProof(root: string): Promise<CanonicalContinuationVerdict> {
  const result = await finalizeScheduledResponse(EMPTY, scheduledContext(root), {
    env: { YCM_HARNESS_SCHEDULED_FINALIZER_MODE: "shadow" },
    now: () => NOW,
    readTicket: async () => undefined,
    readMutations: async () => [],
  });
  assert.equal(result.verdict?.verdict, "PASS");
  return result.verdict!;
}

function binding(root: string, proofId: string, surface: ContinuationClosureSurface) {
  return {
    root,
    proofId,
    parentId: "proof-parent",
    runId: "proof-run",
    sessionId: "proof-session",
    responseText: EMPTY,
    surface,
  };
}

function core(verdict: CanonicalContinuationVerdict): Omit<CanonicalContinuationVerdict, "surface"> {
  const { surface: _surface, ...rest } = verdict;
  return rest;
}

function proofEnv(proofId: string): Record<string, string> {
  return {
    YCM_HARNESS_SCHEDULED_FINALIZER_MODE: "enforce",
    YCM_HARNESS_CONTINUATION_PROOF_ID: proofId,
    YCM_HARNESS_CONTINUATION_PROOF_PARENT_ID: "proof-parent",
    YCM_HARNESS_CONTINUATION_PROOF_RUN_ID: "proof-run",
    YCM_HARNESS_CONTINUATION_PROOF_SESSION_ID: "proof-session",
  };
}

async function withProcessEnv<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { return await action(); } finally {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

test("one audited proof yields byte-identical closure data on every surface without another write", async () => {
  const root = await tempProject("ch-closure-parity-");
  try {
    const scheduled = await passProof(root);
    const loaded = await Promise.all(SURFACES.map((surface) =>
      loadContinuationClosureVerdict(binding(root, scheduled.proof_id, surface))));
    assert.ok(loaded.every((verdict) => JSON.stringify(core(verdict)) === JSON.stringify(core(scheduled))));
    assert.equal((await readContinuationShadowRecords(root)).length, 1);
    assert.equal((await readContinuationAudits(root)).length, 1);

    const env = proofEnv(scheduled.proof_id);
    const gated = await Promise.all(SURFACES.map((surface) => continuationClosureGate({ root, surface, env })));
    assert.ok(gated.every((verdict) => verdict && JSON.stringify(core(verdict)) === JSON.stringify(core(scheduled))));
    assert.equal((await readContinuationShadowRecords(root)).length, 1);
    assert.equal((await readContinuationAudits(root)).length, 1);
  } finally {
    await cleanup(root);
  }
});

test("missing, malformed, not-found, stale-binding, and corrupt-audit proof inputs fail closed stably", async () => {
  const root = await tempProject("ch-closure-invalid-");
  const malformedRoot = await tempProject("ch-closure-malformed-");
  try {
    const proof = await passProof(root);
    assert.deepEqual((await continuationClosureGate({
      root,
      surface: "ticket-completion",
      env: { YCM_HARNESS_SCHEDULED_FINALIZER_MODE: "enforce" },
    }))?.reasons, [
      "CONTINUATION_PROOF_ID_MISSING",
      "CONTINUATION_PROOF_PARENT_MISSING",
      "CONTINUATION_PROOF_RUN_MISSING",
      "CONTINUATION_PROOF_SESSION_MISSING",
    ]);
    assert.deepEqual((await loadContinuationClosureVerdict({ ...binding(root, "bad", "ticket-completion") })).reasons,
      ["CONTINUATION_PROOF_ID_INVALID"]);
    assert.deepEqual((await loadContinuationClosureVerdict(binding(root, "0".repeat(64), "ticket-completion"))).reasons,
      ["CONTINUATION_PROOF_NOT_FOUND"]);
    assert.deepEqual((await loadContinuationClosureVerdict({
      ...binding(root, proof.proof_id, "ticket-completion"),
      parentId: "stale-parent",
      runId: "stale-run",
      sessionId: "stale-session",
    })).reasons, [
      "CONTINUATION_PROOF_PARENT_MISMATCH",
      "CONTINUATION_PROOF_RUN_MISMATCH",
      "CONTINUATION_PROOF_SESSION_MISMATCH",
    ]);

    const legacyContent = {
      schema_version: 1 as const,
      response_sha256: continuationShadowProtectedSha("response", "legacy"),
      schedule_sha256: continuationShadowProtectedSha("schedule", "legacy"),
      parent_sha256: continuationShadowProtectedSha("parent", "proof-parent"),
      run_sha256: continuationShadowProtectedSha("run", "proof-run"),
      session_sha256: continuationShadowProtectedSha("session", "proof-session"),
      routing: "NO_AGENT" as const,
      would_block_verdict: "PASS" as const,
      reasons: [],
      audit_persisted: false,
    };
    const legacyId = continuationShadowProtectedSha("content", JSON.stringify(legacyContent));
    const authenticated = { ...legacyContent, shadow_id: legacyId, content_sha256: legacyId, recorded_at: NOW };
    const legacy = { ...authenticated, record_sha256: continuationShadowProtectedSha("record", JSON.stringify(authenticated)) };
    const shadowDir = path.join(root, ".ycm-harness", "autonomy", "continuation-shadows", "records");
    await fs.writeFile(path.join(shadowDir, `${legacy.record_sha256}.json`), `${JSON.stringify(legacy)}\n`, "utf8");
    assert.deepEqual((await loadContinuationClosureVerdict(binding(root, legacyId, "ticket-completion"))).reasons,
      ["CONTINUATION_PROOF_VERSION_UNSUPPORTED"]);

    const auditDir = path.join(root, ".ycm-harness", "autonomy", "continuation-audits", "records");
    const [auditName] = await fs.readdir(auditDir);
    const auditFile = path.join(auditDir, auditName!);
    const audit = JSON.parse(await fs.readFile(auditFile, "utf8")) as Record<string, unknown>;
    await fs.writeFile(auditFile, `${JSON.stringify({ ...audit, reasons: ["forged"] })}\n`, "utf8");
    assert.deepEqual((await loadContinuationClosureVerdict(binding(root, proof.proof_id, "ticket-completion"))).reasons,
      ["CONTINUATION_AUDIT_MALFORMED"]);

    const malformedDir = path.join(malformedRoot, ".ycm-harness", "autonomy", "continuation-shadows", "records");
    await fs.mkdir(malformedDir, { recursive: true });
    await fs.writeFile(path.join(malformedDir, `${"1".repeat(64)}.json`), "{}\n", "utf8");
    assert.deepEqual((await loadContinuationClosureVerdict(binding(malformedRoot, "1".repeat(64), "ticket-completion"))).reasons,
      ["CONTINUATION_PROOF_MALFORMED"]);
  } finally {
    await cleanup(root);
    await cleanup(malformedRoot);
  }
});

test("v3 cross-store commitments reject no-agent PASS policy and every mismatched audit projection", async () => {
  const root = await tempProject("ch-closure-commitment-");
  try {
    const audit = await persistContinuationAudit(EMPTY, { status: "PASS", reasons: [], items: [] }, {
      root,
      parentId: "proof-parent",
      runId: "proof-run",
      sessionId: "proof-session",
      surface: "scheduled-finalizer",
      mode: "shadow",
      executionPolicy: defaultExecutionPolicy(),
    }, { now: () => NOW });
    const baseCommitment = continuationAuditCommitment(audit);
    const directory = path.join(root, ".ycm-harness", "autonomy", "continuation-shadows", "records");
    await fs.mkdir(directory, { recursive: true });
    const store = async (auditCommitment: typeof baseCommitment): Promise<string> => {
      const content = {
        response_sha256: continuationShadowProtectedSha("response", EMPTY),
        schedule_sha256: continuationShadowProtectedSha("schedule", "proof-schedule"),
        parent_sha256: continuationShadowProtectedSha("parent", "proof-parent"),
        run_sha256: continuationShadowProtectedSha("run", "proof-run"),
        session_sha256: continuationShadowProtectedSha("session", "proof-session"),
        routing: "LLM" as const,
        would_block_verdict: "PASS" as const,
        reasons: [],
        audit_persisted: true,
        audit_reference: audit.audit_id,
        schema_version: 3 as const,
        audit_commitment: auditCommitment,
      };
      const id = continuationShadowProtectedSha("content", JSON.stringify(content));
      const authenticated = { ...content, shadow_id: id, content_sha256: id, recorded_at: NOW };
      const record = { ...authenticated, record_sha256: continuationShadowProtectedSha("record", JSON.stringify(authenticated)) };
      const parsed = ContinuationShadowRecordSchema.safeParse(record);
      assert.ok(parsed.success, parsed.error?.message);
      await fs.writeFile(path.join(directory, `${record.record_sha256}.json`), `${JSON.stringify(record)}\n`, "utf8");
      return id;
    };
    const policyProof = await store(baseCommitment);
    assert.deepEqual((await loadContinuationClosureVerdict(binding(root, policyProof, "ticket-completion"))).reasons,
      ["CONTINUATION_AUDIT_POLICY_MISMATCH"]);
    for (const field of ["response_sha256", "items_sha256", "evidence_reference_ids_sha256", "policy_sha256"] as const) {
      const proofId = await store({ ...baseCommitment, [field]: "f".repeat(64) });
      assert.deepEqual((await loadContinuationClosureVerdict(binding(root, proofId, "ticket-completion"))).reasons,
        ["CONTINUATION_AUDIT_COMMITMENT_MISMATCH"], field);
    }
  } finally {
    await cleanup(root);
  }
});

test("closure canonically re-evaluates committed policy declarations before routing and pair checks", async () => {
  const root = await tempProject("ch-closure-policy-replay-");
  try {
    const auditDirectory = path.join(root, ".ycm-harness", "autonomy", "continuation-audits", "records");
    const shadowDirectory = path.join(root, ".ycm-harness", "autonomy", "continuation-shadows", "records");
    await fs.mkdir(auditDirectory, { recursive: true });
    await fs.mkdir(shadowDirectory, { recursive: true });
    const writeAudit = async (policy: Record<string, unknown>, verdict: "PASS" | "FAIL", reasons: string[]) => {
      const content = {
        schema_version: 2 as const,
        response_sha256: continuationRawSha(EMPTY),
        items: [],
        evidence_reference_ids: [],
        verdict,
        reasons,
        policy,
        surface: "scheduled-finalizer",
        mode: "shadow",
        parent_sha256: continuationRawSha("proof-parent"),
        run_sha256: continuationRawSha("proof-run"),
        session_sha256: continuationRawSha("proof-session"),
      };
      const draft = ContinuationAuditRecordSchema.parse({
        ...content,
        audit_id: "0".repeat(64),
        content_sha256: "0".repeat(64),
        recorded_at: NOW,
        record_sha256: "0".repeat(64),
      });
      const {
        audit_id: _auditId,
        content_sha256: _contentSha,
        recorded_at: _recordedAt,
        record_sha256: _recordSha,
        ...normalizedContent
      } = draft;
      const id = continuationRawSha(JSON.stringify(normalizedContent));
      const authenticated = { ...normalizedContent, audit_id: id, content_sha256: id, recorded_at: NOW };
      const record = { ...authenticated, record_sha256: continuationRawSha(JSON.stringify(authenticated)) };
      const parsed = ContinuationAuditRecordSchema.parse(record);
      await fs.writeFile(path.join(auditDirectory, `${parsed.record_sha256}.json`), `${JSON.stringify(parsed)}\n`, "utf8");
      return parsed;
    };
    const writeProof = async (audit: ReturnType<typeof ContinuationAuditRecordSchema.parse>, pair?: [string, string]) => {
      const content = {
        response_sha256: continuationShadowProtectedSha("response", EMPTY),
        schedule_sha256: continuationShadowProtectedSha("schedule", "proof-schedule"),
        parent_sha256: continuationShadowProtectedSha("parent", "proof-parent"),
        run_sha256: continuationShadowProtectedSha("run", "proof-run"),
        session_sha256: continuationShadowProtectedSha("session", "proof-session"),
        routing: "LLM" as const,
        would_block_verdict: audit.verdict,
        reasons: audit.reasons,
        audit_persisted: true,
        audit_reference: audit.audit_id,
        ...(pair ? { failure_id: pair[0], correction_reservation_id: pair[1] } : {}),
        schema_version: 3 as const,
        audit_commitment: continuationAuditCommitment(audit),
      };
      const id = continuationShadowProtectedSha("content", JSON.stringify(content));
      const authenticated = { ...content, shadow_id: id, content_sha256: id, recorded_at: NOW };
      const record = ContinuationShadowRecordSchema.parse({
        ...authenticated,
        record_sha256: continuationShadowProtectedSha("record", JSON.stringify(authenticated)),
      });
      await fs.writeFile(path.join(shadowDirectory, `${record.record_sha256}.json`), `${JSON.stringify(record)}\n`, "utf8");
      return id;
    };
    const validTrace = {
      stages: llmPolicy().stages,
      required_capabilities: ["synthesis"],
      model_roster: [{ model_id: "bounded", tier: "bounded", cost_rank: 1, capabilities: ["synthesis"] }],
      model_invocations: [{ role: "executor", model_id: "bounded", required_capabilities: ["synthesis"], recursive: false }],
      correction_count: 0,
    };
    const invalidAudit = await writeAudit({
      verdict: "PASS",
      reasons: [],
      trace: {
        ...validTrace,
        model_invocations: [{ role: "judge", model_id: "unknown", required_capabilities: ["wrong"], recursive: true }],
      },
    }, "PASS", []);
    const invalidProof = await writeProof(invalidAudit);
    assert.deepEqual((await loadContinuationClosureVerdict(binding(root, invalidProof, "ticket-completion"))).reasons,
      ["CONTINUATION_AUDIT_POLICY_INVALID"]);

    const declaredFailure = await writeAudit({
      verdict: "FAIL",
      reasons: ["FORGED_POLICY_REASON"],
      trace: validTrace,
      policy_failure_id: "a".repeat(64),
      correction_reservation_id: "b".repeat(64),
    }, "FAIL", ["VALIDATION_FAILED"]);
    const declaredFailureProof = await writeProof(declaredFailure, ["a".repeat(64), "b".repeat(64)]);
    assert.deepEqual((await loadContinuationClosureVerdict(binding(root, declaredFailureProof, "ticket-completion"))).reasons,
      ["CONTINUATION_AUDIT_POLICY_INVALID"]);

    const invalidStages = llmPolicy().stages;
    invalidStages[1] = { stage: "script", outcome: "skipped" };
    const validFailure = await finalizeScheduledResponse(EMPTY, {
      ...scheduledContext(root, "valid-failure-run"),
      executionPolicy: { ...llmPolicy(), stages: invalidStages },
    }, { now: () => NOW, readTicket: async () => undefined, readMutations: async () => [] });
    const accepted = await loadContinuationClosureVerdict({
      root,
      proofId: validFailure.verdict!.proof_id,
      parentId: "proof-parent",
      runId: "valid-failure-run",
      sessionId: "proof-session",
      responseText: EMPTY,
      surface: "ticket-completion",
    });
    assert.equal(accepted.verdict, "FAIL");
    assert.deepEqual(accepted.reasons, validFailure.verdict!.reasons);
  } finally {
    await cleanup(root);
  }
});

test("one tracker-outage proof blocks every enforced CLI closure and retains one failure pair", async () => {
  const root = await tempProject("ch-closure-outage-");
  const tracked = `\`\`\`continuation-ledger\n${JSON.stringify({ items: [{
    lane: "NEXT", action: "Inspect", disposition: "TRACKED", ticket_id: "AUT-34", evidence: "comment-7",
    expected_impact: "Confirms", cost_class: "low", evidence_horizon: "this run",
  }] })}\n\`\`\``;
  try {
    const scheduled = await finalizeScheduledResponse(tracked, scheduledContext(root), {
      env: { YCM_HARNESS_SCHEDULED_FINALIZER_MODE: "enforce" },
      now: () => NOW,
      readTicket: async () => { throw new Error("tracker offline private detail"); },
      readMutations: async () => [],
    });
    assert.equal(scheduled.verdict?.verdict, "FAIL");
    assert.ok(scheduled.verdict?.failure_id && scheduled.verdict.correction_reservation_id);
    const proof = scheduled.verdict!;
    const loaded = await Promise.all(SURFACES.map((surface) =>
      loadContinuationClosureVerdict({ ...binding(root, proof.proof_id, surface), responseText: tracked })));
    assert.ok(loaded.every((verdict) => JSON.stringify(core(verdict)) === JSON.stringify(core(proof))));

    const state = emptyStateV3(NOW);
    state.active_goal_id = "goal";
    state.goals.goal = { id: "goal", title: "Goal", status: "active", assurance: "standard", backend: { kind: "local" }, stop_enforcement: false, created_at: NOW, updated_at: NOW };
    const ticket: TicketT = { id: "ticket", goal_id: "goal", title: "Ticket", acceptance: [], blocked_by: [], status: "in_review", code_changed: false, order: 0, created_at: NOW, updated_at: NOW };
    state.local_tickets.ticket = ticket;
    const digest = await submissionDigest(root, ticket);
    state.evidence.submission = { id: "submission", goal_id: "goal", ticket_id: "ticket", kind: "other", submission_digest: digest, provenance: {}, recorded_at: NOW };
    state.evidence.verification = { id: "verification", goal_id: "goal", ticket_id: "ticket", kind: "verification", submission_digest: digest, outcome: "pass", provenance: { implementer_run: "impl", verifier_run: "review" }, recorded_at: NOW };
    const store = new HarnessStore(root);
    await store.writeStateV3(state);
    await withProcessEnv(proofEnv(proof.proof_id), async () => {
      assert.equal(await runCli(["--cwd", root, "ticket", "done", "ticket"]), 1);
      assert.equal((await store.readStateV3()).local_tickets.ticket?.status, "in_review");
      await assert.rejects(fs.stat(path.join(root, ".ycm-harness", "smoke-logs")));
      assert.equal(await runCli(["--cwd", root, "verify", "run", "--ticket", "ticket", "--command", trivialSmokeCommand(), "--implementer-run", "impl", "--verifier-run", "review"]), 1);
      assert.equal((await store.readStateV3()).local_tickets.ticket?.status, "in_review");
      await assert.rejects(fs.stat(path.join(root, ".ycm-harness", "smoke-logs")));
      const terminal = await store.readStateV3();
      terminal.local_tickets.ticket = { ...terminal.local_tickets.ticket!, status: "done" };
      await store.writeStateV3(terminal);
      assert.equal(await runCli(["--cwd", root, "goal", "complete", "goal"]), 1);
    });
    const after = await store.readStateV3();
    assert.equal(after.goals.goal?.status, "active");
    assert.equal(Object.keys(after.evidence).length, 2);
    assert.equal((await readContinuationShadowRecords(root)).length, 1);
    assert.equal((await readContinuationAudits(root)).length, 1);
  } finally {
    await cleanup(root);
  }
});

test("verification, ticket, and goal terminal mutations reuse the same proof while shadow is rollback", async () => {
  const root = await tempProject("ch-closure-cli-");
  try {
    const proof = await passProof(root);
    const state = emptyStateV3(NOW);
    state.active_goal_id = "goal";
    state.goals.goal = { id: "goal", title: "Goal", status: "active", assurance: "standard", backend: { kind: "local" }, stop_enforcement: false, created_at: NOW, updated_at: NOW };
    const verifyTicket: TicketT = { id: "verify-ticket", goal_id: "goal", title: "Verify", acceptance: [], blocked_by: [], status: "in_review", code_changed: false, order: 0, created_at: NOW, updated_at: NOW };
    const doneTicket: TicketT = { id: "done-ticket", goal_id: "goal", title: "Done", acceptance: [], blocked_by: [], status: "in_review", code_changed: false, order: 1, created_at: NOW, updated_at: NOW };
    state.local_tickets[verifyTicket.id] = verifyTicket;
    state.local_tickets[doneTicket.id] = doneTicket;
    state.evidence["verify-submission"] = { id: "verify-submission", goal_id: "goal", ticket_id: verifyTicket.id, kind: "other", submission_digest: await submissionDigest(root, verifyTicket), provenance: {}, recorded_at: NOW };
    const doneDigest = await submissionDigest(root, doneTicket);
    state.evidence["done-submission"] = { id: "done-submission", goal_id: "goal", ticket_id: doneTicket.id, kind: "other", submission_digest: doneDigest, provenance: {}, recorded_at: NOW };
    state.evidence["done-verification"] = { id: "done-verification", goal_id: "goal", ticket_id: doneTicket.id, kind: "verification", submission_digest: doneDigest, outcome: "pass", provenance: { implementer_run: "impl", verifier_run: "review" }, recorded_at: NOW };
    const store = new HarnessStore(root);
    await store.writeStateV3(state);

    await withProcessEnv(proofEnv(proof.proof_id), async () => {
      assert.equal(await runCli(["--cwd", root, "verify", "run", "--ticket", verifyTicket.id, "--command", trivialSmokeCommand(), "--implementer-run", "impl", "--verifier-run", "review"]), 0);
      assert.equal(await runCli(["--cwd", root, "ticket", "done", doneTicket.id]), 0);
      assert.equal(await runCli(["--cwd", root, "goal", "complete", "goal"]), 0);
    });
    const completed = await store.readStateV3();
    assert.equal(completed.local_tickets[verifyTicket.id]?.status, "done");
    assert.equal(completed.local_tickets[doneTicket.id]?.status, "done");
    assert.equal(completed.goals.goal?.status, "done");
    assert.equal((await readContinuationShadowRecords(root)).length, 1);
    assert.equal((await readContinuationAudits(root)).length, 1);
  } finally {
    await cleanup(root);
  }
});

test("enforce blocks before ticket mutation while invalid mode preserves rollback behavior", async () => {
  const root = await tempProject("ch-closure-rollback-");
  try {
    const state = emptyStateV3(NOW);
    state.active_goal_id = "goal";
    state.goals.goal = { id: "goal", title: "Goal", status: "active", assurance: "standard", backend: { kind: "local" }, stop_enforcement: false, created_at: NOW, updated_at: NOW };
    const ticket: TicketT = { id: "ticket", goal_id: "goal", title: "Ticket", acceptance: [], blocked_by: [], status: "in_review", code_changed: false, order: 0, created_at: NOW, updated_at: NOW };
    state.local_tickets.ticket = ticket;
    const digest = await submissionDigest(root, ticket);
    state.evidence.submission = { id: "submission", goal_id: "goal", ticket_id: "ticket", kind: "other", submission_digest: digest, provenance: {}, recorded_at: NOW };
    state.evidence.verification = { id: "verification", goal_id: "goal", ticket_id: "ticket", kind: "verification", submission_digest: digest, outcome: "pass", provenance: { implementer_run: "impl", verifier_run: "review" }, recorded_at: NOW };
    const store = new HarnessStore(root);
    await store.writeStateV3(state);

    await withProcessEnv({ YCM_HARNESS_SCHEDULED_FINALIZER_MODE: "enforce" }, async () => {
      assert.equal(await runCli(["--cwd", root, "ticket", "done", "ticket"]), 1);
    });
    assert.equal((await store.readStateV3()).local_tickets.ticket?.status, "in_review");
    await withProcessEnv({ YCM_HARNESS_SCHEDULED_FINALIZER_MODE: "invalid" }, async () => {
      assert.equal(await runCli(["--cwd", root, "ticket", "done", "ticket"]), 0);
    });
    assert.equal((await store.readStateV3()).local_tickets.ticket?.status, "done");
  } finally {
    await cleanup(root);
  }
});

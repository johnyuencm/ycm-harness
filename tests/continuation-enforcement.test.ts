import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  defaultExecutionPolicy,
  type ExecutionPolicyInput,
} from "../src/continuation/cost-policy.js";
import { readContinuationAudits } from "../src/continuation/audit.js";
import {
  ContinuationShadowRecordSchema,
  finalizeScheduledResponse,
  readContinuationShadowRecords,
  type ScheduledResponseShadowContext,
} from "../src/continuation/shadow.js";
import { cleanup, tempProject } from "./helpers.js";

const NOW = "2026-07-16T04:05:06.000Z";
const EMPTY = `\`\`\`continuation-ledger\n${JSON.stringify({ items: [] })}\n\`\`\``;
const TRACKED = `\`\`\`continuation-ledger\n${JSON.stringify({ items: [{
  lane: "NEXT",
  action: "Inspect the artifact",
  disposition: "TRACKED",
  ticket_id: "AUT-34",
  evidence: "comment-7",
  expected_impact: "Confirms the result",
  cost_class: "low",
  evidence_horizon: "this run",
}] })}\n\`\`\``;

function llmPolicy(overrides: Partial<ExecutionPolicyInput> = {}): ExecutionPolicyInput {
  return {
    stages: [
      { stage: "no_agent", outcome: "inapplicable", reason: "model_output", evidence_reference: "route", observation_count: 1 },
      { stage: "script", outcome: "insufficient", reason: "semantic_output", evidence_reference: "script-proof", observation_count: 1 },
      { stage: "targeted_read", outcome: "insufficient", reason: "semantic_output", evidence_reference: "read-proof", observation_count: 1 },
      { stage: "reuse_reference", outcome: "insufficient", reason: "semantic_output", evidence_reference: "reuse-proof", observation_count: 1 },
      { stage: "model", outcome: "sufficient" },
    ],
    required_capabilities: ["synthesis"],
    model_roster: [{ model_id: "bounded-low", tier: "bounded", cost_rank: 1, capabilities: ["synthesis"] }],
    model_invocations: [{ role: "executor", model_id: "bounded-low", required_capabilities: ["synthesis"], recursive: false }],
    ...overrides,
  };
}

function context(root: string, overrides: Partial<ScheduledResponseShadowContext> = {}): ScheduledResponseShadowContext {
  return {
    root,
    parentId: "AUT-5",
    runId: "enforcement-run",
    sessionId: "enforcement-session",
    scheduleId: "disposable-schedule",
    trigger: "scheduled",
    enabled: true,
    routing: "LLM",
    executionPolicy: llmPolicy(),
    ...overrides,
  };
}

const baseDeps = {
  now: () => NOW,
  readTicket: async () => undefined,
  readMutations: async () => [],
};

const enforce = { YCM_HARNESS_SCHEDULED_FINALIZER_MODE: "enforce" };

function protectedSha(field: string, value: string): string {
  return createHash("sha256").update(`continuation-shadow:v1:${field}\0${value}`, "utf8").digest("hex");
}

test("mode promotion blocks only invalid LLM closure while preserving exact bytes and env-only rollback", async () => {
  const root = await tempProject("ch-continuation-enforce-mode-");
  const response = `prefix\r\nordinary prose\0  `;
  try {
    for (const env of [{}, { YCM_HARNESS_SCHEDULED_FINALIZER_MODE: "invalid" }, { YCM_HARNESS_SCHEDULED_FINALIZER_MODE: "shadow" }]) {
      const shadow = await finalizeScheduledResponse(response, context(root), { ...baseDeps, env });
      assert.equal(shadow.responseText, response);
      assert.equal(shadow.closure, null);
    }
    const blocked = await finalizeScheduledResponse(response, context(root), { ...baseDeps, env: enforce });
    assert.equal(blocked.responseText, response);
    assert.equal(blocked.closure?.decision, "block");
    assert.equal(blocked.closure?.stopReason, "cursor_harness_continuation_finalization");
    assert.match(blocked.closure?.reason ?? "", /MISSING_LEDGER/);
    assert.doesNotMatch(JSON.stringify(blocked.closure), /ordinary prose/);
    assert.match(blocked.closure?.failure_id ?? "", /^[0-9a-f]{64}$/);
    assert.match(blocked.closure?.correction_reservation_id ?? "", /^[0-9a-f]{64}$/);
    const rollback = await finalizeScheduledResponse(response, context(root), { ...baseDeps, env: {} });
    assert.equal(rollback.closure, null);
    assert.equal(rollback.responseText, response);
    assert.equal((await readContinuationShadowRecords(root)).length, 1);
    assert.equal((await readContinuationAudits(root)).length, 1);

    const passing = await finalizeScheduledResponse(EMPTY, context(root, { runId: "passing-run" }), { ...baseDeps, env: enforce });
    assert.equal(passing.responseText, EMPTY);
    assert.equal(passing.closure, null);
  } finally {
    await cleanup(root);
  }
});

test("tracker, audit, and validator failures block in enforce and retain durable shadow evidence", async () => {
  const root = await tempProject("ch-continuation-enforce-failures-");
  try {
    const fixtures = [
      {
        response: TRACKED,
        runId: "tracker-run",
        deps: { ...baseDeps, readTicket: async () => { throw new Error("tracker private detail"); } },
        reason: "TRACKER_UNREADABLE:AUT-34",
      },
      {
        response: EMPTY,
        runId: "audit-run",
        deps: { ...baseDeps, auditFault: async (point: string) => {
          if (point === "before_record_write") throw new Error("audit unavailable");
        } },
        reason: "AUDIT_PERSISTENCE_FAILED",
      },
      {
        response: EMPTY,
        runId: "validator-run",
        deps: { ...baseDeps, finalizeAudited: async () => { throw new Error("validator private detail"); } },
        reason: "SHADOW_VALIDATOR_FAILED",
      },
    ] as const;
    for (const fixture of fixtures) {
      const result = await finalizeScheduledResponse(fixture.response, context(root, { runId: fixture.runId }), {
        ...fixture.deps,
        env: enforce,
      });
      assert.equal(result.responseText, fixture.response);
      assert.match(result.closure?.reason ?? "", new RegExp(fixture.reason));
    }
    const shadows = await readContinuationShadowRecords(root);
    assert.equal(shadows.length, 3);
    for (const fixture of fixtures) assert.ok(shadows.some((record) => record.reasons.includes(fixture.reason)));
    assert.doesNotMatch(JSON.stringify(shadows), /private detail/);
  } finally {
    await cleanup(root);
  }
});

test("invalid NO_AGENT telemetry never blocks or performs ledger/live reads", async () => {
  const root = await tempProject("ch-continuation-enforce-no-agent-");
  let liveReads = 0;
  let validatorCalls = 0;
  try {
    const result = await finalizeScheduledResponse("script bytes\0\n", context(root, {
      trigger: "cron",
      routing: "NO_AGENT",
      executionPolicy: llmPolicy(),
    }), {
      now: () => NOW,
      env: enforce,
      readTicket: async () => { liveReads += 1; return undefined; },
      readMutations: async () => { liveReads += 1; return []; },
      finalizeAudited: async () => { validatorCalls += 1; return { status: "PASS", reasons: [], items: [] }; },
    });
    assert.equal(result.responseText, "script bytes\0\n");
    assert.equal(result.closure, null);
    assert.equal(liveReads, 0);
    assert.equal(validatorCalls, 0);
    const [record] = await readContinuationShadowRecords(root);
    assert.equal(record?.would_block_verdict, "FAIL");
    assert.equal(record?.routing, "NO_AGENT");
    await assert.rejects(fs.stat(`${root}/.ycm-harness/autonomy/continuation-audits`));
  } finally {
    await cleanup(root);
  }
});

test("disabled and non-scheduled contexts skip all work even in enforce mode", async () => {
  for (const overrides of [{ enabled: false }, { trigger: "interactive" as const }, { trigger: "non-scheduled" as const }]) {
    const root = await tempProject("ch-continuation-enforce-skip-");
    let called = false;
    try {
      const result = await finalizeScheduledResponse("ignored bytes", context(root, overrides), {
        env: enforce,
        now: () => { called = true; return NOW; },
        readTicket: async () => { called = true; return undefined; },
        readMutations: async () => { called = true; return []; },
      });
      assert.deepEqual(result, { responseText: "ignored bytes", closure: null, verdict: null });
      assert.equal(called, false);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      await cleanup(root);
    }
  }
});

test("repeated and concurrent violations reuse one shadow failure and one bounded correction identity", async () => {
  const root = await tempProject("ch-continuation-enforce-concurrent-");
  try {
    const pairs: Array<Array<string | undefined>> = [];
    for (let round = 0; round < 3; round += 1) {
      const calls = Array.from({ length: 12 }, () => finalizeScheduledResponse("ordinary prose", context(root), {
        ...baseDeps,
        env: enforce,
      }));
      const results = await Promise.all(calls);
      pairs.push(...results.map((result) => [result.closure?.failure_id, result.closure?.correction_reservation_id]));
    }
    assert.ok(pairs.every((pair) => pair[0] === pairs[0]?.[0] && pair[1] === pairs[0]?.[1]));
    assert.equal((await readContinuationShadowRecords(root)).length, 1);
    assert.equal((await readContinuationAudits(root)).length, 1);
  } finally {
    await cleanup(root);
  }
});

test("lease acquisition failures and later persistence converge on the same precomputed pair", async () => {
  const root = await tempProject("ch-continuation-enforce-lease-pair-");
  try {
    const failed = await Promise.all(Array.from({ length: 12 }, () => finalizeScheduledResponse("ordinary prose", context(root), {
      ...baseDeps,
      env: enforce,
      lockWaitMs: -1,
    })));
    const pair = [failed[0]?.closure?.failure_id, failed[0]?.closure?.correction_reservation_id];
    assert.ok(failed.every((result) => result.closure?.failure_id === pair[0]
      && result.closure?.correction_reservation_id === pair[1]));
    assert.deepEqual(await readContinuationShadowRecords(root), []);

    const persisted = await finalizeScheduledResponse("ordinary prose", context(root), { ...baseDeps, env: enforce });
    const [record] = await readContinuationShadowRecords(root);
    assert.equal(record?.schema_version, 3);
    if (record?.schema_version !== 3) assert.fail("expected v3 shadow");
    assert.equal(persisted.closure?.failure_id, pair[0]);
    assert.equal(persisted.closure?.correction_reservation_id, pair[1]);
    assert.equal(record.failure_id, pair[0]);
    assert.equal(record.correction_reservation_id, pair[1]);
  } finally {
    await cleanup(root);
  }
});

test("a referenced v2 policy failure reuses its existing failure and correction reservation pair", async () => {
  const root = await tempProject("ch-continuation-enforce-policy-pair-");
  const invalidStages = llmPolicy().stages;
  invalidStages[1] = { stage: "script", outcome: "skipped" };
  try {
    const result = await finalizeScheduledResponse(EMPTY, context(root, {
      executionPolicy: llmPolicy({ stages: invalidStages }),
    }), { ...baseDeps, env: enforce });
    const [audit] = await readContinuationAudits(root);
    assert.equal(audit?.schema_version, 2);
    if (audit?.schema_version !== 2) assert.fail("expected v2 audit");
    assert.equal(result.closure?.failure_id, audit.policy.policy_failure_id);
    assert.equal(result.closure?.correction_reservation_id, audit.policy.correction_reservation_id);
    assert.equal((await readContinuationShadowRecords(root)).length, 1);
  } finally {
    await cleanup(root);
  }
});

test("same provenance cannot bind a stale PASS audit after policy changes to FAIL", async () => {
  const root = await tempProject("ch-continuation-enforce-stale-audit-");
  const staleContext = context(root, { runId: "same-run", sessionId: "same-session" });
  try {
    const passing = await finalizeScheduledResponse(EMPTY, staleContext, { ...baseDeps, env: enforce });
    assert.equal(passing.closure, null);
    const passAudit = (await readContinuationAudits(root))[0];
    assert.equal(passAudit?.verdict, "PASS");

    const invalidStages = llmPolicy().stages;
    invalidStages[1] = { stage: "script", outcome: "skipped" };
    const failed = await finalizeScheduledResponse(EMPTY, {
      ...staleContext,
      executionPolicy: llmPolicy({ stages: invalidStages }),
    }, { ...baseDeps, env: enforce });
    const audits = await readContinuationAudits(root);
    const failAudit = audits.find((record) => record.verdict === "FAIL");
    const failShadow = (await readContinuationShadowRecords(root)).find((record) => record.would_block_verdict === "FAIL");
    assert.equal(audits.length, 2);
    assert.equal(failAudit?.schema_version, 2);
    assert.equal(failShadow?.schema_version, 3);
    assert.notEqual(failShadow?.audit_reference, passAudit?.audit_id);
    assert.equal(failShadow?.audit_reference, failAudit?.audit_id);
    if (failAudit?.schema_version !== 2 || failShadow?.schema_version !== 3) assert.fail("expected current records");
    assert.equal(failed.closure?.failure_id, failAudit.policy.policy_failure_id);
    assert.equal(failed.closure?.failure_id, failShadow.failure_id);
    assert.equal(failed.closure?.correction_reservation_id, failAudit.policy.correction_reservation_id);
    assert.equal(failed.closure?.correction_reservation_id, failShadow.correction_reservation_id);
  } finally {
    await cleanup(root);
  }
});

test("strict mixed replay preserves authenticated v1/v2 digests while new observations emit v3", async () => {
  const root = await tempProject("ch-continuation-shadow-mixed-v1-v2-");
  try {
    const response = "legacy response";
    const legacyContent = {
      schema_version: 1 as const,
      response_sha256: protectedSha("response", response),
      schedule_sha256: protectedSha("schedule", "legacy-schedule"),
      parent_sha256: protectedSha("parent", "AUT-5"),
      run_sha256: protectedSha("run", "legacy-run"),
      session_sha256: protectedSha("session", "legacy-session"),
      routing: "NO_AGENT" as const,
      would_block_verdict: "PASS" as const,
      reasons: [],
      audit_persisted: false,
    };
    const contentSha = protectedSha("content", JSON.stringify(legacyContent));
    const authenticated = {
      ...legacyContent,
      shadow_id: contentSha,
      content_sha256: contentSha,
      recorded_at: NOW,
    };
    const legacy = { ...authenticated, record_sha256: protectedSha("record", JSON.stringify(authenticated)) };
    const v2Content = {
      ...legacyContent,
      schema_version: 2 as const,
      response_sha256: protectedSha("response", "v2 response"),
      schedule_sha256: protectedSha("schedule", "v2-schedule"),
      run_sha256: protectedSha("run", "v2-run"),
    };
    const v2ContentSha = protectedSha("content", JSON.stringify(v2Content));
    const v2Authenticated = { ...v2Content, shadow_id: v2ContentSha, content_sha256: v2ContentSha, recorded_at: NOW };
    const v2 = { ...v2Authenticated, record_sha256: protectedSha("record", JSON.stringify(v2Authenticated)) };
    const directory = path.join(root, ".ycm-harness", "autonomy", "continuation-shadows", "records");
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, `${legacy.record_sha256}.json`), `${JSON.stringify(legacy)}\n`, "utf8");
    await fs.writeFile(path.join(directory, `${v2.record_sha256}.json`), `${JSON.stringify(v2)}\n`, "utf8");

    const replayed = await readContinuationShadowRecords(root);
    assert.deepEqual(replayed, [legacy, v2].sort((left, right) => left.record_sha256.localeCompare(right.record_sha256)));
    await finalizeScheduledResponse("script result", context(root, {
      runId: "current-run",
      routing: "NO_AGENT",
      executionPolicy: defaultExecutionPolicy(),
    }), { ...baseDeps, env: enforce });
    const mixed = await readContinuationShadowRecords(root);
    assert.deepEqual(mixed.map((record) => record.schema_version).sort(), [1, 2, 3]);
    assert.equal(mixed.find((record) => record.schema_version === 1)?.record_sha256, legacy.record_sha256);
    assert.equal(mixed.find((record) => record.schema_version === 2)?.record_sha256, v2.record_sha256);
    const current = mixed.find((record) => record.schema_version === 3);
    assert.equal(ContinuationShadowRecordSchema.safeParse({
      ...current,
      failure_id: undefined,
      correction_reservation_id: undefined,
      would_block_verdict: "FAIL",
    }).success, false);
  } finally {
    await cleanup(root);
  }
});

test("valid script-only NO_AGENT remains a zero-read non-blocking path", async () => {
  const root = await tempProject("ch-continuation-enforce-script-only-");
  try {
    const result = await finalizeScheduledResponse("script result", context(root, {
      routing: "NO_AGENT",
      executionPolicy: defaultExecutionPolicy(),
    }), { ...baseDeps, env: enforce });
    assert.equal(result.closure, null);
    assert.equal(result.responseText, "script result");
  } finally {
    await cleanup(root);
  }
});

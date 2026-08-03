import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { defaultExecutionPolicy, type ExecutionPolicyInput } from "../src/continuation/cost-policy.js";
import {
  finalizeScheduledResponseShadow,
  readContinuationShadowRecords,
  type ScheduledResponseShadowContext,
} from "../src/continuation/shadow.js";
import { cleanup, tempProject } from "./helpers.js";

const NOW = "2026-07-16T03:04:05.000Z";
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

function llmPolicy(): ExecutionPolicyInput {
  const stages: ExecutionPolicyInput["stages"] = [
    { stage: "no_agent", outcome: "inapplicable", reason: "model_output", evidence_reference: "route", observation_count: 1 },
    { stage: "script", outcome: "insufficient", reason: "semantic_output", evidence_reference: "script-proof", observation_count: 1 },
    { stage: "targeted_read", outcome: "insufficient", reason: "semantic_output", evidence_reference: "read-proof", observation_count: 1 },
    { stage: "reuse_reference", outcome: "insufficient", reason: "semantic_output", evidence_reference: "reuse-proof", observation_count: 1 },
    { stage: "model", outcome: "sufficient" },
  ];
  return {
    stages,
    required_capabilities: ["synthesis"],
    model_roster: [{ model_id: "bounded-low", tier: "bounded", cost_rank: 1, capabilities: ["synthesis"] }],
    model_invocations: [{
      role: "executor",
      model_id: "bounded-low",
      required_capabilities: ["synthesis"],
      recursive: false,
    }],
  };
}

function context(
  root: string,
  overrides: Partial<ScheduledResponseShadowContext> = {},
): ScheduledResponseShadowContext {
  return {
    root,
    parentId: "AUT-5",
    runId: "shadow-run",
    sessionId: "shadow-session",
    scheduleId: "disposable-schedule",
    trigger: "scheduled",
    enabled: true,
    routing: "LLM",
    executionPolicy: llmPolicy(),
    ...overrides,
  };
}

const unusedLive = {
  readTicket: async () => undefined,
  readMutations: async () => [],
  now: () => NOW,
};

test("scheduled LLM shadow records canonical PASS while preserving exact output bytes", async () => {
  const root = await tempProject("ch-continuation-shadow-pass-");
  const response = `prefix\r\n${EMPTY}\r\ntrailing spaces  `;
  try {
    const delivered = await finalizeScheduledResponseShadow(response, context(root), unusedLive);
    assert.equal(delivered, response);
    const [record] = await readContinuationShadowRecords(root);
    assert.equal(record?.routing, "LLM");
    assert.equal(record?.would_block_verdict, "PASS");
    assert.deepEqual(record?.reasons, []);
    assert.equal(record?.audit_persisted, true);
    assert.match(record?.audit_reference ?? "", /^[0-9a-f]{64}$/);
    assert.match(record?.response_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(record?.schedule_sha256 ?? "", /^[0-9a-f]{64}$/);
    const serialized = JSON.stringify(record);
    for (const raw of [response, "disposable-schedule", "shadow-run", "shadow-session", "AUT-5"]) {
      assert.equal(serialized.includes(raw), false);
    }
  } finally {
    await cleanup(root);
  }
});

test("malformed, tracker outage, audit failure, and thrown validator remain fail-open with durable FAIL telemetry", async () => {
  const root = await tempProject("ch-continuation-shadow-failures-");
  try {
    const fixtures = [
      {
        response: "ordinary prose\n",
        runId: "malformed-run",
        deps: unusedLive,
        reason: "MISSING_LEDGER",
      },
      {
        response: TRACKED,
        runId: "tracker-run",
        deps: { ...unusedLive, readTicket: async () => { throw new Error("offline secret detail"); } },
        reason: "TRACKER_UNREADABLE:AUT-34",
      },
      {
        response: EMPTY,
        runId: "audit-fault-run",
        deps: { ...unusedLive, auditFault: async (point: string) => {
          if (point === "before_record_write") throw new Error("audit unavailable");
        } },
        reason: "AUDIT_PERSISTENCE_FAILED",
      },
      {
        response: EMPTY,
        runId: "throw-run",
        deps: {
          ...unusedLive,
          finalizeAudited: async () => { throw new Error("validator secret detail"); },
        },
        reason: "SHADOW_VALIDATOR_FAILED",
      },
    ] as const;
    for (const fixture of fixtures) {
      assert.equal(
        await finalizeScheduledResponseShadow(fixture.response, context(root, { runId: fixture.runId }), fixture.deps),
        fixture.response,
      );
    }
    const records = await readContinuationShadowRecords(root);
    assert.equal(records.length, 4);
    for (const fixture of fixtures) {
      const record = records.find((candidate) => candidate.reasons.includes(fixture.reason));
      assert.equal(record?.would_block_verdict, "FAIL", fixture.reason);
    }
    const auditFault = records.find((record) => record.reasons.includes("AUDIT_PERSISTENCE_FAILED"));
    assert.equal(auditFault?.audit_persisted, false);
    const thrown = records.find((record) => record.reasons.includes("SHADOW_VALIDATOR_FAILED"));
    assert.equal(thrown?.audit_persisted, false);
    assert.doesNotMatch(JSON.stringify(records), /offline secret detail|validator secret detail/);
  } finally {
    await cleanup(root);
  }
});

test("valid no-agent route skips canonical and live reads but still writes deterministic telemetry", async () => {
  const root = await tempProject("ch-continuation-shadow-no-agent-");
  let finalizerCalls = 0;
  let liveReads = 0;
  const response = "script monitor output without a ledger\n";
  try {
    const delivered = await finalizeScheduledResponseShadow(response, context(root, {
      trigger: "cron",
      routing: "NO_AGENT",
      executionPolicy: defaultExecutionPolicy(),
    }), {
      now: () => NOW,
      readTicket: async () => { liveReads += 1; return undefined; },
      readMutations: async () => { liveReads += 1; return []; },
      finalizeAudited: async () => {
        finalizerCalls += 1;
        return { status: "PASS", reasons: [], items: [] };
      },
    });
    assert.equal(delivered, response);
    assert.equal(finalizerCalls, 0);
    assert.equal(liveReads, 0);
    const [record] = await readContinuationShadowRecords(root);
    assert.equal(record?.routing, "NO_AGENT");
    assert.equal(record?.would_block_verdict, "PASS");
    assert.equal(record?.audit_persisted, false);
    await assert.rejects(fs.stat(path.join(root, ".ycm-harness", "autonomy", "continuation-audits")));
  } finally {
    await cleanup(root);
  }
});

test("invalid no-agent and LLM routing are visible would-block failures", async () => {
  const root = await tempProject("ch-continuation-shadow-routing-");
  try {
    await finalizeScheduledResponseShadow("script output", context(root, {
      runId: "invalid-no-agent",
      routing: "NO_AGENT",
      executionPolicy: llmPolicy(),
    }), unusedLive);
    await finalizeScheduledResponseShadow(EMPTY, context(root, {
      runId: "invalid-llm",
      routing: "LLM",
      executionPolicy: defaultExecutionPolicy(),
    }), unusedLive);
    const records = await readContinuationShadowRecords(root);
    assert.ok(records.some((record) => record.routing === "NO_AGENT"
      && record.reasons.length === 1 && record.reasons[0] === "NO_AGENT_ROUTE_INVALID"));
    assert.ok(records.some((record) => record.routing === "LLM"
      && record.reasons.length === 1 && record.reasons[0] === "LLM_ROUTE_INVALID"));
    assert.ok(records.every((record) => record.would_block_verdict === "FAIL"));
  } finally {
    await cleanup(root);
  }
});

test("interactive, non-scheduled, and disabled calls perform no reads or writes", async () => {
  for (const overrides of [
    { trigger: "interactive" as const },
    { trigger: "non-scheduled" as const },
    { enabled: false },
  ]) {
    const root = await tempProject("ch-continuation-shadow-ignored-");
    let called = false;
    const response = `ignored-${JSON.stringify(overrides)}\0\n`;
    try {
      const delivered = await finalizeScheduledResponseShadow(response, context(root, overrides), {
        now: () => { called = true; return NOW; },
        readTicket: async () => { called = true; return undefined; },
        readMutations: async () => { called = true; return []; },
        finalizeAudited: async () => { called = true; return { status: "PASS", reasons: [], items: [] }; },
      });
      assert.equal(delivered, response);
      assert.equal(called, false);
      assert.deepEqual(await fs.readdir(root), []);
    } finally {
      await cleanup(root);
    }
  }
});

test("content-addressed records converge concurrently, preserve distinct runs, and recover after post-write failure", async () => {
  const root = await tempProject("ch-continuation-shadow-concurrency-");
  try {
    const calls = Array.from({ length: 12 }, () =>
      finalizeScheduledResponseShadow(EMPTY, context(root), unusedLive));
    assert.deepEqual(await Promise.all(calls), Array.from({ length: 12 }, () => EMPTY));
    assert.equal((await readContinuationShadowRecords(root)).length, 1);

    await finalizeScheduledResponseShadow(EMPTY, context(root, { runId: "distinct-run" }), unusedLive);
    assert.equal((await readContinuationShadowRecords(root)).length, 2);

    const crashContext = context(root, { runId: "post-write-run" });
    assert.equal(await finalizeScheduledResponseShadow(EMPTY, crashContext, {
      ...unusedLive,
      shadowFault: async (point) => {
        if (point === "after_record_write") throw new Error("simulated crash");
      },
    }), EMPTY);
    assert.equal((await readContinuationShadowRecords(root)).length, 3);
    assert.equal(await finalizeScheduledResponseShadow(EMPTY, crashContext, unusedLive), EMPTY);
    assert.equal((await readContinuationShadowRecords(root)).length, 3);
  } finally {
    await cleanup(root);
  }
});

test("replay rejects corrupt content, forged filenames, and symlink path indirection without changing delivery", async () => {
  const corruptRoot = await tempProject("ch-continuation-shadow-corrupt-");
  const filenameRoot = await tempProject("ch-continuation-shadow-filename-");
  const linkedRoot = await tempProject("ch-continuation-shadow-link-");
  const external = await tempProject("ch-continuation-shadow-external-");
  try {
    await finalizeScheduledResponseShadow(EMPTY, context(corruptRoot), unusedLive);
    const corruptDir = path.join(corruptRoot, ".ycm-harness", "autonomy", "continuation-shadows", "records");
    const [corruptName] = await fs.readdir(corruptDir);
    const corruptFile = path.join(corruptDir, corruptName!);
    const raw = JSON.parse(await fs.readFile(corruptFile, "utf8")) as Record<string, unknown>;
    await fs.writeFile(corruptFile, `${JSON.stringify({ ...raw, reasons: ["forged"] })}\n`, "utf8");
    await assert.rejects(readContinuationShadowRecords(corruptRoot), /invalid_stored_continuation_shadow/);

    await finalizeScheduledResponseShadow(EMPTY, context(filenameRoot), unusedLive);
    const filenameDir = path.join(filenameRoot, ".ycm-harness", "autonomy", "continuation-shadows", "records");
    const [name] = await fs.readdir(filenameDir);
    await fs.rename(path.join(filenameDir, name!), path.join(filenameDir, `${"0".repeat(64)}.json`));
    await assert.rejects(readContinuationShadowRecords(filenameRoot), /invalid_stored_continuation_shadow/);

    await fs.mkdir(path.join(linkedRoot, ".ycm-harness", "autonomy"), { recursive: true });
    await fs.symlink(external, path.join(linkedRoot, ".ycm-harness", "autonomy", "continuation-shadows"), "dir");
    assert.equal(await finalizeScheduledResponseShadow(EMPTY, context(linkedRoot), unusedLive), EMPTY);
    assert.deepEqual(await fs.readdir(external), []);
  } finally {
    await cleanup(corruptRoot);
    await cleanup(filenameRoot);
    await cleanup(linkedRoot);
    await cleanup(external);
  }
});

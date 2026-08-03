import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  evaluateExecutionPolicy,
  type ExecutionPolicyInput,
  type ExecutionPolicyStage,
} from "../src/continuation/cost-policy.js";
import {
  finalizeContinuationLedgerLiveAudited,
  readContinuationAudits,
  rebuildContinuationAuditProjection,
} from "../src/continuation/audit.js";
import { cleanup, tempProject } from "./helpers.js";

const RESPONSE = `\`\`\`continuation-ledger\n${JSON.stringify({ items: [] })}\n\`\`\``;
const NOW = "2026-07-16T02:03:04.000Z";
const ORDER: ExecutionPolicyStage[] = ["no_agent", "script", "targeted_read", "reuse_reference", "model"];

function stages(outcomes: ExecutionPolicyInput["stages"][number]["outcome"][]): ExecutionPolicyInput["stages"] {
  return ORDER.map((stage, index) => ({
    stage,
    outcome: outcomes[index]!,
    ...(outcomes[index] === "inapplicable" || outcomes[index] === "insufficient"
      ? {
          reason: `${stage}_cannot_complete`,
          evidence_reference: `${stage}_proof`,
          observation_count: 1,
        }
      : {}),
  }));
}

const roster: ExecutionPolicyInput["model_roster"] = [
  { model_id: "bounded-low", tier: "bounded", cost_rank: 1, capabilities: ["synthesis"] },
  { model_id: "strong-general", tier: "strong", cost_rank: 2, capabilities: ["synthesis", "high-risk"] },
];

function policy(overrides: Partial<ExecutionPolicyInput> = {}): ExecutionPolicyInput {
  return {
    stages: stages(["inapplicable", "insufficient", "insufficient", "insufficient", "sufficient"]),
    required_capabilities: ["synthesis"],
    model_roster: roster,
    model_invocations: [{
      role: "executor",
      model_id: "bounded-low",
      required_capabilities: ["synthesis"],
      recursive: false,
    }],
    ...overrides,
  };
}

test("policy evaluates the full least-cost ladder and cheapest capable model", () => {
  const result = evaluateExecutionPolicy(policy());
  assert.equal(result.verdict, "PASS");
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.trace.stages.map(({ stage, outcome }) => [stage, outcome]), [
    ["no_agent", "inapplicable"],
    ["script", "insufficient"],
    ["targeted_read", "insufficient"],
    ["reuse_reference", "insufficient"],
    ["model", "sufficient"],
  ]);
  assert.equal(result.trace.correction_count, 0);
});

test("policy rejects skipped and invalid stages before an advanced stage", () => {
  const skipped = evaluateExecutionPolicy(policy({
    stages: stages(["inapplicable", "skipped", "insufficient", "insufficient", "sufficient"]),
  }));
  assert.equal(skipped.verdict, "FAIL");
  assert.deepEqual(skipped.reasons, ["POLICY_STAGE_SKIPPED:script"]);

  const invalid = evaluateExecutionPolicy(policy({
    stages: stages(["inapplicable", "invalid", "insufficient", "insufficient", "sufficient"]),
  }));
  assert.equal(invalid.verdict, "FAIL");
  assert.deepEqual(invalid.reasons, ["POLICY_STAGE_INVALID:script"]);
});

test("policy requires concrete bounded evidence for every cheaper attempted stage", () => {
  const missingStages = stages(["inapplicable", "insufficient", "insufficient", "insufficient", "sufficient"]);
  missingStages[1] = { stage: "script", outcome: "insufficient", reason: "script_cannot_complete" };
  const missing = evaluateExecutionPolicy(policy({ stages: missingStages }));
  assert.deepEqual(missing.reasons, [
    "POLICY_STAGE_EVIDENCE_MISSING:script",
    "POLICY_STAGE_OBSERVATION_COUNT_INVALID:script",
  ]);

  const zeroStages = stages(["inapplicable", "insufficient", "insufficient", "insufficient", "sufficient"]);
  zeroStages[2] = { ...zeroStages[2]!, observation_count: 0 };
  const zero = evaluateExecutionPolicy(policy({ stages: zeroStages }));
  assert.deepEqual(zero.reasons, ["POLICY_STAGE_OBSERVATION_COUNT_INVALID:targeted_read"]);

  const invalidStages = stages(["inapplicable", "insufficient", "insufficient", "insufficient", "sufficient"]);
  invalidStages[3] = { ...invalidStages[3]!, evidence_reference: "not bounded evidence" };
  assert.deepEqual(evaluateExecutionPolicy(policy({ stages: invalidStages })).reasons, ["POLICY_TRACE_INVALID"]);
});

test("stronger models require deterministic justification while roster names stay configurable", () => {
  const invocation = {
    role: "executor",
    model_id: "strong-general",
    required_capabilities: ["synthesis"],
    recursive: false,
  } as const;
  const unjustified = evaluateExecutionPolicy(policy({ model_invocations: [invocation] }));
  assert.deepEqual(unjustified.reasons, [
    "MODEL_NOT_CHEAPEST_CAPABLE:0",
    "MODEL_ESCALATION_REASON_MISSING:0",
  ]);

  const justified = evaluateExecutionPolicy(policy({
    model_invocations: [{ ...invocation, escalation_reason: "risk" }],
  }));
  assert.equal(justified.verdict, "PASS");
  assert.deepEqual(justified.reasons, []);

  const soleCapable = evaluateExecutionPolicy(policy({
    required_capabilities: ["high-risk"],
    model_invocations: [{ ...invocation, required_capabilities: ["high-risk"] }],
  }));
  assert.deepEqual(soleCapable.reasons, ["MODEL_ESCALATION_REASON_MISSING:0"]);

  const soleCapableJustified = evaluateExecutionPolicy(policy({
    required_capabilities: ["high-risk"],
    model_invocations: [{ ...invocation, required_capabilities: ["high-risk"], escalation_reason: "complexity" }],
  }));
  assert.equal(soleCapableJustified.verdict, "PASS");
});

test("job capabilities are authoritative and equal-cost selection is deterministic", () => {
  const forged = evaluateExecutionPolicy(policy({
    model_invocations: [{ ...policy().model_invocations[0]!, required_capabilities: ["high-risk"] }],
  }));
  assert.deepEqual(forged.reasons, ["MODEL_REQUIREMENTS_MISMATCH:0"]);

  const tiedRoster = [
    { model_id: "Bounded-Zeta", tier: "bounded", cost_rank: 1, capabilities: ["synthesis"] },
    { model_id: "bounded-alpha", tier: "bounded", cost_rank: 1, capabilities: ["synthesis"] },
  ];
  const tied = evaluateExecutionPolicy(policy({
    model_roster: tiedRoster,
    model_invocations: [{
      role: "executor",
      model_id: "Bounded-Zeta",
      required_capabilities: ["synthesis"],
      recursive: false,
    }],
  }));
  assert.deepEqual(tied.reasons, ["MODEL_TIE_BREAK_MISMATCH:0"]);
  assert.deepEqual(tied.trace.model_roster.map((model) => model.model_id), ["bounded-alpha", "bounded-zeta"]);
});

test("no-agent, auxiliary judge, recursion, and correction budgets fail deterministically", () => {
  const noAgent = evaluateExecutionPolicy(policy({
    stages: stages(["sufficient", "skipped", "skipped", "skipped", "skipped"]),
  }));
  assert.deepEqual(noAgent.reasons, ["NO_AGENT_MODEL_CALL"]);

  const scriptOnly = evaluateExecutionPolicy(policy({
    stages: stages(["inapplicable", "sufficient", "skipped", "skipped", "skipped"]),
  }));
  assert.deepEqual(scriptOnly.reasons, ["PRE_MODEL_STAGE_MODEL_CALL:script"]);

  const forbidden = evaluateExecutionPolicy(policy({
    model_invocations: [{
      role: "judge",
      model_id: "bounded-low",
      required_capabilities: ["synthesis"],
      recursive: true,
    }],
  }));
  assert.deepEqual(forbidden.reasons, ["AUXILIARY_JUDGE_FORBIDDEN:0", "RECURSIVE_AGENT_FORBIDDEN:0"]);

  const oneCorrection = evaluateExecutionPolicy(policy({
    model_invocations: [
      policy().model_invocations[0]!,
      { ...policy().model_invocations[0]!, role: "correction" },
    ],
  }));
  assert.equal(oneCorrection.verdict, "PASS");
  assert.equal(oneCorrection.trace.correction_count, 1);

  const twoCorrections = evaluateExecutionPolicy(policy({
    model_invocations: [
      policy().model_invocations[0]!,
      { ...policy().model_invocations[0]!, role: "correction" },
      { ...policy().model_invocations[0]!, role: "correction" },
    ],
  }));
  assert.deepEqual(twoCorrections.reasons, ["CORRECTION_BUDGET_EXCEEDED"]);
  assert.equal(twoCorrections.trace.correction_count, 2);
});

test("audits persist policy verdict and concurrent violations reuse one correction identity", async () => {
  const root = await tempProject("ch-continuation-cost-audit-");
  const executionPolicy = policy({
    stages: stages(["inapplicable", "skipped", "insufficient", "insufficient", "sufficient"]),
    model_invocations: [
      policy().model_invocations[0]!,
      { ...policy().model_invocations[0]!, role: "correction" },
    ],
  });
  const context = {
    root,
    parentId: "AUT-5",
    runId: "cost-run",
    sessionId: "cost-session",
    surface: "scheduled-finalizer",
    mode: "shadow",
    executionPolicy,
  };
  const deps = {
    now: () => NOW,
    readTicket: async () => undefined,
    readMutations: async () => [],
  };
  try {
    const [first, second] = await Promise.all([
      finalizeContinuationLedgerLiveAudited(RESPONSE, context, deps),
      finalizeContinuationLedgerLiveAudited(RESPONSE, context, deps),
    ]);
    assert.deepEqual(first, second);
    assert.equal(first.status, "FAIL");
    assert.deepEqual(first.reasons, ["POLICY_STAGE_SKIPPED:script"]);

    const records = await readContinuationAudits(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.policy.verdict, "FAIL");
    assert.deepEqual(records[0]?.policy.reasons, ["POLICY_STAGE_SKIPPED:script"]);
    assert.equal(records[0]?.policy.trace.correction_count, 1);
    assert.match(records[0]?.policy.policy_failure_id ?? "", /^[0-9a-f]{64}$/);
    assert.match(records[0]?.policy.correction_reservation_id ?? "", /^[0-9a-f]{64}$/);

    const replay = await finalizeContinuationLedgerLiveAudited(RESPONSE, context, deps);
    assert.equal(replay.status, "FAIL");
    const afterReplay = await readContinuationAudits(root);
    assert.equal(afterReplay.length, 1);
    assert.equal(afterReplay[0]?.policy.policy_failure_id, records[0]?.policy.policy_failure_id);
    assert.equal(afterReplay[0]?.policy.correction_reservation_id, records[0]?.policy.correction_reservation_id);
    const projection = await rebuildContinuationAuditProjection(root);
    assert.equal(projection.records[0]?.policy.policy_failure_id, records[0]?.policy.policy_failure_id);

    const malformed = await finalizeContinuationLedgerLiveAudited("ordinary prose", {
      ...context,
      runId: "malformed-run",
    }, deps);
    assert.deepEqual(malformed.reasons, ["MISSING_LEDGER", "POLICY_STAGE_SKIPPED:script"]);
    const malformedRecord = (await readContinuationAudits(root)).find((record) => record.run_sha256 !== records[0]?.run_sha256);
    assert.deepEqual(malformedRecord?.reasons, ["MISSING_LEDGER", "POLICY_STAGE_SKIPPED:script"]);
  } finally {
    await cleanup(root);
  }
});

test("secret-like invalid model roles fail closed before any audit projection persists", async () => {
  const root = await tempProject("ch-continuation-cost-secret-role-");
  const secretRole = "sk-abcdefgh";
  const executionPolicy = policy({
    model_invocations: [{ ...policy().model_invocations[0]!, role: secretRole }],
  });
  try {
    const result = await finalizeContinuationLedgerLiveAudited(RESPONSE, {
      root,
      parentId: "AUT-5",
      runId: "secret-role-run",
      sessionId: "secret-role-session",
      surface: "scheduled-finalizer",
      mode: "shadow",
      executionPolicy,
    }, {
      now: () => NOW,
      readTicket: async () => undefined,
      readMutations: async () => [],
    });
    assert.deepEqual(result.reasons, ["MODEL_ROLE_INVALID:0", "AUDIT_PERSISTENCE_FAILED"]);
    assert.deepEqual(await readContinuationAudits(root), []);
    const auditDir = path.join(root, ".ycm-harness", "autonomy", "continuation-audits");
    const persisted = await Promise.all(["index.json", "index.jsonl"].map(async (name) =>
      fs.readFile(path.join(auditDir, name), "utf8").catch((error: NodeJS.ErrnoException) =>
        error.code === "ENOENT" ? "" : Promise.reject(error))));
    assert.doesNotMatch(persisted.join("\n"), new RegExp(secretRole));
  } finally {
    await cleanup(root);
  }
});

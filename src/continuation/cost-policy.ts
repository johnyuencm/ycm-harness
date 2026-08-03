import { z } from "zod";

const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const STAGES = ["no_agent", "script", "targeted_read", "reuse_reference", "model"] as const;

export type ExecutionPolicyStage = typeof STAGES[number];

const ExecutionPolicyStageAttemptSchema = z.object({
  stage: z.enum(STAGES),
  outcome: z.enum(["sufficient", "inapplicable", "insufficient", "skipped", "invalid"]),
  reason: z.string().regex(SAFE_LABEL).optional(),
  evidence_reference: z.string().regex(SAFE_LABEL).optional(),
  observation_count: z.number().int().nonnegative().optional(),
}).strict();

const ExecutionPolicyModelSchema = z.object({
  model_id: z.string().regex(SAFE_LABEL),
  tier: z.string().regex(SAFE_LABEL),
  cost_rank: z.number().int().nonnegative(),
  capabilities: z.array(z.string().regex(SAFE_LABEL)),
}).strict();

const ExecutionPolicyModelInvocationSchema = z.object({
  role: z.string().regex(SAFE_LABEL),
  model_id: z.string().regex(SAFE_LABEL),
  required_capabilities: z.array(z.string().regex(SAFE_LABEL)),
  recursive: z.boolean(),
  escalation_reason: z.enum(["risk", "ambiguity", "complexity"]).optional(),
}).strict();

export const ExecutionPolicyInputSchema = z.object({
  stages: z.array(ExecutionPolicyStageAttemptSchema).length(STAGES.length),
  required_capabilities: z.array(z.string().regex(SAFE_LABEL)),
  model_roster: z.array(ExecutionPolicyModelSchema),
  model_invocations: z.array(ExecutionPolicyModelInvocationSchema),
}).strict();

export type ExecutionPolicyInput = z.infer<typeof ExecutionPolicyInputSchema>;

export const NormalizedExecutionPolicyTraceSchema = z.object({
  stages: z.array(ExecutionPolicyStageAttemptSchema).length(STAGES.length),
  required_capabilities: z.array(z.string().regex(SAFE_LABEL)),
  model_roster: z.array(ExecutionPolicyModelSchema),
  model_invocations: z.array(ExecutionPolicyModelInvocationSchema),
  correction_count: z.number().int().nonnegative(),
}).strict();

export type NormalizedExecutionPolicyTrace = z.infer<typeof NormalizedExecutionPolicyTraceSchema>;

export const ExecutionPolicyResultSchema = z.object({
  verdict: z.enum(["PASS", "FAIL"]),
  reasons: z.array(z.string()),
  trace: NormalizedExecutionPolicyTraceSchema,
}).strict();

export type ExecutionPolicyResult = z.infer<typeof ExecutionPolicyResultSchema>;

export function defaultExecutionPolicy(): ExecutionPolicyInput {
  return {
    stages: STAGES.map((stage, index) => ({
      stage,
      outcome: index === 0 ? "sufficient" as const : "skipped" as const,
    })),
    required_capabilities: [],
    model_roster: [],
    model_invocations: [],
  };
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

function canonicalModelId(value: string): string {
  return value.toLocaleLowerCase("en-US");
}

function invalidTrace(): NormalizedExecutionPolicyTrace {
  return {
    stages: STAGES.map((stage) => ({ stage, outcome: "invalid", reason: "invalid_policy_input" })),
    required_capabilities: [],
    model_roster: [],
    model_invocations: [],
    correction_count: 0,
  };
}

function normalize(input: ExecutionPolicyInput): NormalizedExecutionPolicyTrace {
  return NormalizedExecutionPolicyTraceSchema.parse({
    stages: STAGES.map((stage, index) => {
      const actual = input.stages[index]!;
      return actual.stage === stage
        ? actual
        : { stage, outcome: "invalid", reason: "stage_identity_mismatch" };
    }),
    required_capabilities: uniqueSorted(input.required_capabilities),
    model_roster: input.model_roster
      .map((model) => ({
        ...model,
        model_id: canonicalModelId(model.model_id),
        capabilities: uniqueSorted(model.capabilities),
      }))
      .sort((left, right) => left.cost_rank - right.cost_rank
        || (left.model_id < right.model_id ? -1 : left.model_id > right.model_id ? 1 : 0)),
    model_invocations: input.model_invocations.map((invocation) => ({
      ...invocation,
      model_id: canonicalModelId(invocation.model_id),
      required_capabilities: uniqueSorted(invocation.required_capabilities),
    })),
    correction_count: input.model_invocations.filter((invocation) => invocation.role === "correction").length,
  });
}

/** Pure deterministic evaluator for the ordered least-cost execution ladder. */
export function evaluateExecutionPolicy(raw: unknown): ExecutionPolicyResult {
  const parsed = ExecutionPolicyInputSchema.safeParse(raw);
  if (!parsed.success) {
    return { verdict: "FAIL", reasons: ["POLICY_TRACE_INVALID"], trace: invalidTrace() };
  }

  const trace = normalize(parsed.data);
  const reasons: string[] = [];
  const sufficientIndex = trace.stages.findIndex((stage) => stage.outcome === "sufficient");
  const attemptedBoundary = sufficientIndex === -1 ? trace.stages.length : sufficientIndex;

  trace.stages.forEach((attempt, index) => {
    if ((attempt.outcome === "inapplicable" || attempt.outcome === "insufficient") && !attempt.reason) {
      reasons.push(`POLICY_STAGE_REASON_MISSING:${attempt.stage}`);
    }
    if (index < attemptedBoundary && (attempt.outcome === "inapplicable" || attempt.outcome === "insufficient")) {
      if (!attempt.evidence_reference) reasons.push(`POLICY_STAGE_EVIDENCE_MISSING:${attempt.stage}`);
      if (!attempt.observation_count) reasons.push(`POLICY_STAGE_OBSERVATION_COUNT_INVALID:${attempt.stage}`);
    }
    if (attempt.outcome === "invalid") {
      reasons.push(`POLICY_STAGE_INVALID:${attempt.stage}`);
    } else if (sufficientIndex >= 0 && index < sufficientIndex && attempt.outcome === "skipped") {
      reasons.push(`POLICY_STAGE_SKIPPED:${attempt.stage}`);
    } else if (sufficientIndex >= 0 && index > sufficientIndex && attempt.outcome !== "skipped") {
      reasons.push(`POLICY_STAGE_INVALID:${attempt.stage}`);
    }
  });
  if (sufficientIndex === -1) reasons.push("POLICY_NO_SUFFICIENT_STAGE");

  const sufficientStage = sufficientIndex >= 0 ? trace.stages[sufficientIndex]!.stage : undefined;
  if (sufficientIndex >= 0 && sufficientIndex < 4 && trace.model_invocations.length > 0) {
    reasons.push(sufficientStage === "no_agent"
      ? "NO_AGENT_MODEL_CALL"
      : `PRE_MODEL_STAGE_MODEL_CALL:${sufficientStage}`);
  } else if (trace.stages[4]!.outcome === "sufficient" && trace.model_invocations.length === 0) {
    reasons.push("MODEL_STAGE_WITHOUT_CALL");
  }

  const ids = new Set<string>();
  for (const model of trace.model_roster) {
    if (ids.has(model.model_id)) reasons.push(`MODEL_ROSTER_INVALID:${model.model_id}`);
    ids.add(model.model_id);
  }

  trace.model_invocations.forEach((invocation, index) => {
    if (invocation.role === "judge" || invocation.role === "auxiliary_judge") {
      reasons.push(`AUXILIARY_JUDGE_FORBIDDEN:${index}`);
    } else if (invocation.role !== "executor" && invocation.role !== "correction") {
      reasons.push(`MODEL_ROLE_INVALID:${index}`);
    }
    if (invocation.recursive) reasons.push(`RECURSIVE_AGENT_FORBIDDEN:${index}`);

    if (uniqueSorted(invocation.required_capabilities).join("\0") !== trace.required_capabilities.join("\0")) {
      reasons.push(`MODEL_REQUIREMENTS_MISMATCH:${index}`);
    }

    const selected = trace.model_roster.find((model) => model.model_id === invocation.model_id);
    if (!selected) {
      reasons.push(`MODEL_NOT_CONFIGURED:${index}`);
      return;
    }
    const hasCapabilities = (model: typeof selected): boolean =>
      trace.required_capabilities.every((capability) => model.capabilities.includes(capability));
    if (!hasCapabilities(selected)) {
      reasons.push(`MODEL_CAPABILITY_MISMATCH:${index}`);
      return;
    }
    const capable = trace.model_roster.filter(hasCapabilities);
    const cheapestRank = Math.min(...capable.map((model) => model.cost_rank));
    const baselineRank = Math.min(...trace.model_roster.map((model) => model.cost_rank));
    const cheaperCapable = selected.cost_rank > cheapestRank;
    if (cheaperCapable && !invocation.escalation_reason) {
      reasons.push(`MODEL_NOT_CHEAPEST_CAPABLE:${index}`);
    }
    if (selected.cost_rank > baselineRank && !invocation.escalation_reason) {
      reasons.push(`MODEL_ESCALATION_REASON_MISSING:${index}`);
    }
    const deterministicTie = capable
      .filter((model) => model.cost_rank === selected.cost_rank)
      .sort((left, right) => left.model_id < right.model_id ? -1 : left.model_id > right.model_id ? 1 : 0)[0];
    if (deterministicTie && selected.model_id !== deterministicTie.model_id) {
      reasons.push(`MODEL_TIE_BREAK_MISMATCH:${index}`);
    }
  });

  if (trace.correction_count > 1) reasons.push("CORRECTION_BUDGET_EXCEEDED");
  return ExecutionPolicyResultSchema.parse({
    verdict: reasons.length ? "FAIL" : "PASS",
    reasons,
    trace,
  });
}

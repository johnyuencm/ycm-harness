import { readContinuationAudits } from "./audit.js";
import { evaluateExecutionPolicy } from "./cost-policy.js";
import {
  continuationAuditCommitment,
  continuationRawSha,
  continuationShadowProtectedSha,
  continuationVerdictFromShadowRecord,
  readContinuationShadowRecords,
  type CanonicalContinuationVerdict,
  type ContinuationClosureSurface,
  type ContinuationShadowRecord,
} from "./shadow.js";

const SHA256 = /^[0-9a-f]{64}$/;

export interface ContinuationProofBinding {
  root: string;
  proofId: string;
  parentId: string;
  runId: string;
  sessionId: string;
  surface: ContinuationClosureSurface;
  responseText?: string;
  auditReference?: string;
}

export interface ContinuationClosureGateInput {
  root: string;
  surface: ContinuationClosureSurface;
  env?: Record<string, string | undefined>;
}

function failure(
  surface: ContinuationClosureSurface,
  proofId: string,
  reasons: string[],
  stored?: CanonicalContinuationVerdict,
): CanonicalContinuationVerdict {
  return {
    verdict: "FAIL",
    reasons,
    ...(stored?.failure_id ? { failure_id: stored.failure_id } : {}),
    ...(stored?.correction_reservation_id
      ? { correction_reservation_id: stored.correction_reservation_id }
      : {}),
    ...(stored?.audit_reference ? { audit_reference: stored.audit_reference } : {}),
    proof_id: proofId,
    surface,
  };
}

function storageReason(error: unknown, malformed: string, unreadable: string): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "EIO" ? unreadable : malformed;
}

async function readProof(root: string, proofId: string): Promise<
  | { record: ContinuationShadowRecord }
  | { reason: string }
> {
  try {
    const record = (await readContinuationShadowRecords(root)).find((item) => item.shadow_id === proofId);
    return record ? { record } : { reason: "CONTINUATION_PROOF_NOT_FOUND" };
  } catch (error) {
    return {
      reason: storageReason(
        error,
        "CONTINUATION_PROOF_MALFORMED",
        "CONTINUATION_PROOF_UNREADABLE",
      ),
    };
  }
}

function bindingReasons(record: Extract<ContinuationShadowRecord, { schema_version: 3 }>, input: ContinuationProofBinding): string[] {
  const reasons: string[] = [];
  if (record.parent_sha256 !== continuationShadowProtectedSha("parent", input.parentId)) {
    reasons.push("CONTINUATION_PROOF_PARENT_MISMATCH");
  }
  if (record.run_sha256 !== continuationShadowProtectedSha("run", input.runId)) {
    reasons.push("CONTINUATION_PROOF_RUN_MISMATCH");
  }
  if (record.session_sha256 !== continuationShadowProtectedSha("session", input.sessionId)) {
    reasons.push("CONTINUATION_PROOF_SESSION_MISMATCH");
  }
  if (input.responseText !== undefined
    && record.response_sha256 !== continuationShadowProtectedSha("response", input.responseText)) {
    reasons.push("CONTINUATION_PROOF_RESPONSE_MISMATCH");
  }
  if (input.auditReference !== undefined && record.audit_reference !== input.auditReference) {
    reasons.push("CONTINUATION_PROOF_AUDIT_REFERENCE_MISMATCH");
  }
  return reasons;
}

async function auditReasons(
  record: Extract<ContinuationShadowRecord, { schema_version: 3 }>,
  input: ContinuationProofBinding,
): Promise<string[]> {
  if (record.would_block_verdict === "PASS"
    && (record.routing !== "LLM" || !record.audit_persisted || !record.audit_reference || !record.audit_commitment)) {
    return ["CONTINUATION_PROOF_PASS_NOT_AUDITED_LLM"];
  }
  if (!record.audit_reference) return [];
  let audits;
  try {
    audits = await readContinuationAudits(input.root);
  } catch (error) {
    return [storageReason(
      error,
      "CONTINUATION_AUDIT_MALFORMED",
      "CONTINUATION_AUDIT_UNREADABLE",
    )];
  }
  const audit = audits.find((item) => item.audit_id === record.audit_reference);
  if (!audit) return ["CONTINUATION_AUDIT_NOT_FOUND"];
  if (audit.schema_version !== 2
    || audit.surface !== "scheduled-finalizer"
    || audit.mode !== "shadow"
    || audit.parent_sha256 !== continuationRawSha(input.parentId)
    || audit.run_sha256 !== continuationRawSha(input.runId)
    || audit.session_sha256 !== continuationRawSha(input.sessionId)
    || audit.verdict !== record.would_block_verdict
    || JSON.stringify(audit.reasons) !== JSON.stringify(record.reasons)
    || (input.responseText !== undefined && audit.response_sha256 !== continuationRawSha(input.responseText))) {
    return ["CONTINUATION_AUDIT_MISMATCH"];
  }
  if (!record.audit_commitment
    || JSON.stringify(record.audit_commitment) !== JSON.stringify(continuationAuditCommitment(audit))) {
    return ["CONTINUATION_AUDIT_COMMITMENT_MISMATCH"];
  }
  const recomputedPolicy = evaluateExecutionPolicy({
    stages: audit.policy.trace.stages,
    required_capabilities: audit.policy.trace.required_capabilities,
    model_roster: audit.policy.trace.model_roster,
    model_invocations: audit.policy.trace.model_invocations,
  });
  if (recomputedPolicy.verdict !== audit.policy.verdict
    || JSON.stringify(recomputedPolicy.reasons) !== JSON.stringify(audit.policy.reasons)
    || JSON.stringify(recomputedPolicy.trace) !== JSON.stringify(audit.policy.trace)) {
    return ["CONTINUATION_AUDIT_POLICY_INVALID"];
  }
  if (record.would_block_verdict === "PASS") {
    const noAgent = audit.policy.trace.stages[0];
    const model = audit.policy.trace.stages[4];
    if (audit.policy.verdict !== "PASS"
      || noAgent?.outcome === "sufficient"
      || model?.outcome !== "sufficient"
      || audit.policy.trace.model_invocations.length === 0) {
      return ["CONTINUATION_AUDIT_POLICY_MISMATCH"];
    }
  }
  if (audit.policy.verdict === "FAIL"
    && (record.failure_id !== audit.policy.policy_failure_id
      || record.correction_reservation_id !== audit.policy.correction_reservation_id)) {
    return ["CONTINUATION_AUDIT_POLICY_PAIR_MISMATCH"];
  }
  return [];
}

/** Load and authenticate one stored v3 proof without parsing output or performing live reads. */
export async function loadContinuationClosureVerdict(
  input: ContinuationProofBinding,
): Promise<CanonicalContinuationVerdict> {
  if (!SHA256.test(input.proofId)) {
    return failure(input.surface, input.proofId, ["CONTINUATION_PROOF_ID_INVALID"]);
  }
  const loaded = await readProof(input.root, input.proofId);
  if ("reason" in loaded) return failure(input.surface, input.proofId, [loaded.reason]);
  if (loaded.record.schema_version !== 3) {
    return failure(input.surface, input.proofId, ["CONTINUATION_PROOF_VERSION_UNSUPPORTED"]);
  }
  const stored = continuationVerdictFromShadowRecord(loaded.record, input.surface);
  const reasons = bindingReasons(loaded.record, input);
  if (reasons.length) return failure(input.surface, input.proofId, reasons, stored);
  const audit = await auditReasons(loaded.record, input);
  return audit.length ? failure(input.surface, input.proofId, audit, stored) : stored;
}

function envValue(env: Record<string, string | undefined>, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

/** Invalid or absent mode is the rollback-safe shadow default; enforce is fail closed. */
export async function continuationClosureGate(
  input: ContinuationClosureGateInput,
): Promise<CanonicalContinuationVerdict | null> {
  const env = input.env ?? process.env;
  if (env.YCM_HARNESS_SCHEDULED_FINALIZER_MODE !== "enforce") return null;
  const proofId = envValue(env, "YCM_HARNESS_CONTINUATION_PROOF_ID") ?? "";
  const parentId = envValue(env, "YCM_HARNESS_CONTINUATION_PROOF_PARENT_ID");
  const runId = envValue(env, "YCM_HARNESS_CONTINUATION_PROOF_RUN_ID");
  const sessionId = envValue(env, "YCM_HARNESS_CONTINUATION_PROOF_SESSION_ID");
  const missing = [
    ...(!proofId ? ["CONTINUATION_PROOF_ID_MISSING"] : []),
    ...(!parentId ? ["CONTINUATION_PROOF_PARENT_MISSING"] : []),
    ...(!runId ? ["CONTINUATION_PROOF_RUN_MISSING"] : []),
    ...(!sessionId ? ["CONTINUATION_PROOF_SESSION_MISSING"] : []),
  ];
  if (missing.length) return failure(input.surface, proofId, missing);
  return loadContinuationClosureVerdict({
    root: input.root,
    proofId,
    parentId: parentId!,
    runId: runId!,
    sessionId: sessionId!,
    surface: input.surface,
  });
}

export async function requireContinuationClosure(
  input: ContinuationClosureGateInput,
): Promise<CanonicalContinuationVerdict | null> {
  const verdict = await continuationClosureGate(input);
  if (verdict?.verdict === "FAIL") {
    throw new Error(`Continuation closure failed: ${verdict.reasons.join(", ")}.`);
  }
  return verdict;
}

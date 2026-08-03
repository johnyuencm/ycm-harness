import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  assertNoSecrets,
  type CoordinationDeps,
  withCoordinationLease,
} from "../autonomy/coordination.js";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import {
  buildContinuationPolicyFailurePair,
  finalizeContinuationLedgerLiveAudited,
  readContinuationAudits,
  type ContinuationAuditContext,
  type ContinuationAuditDeps,
  type ContinuationAuditRecord,
  type ContinuationPolicyFailurePair,
} from "./audit.js";
import {
  evaluateExecutionPolicy,
  type ExecutionPolicyInput,
  type ExecutionPolicyResult,
} from "./cost-policy.js";
import type { ContinuationFinalizerResult } from "./finalizer.js";
import {
  assertSafeContinuationLeaseTree,
  assertSafeContinuationStoragePath,
} from "./storage-safety.js";

const SHA256 = /^[0-9a-f]{64}$/;
const SHADOW_LEASE = "continuation-shadows";

const LegacyContinuationShadowContentObjectSchema = z.object({
  schema_version: z.literal(1),
  response_sha256: z.string().regex(SHA256),
  schedule_sha256: z.string().regex(SHA256),
  parent_sha256: z.string().regex(SHA256),
  run_sha256: z.string().regex(SHA256),
  session_sha256: z.string().regex(SHA256),
  routing: z.enum(["LLM", "NO_AGENT"]),
  would_block_verdict: z.enum(["PASS", "FAIL"]),
  reasons: z.array(z.string()),
  audit_persisted: z.boolean(),
  audit_reference: z.string().regex(SHA256).optional(),
}).strict();

const LegacyContinuationShadowContentSchema = LegacyContinuationShadowContentObjectSchema.superRefine((record, context) => {
  if (record.audit_persisted !== Boolean(record.audit_reference)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "audit persistence and reference must agree" });
  }
});

const CurrentContinuationShadowContentObjectSchema = z.object({
  schema_version: z.literal(2),
  response_sha256: z.string().regex(SHA256),
  schedule_sha256: z.string().regex(SHA256),
  parent_sha256: z.string().regex(SHA256),
  run_sha256: z.string().regex(SHA256),
  session_sha256: z.string().regex(SHA256),
  routing: z.enum(["LLM", "NO_AGENT"]),
  would_block_verdict: z.enum(["PASS", "FAIL"]),
  reasons: z.array(z.string()),
  audit_persisted: z.boolean(),
  audit_reference: z.string().regex(SHA256).optional(),
  failure_id: z.string().regex(SHA256).optional(),
  correction_reservation_id: z.string().regex(SHA256).optional(),
}).strict();

const CurrentContinuationShadowContentSchema = CurrentContinuationShadowContentObjectSchema.superRefine((record, context) => {
  if (record.audit_persisted !== Boolean(record.audit_reference)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "audit persistence and reference must agree" });
  }
  const hasPair = Boolean(record.failure_id && record.correction_reservation_id);
  if (record.would_block_verdict === "FAIL" && !hasPair) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "failed shadow requires one correction reservation" });
  }
  if (record.would_block_verdict === "PASS" && (record.failure_id || record.correction_reservation_id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "passing shadow cannot reserve a correction" });
  }
});

export const ContinuationAuditCommitmentSchema = z.object({
  response_sha256: z.string().regex(SHA256),
  items_sha256: z.string().regex(SHA256),
  evidence_reference_ids_sha256: z.string().regex(SHA256),
  policy_sha256: z.string().regex(SHA256),
}).strict();

export type ContinuationAuditCommitment = z.infer<typeof ContinuationAuditCommitmentSchema>;

const StrictContinuationShadowContentObjectSchema = CurrentContinuationShadowContentObjectSchema
  .omit({ schema_version: true })
  .extend({
    schema_version: z.literal(3),
    audit_commitment: ContinuationAuditCommitmentSchema.optional(),
  }).strict();

const StrictContinuationShadowContentSchema = StrictContinuationShadowContentObjectSchema.superRefine((record, context) => {
  if (record.audit_persisted !== Boolean(record.audit_reference)
    || record.audit_persisted !== Boolean(record.audit_commitment)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "audit persistence, reference, and commitment must agree" });
  }
  const hasPair = Boolean(record.failure_id && record.correction_reservation_id);
  if (record.would_block_verdict === "FAIL" && !hasPair) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "failed shadow requires one correction reservation" });
  }
  if (record.would_block_verdict === "PASS" && (record.failure_id || record.correction_reservation_id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "passing shadow cannot reserve a correction" });
  }
  if (record.would_block_verdict === "PASS" && record.routing === "LLM"
    && (!record.audit_persisted || !record.audit_reference || !record.audit_commitment)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "passing LLM shadow requires an audit commitment" });
  }
});

const LegacyContinuationShadowRecordSchema = LegacyContinuationShadowContentObjectSchema.extend({
  shadow_id: z.string().regex(SHA256),
  content_sha256: z.string().regex(SHA256),
  recorded_at: z.string().datetime(),
  record_sha256: z.string().regex(SHA256),
}).strict();

const CurrentContinuationShadowRecordSchema = CurrentContinuationShadowContentObjectSchema.extend({
  shadow_id: z.string().regex(SHA256),
  content_sha256: z.string().regex(SHA256),
  recorded_at: z.string().datetime(),
  record_sha256: z.string().regex(SHA256),
}).strict();

const StrictContinuationShadowRecordSchema = StrictContinuationShadowContentObjectSchema.extend({
  shadow_id: z.string().regex(SHA256),
  content_sha256: z.string().regex(SHA256),
  recorded_at: z.string().datetime(),
  record_sha256: z.string().regex(SHA256),
}).strict();

const ContinuationShadowRecordUnionSchema = z.discriminatedUnion("schema_version", [
  LegacyContinuationShadowRecordSchema,
  CurrentContinuationShadowRecordSchema,
  StrictContinuationShadowRecordSchema,
]);

export const ContinuationShadowRecordSchema = ContinuationShadowRecordUnionSchema.superRefine((record, context) => {
  const {
    shadow_id: _shadowId,
    content_sha256: _contentSha,
    recorded_at: _recordedAt,
    record_sha256: _recordSha,
    ...content
  } = record;
  const parsed = record.schema_version === 1
    ? LegacyContinuationShadowContentSchema.safeParse(content)
    : record.schema_version === 2
      ? CurrentContinuationShadowContentSchema.safeParse(content)
      : StrictContinuationShadowContentSchema.safeParse(content);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: issue.path, message: issue.message });
    }
  }
});

export type ContinuationShadowRecord = z.infer<typeof ContinuationShadowRecordSchema>;

export type ContinuationClosureSurface =
  | "scheduled-finalization"
  | "verification-completion"
  | "ticket-completion"
  | "goal-completion";

export interface ScheduledResponseShadowContext {
  root: string;
  parentId: string;
  runId: string;
  sessionId: string;
  scheduleId: string;
  trigger: "scheduled" | "cron" | "interactive" | "non-scheduled";
  enabled: boolean;
  routing: "LLM" | "NO_AGENT";
  executionPolicy: ExecutionPolicyInput;
}

export type ContinuationShadowFaultPoint = "before_record_write" | "after_record_write";

type AuditedFinalizer = typeof finalizeContinuationLedgerLiveAudited;

export interface ScheduledResponseShadowDeps extends ContinuationAuditDeps, CoordinationDeps {
  finalizeAudited?: AuditedFinalizer;
  shadowFault?: (point: ContinuationShadowFaultPoint) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export interface ScheduledFinalizerBlock {
  decision: "block";
  reason: string;
  stopReason: "cursor_harness_continuation_finalization";
  systemMessage: string;
  failure_id: string;
  correction_reservation_id: string;
}

export interface CanonicalContinuationVerdict {
  verdict: "PASS" | "FAIL";
  reasons: string[];
  failure_id?: string;
  correction_reservation_id?: string;
  audit_reference?: string;
  proof_id: string;
  surface: string;
}

export interface ScheduledFinalizerResult {
  responseText: string;
  closure: ScheduledFinalizerBlock | null;
  verdict: CanonicalContinuationVerdict | null;
}

/** The only record-to-verdict projection used by scheduled delivery and closure gates. */
export function continuationVerdictFromShadowRecord(
  record: ContinuationShadowRecord,
  surface: ContinuationClosureSurface,
): CanonicalContinuationVerdict {
  const parsed = ContinuationShadowRecordSchema.parse(record);
  if (parsed.schema_version !== 3) throw new Error("unsupported_continuation_shadow_version");
  return {
    verdict: parsed.would_block_verdict,
    reasons: [...parsed.reasons],
    ...(parsed.failure_id ? { failure_id: parsed.failure_id } : {}),
    ...(parsed.correction_reservation_id
      ? { correction_reservation_id: parsed.correction_reservation_id }
      : {}),
    ...(parsed.audit_reference ? { audit_reference: parsed.audit_reference } : {}),
    proof_id: parsed.shadow_id,
    surface,
  };
}

export function continuationRawSha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function continuationShadowProtectedSha(field: string, value: string): string {
  return continuationRawSha(`continuation-shadow:v1:${field}\0${value}`);
}

export function continuationAuditCommitment(audit: ContinuationAuditRecord): ContinuationAuditCommitment {
  if (audit.schema_version !== 2) throw new Error("unsupported_continuation_audit_version");
  return ContinuationAuditCommitmentSchema.parse({
    response_sha256: audit.response_sha256,
    items_sha256: continuationRawSha(JSON.stringify(audit.items)),
    evidence_reference_ids_sha256: continuationRawSha(JSON.stringify(audit.evidence_reference_ids)),
    policy_sha256: continuationRawSha(JSON.stringify(audit.policy)),
  });
}

function shadowDirectory(root: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "continuation-shadows");
}

function recordsDirectory(root: string): string {
  return path.join(shadowDirectory(root), "records");
}

async function assertSafeShadowTree(root: string): Promise<void> {
  await assertSafeContinuationStoragePath(root, path.join(root, HARNESS_DIR_NAME), "directory");
  await assertSafeContinuationStoragePath(root, path.join(root, HARNESS_DIR_NAME, "autonomy"), "directory");
  await assertSafeContinuationStoragePath(root, shadowDirectory(root), "directory");
  await assertSafeContinuationStoragePath(root, recordsDirectory(root), "directory");
}

async function ensureSafeShadowDirectories(root: string): Promise<void> {
  await assertSafeShadowTree(root);
  await fs.mkdir(recordsDirectory(root), { recursive: true });
  await assertSafeShadowTree(root);
}

type ContinuationShadowContent = z.infer<typeof LegacyContinuationShadowContentSchema>
  | z.infer<typeof CurrentContinuationShadowContentSchema>
  | z.infer<typeof StrictContinuationShadowContentSchema>;

function contentOf(record: ContinuationShadowRecord): ContinuationShadowContent {
  const base = {
    schema_version: record.schema_version,
    response_sha256: record.response_sha256,
    schedule_sha256: record.schedule_sha256,
    parent_sha256: record.parent_sha256,
    run_sha256: record.run_sha256,
    session_sha256: record.session_sha256,
    routing: record.routing,
    would_block_verdict: record.would_block_verdict,
    reasons: record.reasons,
    audit_persisted: record.audit_persisted,
    ...(record.audit_reference ? { audit_reference: record.audit_reference } : {}),
    ...(record.schema_version === 3 ? { audit_commitment: record.audit_commitment } : {}),
  };
  return record.schema_version === 1
    ? LegacyContinuationShadowContentSchema.parse(base)
    : record.schema_version === 2
      ? CurrentContinuationShadowContentSchema.parse({
        ...base,
        ...(record.failure_id ? { failure_id: record.failure_id } : {}),
        ...(record.correction_reservation_id
          ? { correction_reservation_id: record.correction_reservation_id }
          : {}),
      })
      : StrictContinuationShadowContentSchema.parse({
          ...base,
          ...(record.failure_id ? { failure_id: record.failure_id } : {}),
          ...(record.correction_reservation_id
            ? { correction_reservation_id: record.correction_reservation_id }
            : {}),
        });
}

function contentDigest(content: ContinuationShadowContent): string {
  const parsed = content.schema_version === 1
    ? LegacyContinuationShadowContentSchema.parse(content)
    : content.schema_version === 2
      ? CurrentContinuationShadowContentSchema.parse(content)
      : StrictContinuationShadowContentSchema.parse(content);
  return continuationShadowProtectedSha("content", JSON.stringify(parsed));
}

function recordDigest(record: object): string {
  return continuationShadowProtectedSha("record", JSON.stringify(record));
}

function storedRecord(raw: unknown, filenameId: string): ContinuationShadowRecord {
  const parsed = ContinuationShadowRecordSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid_stored_continuation_shadow");
  const { record_sha256: recordSha, ...authenticated } = parsed.data;
  const contentSha = contentDigest(contentOf(parsed.data));
  if (parsed.data.shadow_id !== contentSha || parsed.data.content_sha256 !== contentSha
    || recordSha !== filenameId || recordDigest(authenticated) !== recordSha) {
    throw new Error("invalid_stored_continuation_shadow");
  }
  return parsed.data;
}

async function readRecordsUnlocked(root: string): Promise<ContinuationShadowRecord[]> {
  await assertSafeShadowTree(root);
  const directory = recordsDirectory(root);
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? [] : Promise.reject(error));
  const records: ContinuationShadowRecord[] = [];
  const identities = new Set<string>();
  for (const name of names.sort()) {
    await assertSafeContinuationStoragePath(root, path.join(directory, name), "file");
    if (name.endsWith(".tmp")) continue;
    if (!/^[0-9a-f]{64}\.json$/.test(name)) throw new Error("invalid_stored_continuation_shadow");
    const record = storedRecord(await readJsonIfExists<unknown>(path.join(directory, name)), name.slice(0, -5));
    if (identities.has(record.shadow_id)) throw new Error("invalid_stored_continuation_shadow");
    identities.add(record.shadow_id);
    records.push(record);
  }
  return records;
}

export async function readContinuationShadowRecords(root: string): Promise<ContinuationShadowRecord[]> {
  return readRecordsUnlocked(root);
}

interface ShadowOutcome {
  verdict: "PASS" | "FAIL";
  reasons: string[];
  audit?: ContinuationAuditRecord;
}

interface FailurePair {
  failureId: string;
  correctionReservationId: string;
}

function buildRecord(
  responseText: string,
  context: ScheduledResponseShadowContext,
  outcome: ShadowOutcome,
  failurePair: FailurePair,
  recordedAt: string,
): ContinuationShadowRecord {
  assertNoSecrets({
    schedule_id: context.scheduleId,
    parent_id: context.parentId,
    run_id: context.runId,
    session_id: context.sessionId,
    ...Object.fromEntries(outcome.reasons.map((reason, index) => [`reason_${index}`, reason])),
  });
  const content = StrictContinuationShadowContentSchema.parse({
    schema_version: 3,
    response_sha256: continuationShadowProtectedSha("response", responseText),
    schedule_sha256: continuationShadowProtectedSha("schedule", context.scheduleId),
    parent_sha256: continuationShadowProtectedSha("parent", context.parentId),
    run_sha256: continuationShadowProtectedSha("run", context.runId),
    session_sha256: continuationShadowProtectedSha("session", context.sessionId),
    routing: context.routing,
    would_block_verdict: outcome.verdict,
    reasons: outcome.reasons,
    audit_persisted: Boolean(outcome.audit),
    ...(outcome.audit
      ? {
          audit_reference: outcome.audit.audit_id,
          audit_commitment: continuationAuditCommitment(outcome.audit),
        }
      : {}),
    ...(outcome.verdict === "FAIL"
      ? {
          failure_id: failurePair.failureId,
          correction_reservation_id: failurePair.correctionReservationId,
        }
      : {}),
  });
  const contentSha = contentDigest(content);
  const authenticated = {
    ...content,
    shadow_id: contentSha,
    content_sha256: contentSha,
    recorded_at: recordedAt,
  };
  return ContinuationShadowRecordSchema.parse({
    ...authenticated,
    record_sha256: recordDigest(authenticated),
  });
}

async function persistShadowRecordUnlocked(
  record: ContinuationShadowRecord,
  context: ScheduledResponseShadowContext,
  deps: ScheduledResponseShadowDeps,
): Promise<ContinuationShadowRecord> {
  await ensureSafeShadowDirectories(context.root);
  const records = await readRecordsUnlocked(context.root);
  const existing = records.find((candidate) => candidate.shadow_id === record.shadow_id);
  if (existing) return existing;
  const file = path.join(recordsDirectory(context.root), `${record.record_sha256}.json`);
  await deps.shadowFault?.("before_record_write");
  await assertSafeContinuationStoragePath(context.root, file, "file");
  await writeJsonAtomic(file, record);
  await deps.shadowFault?.("after_record_write");
  await assertSafeContinuationStoragePath(context.root, file, "file");
  return storedRecord(await readJsonIfExists<unknown>(file), record.record_sha256);
}

function noAgentRouteIsValid(policy: ExecutionPolicyResult): boolean {
  return policy.verdict === "PASS"
    && policy.trace.stages[0]?.stage === "no_agent"
    && policy.trace.stages[0].outcome === "sufficient"
    && policy.trace.model_invocations.length === 0;
}

function auditContext(context: ScheduledResponseShadowContext): ContinuationAuditContext {
  return {
    root: context.root,
    parentId: context.parentId,
    runId: context.runId,
    sessionId: context.sessionId,
    surface: "scheduled-finalizer",
    mode: "shadow",
    executionPolicy: context.executionPolicy,
  };
}

async function exactAuditRecord(
  responseText: string,
  context: ScheduledResponseShadowContext,
  result: ContinuationFinalizerResult,
  policy: ExecutionPolicyResult,
): Promise<ContinuationAuditRecord | undefined> {
  if (result.reasons.includes("AUDIT_PERSISTENCE_FAILED")) return undefined;
  const responseSha = continuationRawSha(responseText);
  const parentSha = continuationRawSha(context.parentId);
  const runSha = continuationRawSha(context.runId);
  const sessionSha = continuationRawSha(context.sessionId);
  try {
    return (await readContinuationAudits(context.root)).find((record) =>
      record.schema_version === 2
      && record.response_sha256 === responseSha
      && record.parent_sha256 === parentSha
      && record.run_sha256 === runSha
      && record.session_sha256 === sessionSha
      && record.surface === "scheduled-finalizer"
      && record.mode === "shadow"
      && record.verdict === result.status
      && JSON.stringify(record.reasons) === JSON.stringify(result.reasons)
      && JSON.stringify(record.items) === JSON.stringify(result.items)
      && record.policy.verdict === policy.verdict
      && JSON.stringify(record.policy.reasons) === JSON.stringify(policy.reasons)
      && JSON.stringify(record.policy.trace) === JSON.stringify(policy.trace));
  } catch {
    return undefined;
  }
}

function withReason(result: ContinuationFinalizerResult, reason: string): ContinuationFinalizerResult {
  return result.reasons.includes(reason)
    ? result
    : { ...result, status: "FAIL", reasons: [...result.reasons, reason] };
}

async function llmOutcome(
  responseText: string,
  context: ScheduledResponseShadowContext,
  policy: ExecutionPolicyResult,
  deps: ScheduledResponseShadowDeps,
): Promise<ShadowOutcome> {
  let result: ContinuationFinalizerResult;
  try {
    result = await (deps.finalizeAudited ?? finalizeContinuationLedgerLiveAudited)(
      responseText,
      auditContext(context),
      deps,
    );
  } catch {
    return { verdict: "FAIL", reasons: ["SHADOW_VALIDATOR_FAILED"] };
  }
  if (noAgentRouteIsValid(policy)) result = withReason(result, "LLM_ROUTE_INVALID");
  const audit = await exactAuditRecord(responseText, context, result, policy);
  if (!audit
    && !result.reasons.includes("AUDIT_PERSISTENCE_FAILED")
    && !result.reasons.includes("LLM_ROUTE_INVALID")) {
    result = withReason(result, "SHADOW_AUDIT_MISSING");
  }
  return {
    verdict: result.status,
    reasons: result.reasons,
    ...(audit ? { audit } : {}),
  };
}

interface ScheduledObservation {
  applicable: boolean;
  outcome?: ShadowOutcome;
  record?: ContinuationShadowRecord;
  failurePair?: FailurePair;
  persistenceFailed: boolean;
}

function shadowFailurePair(responseText: string, context: ScheduledResponseShadowContext): FailurePair {
  const identity = JSON.stringify({
    schema_version: 2,
    response_sha256: continuationShadowProtectedSha("response", responseText),
    schedule_sha256: continuationShadowProtectedSha("schedule", context.scheduleId),
    parent_sha256: continuationShadowProtectedSha("parent", context.parentId),
    run_sha256: continuationShadowProtectedSha("run", context.runId),
    session_sha256: continuationShadowProtectedSha("session", context.sessionId),
    routing: context.routing,
  });
  const failureId = continuationRawSha(`continuation-shadow-enforcement:v2:failure\0${identity}`);
  return {
    failureId,
    correctionReservationId: continuationRawSha(`continuation-shadow-enforcement:v2:correction\0${failureId}`),
  };
}

function observationFailurePair(
  responseText: string,
  context: ScheduledResponseShadowContext,
  policy: ExecutionPolicyResult,
): FailurePair {
  if (policy.verdict === "PASS") return shadowFailurePair(responseText, context);
  const pair: ContinuationPolicyFailurePair = buildContinuationPolicyFailurePair(
    responseText,
    policy,
    auditContext(context),
  );
  return {
    failureId: pair.policy_failure_id,
    correctionReservationId: pair.correction_reservation_id,
  };
}

async function observeScheduledResponse(
  responseText: string,
  context: ScheduledResponseShadowContext,
  deps: ScheduledResponseShadowDeps,
): Promise<ScheduledObservation> {
  if (!context.enabled || (context.trigger !== "scheduled" && context.trigger !== "cron")) {
    return { applicable: false, persistenceFailed: false };
  }

  const policy = evaluateExecutionPolicy(context.executionPolicy);
  const failurePair = observationFailurePair(responseText, context, policy);
  let outcome: ShadowOutcome | undefined;
  let record: ContinuationShadowRecord | undefined;
  try {
    await assertSafeContinuationLeaseTree(context.root, SHADOW_LEASE);
    await withCoordinationLease(context.root, SHADOW_LEASE, async () => {
      outcome = context.routing === "NO_AGENT"
        ? {
            verdict: (noAgentRouteIsValid(policy) ? "PASS" : "FAIL") as "PASS" | "FAIL",
            reasons: noAgentRouteIsValid(policy)
              ? []
              : policy.reasons.length ? policy.reasons : ["NO_AGENT_ROUTE_INVALID"],
          }
        : await llmOutcome(responseText, context, policy, deps);
      const candidate = buildRecord(
        responseText,
        context,
        outcome,
        failurePair,
        (deps.now ?? (() => new Date().toISOString()))(),
      );
      record = candidate;
      record = await persistShadowRecordUnlocked(candidate, context, deps);
    }, deps);
    return { applicable: true, outcome, record, failurePair, persistenceFailed: false };
  } catch {
    return { applicable: true, outcome, record, failurePair, persistenceFailed: true };
  }
}

function scheduledFinalizerMode(deps: ScheduledResponseShadowDeps): "shadow" | "enforce" {
  return (deps.env ?? process.env).YCM_HARNESS_SCHEDULED_FINALIZER_MODE === "enforce"
    ? "enforce"
    : "shadow";
}

async function enforcementClosure(
  context: ScheduledResponseShadowContext,
  verdict: CanonicalContinuationVerdict | null,
): Promise<ScheduledFinalizerBlock | null> {
  if (!verdict || context.routing === "NO_AGENT" || verdict.verdict !== "FAIL") return null;
  if (!verdict.failure_id || !verdict.correction_reservation_id) {
    throw new Error("missing_scheduled_finalizer_failure_pair");
  }
  const reason = `Scheduled continuation finalization failed: ${verdict.reasons.join(", ")}.`;
  return {
    decision: "block",
    reason,
    stopReason: "cursor_harness_continuation_finalization",
    systemMessage: `${reason} Use the reserved bounded correction, then retry finalization.`,
    failure_id: verdict.failure_id,
    correction_reservation_id: verdict.correction_reservation_id,
  };
}

function observationVerdict(
  responseText: string,
  context: ScheduledResponseShadowContext,
  observation: ScheduledObservation,
): CanonicalContinuationVerdict | null {
  if (!observation.applicable) return null;
  if (!observation.record) {
    const reasons = [...new Set([...(observation.outcome?.reasons ?? []), "SHADOW_PERSISTENCE_FAILED"])];
    const identity = JSON.stringify({
      response_sha256: continuationShadowProtectedSha("response", responseText),
      schedule_sha256: continuationShadowProtectedSha("schedule", context.scheduleId),
      parent_sha256: continuationShadowProtectedSha("parent", context.parentId),
      run_sha256: continuationShadowProtectedSha("run", context.runId),
      session_sha256: continuationShadowProtectedSha("session", context.sessionId),
      routing: context.routing,
    });
    return {
      verdict: "FAIL",
      reasons,
      ...(observation.failurePair
        ? {
            failure_id: observation.failurePair.failureId,
            correction_reservation_id: observation.failurePair.correctionReservationId,
          }
        : {}),
      proof_id: continuationShadowProtectedSha("unpersisted", identity),
      surface: "scheduled-finalization",
    };
  }
  let verdict = continuationVerdictFromShadowRecord(observation.record, "scheduled-finalization");
  if (observation.persistenceFailed) {
    verdict = {
      ...verdict,
      verdict: "FAIL",
      reasons: [...new Set([...verdict.reasons, "SHADOW_PERSISTENCE_FAILED"])],
    };
  }
  return verdict;
}

/**
 * Disposable scheduled-only shadow adapter. It never alters or blocks delivery;
 * enabled=false is the complete rollback switch.
 */
export async function finalizeScheduledResponseShadow(
  responseText: string,
  context: ScheduledResponseShadowContext,
  deps: ScheduledResponseShadowDeps,
): Promise<string> {
  await observeScheduledResponse(responseText, context, deps);
  return responseText;
}

/** Scheduled-only staged adapter. Observation is shared; the environment switch changes only closure policy. */
export async function finalizeScheduledResponse(
  responseText: string,
  context: ScheduledResponseShadowContext,
  deps: ScheduledResponseShadowDeps,
): Promise<ScheduledFinalizerResult> {
  const observation = await observeScheduledResponse(responseText, context, deps);
  const verdict = observationVerdict(responseText, context, observation);
  return {
    responseText,
    closure: scheduledFinalizerMode(deps) === "enforce"
      ? await enforcementClosure(context, verdict)
      : null,
    verdict,
  };
}

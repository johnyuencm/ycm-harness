import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertNoSecrets, type CoordinationDeps, withCoordinationLease } from "../autonomy/coordination.js";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import {
  finalizeContinuationLedgerLive,
  type ContinuationFinalizerResult,
  type ContinuationLiveProofContext,
  type ContinuationLiveProofDeps,
} from "./finalizer.js";
import {
  defaultExecutionPolicy,
  evaluateExecutionPolicy,
  NormalizedExecutionPolicyTraceSchema,
  type ExecutionPolicyInput,
  type ExecutionPolicyResult,
} from "./cost-policy.js";
import {
  assertSafeContinuationLeaseTree,
  assertSafeContinuationStoragePath,
} from "./storage-safety.js";

const SHA256 = /^[0-9a-f]{64}$/;
const SAFE_LABEL = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const AUDIT_PATH_FAILURE = "unsafe_continuation_audit_path";

const NormalizedContinuationItemSchema = z.object({
  lane: z.string(),
  action: z.string(),
  disposition: z.string(),
  evidence: z.string(),
  expected_impact: z.string(),
  cost_class: z.string(),
  evidence_horizon: z.string(),
  ticket_id: z.string().optional(),
  mutation_action: z.string().optional(),
  monitoring_owner: z.string().optional(),
  monitoring_reference: z.string().optional(),
  monitoring_reason: z.string().optional(),
  monitoring_check: z.string().optional(),
  monitoring_exit: z.string().optional(),
}).strict();

export const ContinuationAuditPolicySchema = z.object({
  trace: NormalizedExecutionPolicyTraceSchema,
  verdict: z.enum(["PASS", "FAIL"]),
  reasons: z.array(z.string()),
  policy_failure_id: z.string().regex(SHA256).optional(),
  correction_reservation_id: z.string().regex(SHA256).optional(),
}).strict().superRefine((policy, context) => {
  const hasFailureIdentity = Boolean(policy.policy_failure_id && policy.correction_reservation_id);
  if (policy.verdict === "FAIL" && !hasFailureIdentity) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "failed policy requires one correction reservation" });
  }
  if (policy.verdict === "PASS" && (policy.policy_failure_id || policy.correction_reservation_id)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "passing policy cannot reserve a correction" });
  }
});

export type ContinuationAuditPolicy = z.infer<typeof ContinuationAuditPolicySchema>;

const LegacyContinuationAuditContentSchema = z.object({
  schema_version: z.literal(1),
  response_sha256: z.string().regex(SHA256),
  items: z.array(NormalizedContinuationItemSchema),
  evidence_reference_ids: z.array(z.string()),
  verdict: z.enum(["PASS", "FAIL"]),
  reasons: z.array(z.string()),
  surface: z.string().regex(SAFE_LABEL),
  mode: z.string().regex(SAFE_LABEL),
  parent_sha256: z.string().regex(SHA256),
  run_sha256: z.string().regex(SHA256),
  session_sha256: z.string().regex(SHA256),
}).strict();

const ContinuationAuditContentSchema = z.object({
  schema_version: z.literal(2),
  response_sha256: z.string().regex(SHA256),
  items: z.array(NormalizedContinuationItemSchema),
  evidence_reference_ids: z.array(z.string()),
  verdict: z.enum(["PASS", "FAIL"]),
  reasons: z.array(z.string()),
  policy: ContinuationAuditPolicySchema,
  surface: z.string().regex(SAFE_LABEL),
  mode: z.string().regex(SAFE_LABEL),
  parent_sha256: z.string().regex(SHA256),
  run_sha256: z.string().regex(SHA256),
  session_sha256: z.string().regex(SHA256),
}).strict();

const LegacyContinuationAuditRecordSchema = LegacyContinuationAuditContentSchema.extend({
  audit_id: z.string().regex(SHA256),
  content_sha256: z.string().regex(SHA256),
  record_sha256: z.string().regex(SHA256),
  recorded_at: z.string().datetime(),
}).strict();

const CurrentContinuationAuditRecordSchema = ContinuationAuditContentSchema.extend({
  audit_id: z.string().regex(SHA256),
  content_sha256: z.string().regex(SHA256),
  record_sha256: z.string().regex(SHA256),
  recorded_at: z.string().datetime(),
}).strict();

export const ContinuationAuditRecordSchema = z.discriminatedUnion("schema_version", [
  LegacyContinuationAuditRecordSchema,
  CurrentContinuationAuditRecordSchema,
]);

export type ContinuationAuditRecord = z.infer<typeof ContinuationAuditRecordSchema>;

export const ContinuationAuditProjectionSchema = z.object({
  schema_version: z.literal(1),
  rebuilt_at: z.string().datetime(),
  records: z.array(ContinuationAuditRecordSchema),
}).strict();

export type ContinuationAuditProjection = z.infer<typeof ContinuationAuditProjectionSchema>;

export interface ContinuationAuditContext extends ContinuationLiveProofContext {
  root: string;
  surface: string;
  mode: string;
  executionPolicy?: ExecutionPolicyInput;
}

export type ContinuationAuditFaultPoint =
  | "before_record_write"
  | "after_record_write"
  | "before_projection_rebuild"
  | "after_index_projection_write"
  | "after_projection_rebuild";

export interface ContinuationAuditDeps extends ContinuationLiveProofDeps, CoordinationDeps {
  auditFault?: (point: ContinuationAuditFaultPoint) => Promise<void>;
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function auditDirectory(root: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "continuation-audits");
}

function recordsDirectory(root: string): string {
  return path.join(auditDirectory(root), "records");
}

function indexFile(root: string): string {
  return path.join(auditDirectory(root), "index.json");
}

function jsonlFile(root: string): string {
  return path.join(auditDirectory(root), "index.jsonl");
}

async function assertSafeAuditTree(root: string): Promise<void> {
  await assertSafeContinuationStoragePath(root, path.join(root, HARNESS_DIR_NAME), "directory", AUDIT_PATH_FAILURE);
  await assertSafeContinuationStoragePath(root, path.join(root, HARNESS_DIR_NAME, "autonomy"), "directory", AUDIT_PATH_FAILURE);
  await assertSafeContinuationStoragePath(root, auditDirectory(root), "directory", AUDIT_PATH_FAILURE);
  await assertSafeContinuationStoragePath(root, recordsDirectory(root), "directory", AUDIT_PATH_FAILURE);
  await assertSafeContinuationStoragePath(root, indexFile(root), "file", AUDIT_PATH_FAILURE);
  await assertSafeContinuationStoragePath(root, jsonlFile(root), "file", AUDIT_PATH_FAILURE);
}

async function ensureSafeAuditDirectories(root: string): Promise<void> {
  await assertSafeAuditTree(root);
  await fs.mkdir(recordsDirectory(root), { recursive: true });
  await assertSafeAuditTree(root);
}

function contentOf(record: ContinuationAuditRecord):
  | z.infer<typeof LegacyContinuationAuditContentSchema>
  | z.infer<typeof ContinuationAuditContentSchema> {
  const base = {
    schema_version: record.schema_version,
    response_sha256: record.response_sha256,
    items: record.items,
    evidence_reference_ids: record.evidence_reference_ids,
    verdict: record.verdict,
    reasons: record.reasons,
    surface: record.surface,
    mode: record.mode,
    parent_sha256: record.parent_sha256,
    run_sha256: record.run_sha256,
    session_sha256: record.session_sha256,
  };
  return record.schema_version === 1
    ? LegacyContinuationAuditContentSchema.parse(base)
    : ContinuationAuditContentSchema.parse({ ...base, policy: record.policy });
}

function contentDigest(content: ReturnType<typeof contentOf>): string {
  const parsed = content.schema_version === 1
    ? LegacyContinuationAuditContentSchema.parse(content)
    : ContinuationAuditContentSchema.parse(content);
  return sha(JSON.stringify(parsed));
}

function recordDigest(record: object): string {
  return sha(JSON.stringify(record));
}

function storedRecord(raw: unknown, filenameId: string): ContinuationAuditRecord {
  const parsed = ContinuationAuditRecordSchema.safeParse(raw);
  if (!parsed.success) throw new Error("invalid_stored_continuation_audit");
  const { record_sha256: recordSha, ...authenticated } = parsed.data;
  const contentSha = contentDigest(contentOf(parsed.data));
  if (parsed.data.audit_id !== contentSha || parsed.data.content_sha256 !== contentSha
    || recordSha !== filenameId || recordDigest(authenticated) !== recordSha) {
    throw new Error("invalid_stored_continuation_audit");
  }
  return parsed.data;
}

async function readRecordsUnlocked(root: string): Promise<ContinuationAuditRecord[]> {
  await assertSafeAuditTree(root);
  const dir = recordsDirectory(root);
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? [] : Promise.reject(error));
  const records: ContinuationAuditRecord[] = [];
  const auditIds = new Set<string>();
  for (const name of names.sort()) {
    await assertSafeContinuationStoragePath(root, path.join(dir, name), "file", AUDIT_PATH_FAILURE);
    if (name.endsWith(".tmp")) continue;
    if (!/^[0-9a-f]{64}\.json$/.test(name)) throw new Error("invalid_stored_continuation_audit");
    const record = storedRecord(await readJsonIfExists<unknown>(path.join(dir, name)), name.slice(0, -5));
    if (auditIds.has(record.audit_id)) throw new Error("invalid_stored_continuation_audit");
    auditIds.add(record.audit_id);
    records.push(record);
  }
  return records;
}

function projectionOf(records: ContinuationAuditRecord[]): ContinuationAuditProjection {
  return ContinuationAuditProjectionSchema.parse({
    schema_version: 1,
    rebuilt_at: records.at(-1)?.recorded_at ?? "1970-01-01T00:00:00.000Z",
    records,
  });
}

async function writeTextAtomic(root: string, file: string, data: string): Promise<void> {
  await assertSafeContinuationStoragePath(root, file, "file", AUDIT_PATH_FAILURE);
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await assertSafeContinuationStoragePath(root, tmp, "any", AUDIT_PATH_FAILURE);
  try {
    await fs.writeFile(tmp, data, "utf8");
    await assertSafeContinuationStoragePath(root, file, "file", AUDIT_PATH_FAILURE);
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, { force: true });
  }
}

async function rebuildProjectionUnlocked(root: string, fault?: ContinuationAuditDeps["auditFault"]): Promise<ContinuationAuditProjection> {
  await fault?.("before_projection_rebuild");
  await ensureSafeAuditDirectories(root);
  const projection = projectionOf(await readRecordsUnlocked(root));
  await assertSafeContinuationStoragePath(root, indexFile(root), "file", AUDIT_PATH_FAILURE);
  await writeJsonAtomic(indexFile(root), projection);
  await fault?.("after_index_projection_write");
  await writeTextAtomic(root, jsonlFile(root), projection.records.map((record) => JSON.stringify(record)).join("\n") + (projection.records.length ? "\n" : ""));
  await fault?.("after_projection_rebuild");
  return projection;
}

function assertAuditHasNoSecrets(result: ContinuationFinalizerResult, policy: ContinuationAuditPolicy): void {
  for (const [index, item] of result.items.entries()) {
    assertNoSecrets(Object.fromEntries(Object.entries(item).map(([field, value]) => [`item_${index}_${field}`, value])));
  }
  assertNoSecrets(Object.fromEntries(result.reasons.map((reason, index) => [`reason_${index}`, reason])));
  assertNoSecrets(Object.fromEntries(policy.reasons.map((reason, index) => [`policy_reason_${index}`, reason])));
  policy.trace.stages.forEach((stage, index) => assertNoSecrets({
    [`policy_stage_reason_${index}`]: stage.reason,
    [`policy_stage_evidence_${index}`]: stage.evidence_reference,
  }));
  assertNoSecrets(Object.fromEntries(policy.trace.required_capabilities.map((capability, index) =>
    [`policy_required_capability_${index}`, capability])));
  policy.trace.model_roster.forEach((model, index) => assertNoSecrets({
    [`policy_model_${index}`]: model.model_id,
    [`policy_tier_${index}`]: model.tier,
    ...Object.fromEntries(model.capabilities.map((capability, capabilityIndex) =>
      [`policy_capability_${index}_${capabilityIndex}`, capability])),
  }));
  policy.trace.model_invocations.forEach((invocation, index) => assertNoSecrets({
    [`policy_invocation_role_${index}`]: invocation.role,
    [`policy_invocation_model_${index}`]: invocation.model_id,
    ...Object.fromEntries(invocation.required_capabilities.map((capability, capabilityIndex) =>
      [`policy_invocation_capability_${index}_${capabilityIndex}`, capability])),
  }));
}

export interface ContinuationPolicyFailurePair {
  policy_failure_id: string;
  correction_reservation_id: string;
}

/** Pure P4-D identity builder shared by persistence and closure enforcement. */
export function buildContinuationPolicyFailurePair(
  responseText: string,
  policy: ExecutionPolicyResult,
  context: ContinuationAuditContext,
): ContinuationPolicyFailurePair {
  if (policy.verdict !== "FAIL") throw new Error("passing_policy_has_no_failure_pair");
  const policyFailureId = sha(JSON.stringify({
    schema_version: 1,
    response_sha256: sha(responseText),
    parent_sha256: sha(context.parentId),
    run_sha256: sha(context.runId),
    session_sha256: sha(context.sessionId),
    reasons: policy.reasons,
  }));
  return {
    policy_failure_id: policyFailureId,
    correction_reservation_id: sha(`continuation-policy-correction:${policyFailureId}`),
  };
}

function auditedPolicy(
  responseText: string,
  policy: ExecutionPolicyResult,
  context: ContinuationAuditContext,
  records: ContinuationAuditRecord[],
): ContinuationAuditPolicy {
  if (policy.verdict === "PASS") return { ...policy };
  const pair = buildContinuationPolicyFailurePair(responseText, policy, context);
  const failureId = pair.policy_failure_id;
  const prior = records.find((record) => record.schema_version === 2 && record.policy.policy_failure_id === failureId);
  return ContinuationAuditPolicySchema.parse({
    ...policy,
    policy_failure_id: failureId,
    correction_reservation_id: prior?.schema_version === 2
      ? prior.policy.correction_reservation_id
      : pair.correction_reservation_id,
  });
}

function buildRecord(
  responseText: string,
  result: ContinuationFinalizerResult,
  policy: ContinuationAuditPolicy,
  context: ContinuationAuditContext,
  recordedAt: string,
): ContinuationAuditRecord {
  assertAuditHasNoSecrets(result, policy);
  const evidence = [...new Set(result.items.flatMap((item) =>
    [item.evidence, item.monitoring_reference].filter((value): value is string => Boolean(value))))];
  const content = ContinuationAuditContentSchema.parse({
    schema_version: 2,
    response_sha256: sha(responseText),
    items: result.items,
    evidence_reference_ids: evidence,
    verdict: result.status,
    reasons: result.reasons,
    policy,
    surface: context.surface,
    mode: context.mode,
    parent_sha256: sha(context.parentId),
    run_sha256: sha(context.runId),
    session_sha256: sha(context.sessionId),
  });
  const contentSha = contentDigest(content);
  const authenticated = {
    ...content,
    audit_id: contentSha,
    content_sha256: contentSha,
    recorded_at: recordedAt,
  };
  return ContinuationAuditRecordSchema.parse({
    ...authenticated,
    record_sha256: recordDigest(authenticated),
  });
}

export async function readContinuationAudits(root: string): Promise<ContinuationAuditRecord[]> {
  return readRecordsUnlocked(root);
}

export async function rebuildContinuationAuditProjection(
  root: string,
  deps: Pick<ContinuationAuditDeps, "auditFault"> & CoordinationDeps = {},
): Promise<ContinuationAuditProjection> {
  await assertSafeContinuationLeaseTree(root, "continuation-audits", AUDIT_PATH_FAILURE);
  return withCoordinationLease(root, "continuation-audits", () => rebuildProjectionUnlocked(root, deps.auditFault), deps);
}

export async function persistContinuationAudit(
  responseText: string,
  result: ContinuationFinalizerResult,
  context: ContinuationAuditContext,
  deps: Pick<ContinuationAuditDeps, "auditFault"> & CoordinationDeps = {},
  evaluatedPolicy: ExecutionPolicyResult = evaluateExecutionPolicy(context.executionPolicy ?? defaultExecutionPolicy()),
): Promise<ContinuationAuditRecord> {
  await assertSafeContinuationLeaseTree(context.root, "continuation-audits", AUDIT_PATH_FAILURE);
  return withCoordinationLease(context.root, "continuation-audits", async () => {
    await ensureSafeAuditDirectories(context.root);
    const records = await readRecordsUnlocked(context.root);
    const policy = auditedPolicy(responseText, evaluatedPolicy, context, records);
    const record = buildRecord(
      responseText,
      result,
      policy,
      context,
      (deps.now ?? (() => new Date().toISOString()))(),
    );
    const file = path.join(recordsDirectory(context.root), `${record.record_sha256}.json`);
    const existing = records.find((candidate) => candidate.audit_id === record.audit_id);
    if (existing) {
      await rebuildProjectionUnlocked(context.root, deps.auditFault);
      return existing;
    }
    await deps.auditFault?.("before_record_write");
    await assertSafeContinuationStoragePath(context.root, file, "file", AUDIT_PATH_FAILURE);
    await writeJsonAtomic(file, record);
    await deps.auditFault?.("after_record_write");
    await assertSafeContinuationStoragePath(context.root, file, "file", AUDIT_PATH_FAILURE);
    const authoritative = storedRecord(await readJsonIfExists<unknown>(file), record.record_sha256);
    await rebuildProjectionUnlocked(context.root, deps.auditFault);
    return authoritative;
  }, deps);
}

/** Live validation plus fail-closed authoritative audit persistence. */
export async function finalizeContinuationLedgerLiveAudited(
  responseText: string,
  context: ContinuationAuditContext,
  deps: ContinuationAuditDeps,
): Promise<ContinuationFinalizerResult> {
  const validation = await finalizeContinuationLedgerLive(responseText, context, deps);
  const policy = evaluateExecutionPolicy(context.executionPolicy ?? defaultExecutionPolicy());
  const result: ContinuationFinalizerResult = {
    ...validation,
    status: validation.status === "FAIL" || policy.verdict === "FAIL" ? "FAIL" : "PASS",
    reasons: [...validation.reasons, ...policy.reasons],
  };
  try {
    await persistContinuationAudit(responseText, result, context, deps, policy);
    return result;
  } catch {
    return {
      ...result,
      status: "FAIL",
      reasons: result.reasons.includes("AUDIT_PERSISTENCE_FAILED")
        ? result.reasons
        : [...result.reasons, "AUDIT_PERSISTENCE_FAILED"],
    };
  }
}

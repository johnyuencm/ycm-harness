import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, createPublicKey, verify } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import type { Stats } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  buildContinuationPolicyFailurePair,
  finalizeContinuationLedgerLiveAudited,
  readContinuationAudits,
  type ContinuationAuditContext,
  type ContinuationAuditRecord,
} from "../continuation/audit.js";
import {
  evaluateExecutionPolicy,
  type ExecutionPolicyInput,
  type ExecutionPolicyResult,
} from "../continuation/cost-policy.js";
import type { ContinuationFinalizerResult, LiveTicketProof } from "../continuation/finalizer.js";
import {
  assertSafeContinuationLeaseTree,
  assertSafeContinuationStoragePath,
} from "../continuation/storage-safety.js";
import { providerForState } from "../tickets/provider.js";
import { HarnessStore } from "../state/store.js";
import {
  ensureContinuation,
  resolveHarnessGoal,
  withCoordinationLease,
  type CoordinationDeps,
} from "./coordination.js";
import { readMutationProofs } from "./mutation-proof.js";

export type StrategicReviewOperation = "evaluate" | "status" | "replay";
export type StrategicReviewMode = "normal" | "bounded_snapshot";
export type StrategicReviewEvidenceClass = "FACT" | "INFERENCE" | "UNKNOWN" | "UNAVAILABLE";
export type StrategicReviewCommitmentStatus = "confirmed" | "contradicted" | "unresolved";
export type StrategicReviewLane = "NOW" | "NEXT" | "LATER";

export interface StrategicReviewEvidenceReference {
  id: string;
  role: string;
  classification: StrategicReviewEvidenceClass;
  source: string;
  observed_at: string;
  digest?: string;
  supports?: string[];
  finding_id?: string;
}

export interface StrategicReviewLaneItem {
  finding_id: string;
  action: string;
  evidence: string[];
  disposition: "TRACKED" | "MUTATED" | "MONITORING ONLY";
  ticket_id?: string;
  independent_action?: boolean;
}

export interface StrategicReviewFinding {
  id: string;
  material: boolean;
  defect_type: "product" | "reviewer" | "measurement";
  domain: string;
  owner: string;
  control: string;
  recurrence_count: number;
  recurrence_threshold?: number;
  symptoms: string[];
  root_cause?: string;
  prevention?: string;
  postcondition?: string;
  safety_net?: string;
  indicator?: string;
  counter_failure?: string;
  evidence_horizon?: string;
  rollback?: string;
  evidence: string[];
}

export interface StrategicReviewAnalysis {
  prior_commitments: Array<{
    id: string;
    status: StrategicReviewCommitmentStatus;
    evidence: string[];
  }>;
  user_feedback: Array<{
    id: string;
    priority: number;
    correction: boolean;
    evidence: string[];
  }>;
  recurrence: {
    seven_day: string[];
    thirty_day: string[];
  };
  reviewer_self_correction: {
    defect_type: "reviewer" | "measurement";
    description: string;
    evidence: string[];
  };
  findings: StrategicReviewFinding[];
  lanes: Record<StrategicReviewLane, StrategicReviewLaneItem[]>;
}

export interface StrategicReviewContinuationInput {
  parent_id: string;
  run_id: string;
  session_id: string;
  response_text: string;
  tickets: Record<string, LiveTicketProof>;
  mutations: unknown[];
}

export interface StrategicReviewIntegrityFollowUp {
  operation: "create_or_reuse";
  stable_key: string;
  finding_id: string;
  ticket_id: string;
  evidence_reference_id: string;
}

export interface StrategicReviewIntegrityInput {
  observed_source_ownership_sha256: string;
  follow_up?: StrategicReviewIntegrityFollowUp;
}

export type StrategicReviewIntegrityDisposition =
  | {
      verdict: "CLEAN";
      expected_source_ownership_sha256: string;
      observed_source_ownership_sha256: string;
    }
  | {
      verdict: "DRIFT_TRACKED";
      expected_source_ownership_sha256: string;
      observed_source_ownership_sha256: string;
      follow_up: StrategicReviewIntegrityFollowUp & { proof_sha256: string };
    };

export interface StrategicReviewEvidenceOrigin {
  origin_id: string;
  record_id: string;
}

export interface StrategicReviewAuthenticatedEvidence {
  origin_id: string;
  record_id: string;
  record_sha256: string;
}

export interface StrategicReviewRequest {
  cwd: string;
  operation: StrategicReviewOperation;
  goal_id?: string;
  report_id?: string;
  profile: string;
  mode: StrategicReviewMode;
  producer: {
    id: string;
    slot: string;
  };
  authority: {
    installation_id: string;
    profile: string;
    domain: string;
    proof: string;
  };
  evidence_origin: StrategicReviewEvidenceOrigin;
  evidence: {
    maximum_references: number;
    references: StrategicReviewEvidenceReference[];
  };
  analysis?: StrategicReviewAnalysis;
  resource_stewardship?: {
    execution_policy: ExecutionPolicyInput;
  };
  continuation?: StrategicReviewContinuationInput;
  integrity?: StrategicReviewIntegrityInput;
}

export interface StrategicReviewFailure {
  ok: false;
  status: "PARTIAL" | "BLOCKED";
  reason: string;
  reasons?: string[];
  policy_failure_id?: string;
  correction_reservation_id?: string;
  mutation_count: 0;
}

export interface StrategicReviewSnapshotReport {
  schema_version: 1;
  profile: string;
  mode: "bounded_snapshot";
  authenticated_evidence: StrategicReviewAuthenticatedEvidence;
  evidence: {
    maximum_references: number;
    references: StrategicReviewEvidenceReference[];
  };
  exemptions: ["durable_tracking", "closed_loop_action", "mutation"];
}

export interface StrategicReviewSnapshotSuccess {
  ok: true;
  status: "SNAPSHOT";
  report_id: string;
  report_sha256: string;
  report_bytes: string;
  report: StrategicReviewSnapshotReport;
  mutation_count: 0;
}

export interface StrategicReviewNormalReport {
  schema_version: 1;
  profile: string;
  mode: "normal";
  producer: StrategicReviewRequest["producer"];
  authority: StrategicReviewRequest["authority"];
  authenticated_evidence: StrategicReviewAuthenticatedEvidence;
  evidence: StrategicReviewRequest["evidence"];
  findings: StrategicReviewFinding[];
  lanes: StrategicReviewAnalysis["lanes"];
  obligations: Array<{ id: string; status: "PASS" }>;
  resource_stewardship: ExecutionPolicyResult;
  continuation: ContinuationFinalizerResult;
  integrity: StrategicReviewIntegrityDisposition;
}

export interface StrategicReviewNormalSuccess {
  ok: true;
  status: "PASS";
  report_id: string;
  report_sha256: string;
  report_bytes: string;
  storage_reference: string;
  report: StrategicReviewNormalReport;
  mutation_count: 0;
}

export interface StrategicReviewStatusSuccess {
  ok: true;
  status: "PASS";
  receipt: {
    schema_version: 1;
    report_id: string;
    report_sha256: string;
    profile: string;
    mode: "normal";
    report_status: "PASS";
    storage_reference: string;
  };
  mutation_count: 0;
}

export type StrategicReviewResult =
  | StrategicReviewFailure
  | StrategicReviewSnapshotSuccess
  | StrategicReviewNormalSuccess
  | StrategicReviewStatusSuccess;

const T62_EXPECTED_SOURCE_OWNERSHIP_SHA256 = "adb8194210f21feda5386ab9c830739e2914568da38393276910648c718b72f0";

const INSTALLED_PROFILES = new Map([
  ["pm-17:00", { domain: "product-management", recurrenceThreshold: 2 }],
  ["nightly-workspace", { domain: "workspace", recurrenceThreshold: 2 }],
  ["operations-cron-output", { domain: "operations", recurrenceThreshold: 2 }],
  ["optional-domain", { domain: "optional-domain", recurrenceThreshold: 2 }],
]);

/** Installation-owned enrolled profile lookup reused by strategic action authority checks. */
export function installedStrategicReviewProfile(profile: string): { domain: string; recurrenceThreshold: number } | undefined {
  return INSTALLED_PROFILES.get(profile);
}
const SAFE_REVIEW_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const REVIEW_MANIFEST_NAME = "strategic-review-origins.json";
const MAX_REVIEW_MANIFEST_BYTES = 64 * 1024;
const MAX_REVIEW_RECORD_BYTES = 256 * 1024;
const MAX_REVIEW_SIGNATURE_BYTES = 1024;
const MAX_PLUGIN_MARKER_BYTES = 16 * 1024;

const StrategicReviewEvidenceOriginSchema = z.object({
  origin_id: z.string().regex(SAFE_REVIEW_REF),
  record_id: z.string().regex(SAFE_REVIEW_REF),
}).strict();

const StrategicReviewEvidenceReferenceSchema = z.object({
  id: z.string().min(1).max(4096),
  role: z.string().min(1).max(256),
  classification: z.enum(["FACT", "INFERENCE", "UNKNOWN", "UNAVAILABLE"]),
  source: z.string().min(1).max(4096),
  observed_at: z.string().datetime(),
  digest: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  supports: z.array(z.string().min(1).max(4096)).max(128).optional(),
  finding_id: z.string().min(1).max(4096).optional(),
}).strict();

const StrategicReviewEvidenceManifestSchema = z.object({
  maximum_references: z.number().int().min(0).max(128),
  references: z.array(StrategicReviewEvidenceReferenceSchema).max(128),
}).strict();

const StrategicReviewInstalledProfileSchema = z.object({
  profile: z.string().regex(SAFE_REVIEW_REF),
  domain: z.string().min(1).max(256),
  proof: z.string().min(1).max(4096),
  recurrence_threshold: z.number().int().positive().max(1000),
}).strict();

const StrategicReviewOriginSchema = z.object({
  origin_id: z.string().regex(SAFE_REVIEW_REF),
  record_root: z.string().min(1).max(4096).refine((value) => path.isAbsolute(value), "record root must be absolute"),
  key_id: z.string().regex(SAFE_REVIEW_REF),
  public_key_pem: z.string().min(1).max(8192).refine((value) =>
    value.startsWith("-----BEGIN PUBLIC KEY-----\n") && value.trimEnd().endsWith("-----END PUBLIC KEY-----"),
  "public key must be PEM SPKI"),
  profiles: z.array(StrategicReviewInstalledProfileSchema).max(32),
}).strict().superRefine((value, context) => {
  const profiles = value.profiles.map(({ profile }) => profile);
  if (new Set(profiles).size !== profiles.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "installed review profiles must be unique" });
  }
});

const StrategicReviewInstallationManifestSchema = z.object({
  schema_version: z.literal(1),
  origins: z.array(StrategicReviewOriginSchema).max(32),
}).strict().superRefine((value, context) => {
  const origins = value.origins.map(({ origin_id }) => origin_id);
  if (new Set(origins).size !== origins.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "review origin ids must be unique" });
  }
});

const StrategicReviewEvidenceRecordSchema = z.object({
  schema_version: z.literal(1),
  origin_id: z.string().regex(SAFE_REVIEW_REF),
  record_id: z.string().regex(SAFE_REVIEW_REF),
  key_id: z.string().regex(SAFE_REVIEW_REF),
  installation_id: z.string().min(1).max(4096),
  profile: z.string().regex(SAFE_REVIEW_REF),
  domain: z.string().min(1).max(256),
  evidence: StrategicReviewEvidenceManifestSchema,
}).strict();

const StrategicReviewPluginMarkerSchema = z.object({
  name: z.literal("ycm-harness"),
  displayName: z.string().min(1).max(256),
  description: z.string().min(1).max(2048),
  version: z.string().min(1).max(64),
  license: z.string().min(1).max(64),
  skills: z.literal("./skills/"),
  hooks: z.literal("./hooks/hooks-cursor.json"),
}).strict();

interface StrategicReviewFileIdentity {
  dev: number;
  ino: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
}

interface StrategicReviewRuntimeDependencies {
  installationRoot: () => Promise<string>;
  coordination: CoordinationDeps;
  ticketProviderForState: typeof providerForState;
}

interface TrustedStrategicReviewEvidence {
  authority: {
    installation_id: string;
    profile: string;
    domain: string;
    proof: string;
  };
  profile: {
    recurrence_threshold: number;
  };
  evidence: StrategicReviewRequest["evidence"];
  authenticated_evidence: StrategicReviewAuthenticatedEvidence;
}

type StrategicReviewEvidenceRead =
  | { kind: "trusted"; value: TrustedStrategicReviewEvidence }
  | { kind: "profile_missing" }
  | { kind: "evidence_missing" };

class StrategicReviewInstallationError extends Error {}

const strategicReviewTestDependencies = new AsyncLocalStorage<Partial<StrategicReviewRuntimeDependencies>>();

/** @internal Production-shaped dependency wrapper for public-seam tests only. */
export async function withStrategicReviewTestDependencies<T>(
  dependencies: Partial<StrategicReviewRuntimeDependencies>,
  operation: () => Promise<T>,
): Promise<T> {
  return strategicReviewTestDependencies.run(dependencies, operation);
}

function strategicReviewFileIdentity(stat: Stats): StrategicReviewFileIdentity {
  return {
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
  };
}

function sameStrategicReviewFile(left: StrategicReviewFileIdentity, right: StrategicReviewFileIdentity): boolean {
  // Windows Node reports lstat().dev as 0 while fstat()/handle.stat() returns the real volume id.
  const sameDev = left.dev === right.dev
    || (process.platform === "win32" && (left.dev === 0 || right.dev === 0));
  return sameDev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

async function safeStrategicReviewDirectory(directory: string): Promise<boolean> {
  if (!path.isAbsolute(directory)) throw new StrategicReviewInstallationError("installation path is not absolute");
  const parsed = path.parse(path.resolve(directory));
  let current = parsed.root;
  for (const segment of path.resolve(directory).slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat: Stats;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw new StrategicReviewInstallationError("installation directory is unreadable");
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new StrategicReviewInstallationError("installation directory is unsafe");
    }
  }
  return true;
}

async function readBoundedStrategicReviewFile(file: string, maximumBytes: number): Promise<Buffer | undefined> {
  if (!await safeStrategicReviewDirectory(path.dirname(file))) return undefined;
  let before: Stats;
  try {
    before = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new StrategicReviewInstallationError("installation file is unreadable");
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > maximumBytes) {
    throw new StrategicReviewInstallationError("installation file is unsafe");
  }

  let handle: Awaited<ReturnType<typeof fs.open>>;
  try {
    handle = await fs.open(file, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch {
    throw new StrategicReviewInstallationError("installation file cannot be opened safely");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameStrategicReviewFile(strategicReviewFileIdentity(before), strategicReviewFileIdentity(opened))) {
      throw new StrategicReviewInstallationError("installation file changed before read");
    }
    const raw = await handle.readFile();
    const after = await handle.stat();
    if (raw.byteLength !== before.size || raw.byteLength > maximumBytes
      || !sameStrategicReviewFile(strategicReviewFileIdentity(opened), strategicReviewFileIdentity(after))) {
      throw new StrategicReviewInstallationError("installation file changed during read");
    }
    const final = await fs.lstat(file);
    if (!sameStrategicReviewFile(strategicReviewFileIdentity(after), strategicReviewFileIdentity(final))) {
      throw new StrategicReviewInstallationError("installation file changed after read");
    }
    return raw;
  } finally {
    await handle.close();
  }
}

function parseStrategicReviewJson(raw: Buffer, label: string): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    throw new StrategicReviewInstallationError(`${label} is not UTF-8`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new StrategicReviewInstallationError(`${label} is not JSON`);
  }
}

function decodeStrategicReviewSignature(raw: Buffer): Buffer {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw).trim();
  } catch {
    throw new StrategicReviewInstallationError("evidence signature is not UTF-8 base64");
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(text)) {
    throw new StrategicReviewInstallationError("evidence signature is not canonical base64");
  }
  const signature = Buffer.from(text, "base64");
  if (signature.byteLength !== 64 || signature.toString("base64") !== text) {
    throw new StrategicReviewInstallationError("evidence signature is not Ed25519 output");
  }
  return signature;
}

async function nearestStrategicReviewPackageRoot(moduleFile: string): Promise<string> {
  let current = path.dirname(moduleFile);
  for (;;) {
    try {
      const stat = await fs.lstat(path.join(current, "package.json"));
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new StrategicReviewInstallationError("runtime package marker is unsafe");
      }
      return current;
    } catch (error) {
      if (error instanceof StrategicReviewInstallationError) throw error;
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new StrategicReviewInstallationError("runtime package root cannot be authenticated");
      }
    }
    const parent = path.dirname(current);
    if (parent === current) throw new StrategicReviewInstallationError("runtime has no package root");
    current = parent;
  }
}

async function fixedStrategicReviewInstallationRoot(): Promise<string> {
  const packageRoot = await nearestStrategicReviewPackageRoot(fileURLToPath(import.meta.url));
  const parent = path.dirname(packageRoot);
  const markerRaw = await readBoundedStrategicReviewFile(
    path.join(parent, ".cursor-plugin", "plugin.json"),
    MAX_PLUGIN_MARKER_BYTES,
  );
  if (markerRaw) {
    const marker = StrategicReviewPluginMarkerSchema.safeParse(parseStrategicReviewJson(markerRaw, "plugin marker"));
    if (!marker.success) throw new StrategicReviewInstallationError("plugin marker is malformed");
    return parent;
  }
  const sourcePlugin = path.join(packageRoot, "plugin");
  if (!await safeStrategicReviewDirectory(sourcePlugin)) {
    throw new StrategicReviewInstallationError("source plugin root is unavailable");
  }
  return sourcePlugin;
}

async function readStrategicReviewInstallationEvidence(
  selectorInput: StrategicReviewEvidenceOrigin,
  installationRoot: string,
): Promise<StrategicReviewEvidenceRead> {
  const selector = StrategicReviewEvidenceOriginSchema.safeParse(selectorInput);
  if (!selector.success) return { kind: "profile_missing" };
  if (!await safeStrategicReviewDirectory(installationRoot)) {
    throw new StrategicReviewInstallationError("installation root is unavailable");
  }
  const manifestRaw = await readBoundedStrategicReviewFile(
    path.join(installationRoot, "config", REVIEW_MANIFEST_NAME),
    MAX_REVIEW_MANIFEST_BYTES,
  );
  if (!manifestRaw) return { kind: "profile_missing" };
  const manifest = StrategicReviewInstallationManifestSchema.safeParse(
    parseStrategicReviewJson(manifestRaw, "review installation manifest"),
  );
  if (!manifest.success) throw new StrategicReviewInstallationError("review installation manifest is malformed");
  const origin = manifest.data.origins.find((candidate) => candidate.origin_id === selector.data.origin_id);
  if (!origin) return { kind: "profile_missing" };

  if (!await safeStrategicReviewDirectory(origin.record_root)) {
    throw new StrategicReviewInstallationError("review evidence record root is unavailable");
  }
  const recordRaw = await readBoundedStrategicReviewFile(
    path.join(origin.record_root, `${selector.data.record_id}.json`),
    MAX_REVIEW_RECORD_BYTES,
  );
  if (!recordRaw) return { kind: "evidence_missing" };
  const signatureRaw = await readBoundedStrategicReviewFile(
    path.join(origin.record_root, `${selector.data.record_id}.sig`),
    MAX_REVIEW_SIGNATURE_BYTES,
  );
  if (!signatureRaw) throw new StrategicReviewInstallationError("review evidence signature is missing");
  let key: ReturnType<typeof createPublicKey>;
  try {
    key = createPublicKey(origin.public_key_pem);
  } catch {
    throw new StrategicReviewInstallationError("review evidence public key is invalid");
  }
  if (key.asymmetricKeyType !== "ed25519") {
    throw new StrategicReviewInstallationError("review evidence key is not Ed25519");
  }
  if (!verify(null, recordRaw, key, decodeStrategicReviewSignature(signatureRaw))) {
    throw new StrategicReviewInstallationError("review evidence signature verification failed");
  }
  const record = StrategicReviewEvidenceRecordSchema.safeParse(
    parseStrategicReviewJson(recordRaw, "review evidence record"),
  );
  if (!record.success) throw new StrategicReviewInstallationError("review evidence record is malformed");
  const installedProfile = origin.profiles.find((candidate) => candidate.profile === record.data.profile);
  if (!installedProfile) return { kind: "profile_missing" };
  if (record.data.origin_id !== selector.data.origin_id
    || record.data.record_id !== selector.data.record_id
    || record.data.key_id !== origin.key_id
    || record.data.domain !== installedProfile.domain) {
    throw new StrategicReviewInstallationError("signed review evidence does not match its origin");
  }
  return {
    kind: "trusted",
    value: {
      authority: {
        installation_id: record.data.installation_id,
        profile: record.data.profile,
        domain: record.data.domain,
        proof: installedProfile.proof,
      },
      profile: { recurrence_threshold: installedProfile.recurrence_threshold },
      evidence: record.data.evidence,
      authenticated_evidence: {
        origin_id: record.data.origin_id,
        record_id: record.data.record_id,
        record_sha256: createHash("sha256").update(recordRaw).digest("hex"),
      },
    },
  };
}

const ROOT_CAUSE_FIELDS = [
  "root_cause",
  "prevention",
  "postcondition",
  "safety_net",
  "indicator",
  "counter_failure",
  "evidence_horizon",
  "rollback",
] as const;
const EVIDENCE_CLASSES = new Set<StrategicReviewEvidenceClass>([
  "FACT",
  "INFERENCE",
  "UNKNOWN",
  "UNAVAILABLE",
]);
const COMMITMENT_STATUSES = new Set<StrategicReviewCommitmentStatus>([
  "confirmed",
  "contradicted",
  "unresolved",
]);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function bytesDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function authenticateStrategicReviewRequest(
  request: StrategicReviewRequest,
): Promise<TrustedStrategicReviewEvidence | StrategicReviewFailure> {
  const dependencies = strategicReviewTestDependencies.getStore();
  try {
    const installationRoot = await (dependencies?.installationRoot ?? fixedStrategicReviewInstallationRoot)();
    const read = await readStrategicReviewInstallationEvidence(request.evidence_origin, installationRoot);
    if (read.kind === "profile_missing") {
      return request.profile === "optional-domain"
        ? failure("PROFILE_NOT_AUTHORIZED")
        : failure("EVIDENCE_UNAVAILABLE", "PARTIAL");
    }
    if (read.kind === "evidence_missing") return failure("EVIDENCE_UNAVAILABLE", "PARTIAL");
    if (canonicalJson(read.value.authority) !== canonicalJson(request.authority)) {
      return failure("PROFILE_AUTHORITY_EXPANSION");
    }
    if (canonicalJson(read.value.evidence) !== canonicalJson(request.evidence)) {
      return failure("EVIDENCE_UNAVAILABLE", "PARTIAL");
    }
    return read.value;
  } catch {
    return failure("REVIEW_INTEGRITY_FAILURE");
  }
}

function snapshotResult(
  request: StrategicReviewRequest,
  report: StrategicReviewSnapshotReport,
): StrategicReviewSnapshotSuccess {
  const canonicalRequestSha256 = digest({
    schema_version: 1,
    goal_id: request.goal_id,
    profile: request.profile,
    mode: request.mode,
    producer: request.producer,
    authority: request.authority,
    evidence_origin: request.evidence_origin,
    evidence: request.evidence,
  });
  const reportSha256 = bytesDigest(canonicalJson(report));
  const reportId = `review-${digest({ canonical_request_sha256: canonicalRequestSha256, report_sha256: reportSha256 })}`;
  const reportBytes = `${canonicalJson({
    schema_version: 1,
    report_id: reportId,
    canonical_request_sha256: canonicalRequestSha256,
    report_sha256: reportSha256,
    report,
  })}\n`;
  return {
    ok: true,
    status: "SNAPSHOT",
    report_id: reportId,
    report_sha256: reportSha256,
    report_bytes: reportBytes,
    report,
    mutation_count: 0,
  };
}

function canonicalReviewInput(request: StrategicReviewRequest, policy: ExecutionPolicyResult): unknown {
  return {
    schema_version: 1,
    goal_id: request.goal_id,
    profile: request.profile,
    mode: request.mode,
    producer: request.producer,
    authority: request.authority,
    evidence_origin: request.evidence_origin,
    evidence: request.evidence,
    analysis: request.analysis,
    policy: policy.trace,
    continuation: request.continuation,
    integrity: request.integrity,
  };
}

interface StoredStrategicReviewRecord {
  schema_version: 1;
  report_id: string;
  canonical_request_sha256: string;
  report_sha256: string;
  report: StrategicReviewNormalReport;
}

const StoredStrategicReviewRecordSchema = z.object({
  schema_version: z.literal(1),
  report_id: z.string().regex(/^review-[a-f0-9]{64}$/),
  canonical_request_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  report_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  report: z.unknown(),
}).strict();

class StrategicReviewReadError extends Error {
  constructor(readonly reason: string) {
    super(reason);
  }
}

async function persistNormalReport(
  request: StrategicReviewRequest,
  report: StrategicReviewNormalReport,
  policy: ExecutionPolicyResult,
): Promise<Omit<StrategicReviewNormalSuccess, "ok" | "status" | "report" | "mutation_count">> {
  const canonicalRequestSha256 = digest(canonicalReviewInput(request, policy));
  const protectedReportBytes = canonicalJson(report);
  const reportSha256 = bytesDigest(protectedReportBytes);
  const reportId = `review-${digest({ canonical_request_sha256: canonicalRequestSha256, report_sha256: reportSha256 })}`;
  const storageReference = `.ycm-harness/autonomy/strategic-reviews/reports/${reportId}.json`;
  const reportsRoot = path.join(request.cwd, ".ycm-harness", "autonomy", "strategic-reviews", "reports");
  const target = path.join(request.cwd, ...storageReference.split("/"));
  const record = {
    schema_version: 1,
    report_id: reportId,
    canonical_request_sha256: canonicalRequestSha256,
    report_sha256: reportSha256,
    report,
  };
  const reportBytes = `${canonicalJson(record)}\n`;
  const leaseKey = `review-${reportId.slice(-48)}`;

  await assertSafeContinuationLeaseTree(request.cwd, leaseKey, "REVIEW_INTEGRITY_FAILURE");
  return withCoordinationLease(request.cwd, leaseKey, async () => {
    await assertSafeContinuationStoragePath(request.cwd, path.join(request.cwd, ".ycm-harness"), "directory", "REVIEW_INTEGRITY_FAILURE");
    await assertSafeContinuationStoragePath(request.cwd, path.join(request.cwd, ".ycm-harness", "autonomy"), "directory", "REVIEW_INTEGRITY_FAILURE");
    await assertSafeContinuationStoragePath(request.cwd, path.join(request.cwd, ".ycm-harness", "autonomy", "strategic-reviews"), "directory", "REVIEW_INTEGRITY_FAILURE");
    await assertSafeContinuationStoragePath(request.cwd, reportsRoot, "directory", "REVIEW_INTEGRITY_FAILURE");
    await assertSafeContinuationStoragePath(request.cwd, target, "file", "REVIEW_INTEGRITY_FAILURE");
    await fs.mkdir(reportsRoot, { recursive: true });
    await assertSafeContinuationStoragePath(request.cwd, target, "file", "REVIEW_INTEGRITY_FAILURE");

    let existing: string | undefined;
    try {
      existing = await fs.readFile(target, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (existing !== undefined && existing !== reportBytes) throw new Error("REVIEW_INTEGRITY_FAILURE");
    if (existing === undefined) {
      const temporary = `${target}.${process.pid}.tmp`;
      await assertSafeContinuationStoragePath(request.cwd, temporary, "file", "REVIEW_INTEGRITY_FAILURE");
      await fs.writeFile(temporary, reportBytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, target);
    }
    const readback = await fs.readFile(target, "utf8");
    if (readback !== reportBytes) throw new Error("REVIEW_INTEGRITY_FAILURE");
    return {
      report_id: reportId,
      report_sha256: reportSha256,
      report_bytes: readback,
      storage_reference: storageReference,
    };
  });
}

async function loadNormalReport(
  request: StrategicReviewRequest,
  authenticated: TrustedStrategicReviewEvidence,
): Promise<Omit<StrategicReviewNormalSuccess, "ok" | "status" | "mutation_count">> {
  if (!request.report_id || !/^review-[a-f0-9]{64}$/.test(request.report_id)) {
    throw new StrategicReviewReadError("REVIEW_REPLAY_CONFLICT");
  }
  const storageReference = `.ycm-harness/autonomy/strategic-reviews/reports/${request.report_id}.json`;
  const target = path.join(request.cwd, ...storageReference.split("/"));
  await assertSafeContinuationStoragePath(request.cwd, target, "file", "REVIEW_INTEGRITY_FAILURE");
  let reportBytes: string;
  try {
    reportBytes = await fs.readFile(target, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new StrategicReviewReadError("EVIDENCE_UNAVAILABLE");
    }
    throw new StrategicReviewReadError("REVIEW_INTEGRITY_FAILURE");
  }

  let record: StoredStrategicReviewRecord;
  try {
    const parsed = StoredStrategicReviewRecordSchema.safeParse(JSON.parse(reportBytes) as unknown);
    if (!parsed.success) throw new Error("stored report schema is invalid");
    record = parsed.data as StoredStrategicReviewRecord;
  } catch {
    throw new StrategicReviewReadError("REVIEW_INTEGRITY_FAILURE");
  }
  if (
    record.schema_version !== 1
    || record.report_id !== request.report_id
    || record.report?.schema_version !== 1
    || record.report.mode !== "normal"
    || record.report.authority?.profile !== record.report.profile
    || `${canonicalJson(record)}\n` !== reportBytes
  ) throw new StrategicReviewReadError("REVIEW_INTEGRITY_FAILURE");

  const reportSha256 = bytesDigest(canonicalJson(record.report));
  const recomputedId = `review-${digest({
    canonical_request_sha256: record.canonical_request_sha256,
    report_sha256: reportSha256,
  })}`;
  if (record.report_sha256 !== reportSha256 || record.report_id !== recomputedId) {
    throw new StrategicReviewReadError("REVIEW_INTEGRITY_FAILURE");
  }
  if (record.report.profile !== request.profile) {
    throw new StrategicReviewReadError("REVIEW_REPLAY_CONFLICT");
  }
  if (canonicalJson(record.report.authenticated_evidence) !== canonicalJson(authenticated.authenticated_evidence)) {
    throw new StrategicReviewReadError("REVIEW_INTEGRITY_FAILURE");
  }
  if (!request.resource_stewardship) throw new StrategicReviewReadError("REVIEW_REPLAY_CONFLICT");
  const policy = evaluateExecutionPolicy(request.resource_stewardship.execution_policy);
  const expectedCanonicalRequest = digest(canonicalReviewInput(request, policy));
  if (record.canonical_request_sha256 !== expectedCanonicalRequest) {
    throw new StrategicReviewReadError("REVIEW_REPLAY_CONFLICT");
  }
  return {
    report_id: record.report_id,
    report_sha256: record.report_sha256,
    report_bytes: reportBytes,
    storage_reference: storageReference,
    report: record.report,
  };
}

function failure(reason: string, status: "PARTIAL" | "BLOCKED" = "BLOCKED", reasons?: string[]): StrategicReviewFailure {
  return {
    ok: false,
    status,
    reason,
    ...(reasons ? { reasons } : {}),
    mutation_count: 0,
  };
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validEvidence(reference: StrategicReviewEvidenceReference): boolean {
  if (
    !nonEmpty(reference.id)
    || !nonEmpty(reference.role)
    || !EVIDENCE_CLASSES.has(reference.classification)
    || !nonEmpty(reference.source)
    || !nonEmpty(reference.observed_at)
    || Number.isNaN(Date.parse(reference.observed_at))
  ) return false;
  if (reference.classification === "FACT") return /^[a-f0-9]{64}$/i.test(reference.digest ?? "");
  if (reference.classification === "INFERENCE") return Array.isArray(reference.supports) && reference.supports.length > 0;
  return reference.digest === undefined;
}

function evidenceManifestValid(references: StrategicReviewEvidenceReference[]): boolean {
  const ids = new Set(references.map(({ id }) => id));
  if (ids.size !== references.length || !references.every(validEvidence)) return false;
  return references.every((reference) => reference.classification !== "INFERENCE"
    || reference.supports?.every((id) => references.some((candidate) => candidate.id === id && candidate.classification === "FACT")) === true);
}

function referencedEvidenceExists(values: string[], evidenceIds: Set<string>): boolean {
  return values.length > 0 && values.every((value) => evidenceIds.has(value));
}

function rootCauseComplete(finding: StrategicReviewFinding, threshold: number): boolean {
  if (finding.recurrence_count < threshold) return true;
  return finding.symptoms.length > 0
    && ROOT_CAUSE_FIELDS.every((field) => nonEmpty(finding[field]));
}

function lanesMatchAuthenticatedContinuation(
  analysis: StrategicReviewAnalysis,
  continuation: ContinuationFinalizerResult,
  references: StrategicReviewEvidenceReference[],
): boolean {
  const laneItems = Object.entries(analysis.lanes)
    .flatMap(([lane, items]) => items.map((item) => ({ lane, item })));
  if (laneItems.length !== continuation.items.length) return false;
  return laneItems.every(({ lane, item }) => {
    const finding = analysis.findings.find((candidate) => candidate.id === item.finding_id);
    const actionableEvidence = item.evidence.every((evidenceId) => references.some((reference) =>
      reference.id === evidenceId
      && (reference.classification === "FACT" || reference.classification === "INFERENCE")));
    if (!finding || !actionableEvidence || !item.evidence.every((evidenceId) => finding.evidence.includes(evidenceId))) {
      return false;
    }
    const matches = continuation.items.filter((candidate) =>
      candidate.lane === lane
      && candidate.action === item.action
      && candidate.disposition === item.disposition
      && candidate.ticket_id === item.ticket_id
      && item.evidence.includes(candidate.evidence));
    return matches.length === 1;
  });
}

interface PreparedIntegrityCoordination {
  disposition: StrategicReviewIntegrityDisposition;
  parentId: string;
  readTicket: (ticketId: string) => Promise<LiveTicketProof | undefined>;
  readMutations: () => Promise<unknown[]>;
}

function canonicalT62Action(observed: string): string {
  return `Create or reuse T62 source ownership drift follow-up ${observed.slice(0, 12)}`;
}

async function prepareIntegrityCoordination(
  request: StrategicReviewRequest,
): Promise<PreparedIntegrityCoordination | undefined> {
  const observed = request.integrity?.observed_source_ownership_sha256;
  const continuation = request.continuation;
  if (!observed || !/^[a-f0-9]{64}$/.test(observed) || !continuation) return undefined;
  if (observed === T62_EXPECTED_SOURCE_OWNERSHIP_SHA256) {
    if (request.integrity?.follow_up) return undefined;
    return {
      disposition: {
        verdict: "CLEAN",
        expected_source_ownership_sha256: T62_EXPECTED_SOURCE_OWNERSHIP_SHA256,
        observed_source_ownership_sha256: observed,
      },
      parentId: continuation.parent_id,
      readTicket: async (ticketId) => continuation.tickets[ticketId],
      readMutations: async () => continuation.mutations,
    };
  }

  const analysis = request.analysis;
  if (!analysis || !request.goal_id) return undefined;
  const findingId = "t62-source-integrity-drift";
  const evidence = request.evidence.references.filter((reference) =>
    reference.role === "integrity_drift"
    && reference.classification === "FACT"
    && reference.digest === observed
    && reference.finding_id === findingId);
  const finding = analysis.findings.find((candidate) => candidate.id === findingId);
  const laneItems = Object.values(analysis.lanes).flat().filter((item) => item.finding_id === findingId);
  const action = canonicalT62Action(observed);
  if (evidence.length !== 1
    || !finding?.material
    || finding.control !== "phase-source-integrity"
    || !finding.evidence.includes(evidence[0]!.id)
    || laneItems.length !== 1
    || laneItems[0]?.action !== action
    || laneItems[0].disposition !== "TRACKED"
    || !nonEmpty(laneItems[0].ticket_id)
    || !laneItems[0].evidence.includes(evidence[0]!.id)) {
    return undefined;
  }

  const runtime = strategicReviewTestDependencies.getStore();
  const coordination = runtime?.coordination ?? {};
  const resolved = await resolveHarnessGoal(request.cwd, request.goal_id, coordination.gitProbe);
  if (!resolved) return undefined;
  const state = await new HarnessStore(resolved.root).readStateV3();
  const goal = state.goals[resolved.goalId];
  if (!goal) return undefined;
  const parentId = goal.backend.kind === "github"
    ? String(goal.backend.parent_issue_number)
    : goal.backend.kind === "multica"
      ? goal.backend.parent_issue_id
      : goal.id;
  const verified = await ensureContinuation({
    cwd: resolved.root,
    goal: resolved.goalId,
    metadataPolicy: "optional",
    request: {
      title: `T62 source ownership drift ${observed.slice(0, 12)}`,
      source_class: "integrity_drift",
      source: evidence[0]!.source,
      problem: `Observed source ownership differs from the Phase 6 accepted digest at prefix ${observed.slice(0, 12)}.`,
      impact_scope: "Phase 6 source ownership integrity and closeout eligibility.",
      owner_control: "phase-source-integrity",
      acceptance: [action],
      verification: ["Live proof contains the canonical T62 action and authenticated evidence reference."],
      dependencies: ["P1 through P7 source ownership remain explicit."],
      safety_blockers: ["Block Phase 6 close until exact live proof is authenticated."],
      cost_class: "no_agent",
      evidence_horizon: "before-phase-6-close",
      rollback: "Retain the drift record and stop Phase 6 close if live proof cannot be authenticated.",
      status: "todo",
      priority: "medium",
      evidence: [evidence[0]!.id],
    },
  }, coordination);
  if (!verified || laneItems[0].ticket_id !== verified.identifier) return undefined;

  const provider = (runtime?.ticketProviderForState ?? providerForState)(state, resolved.goalId, {
    ...(coordination.runner ? { runner: coordination.runner } : {}),
    ...(coordination.env ? { env: coordination.env } : {}),
  });
  const requestedAt = Date.now();
  const read = await provider.readProof(verified.identifier);
  if (read.kind !== "found") return undefined;
  const proof = read.proof;
  const readbackAt = Date.parse(proof.readback_at);
  if (proof.ticket_id !== verified.identifier
    || proof.configured_parent_id !== parentId
    || proof.parent_id !== parentId
    || !proof.content_strings.includes(action)
    || !proof.content_strings.includes(evidence[0]!.id)
    || Number.isNaN(readbackAt)
    || readbackAt < requestedAt - 1_000
    || readbackAt > Date.now() + 1_000) {
    return undefined;
  }
  const bridgedProof: LiveTicketProof = {
    ...proof,
    evidence_reference_ids: [evidence[0]!.id],
  };
  const proofSha256 = digest({
    ticket_id: bridgedProof.ticket_id,
    configured_parent_id: bridgedProof.configured_parent_id,
    parent_id: bridgedProof.parent_id,
    status: bridgedProof.status,
    content_strings: bridgedProof.content_strings,
    evidence_reference_ids: bridgedProof.evidence_reference_ids,
  });
  return {
    disposition: {
      verdict: "DRIFT_TRACKED",
      expected_source_ownership_sha256: T62_EXPECTED_SOURCE_OWNERSHIP_SHA256,
      observed_source_ownership_sha256: observed,
      follow_up: {
        operation: "create_or_reuse",
        stable_key: verified.key,
        finding_id: findingId,
        ticket_id: verified.identifier,
        evidence_reference_id: evidence[0]!.id,
        proof_sha256: proofSha256,
      },
    },
    parentId,
    readTicket: async (ticketId) => ticketId === verified.identifier ? bridgedProof : undefined,
    readMutations: async () => readMutationProofs(resolved.root),
  };
}

function snapshotCarriesMutationAuthority(request: StrategicReviewRequest): boolean {
  if (request.continuation !== undefined || request.integrity?.follow_up !== undefined) return true;
  if (!request.analysis?.lanes) return false;
  return Object.values(request.analysis.lanes).flat().some((item) =>
    item.disposition === "TRACKED" || item.disposition === "MUTATED");
}

function contractChecks(
  request: StrategicReviewRequest,
  threshold: number,
): { checks: boolean[]; rootCauseFailure: boolean } {
  const analysis = request.analysis;
  if (!analysis) return { checks: Array.from({ length: 12 }, () => false), rootCauseFailure: false };
  const references = request.evidence.references;
  const evidenceIds = new Set(references.map(({ id }) => id));
  const evidenceValid = evidenceManifestValid(references);
  const currentAuthenticated = references.some((reference) => reference.role === "current" && reference.classification === "FACT");
  const commitmentsValid = references.some((reference) => reference.role === "prior_commitment")
    && Array.isArray(analysis.prior_commitments)
    && analysis.prior_commitments.length > 0
    && analysis.prior_commitments.every((commitment) => nonEmpty(commitment.id)
      && COMMITMENT_STATUSES.has(commitment.status)
      && referencedEvidenceExists(commitment.evidence, evidenceIds));
  const feedbackValid = references.some((reference) => reference.role === "user_feedback")
    && Array.isArray(analysis.user_feedback)
    && analysis.user_feedback.length > 0
    && analysis.user_feedback.every((feedback) => nonEmpty(feedback.id)
      && Number.isInteger(feedback.priority)
      && feedback.priority >= 0
      && referencedEvidenceExists(feedback.evidence, evidenceIds));
  const recurrenceReferences = references.filter((reference) =>
    reference.role === "recurrence_7d" || reference.role === "recurrence_30d");
  const recurrenceIds = new Set([
    ...(analysis.recurrence?.seven_day ?? []),
    ...(analysis.recurrence?.thirty_day ?? []),
  ]);
  const recurrenceValid = references.some((reference) => reference.role === "recurrence_7d")
    && references.some((reference) => reference.role === "recurrence_30d")
    && Array.isArray(analysis.recurrence?.seven_day)
    && Array.isArray(analysis.recurrence?.thirty_day)
    && analysis.recurrence.seven_day.every((id) => references.some((reference) => reference.id === id && reference.role === "recurrence_7d"))
    && analysis.recurrence.thirty_day.every((id) => references.some((reference) => reference.id === id && reference.role === "recurrence_30d"))
    && recurrenceReferences.every((reference) => recurrenceIds.has(reference.id)
      && nonEmpty(reference.finding_id)
      && analysis.findings.some((finding) => finding.id === reference.finding_id))
    && analysis.findings.every((finding) => {
      const scoped = recurrenceReferences.filter((reference) => reference.finding_id === finding.id);
      return finding.recurrence_count === scoped.length
        && scoped.every((reference) => finding.evidence.includes(reference.id));
    });
  const findingsValid = Array.isArray(analysis.findings)
    && analysis.findings.every((finding) => !finding.material || (
      nonEmpty(finding.owner)
      && nonEmpty(finding.control)
      && referencedEvidenceExists(finding.evidence, evidenceIds)
    ));
  const selfCorrectionValid = nonEmpty(analysis.reviewer_self_correction?.description)
    && (analysis.reviewer_self_correction.defect_type === "reviewer"
      || analysis.reviewer_self_correction.defect_type === "measurement")
    && referencedEvidenceExists(analysis.reviewer_self_correction.evidence, evidenceIds);
  const lanesValid = ["NOW", "NEXT", "LATER"].every((lane) => Array.isArray(analysis.lanes?.[lane as StrategicReviewLane]))
    && Object.values(analysis.lanes).flat().every((item) => nonEmpty(item.action)
      && referencedEvidenceExists(item.evidence, evidenceIds));
  const laneItems = Object.values(analysis.lanes).flat();
  const ticketFirst = laneItems.every((item) => item.disposition === "MONITORING ONLY" || nonEmpty(item.ticket_id));
  const rootCauseFailure = analysis.findings.some((finding) => {
    if (!finding.material || finding.recurrence_count < threshold) return false;
    const actions = laneItems.filter((item) => item.finding_id === finding.id);
    const duplicateSymptomsNotConsolidated = finding.symptoms.length > 1
      && actions.length > 1
      && !actions.every((item) => item.independent_action === true);
    return !rootCauseComplete(finding, threshold) || duplicateSymptomsNotConsolidated;
  });
  return {
    checks: [
      currentAuthenticated,
      commitmentsValid,
      feedbackValid,
      recurrenceValid,
      findingsValid,
      selfCorrectionValid,
      lanesValid,
      true,
      ticketFirst,
      true,
      true,
      evidenceValid,
    ],
    rootCauseFailure,
  };
}

async function exactStrategicReviewAudit(
  responseText: string,
  context: ContinuationAuditContext,
  result: ContinuationFinalizerResult,
  policy: ExecutionPolicyResult,
): Promise<ContinuationAuditRecord | undefined> {
  if (result.reasons.includes("AUDIT_PERSISTENCE_FAILED")) return undefined;
  const expectedPair = policy.verdict === "FAIL"
    ? buildContinuationPolicyFailurePair(responseText, policy, context)
    : undefined;
  try {
    return (await readContinuationAudits(context.root)).find((record) =>
      record.schema_version === 2
      && record.response_sha256 === bytesDigest(responseText)
      && record.parent_sha256 === bytesDigest(context.parentId)
      && record.run_sha256 === bytesDigest(context.runId)
      && record.session_sha256 === bytesDigest(context.sessionId)
      && record.surface === context.surface
      && record.mode === context.mode
      && record.verdict === result.status
      && JSON.stringify(record.reasons) === JSON.stringify(result.reasons)
      && JSON.stringify(record.items) === JSON.stringify(result.items)
      && record.policy.verdict === policy.verdict
      && JSON.stringify(record.policy.reasons) === JSON.stringify(policy.reasons)
      && JSON.stringify(record.policy.trace) === JSON.stringify(policy.trace)
      && (!expectedPair || (
        record.policy.policy_failure_id === expectedPair.policy_failure_id
        && record.policy.correction_reservation_id === expectedPair.correction_reservation_id
      )));
  } catch {
    return undefined;
  }
}

export async function review(request: StrategicReviewRequest): Promise<StrategicReviewResult> {
  const installedProfile = INSTALLED_PROFILES.get(request.profile);
  if (!installedProfile) return failure("PROFILE_NOT_AUTHORIZED");
  if (!request.evidence || !Array.isArray(request.evidence.references)
    || request.evidence.references.length > request.evidence.maximum_references) {
    return failure("SNAPSHOT_BOUND_EXCEEDED");
  }
  if (!evidenceManifestValid(request.evidence.references)) {
    return failure("EVIDENCE_UNAVAILABLE", "PARTIAL");
  }

  const authenticated = await authenticateStrategicReviewRequest(request);
  if ("ok" in authenticated) return authenticated;
  const expectedProof = `strategic-review/v1/${request.profile}/${installedProfile.domain}`;
  if (
    authenticated.authority.profile !== request.profile
    || authenticated.authority.domain !== installedProfile.domain
    || authenticated.authority.proof !== expectedProof
  ) return failure("PROFILE_AUTHORITY_EXPANSION");

  if ((request.operation === "replay" || request.operation === "status") && request.mode === "normal") {
    try {
      const stored = await loadNormalReport(request, authenticated);
      if (request.operation === "status") {
        return {
          ok: true,
          status: "PASS",
          receipt: {
            schema_version: 1,
            report_id: stored.report_id,
            report_sha256: stored.report_sha256,
            profile: stored.report.profile,
            mode: "normal",
            report_status: "PASS",
            storage_reference: stored.storage_reference,
          },
          mutation_count: 0,
        };
      }
      return {
        ok: true,
        status: "PASS",
        ...stored,
        mutation_count: 0,
      };
    } catch (error) {
      const reason = error instanceof StrategicReviewReadError ? error.reason : "REVIEW_INTEGRITY_FAILURE";
      return failure(reason, reason === "EVIDENCE_UNAVAILABLE" ? "PARTIAL" : "BLOCKED");
    }
  }

  if (request.mode === "bounded_snapshot") {
    if (snapshotCarriesMutationAuthority(request)) return failure("SNAPSHOT_MUTATION_FORBIDDEN");
    const result = snapshotResult(request, {
      schema_version: 1,
      profile: request.profile,
      mode: "bounded_snapshot",
      authenticated_evidence: authenticated.authenticated_evidence,
      evidence: request.evidence,
      exemptions: ["durable_tracking", "closed_loop_action", "mutation"],
    });
    if (request.operation === "replay" && request.report_id !== result.report_id) {
      return failure("REVIEW_REPLAY_CONFLICT");
    }
    return result;
  }

  if (request.operation === "evaluate" && request.mode === "normal") {
    if (request.analysis?.findings.some((finding) => finding.domain !== installedProfile.domain)) {
      return failure("PROFILE_AUTHORITY_EXPANSION");
    }
    const { checks, rootCauseFailure } = contractChecks(request, authenticated.profile.recurrence_threshold);
    if (rootCauseFailure) return failure("RECURRENCE_ROOT_CAUSE_REQUIRED");
    if (!checks.every(Boolean) || !request.analysis || !request.resource_stewardship || !request.continuation) {
      return failure("REVIEW_CONTRACT_INCOMPLETE");
    }

    const policy = evaluateExecutionPolicy(request.resource_stewardship.execution_policy);
    let preparedIntegrity: PreparedIntegrityCoordination;
    if (policy.verdict === "FAIL") {
      preparedIntegrity = {
        disposition: {
          verdict: "CLEAN",
          expected_source_ownership_sha256: T62_EXPECTED_SOURCE_OWNERSHIP_SHA256,
          observed_source_ownership_sha256: request.integrity?.observed_source_ownership_sha256 ?? "",
        },
        parentId: request.continuation.parent_id,
        readTicket: async (ticketId) => request.continuation?.tickets[ticketId],
        readMutations: async () => request.continuation?.mutations ?? [],
      };
    } else {
      try {
        const prepared = await prepareIntegrityCoordination(request);
        if (!prepared) return failure("REVIEW_INTEGRITY_FAILURE");
        preparedIntegrity = prepared;
      } catch {
        return failure("REVIEW_INTEGRITY_FAILURE");
      }
    }
    const auditContext: ContinuationAuditContext = {
      root: request.cwd,
      parentId: preparedIntegrity.parentId,
      runId: request.continuation.run_id,
      sessionId: request.continuation.session_id,
      surface: "strategic-review",
      mode: request.mode,
      executionPolicy: request.resource_stewardship.execution_policy,
    };
    const continuation = await finalizeContinuationLedgerLiveAudited(
      request.continuation.response_text,
      auditContext,
      {
        readTicket: preparedIntegrity.readTicket,
        readMutations: preparedIntegrity.readMutations,
      },
    );
    if (policy.verdict === "FAIL" || continuation.status === "FAIL") {
      const reasons = [...new Set([...policy.reasons, ...continuation.reasons])];
      const result = failure(reasons[0] ?? "REVIEW_CONTRACT_INCOMPLETE", "BLOCKED", reasons);
      if (policy.verdict === "FAIL") {
        const audit = await exactStrategicReviewAudit(
          request.continuation.response_text,
          auditContext,
          continuation,
          policy,
        );
        if (audit?.schema_version !== 2
          || !audit.policy.policy_failure_id
          || !audit.policy.correction_reservation_id) {
          return failure("REVIEW_INTEGRITY_FAILURE");
        }
        result.policy_failure_id = audit.policy.policy_failure_id;
        result.correction_reservation_id = audit.policy.correction_reservation_id;
      }
      return result;
    }
    if (!lanesMatchAuthenticatedContinuation(request.analysis, continuation, request.evidence.references)) {
      return failure("REVIEW_CONTRACT_INCOMPLETE");
    }
    const integrity = preparedIntegrity.disposition;

    const report: StrategicReviewNormalReport = {
      schema_version: 1,
      profile: request.profile,
      mode: "normal",
      producer: request.producer,
      authority: request.authority,
      authenticated_evidence: authenticated.authenticated_evidence,
      evidence: request.evidence,
      findings: request.analysis.findings,
      lanes: request.analysis.lanes,
      obligations: checks.map((_, index) => ({ id: `T60-${index + 1}`, status: "PASS" as const })),
      resource_stewardship: policy,
      continuation,
      integrity,
    };
    try {
      const stored = await persistNormalReport(request, report, policy);
      return {
        ok: true,
        status: "PASS",
        ...stored,
        report,
        mutation_count: 0,
      };
    } catch {
      return failure("REVIEW_INTEGRITY_FAILURE");
    }
  }

  return failure("REVIEW_CONTRACT_INCOMPLETE");
}

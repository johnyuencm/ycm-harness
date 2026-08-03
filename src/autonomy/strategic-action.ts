import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  assertSafeContinuationLeaseTree,
  assertSafeContinuationStoragePath,
} from "../continuation/storage-safety.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { HarnessStore } from "../state/store.js";
import {
  providerForState,
  type StrategicTicketCapability,
  type StrategicTicketRead,
} from "../tickets/provider.js";
import {
  assertNoSecrets,
  resolveHarnessGoal,
  verifyCoordinationBinding,
  withCoordinationLease,
  type CoordinationDeps,
} from "./coordination.js";
import { installedLoopAdapter, type InstalledLoopAdapter } from "./installed-loop-state.js";
import { recordMutationProof } from "./mutation-proof.js";
import {
  installedStrategicReviewProfile,
  review,
  type StrategicReviewNormalReport,
  type StrategicReviewRequest,
  type StrategicReviewResult,
} from "./strategic-review.js";

export const STRATEGIC_ACTION_SELECTOR_OPERATIONS = [
  "ticket_reuse_or_create",
  "ticket_comment",
  "ticket_priority",
  "installed_loop_pause",
  "rollback",
] as const;
export type StrategicActionSelectorOperation = typeof STRATEGIC_ACTION_SELECTOR_OPERATIONS[number];
export type StrategicActionCapability = StrategicActionSelectorOperation;
export type StrategicActionPriority = "urgent" | "high" | "medium" | "low";

export interface StrategicActionCommentState {
  id: string;
  content: string;
  action_identity: string | null;
}

export interface StrategicActionTicketState {
  kind: "ticket";
  ticket_id: string;
  title: string;
  root_cause: string;
  action_identities: string[];
  owner: string | null;
  priority: StrategicActionPriority;
  comments: StrategicActionCommentState[];
  provider_proof: {
    source: string;
    digest: string;
    read_at: string;
  };
}

export interface StrategicActionTicketSearchState {
  kind: "ticket_search";
  root_cause: string;
  action_identity: string;
  owner: null;
  matching_ticket_ids: string[];
}

export interface StrategicActionLoopState {
  kind: "installed_loop";
  loop_id: string;
  profile: string;
  paused: boolean;
  state_version: string;
  protected_state_digest: string;
  read_at: string;
}

export type StrategicActionState =
  | StrategicActionTicketState
  | StrategicActionTicketSearchState
  | StrategicActionLoopState;

interface StrategicActionSelectorBase {
  finding_id: string;
  action: string;
  evidence_reference_ids: string[];
}

export type StrategicActionSelector =
  | (StrategicActionSelectorBase & {
      operation: "ticket_reuse_or_create";
      root_cause: string;
      owner: null;
      ticket: {
        title: string;
        brief: string;
        acceptance: string[];
      };
    })
  | (StrategicActionSelectorBase & {
      operation: "ticket_comment";
      ticket_id: string;
      content: string;
    })
  | (StrategicActionSelectorBase & {
      operation: "ticket_priority";
      ticket_id: string;
      priority: StrategicActionPriority;
    })
  | (StrategicActionSelectorBase & {
      operation: "installed_loop_pause";
      loop_id: string;
      reason: string;
    })
  | (StrategicActionSelectorBase & {
      operation: "rollback";
      target_receipt_id: string;
    });

export interface StrategicActionRequest {
  cwd: string;
  operation: "apply" | "status" | "replay";
  report: {
    report_id: string;
    report_sha256: string;
    report_bytes: string;
    authentication: Omit<StrategicReviewRequest, "cwd" | "operation" | "report_id">;
  };
  authority: {
    installation_id: string;
    profile: string;
    domain: string;
    capability_proof: string;
    capabilities: StrategicActionCapability[];
  };
  action_identity: string;
  selector: StrategicActionSelector;
  expected_before: StrategicActionState;
}

export interface StrategicActionFailure {
  ok: false;
  status: "PARTIAL" | "BLOCKED";
  reason: string;
  action_identity?: string;
  pending_receipt?: {
    action_identity: string;
    request_sha256: string;
    storage_reference: string;
  };
  mutation_count: 0 | 1;
}

export interface StrategicActionReceipt {
  schema_version: 1;
  receipt_id: string;
  action_identity: string;
  request_sha256: string;
  status: "APPLIED" | "ROLLED_BACK";
  report: {
    report_id: string;
    report_sha256: string;
    profile: string;
  };
  selector: StrategicActionSelector;
  authority: StrategicActionRequest["authority"];
  before: StrategicActionState;
  after: StrategicActionState;
  provenance: {
    finding_id: string;
    action: string;
    evidence_reference_ids: string[];
    mutation_proof_id?: string;
  };
  live_proof: StrategicActionTicketState["provider_proof"] | {
    source: "installed-loop";
    digest: string;
    read_at: string;
  };
  timestamps: {
    intended_at: string;
    mutated_at: string;
    finalized_at: string;
  };
  protected_state_digest: string;
}

export interface StrategicActionSuccess {
  ok: true;
  status: "APPLIED" | "ROLLED_BACK";
  receipt_id: string;
  receipt_sha256: string;
  receipt_bytes: string;
  storage_reference: string;
  receipt: StrategicActionReceipt;
  mutation_count: 0 | 1;
}

export type StrategicActionResult = StrategicActionFailure | StrategicActionSuccess;

export interface StrategicActionDependencies {
  reviewReport(request: StrategicReviewRequest): Promise<StrategicReviewResult>;
  ticket: StrategicTicketCapability;
  loop: InstalledLoopAdapter;
  now(): string;
  coordination: CoordinationDeps;
  faultAt: "after_receipt_intent_before_receipt_write";
}

const strategicActionTestDependencies = new AsyncLocalStorage<Partial<StrategicActionDependencies>>();

/** @internal Production-shaped dependency wrapper for public-seam tests only. */
export async function withStrategicActionTestDependencies<T>(
  dependencies: Partial<StrategicActionDependencies>,
  operation: () => Promise<T>,
): Promise<T> {
  return strategicActionTestDependencies.run(dependencies, operation);
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPORT_ID = /^review-[a-f0-9]{64}$/;
const ACTION_ID = /^action-[a-f0-9]{64}$/;
const RECEIPT_ID = /^action-receipt-[a-f0-9]{64}$/;
const SafeText = z.string().min(1).max(8192);
const EvidenceIds = z.array(z.string().regex(SAFE_REF)).min(1).max(128);
const SelectorBase = {
  finding_id: z.string().regex(SAFE_REF),
  action: SafeText,
  evidence_reference_ids: EvidenceIds,
};
const SelectorSchema = z.discriminatedUnion("operation", [
  z.object({
    ...SelectorBase,
    operation: z.literal("ticket_reuse_or_create"),
    root_cause: SafeText,
    owner: z.null(),
    ticket: z.object({
      title: z.string().min(1).max(512),
      brief: SafeText,
      acceptance: z.array(SafeText).min(1).max(64),
    }).strict(),
  }).strict(),
  z.object({
    ...SelectorBase,
    operation: z.literal("ticket_comment"),
    ticket_id: z.string().regex(SAFE_REF),
    content: SafeText,
  }).strict(),
  z.object({
    ...SelectorBase,
    operation: z.literal("ticket_priority"),
    ticket_id: z.string().regex(SAFE_REF),
    priority: z.enum(["urgent", "high", "medium", "low"]),
  }).strict(),
  z.object({
    ...SelectorBase,
    operation: z.literal("installed_loop_pause"),
    loop_id: z.string().regex(SAFE_REF),
    reason: SafeText,
  }).strict(),
  z.object({
    ...SelectorBase,
    operation: z.literal("rollback"),
    target_receipt_id: z.string().regex(RECEIPT_ID),
  }).strict(),
]);
const TicketSearchStateSchema = z.object({
  kind: z.literal("ticket_search"),
  root_cause: SafeText,
  action_identity: z.string().regex(ACTION_ID),
  owner: z.null(),
  matching_ticket_ids: z.array(z.string().regex(SAFE_REF)).max(200),
}).strict();
const TicketStateSchema = z.object({
  kind: z.literal("ticket"),
  ticket_id: z.string().regex(SAFE_REF),
  title: z.string().min(1).max(512),
  root_cause: SafeText,
  action_identities: z.array(z.string().regex(ACTION_ID)).max(128),
  owner: z.string().regex(SAFE_REF).nullable(),
  priority: z.enum(["urgent", "high", "medium", "low"]),
  comments: z.array(z.object({
    id: z.string().regex(SAFE_REF),
    content: SafeText,
    action_identity: z.string().regex(ACTION_ID).nullable(),
  }).strict()).max(1000),
  provider_proof: z.object({
    source: z.string().min(1).max(1024),
    digest: z.string().regex(SHA256),
    read_at: z.string().datetime(),
  }).strict(),
}).strict();
const LoopStateSchema = z.object({
  kind: z.literal("installed_loop"),
  loop_id: z.string().regex(SAFE_REF),
  profile: z.string().regex(SAFE_REF),
  paused: z.boolean(),
  state_version: z.string().regex(SAFE_REF),
  protected_state_digest: z.string().regex(SHA256),
  read_at: z.string().datetime(),
}).strict();
const StateSchema = z.discriminatedUnion("kind", [TicketSearchStateSchema, TicketStateSchema, LoopStateSchema]);
const RequestSchema = z.object({
  cwd: z.string().min(1).max(4096),
  operation: z.enum(["apply", "status", "replay"]),
  report: z.object({
    report_id: z.string().regex(REPORT_ID),
    report_sha256: z.string().regex(SHA256),
    report_bytes: z.string().min(1).max(1024 * 1024),
    authentication: z.record(z.unknown()),
  }).strict(),
  authority: z.object({
    installation_id: z.string().min(1).max(4096),
    profile: z.string().regex(SAFE_REF),
    domain: z.string().min(1).max(256),
    capability_proof: z.string().min(1).max(4096),
    capabilities: z.array(z.enum(STRATEGIC_ACTION_SELECTOR_OPERATIONS)).length(5),
  }).strict(),
  action_identity: z.string().regex(ACTION_ID),
  selector: SelectorSchema,
  expected_before: StateSchema,
}).strict();

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function protectedStateValue(state: StrategicActionState): unknown {
  if (state.kind === "ticket") {
    const { read_at: _readAt, ...providerProof } = state.provider_proof;
    return { ...state, provider_proof: providerProof };
  }
  if (state.kind === "installed_loop") {
    const { read_at: _readAt, ...protectedState } = state;
    return protectedState;
  }
  return state;
}

function sameProtectedState(left: StrategicActionState, right: StrategicActionState): boolean {
  return canonicalJson(protectedStateValue(left)) === canonicalJson(protectedStateValue(right));
}

function protectedStateDigest(state: StrategicActionState): string {
  return sha256(canonicalJson(protectedStateValue(state)));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalStrategicActionIdentity(profile: string, findingId: string, action: string): string {
  return `action-${sha256(canonicalJson({ schema_version: 1, profile, finding_id: findingId, action }))}`;
}

function failure(
  reason: string,
  actionIdentity?: string,
  status: "PARTIAL" | "BLOCKED" = "BLOCKED",
  mutationCount: 0 | 1 = 0,
  pendingReceipt?: StrategicActionFailure["pending_receipt"],
): StrategicActionFailure {
  return {
    ok: false,
    status,
    reason,
    ...(actionIdentity ? { action_identity: actionIdentity } : {}),
    ...(pendingReceipt ? { pending_receipt: pendingReceipt } : {}),
    mutation_count: mutationCount,
  };
}

function exactCapabilities(authority: StrategicActionRequest["authority"]): boolean {
  const expected = [...STRATEGIC_ACTION_SELECTOR_OPERATIONS];
  return authority.capabilities.length === expected.length
    && expected.every((capability, index) => authority.capabilities[index] === capability);
}

async function authenticate(request: StrategicActionRequest): Promise<
  | { ok: true; report: StrategicReviewNormalReport }
  | StrategicActionFailure
> {
  const dependencies = strategicActionTestDependencies.getStore();
  let replay: StrategicReviewResult;
  try {
    replay = await (dependencies?.reviewReport ?? review)({
      ...(request.report.authentication as Omit<StrategicReviewRequest, "cwd" | "operation" | "report_id">),
      cwd: request.cwd,
      operation: "replay",
      report_id: request.report.report_id,
    });
  } catch {
    return failure("REPORT_AUTHENTICATION_FAILED", request.action_identity);
  }
  if (!replay.ok) return failure("REPORT_AUTHENTICATION_FAILED", request.action_identity);
  if (replay.status === "SNAPSHOT") return failure("SNAPSHOT_MUTATION_FORBIDDEN", request.action_identity);
  if (replay.status !== "PASS" || !("report" in replay)
    || replay.report.mode !== "normal"
    || replay.report_id !== request.report.report_id
    || replay.report_sha256 !== request.report.report_sha256
    || replay.report_bytes !== request.report.report_bytes) {
    return failure("REPORT_AUTHENTICATION_FAILED", request.action_identity);
  }
  const authority = request.authority;
  const installed = installedStrategicReviewProfile(authority.profile);
  const liveAuthority = request.report.authentication.authority;
  if (!installed
    || !liveAuthority
    || authority.installation_id !== liveAuthority.installation_id
    || authority.profile !== liveAuthority.profile
    || authority.profile !== request.report.authentication.profile
    || authority.domain !== liveAuthority.domain
    || authority.domain !== installed.domain
    || liveAuthority.domain !== installed.domain
    || liveAuthority.proof !== `strategic-review/v1/${authority.profile}/${installed.domain}`
    || authority.installation_id !== replay.report.authority.installation_id
    || authority.profile !== replay.report.profile
    || authority.domain !== replay.report.authority.domain
    || authority.capability_proof !== `strategic-action/v1/${authority.profile}/${installed.domain}`
    || !exactCapabilities(authority)
    || !authority.capabilities.includes(request.selector.operation)) {
    return failure("ACTION_NOT_AUTHORIZED", request.action_identity);
  }
  const laneItems = Object.values(replay.report.lanes).flat();
  const selected = laneItems.filter((item) =>
    item.finding_id === request.selector.finding_id && item.action === request.selector.action);
  if (selected.length !== 1
    || canonicalStrategicActionIdentity(replay.report.profile, request.selector.finding_id, request.selector.action) !== request.action_identity) {
    return failure("ACTION_SELECTOR_INVALID", request.action_identity);
  }
  const lane = selected[0]!;
  const evidenceIds = [...request.selector.evidence_reference_ids].sort();
  if (canonicalJson(evidenceIds) !== canonicalJson([...lane.evidence].sort())
    || evidenceIds.some((id) => !replay.report.evidence.references.some((reference) =>
      reference.id === id && reference.classification === "FACT"))) {
    return failure("ACTION_SELECTOR_INVALID", request.action_identity);
  }
  const finding = replay.report.findings.find(({ id }) => id === request.selector.finding_id);
  if (!finding || (request.selector.operation === "ticket_reuse_or_create"
    && request.selector.root_cause !== finding.root_cause)) {
    return failure("ACTION_SELECTOR_INVALID", request.action_identity);
  }
  return { ok: true, report: replay.report };
}

interface StrategicActionIntent {
  schema_version: 1;
  action_identity: string;
  request_sha256: string;
  state: "pending" | "partial" | "blocked" | "finalized";
  report: {
    report_id: string;
    report_sha256: string;
    profile: string;
  };
  selector: StrategicActionSelector;
  authority: StrategicActionRequest["authority"];
  authenticated_before: StrategicActionState;
  intended_at: string;
  mutation_attempted: boolean;
  mutated_at?: string;
  receipt_id?: string;
  receipt_bytes?: string;
}

const IntentSchema = z.object({
  schema_version: z.literal(1),
  action_identity: z.string().regex(ACTION_ID),
  request_sha256: z.string().regex(SHA256),
  state: z.enum(["pending", "partial", "blocked", "finalized"]),
  report: z.object({
    report_id: z.string().regex(REPORT_ID),
    report_sha256: z.string().regex(SHA256),
    profile: z.string().regex(SAFE_REF),
  }).strict(),
  selector: SelectorSchema,
  authority: RequestSchema.shape.authority,
  authenticated_before: StateSchema,
  intended_at: z.string().datetime(),
  mutation_attempted: z.boolean(),
  mutated_at: z.string().datetime().optional(),
  receipt_id: z.string().regex(RECEIPT_ID).optional(),
  receipt_bytes: z.string().min(1).max(1024 * 1024).optional(),
}).strict();

const ReceiptSchema = z.object({
  schema_version: z.literal(1),
  receipt_id: z.string().regex(RECEIPT_ID),
  action_identity: z.string().regex(ACTION_ID),
  request_sha256: z.string().regex(SHA256),
  status: z.enum(["APPLIED", "ROLLED_BACK"]),
  report: IntentSchema.shape.report,
  selector: SelectorSchema,
  authority: RequestSchema.shape.authority,
  before: StateSchema,
  after: StateSchema,
  provenance: z.object({
    finding_id: z.string().regex(SAFE_REF),
    action: SafeText,
    evidence_reference_ids: EvidenceIds,
    mutation_proof_id: z.string().regex(SHA256).optional(),
  }).strict(),
  live_proof: z.union([
    TicketStateSchema.shape.provider_proof,
    z.object({
      source: z.literal("installed-loop"),
      digest: z.string().regex(SHA256),
      read_at: z.string().datetime(),
    }).strict(),
  ]),
  timestamps: z.object({
    intended_at: z.string().datetime(),
    mutated_at: z.string().datetime(),
    finalized_at: z.string().datetime(),
  }).strict(),
  protected_state_digest: z.string().regex(SHA256),
}).strict();

function requestDigest(request: StrategicActionRequest): string {
  return sha256(canonicalJson({
    schema_version: 1,
    report_id: request.report.report_id,
    report_sha256: request.report.report_sha256,
    authority: request.authority,
    action_identity: request.action_identity,
    selector: request.selector,
    expected_before: protectedStateValue(request.expected_before),
  }));
}

function actionStorage(root: string): {
  root: string;
  intents: string;
  receipts: string;
} {
  const storageRoot = path.join(root, HARNESS_DIR_NAME, "autonomy", "strategic-actions");
  return {
    root: storageRoot,
    intents: path.join(storageRoot, "intents"),
    receipts: path.join(storageRoot, "receipts"),
  };
}

function intentFile(root: string, actionIdentity: string): string {
  return path.join(actionStorage(root).intents, `${actionIdentity}.json`);
}

function receiptFile(root: string, receiptId: string): string {
  return path.join(actionStorage(root).receipts, `${receiptId}.json`);
}

async function ensureActionStorage(root: string): Promise<void> {
  const storage = actionStorage(root);
  const harness = path.join(root, HARNESS_DIR_NAME);
  const autonomy = path.join(harness, "autonomy");
  for (const directory of [harness, autonomy, storage.root, storage.intents, storage.receipts]) {
    await assertSafeContinuationStoragePath(root, directory, "directory", "ACTION_STATE_UNAVAILABLE");
  }
  await fs.mkdir(storage.intents, { recursive: true });
  await fs.mkdir(storage.receipts, { recursive: true });
  for (const directory of [harness, autonomy, storage.root, storage.intents, storage.receipts]) {
    await assertSafeContinuationStoragePath(root, directory, "directory", "ACTION_STATE_UNAVAILABLE");
  }
}

async function readIntent(root: string, actionIdentity: string): Promise<StrategicActionIntent | undefined> {
  const file = intentFile(root, actionIdentity);
  await assertSafeContinuationStoragePath(root, file, "file", "ACTION_STATE_UNAVAILABLE");
  const raw = await readJsonIfExists<unknown>(file);
  if (raw === undefined) return undefined;
  const parsed = IntentSchema.safeParse(raw);
  if (!parsed.success || parsed.data.action_identity !== actionIdentity) throw new Error("ACTION_STATE_UNAVAILABLE");
  return parsed.data as StrategicActionIntent;
}

async function writeIntent(root: string, intent: StrategicActionIntent): Promise<StrategicActionIntent> {
  const file = intentFile(root, intent.action_identity);
  await assertSafeContinuationStoragePath(root, file, "file", "ACTION_STATE_UNAVAILABLE");
  await writeJsonAtomic(file, IntentSchema.parse(intent));
  const readback = await readIntent(root, intent.action_identity);
  if (!readback || canonicalJson(readback) !== canonicalJson(intent)) throw new Error("ACTION_STATE_UNAVAILABLE");
  return readback;
}

function receiptIdentity(receipt: Omit<StrategicActionReceipt, "receipt_id">): string {
  return `action-receipt-${sha256(canonicalJson(receipt))}`;
}

function parseReceiptBytes(receiptId: string, receiptBytes: string): StrategicActionReceipt {
  let raw: unknown;
  try {
    raw = JSON.parse(receiptBytes) as unknown;
  } catch {
    throw new Error("ACTION_STATE_UNAVAILABLE");
  }
  const parsed = ReceiptSchema.safeParse(raw);
  if (!parsed.success) throw new Error("ACTION_STATE_UNAVAILABLE");
  const receipt = parsed.data as StrategicActionReceipt;
  const { receipt_id: _receiptId, ...body } = receipt;
  if (receipt.receipt_id !== receiptId
    || receiptIdentity(body) !== receiptId
    || `${canonicalJson(receipt)}\n` !== receiptBytes) {
    throw new Error("ACTION_STATE_UNAVAILABLE");
  }
  return receipt;
}

async function readReceipt(root: string, receiptId: string): Promise<{
  receipt: StrategicActionReceipt;
  receiptBytes: string;
}> {
  const file = receiptFile(root, receiptId);
  await assertSafeContinuationStoragePath(root, file, "file", "ACTION_STATE_UNAVAILABLE");
  const receiptBytes = await fs.readFile(file, "utf8");
  return { receipt: parseReceiptBytes(receiptId, receiptBytes), receiptBytes };
}

async function writeReceipt(
  root: string,
  receipt: StrategicActionReceipt,
  canonicalBytes?: string,
): Promise<{
  receipt: StrategicActionReceipt;
  receiptBytes: string;
}> {
  const file = receiptFile(root, receipt.receipt_id);
  await assertSafeContinuationStoragePath(root, file, "file", "ACTION_STATE_UNAVAILABLE");
  const receiptBytes = `${canonicalJson(ReceiptSchema.parse(receipt))}\n`;
  if (canonicalBytes !== undefined && canonicalBytes !== receiptBytes) throw new Error("ACTION_STATE_UNAVAILABLE");
  let existing: string | undefined;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined && existing !== receiptBytes) throw new Error("ACTION_REPLAY_CONFLICT");
  if (existing === undefined) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await assertSafeContinuationStoragePath(root, temporary, "file", "ACTION_STATE_UNAVAILABLE");
    await fs.writeFile(temporary, receiptBytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  }
  return readReceipt(root, receipt.receipt_id);
}

function success(
  receipt: StrategicActionReceipt,
  receiptBytes: string,
  mutationCount: 0 | 1,
): StrategicActionSuccess {
  return {
    ok: true,
    status: receipt.status,
    receipt_id: receipt.receipt_id,
    receipt_sha256: sha256(receiptBytes),
    receipt_bytes: receiptBytes,
    storage_reference: `${HARNESS_DIR_NAME}/autonomy/strategic-actions/receipts/${receipt.receipt_id}.json`,
    receipt,
    mutation_count: mutationCount,
  };
}

async function persistFinalReceipt(
  request: StrategicActionRequest,
  intent: StrategicActionIntent,
  receipt: StrategicActionReceipt,
  mutatedAt: string,
  mutationCount: 0 | 1,
): Promise<StrategicActionSuccess> {
  const receiptBytes = `${canonicalJson(ReceiptSchema.parse(receipt))}\n`;
  const receiptIntent = await writeIntent(request.cwd, {
    ...intent,
    mutated_at: mutatedAt,
    receipt_id: receipt.receipt_id,
    receipt_bytes: receiptBytes,
  });
  if (strategicActionTestDependencies.getStore()?.faultAt === "after_receipt_intent_before_receipt_write") {
    throw new Error("action_fault_after_receipt_intent_before_receipt_write");
  }
  const stored = await writeReceipt(request.cwd, receipt, receiptBytes);
  await writeIntent(request.cwd, { ...receiptIntent, state: "finalized" });
  return success(stored.receipt, stored.receiptBytes, mutationCount);
}

async function finalizedReplay(
  request: StrategicActionRequest,
  requestSha256: string,
): Promise<StrategicActionSuccess | StrategicActionFailure | undefined> {
  const existing = await readIntent(request.cwd, request.action_identity);
  if (!existing) return undefined;
  if (existing.request_sha256 !== requestSha256
    || canonicalJson(existing.selector) !== canonicalJson(request.selector)
    || canonicalJson(existing.authority) !== canonicalJson(request.authority)) {
    return failure("ACTION_REPLAY_CONFLICT", request.action_identity);
  }
  if (!existing.receipt_id) return undefined;
  const intentReceipt = existing.receipt_bytes
    ? parseReceiptBytes(existing.receipt_id, existing.receipt_bytes)
    : undefined;
  if (intentReceipt && (intentReceipt.action_identity !== request.action_identity
    || intentReceipt.request_sha256 !== requestSha256)) {
    return failure("ACTION_REPLAY_CONFLICT", request.action_identity);
  }
  const stored = intentReceipt && existing.receipt_bytes
    ? await writeReceipt(request.cwd, intentReceipt, existing.receipt_bytes)
    : await readReceipt(request.cwd, existing.receipt_id);
  if (stored.receipt.action_identity !== request.action_identity
    || stored.receipt.request_sha256 !== requestSha256) {
    return failure("ACTION_REPLAY_CONFLICT", request.action_identity);
  }
  if (existing.state !== "finalized") await writeIntent(request.cwd, { ...existing, state: "finalized" });
  return success(stored.receipt, stored.receiptBytes, 0);
}

function ticketMutationProofAction(selector: StrategicActionSelector): "raised" | "commented" | "advanced" | undefined {
  if (selector.operation === "ticket_reuse_or_create") return "raised";
  if (selector.operation === "ticket_comment") return "commented";
  if (selector.operation === "ticket_priority" || selector.operation === "rollback") return "advanced";
  return undefined;
}

async function finalizeTicketReceipt(
  request: StrategicActionRequest,
  intent: StrategicActionIntent,
  after: StrategicActionTicketState,
  mutationCount: 0 | 1,
  now: () => string,
): Promise<StrategicActionSuccess> {
  const mutatedAt = intent.mutated_at ?? now();
  const proofAction = ticketMutationProofAction(request.selector);
  const continuation = request.report.authentication.continuation;
  const mutationProof = proofAction && continuation
    && !(request.selector.operation === "ticket_reuse_or_create" && mutationCount === 0)
    ? await recordMutationProof({
        root: request.cwd,
        runId: continuation.run_id,
        sessionId: continuation.session_id,
        ticketId: after.ticket_id,
        action: proofAction,
      })
    : undefined;
  const body: Omit<StrategicActionReceipt, "receipt_id"> = {
    schema_version: 1,
    action_identity: request.action_identity,
    request_sha256: intent.request_sha256,
    status: "APPLIED",
    report: intent.report,
    selector: request.selector,
    authority: request.authority,
    before: intent.authenticated_before,
    after,
    provenance: {
      finding_id: request.selector.finding_id,
      action: request.selector.action,
      evidence_reference_ids: [...request.selector.evidence_reference_ids],
      ...(mutationProof ? { mutation_proof_id: mutationProof.proof.proof_id } : {}),
    },
    live_proof: after.provider_proof,
    timestamps: {
      intended_at: intent.intended_at,
      mutated_at: mutatedAt,
      finalized_at: now(),
    },
    protected_state_digest: protectedStateDigest(after),
  };
  const receipt: StrategicActionReceipt = { ...body, receipt_id: receiptIdentity(body) };
  return persistFinalReceipt(request, intent, receipt, mutatedAt, mutationCount);
}

async function pendingIntent(
  request: StrategicActionRequest,
  requestSha256: string,
  now: () => string,
): Promise<StrategicActionIntent | StrategicActionFailure> {
  const existing = await readIntent(request.cwd, request.action_identity);
  if (existing) {
    if (existing.request_sha256 !== requestSha256
      || canonicalJson(existing.selector) !== canonicalJson(request.selector)
      || !sameProtectedState(existing.authenticated_before, request.expected_before)) {
      return failure("ACTION_REPLAY_CONFLICT", request.action_identity);
    }
    return existing;
  }
  return writeIntent(request.cwd, {
    schema_version: 1,
    action_identity: request.action_identity,
    request_sha256: requestSha256,
    state: "pending",
    report: {
      report_id: request.report.report_id,
      report_sha256: request.report.report_sha256,
      profile: request.authority.profile,
    },
    selector: request.selector,
    authority: request.authority,
    authenticated_before: request.expected_before,
    intended_at: now(),
    mutation_attempted: false,
  });
}

async function markMutationAttempted(
  request: StrategicActionRequest,
  intent: StrategicActionIntent,
  now: () => string,
): Promise<StrategicActionIntent> {
  return writeIntent(request.cwd, {
    ...intent,
    mutation_attempted: true,
    mutated_at: intent.mutated_at ?? now(),
  });
}

function pendingReceipt(intent: StrategicActionIntent): NonNullable<StrategicActionFailure["pending_receipt"]> {
  return {
    action_identity: intent.action_identity,
    request_sha256: intent.request_sha256,
    storage_reference: `${HARNESS_DIR_NAME}/autonomy/strategic-actions/intents/${intent.action_identity}.json`,
  };
}

async function partialIntent(
  request: StrategicActionRequest,
  intent: StrategicActionIntent,
  reason: string,
  mutationCount: 0 | 1,
): Promise<StrategicActionFailure> {
  const stored = await writeIntent(request.cwd, { ...intent, state: "partial" });
  return failure(reason, request.action_identity, "PARTIAL", mutationCount, pendingReceipt(stored));
}

async function blockedIntent(
  request: StrategicActionRequest,
  intent: StrategicActionIntent,
  reason: string,
  mutationCount: 0 | 1,
): Promise<StrategicActionFailure> {
  const stored = await writeIntent(request.cwd, { ...intent, state: "blocked" });
  return failure(reason, request.action_identity, "BLOCKED", mutationCount, pendingReceipt(stored));
}

async function applyTicketOwner(
  request: StrategicActionRequest,
  dependencies: Partial<StrategicActionDependencies>,
): Promise<StrategicActionResult> {
  if (request.selector.operation !== "ticket_reuse_or_create" || !dependencies.ticket) {
    return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
  }
  const selector = request.selector;
  let found: StrategicActionTicketState[];
  try {
    found = await dependencies.ticket.search({
      root_cause: selector.root_cause,
      action_identity: request.action_identity,
      owner: null,
    });
  } catch {
    return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
  }
  const matching = found
    .filter((ticket) => ticket.root_cause === selector.root_cause
      && (ticket.action_identities.length === 0 || ticket.action_identities.includes(request.action_identity))
      && ticket.owner === null)
    .sort((left, right) => left.ticket_id.localeCompare(right.ticket_id));
  const matchingTicketIds = matching.map(({ ticket_id }) => ticket_id);
  const expected = request.expected_before;
  if (expected.kind !== "ticket_search"
    || expected.root_cause !== selector.root_cause
    || expected.action_identity !== request.action_identity
    || canonicalJson([...expected.matching_ticket_ids].sort()) !== canonicalJson(matchingTicketIds)) {
    return failure("ACTION_EXPECTED_STATE_STALE", request.action_identity);
  }
  if (matching.length > 1) return failure("ACTION_READBACK_MISMATCH", request.action_identity);

  const now = dependencies.now ?? (() => new Date().toISOString());
  const requestSha256 = requestDigest(request);
  const existingIntent = await readIntent(request.cwd, request.action_identity);
  const intent = existingIntent ?? await writeIntent(request.cwd, {
    schema_version: 1,
    action_identity: request.action_identity,
    request_sha256: requestSha256,
    state: "pending",
    report: {
      report_id: request.report.report_id,
      report_sha256: request.report.report_sha256,
      profile: request.authority.profile,
    },
    selector: request.selector,
    authority: request.authority,
    authenticated_before: request.expected_before,
    intended_at: now(),
    mutation_attempted: false,
  });
  if (intent.request_sha256 !== requestSha256) return failure("ACTION_REPLAY_CONFLICT", request.action_identity);

  let mutationCount: 0 | 1 = 0;
  let mutationIntent = intent;
  let candidate = matching[0];
  if (!candidate) {
    mutationIntent = await markMutationAttempted(request, intent, now);
    try {
      await dependencies.ticket.create({
        title: selector.ticket.title,
        brief: selector.ticket.brief,
        acceptance: selector.ticket.acceptance,
        root_cause: selector.root_cause,
        action_identity: request.action_identity,
        owner: null,
      });
      mutationCount = 1;
    } catch {
      return partialIntent(request, mutationIntent, "ACTION_MUTATION_OUTCOME_UNKNOWN", 1);
    }
    let readback: StrategicActionTicketState[];
    try {
      readback = await dependencies.ticket.search({
        root_cause: selector.root_cause,
        action_identity: request.action_identity,
        owner: null,
      });
    } catch {
      return partialIntent(request, mutationIntent, "ACTION_READBACK_UNAVAILABLE", 1);
    }
    const verified = readback.filter((ticket) => ticket.root_cause === selector.root_cause
      && ticket.action_identities.includes(request.action_identity)
      && ticket.owner === null);
    if (verified.length !== 1) return blockedIntent(request, mutationIntent, "ACTION_READBACK_MISMATCH", 1);
    candidate = verified[0];
  }
  if (!candidate) return blockedIntent(request, mutationIntent, "ACTION_READBACK_MISMATCH", mutationCount);
  let exact: StrategicActionTicketState | undefined;
  try {
    exact = await dependencies.ticket.read(candidate.ticket_id);
  } catch {
    return mutationCount === 1
      ? partialIntent(request, mutationIntent, "ACTION_READBACK_UNAVAILABLE", 1)
      : failure("ACTION_READBACK_UNAVAILABLE", request.action_identity);
  }
  if (!exact || !sameProtectedState(exact, candidate)) {
    return blockedIntent(request, mutationIntent, "ACTION_READBACK_MISMATCH", mutationCount);
  }
  return finalizeTicketReceipt(
    request,
    mutationIntent,
    exact,
    mutationCount,
    now,
  );
}

function sameTicketBase(left: StrategicActionTicketState, right: StrategicActionTicketState): boolean {
  return left.ticket_id === right.ticket_id
    && left.title === right.title
    && left.root_cause === right.root_cause
    && canonicalJson(left.action_identities) === canonicalJson(right.action_identities)
    && left.owner === right.owner;
}

function ticketMutationReadbackMatches(
  before: StrategicActionTicketState,
  after: StrategicActionTicketState,
  selector: Extract<StrategicActionSelector, { operation: "ticket_comment" | "ticket_priority" }>,
  actionIdentity: string,
): boolean {
  if (!sameTicketBase(before, after)) return false;
  if (selector.operation === "ticket_priority") {
    return after.priority === selector.priority
      && canonicalJson(after.comments) === canonicalJson(before.comments);
  }
  const priorCommentsPreserved = before.comments.every((comment) => after.comments.some((candidate) =>
    canonicalJson(candidate) === canonicalJson(comment)));
  const applied = after.comments.filter((comment) =>
    comment.content === selector.content && comment.action_identity === actionIdentity);
  return priorCommentsPreserved
    && after.priority === before.priority
    && applied.length === 1
    && after.comments.length === before.comments.length + (before.comments.some((comment) =>
      comment.content === selector.content && comment.action_identity === actionIdentity) ? 0 : 1);
}

async function finalizeStateReceipt(
  request: StrategicActionRequest,
  intent: StrategicActionIntent,
  after: StrategicActionTicketState | StrategicActionLoopState,
  status: "APPLIED" | "ROLLED_BACK",
  mutationCount: 0 | 1,
  now: () => string,
): Promise<StrategicActionSuccess> {
  const mutatedAt = intent.mutated_at ?? now();
  const liveProof = after.kind === "ticket"
    ? after.provider_proof
    : { source: "installed-loop" as const, digest: after.protected_state_digest, read_at: after.read_at };
  const body: Omit<StrategicActionReceipt, "receipt_id"> = {
    schema_version: 1,
    action_identity: request.action_identity,
    request_sha256: intent.request_sha256,
    status,
    report: intent.report,
    selector: request.selector,
    authority: request.authority,
    before: intent.authenticated_before,
    after,
    provenance: {
      finding_id: request.selector.finding_id,
      action: request.selector.action,
      evidence_reference_ids: [...request.selector.evidence_reference_ids],
    },
    live_proof: liveProof,
    timestamps: {
      intended_at: intent.intended_at,
      mutated_at: mutatedAt,
      finalized_at: now(),
    },
    protected_state_digest: protectedStateDigest(after),
  };
  const receipt: StrategicActionReceipt = { ...body, receipt_id: receiptIdentity(body) };
  return persistFinalReceipt(request, intent, receipt, mutatedAt, mutationCount);
}

async function applyTicketMutation(
  request: StrategicActionRequest,
  dependencies: Partial<StrategicActionDependencies>,
): Promise<StrategicActionResult> {
  if ((request.selector.operation !== "ticket_comment" && request.selector.operation !== "ticket_priority")
    || !dependencies.ticket) {
    return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
  }
  const selector = request.selector;
  if (request.expected_before.kind !== "ticket" || request.expected_before.ticket_id !== selector.ticket_id) {
    return failure("ACTION_EXPECTED_STATE_STALE", request.action_identity);
  }
  let before: StrategicActionTicketState | undefined;
  try {
    before = await dependencies.ticket.read(selector.ticket_id);
  } catch {
    return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
  }
  if (!before || !sameProtectedState(before, request.expected_before)) {
    return failure("ACTION_EXPECTED_STATE_STALE", request.action_identity);
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const requestSha256 = requestDigest(request);
  const pending = await pendingIntent(request, requestSha256, now);
  if (!("schema_version" in pending)) return pending;
  const mutated = await markMutationAttempted(request, pending, now);
  try {
    if (selector.operation === "ticket_comment") {
      await dependencies.ticket.comment(selector.ticket_id, selector.content, request.action_identity);
    } else {
      await dependencies.ticket.setPriority(selector.ticket_id, selector.priority, request.action_identity);
    }
  } catch {
    return partialIntent(request, mutated, "ACTION_MUTATION_OUTCOME_UNKNOWN", 1);
  }
  let after: StrategicActionTicketState | undefined;
  try {
    after = await dependencies.ticket.read(selector.ticket_id);
  } catch {
    return partialIntent(request, mutated, "ACTION_READBACK_UNAVAILABLE", 1);
  }
  if (!after || !ticketMutationReadbackMatches(before, after, selector, request.action_identity)) {
    return blockedIntent(request, mutated, "ACTION_READBACK_MISMATCH", 1);
  }
  return finalizeTicketReceipt(request, mutated, after, 1, now);
}

function loopReadbackMatches(
  before: StrategicActionLoopState,
  after: StrategicActionLoopState,
  paused: boolean,
): boolean {
  return after.loop_id === before.loop_id
    && after.profile === before.profile
    && after.paused === paused;
}

async function applyLoopPause(
  request: StrategicActionRequest,
  dependencies: Partial<StrategicActionDependencies>,
): Promise<StrategicActionResult> {
  if (request.selector.operation !== "installed_loop_pause" || !dependencies.loop) {
    return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
  }
  const selector = request.selector;
  if (request.expected_before.kind !== "installed_loop"
    || request.expected_before.loop_id !== selector.loop_id
    || request.expected_before.profile !== request.authority.profile) {
    return failure("ACTION_EXPECTED_STATE_STALE", request.action_identity);
  }
  let before: StrategicActionLoopState | undefined;
  try {
    before = await dependencies.loop.read(selector.loop_id);
  } catch {
    return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
  }
  if (!before || !sameProtectedState(before, request.expected_before) || before.paused) {
    return failure("ACTION_EXPECTED_STATE_STALE", request.action_identity);
  }
  const now = dependencies.now ?? (() => new Date().toISOString());
  const requestSha256 = requestDigest(request);
  const pending = await pendingIntent(request, requestSha256, now);
  if (!("schema_version" in pending)) return pending;
  const mutated = await markMutationAttempted(request, pending, now);
  try {
    await dependencies.loop.setPaused(selector.loop_id, true, request.action_identity);
  } catch {
    return partialIntent(request, mutated, "ACTION_MUTATION_OUTCOME_UNKNOWN", 1);
  }
  let after: StrategicActionLoopState | undefined;
  try {
    after = await dependencies.loop.read(selector.loop_id);
  } catch {
    return partialIntent(request, mutated, "ACTION_READBACK_UNAVAILABLE", 1);
  }
  if (!after || !loopReadbackMatches(before, after, true)) {
    return blockedIntent(request, mutated, "ACTION_READBACK_MISMATCH", 1);
  }
  return finalizeStateReceipt(request, mutated, after, "APPLIED", 1, now);
}

async function rollbackTarget(
  request: StrategicActionRequest,
): Promise<StrategicActionReceipt | StrategicActionFailure> {
  if (request.selector.operation !== "rollback") {
    return failure("ROLLBACK_TARGET_INVALID", request.action_identity);
  }
  let target: StrategicActionReceipt;
  try {
    target = (await readReceipt(request.cwd, request.selector.target_receipt_id)).receipt;
  } catch {
    return failure("ROLLBACK_TARGET_INVALID", request.action_identity);
  }
  const targetKindSupported = (target.selector.operation === "installed_loop_pause"
      && target.before.kind === "installed_loop" && target.after.kind === "installed_loop")
    || (target.selector.operation === "ticket_priority"
      && target.before.kind === "ticket" && target.after.kind === "ticket");
  if (target.status !== "APPLIED"
    || target.report.report_id !== request.report.report_id
    || target.report.report_sha256 !== request.report.report_sha256
    || target.authority.installation_id !== request.authority.installation_id
    || target.authority.profile !== request.authority.profile
    || !targetKindSupported
    || !sameProtectedState(target.after, request.expected_before)) {
    return failure("ROLLBACK_TARGET_INVALID", request.action_identity);
  }
  return target;
}

async function applyRollback(
  request: StrategicActionRequest,
  dependencies: Partial<StrategicActionDependencies>,
): Promise<StrategicActionResult> {
  if (request.selector.operation !== "rollback") return failure("ROLLBACK_TARGET_INVALID", request.action_identity);
  const target = await rollbackTarget(request);
  if (!("receipt_id" in target)) return target;
  const now = dependencies.now ?? (() => new Date().toISOString());
  const requestSha256 = requestDigest(request);

  if (target.before.kind === "installed_loop" && target.after.kind === "installed_loop") {
    if (!dependencies.loop) return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
    let current: StrategicActionLoopState | undefined;
    try {
      current = await dependencies.loop.read(target.after.loop_id);
    } catch {
      return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
    }
    if (!current || !sameProtectedState(current, target.after)) {
      return failure("ROLLBACK_TARGET_INVALID", request.action_identity);
    }
    const pending = await pendingIntent(request, requestSha256, now);
    if (!("schema_version" in pending)) return pending;
    const mutated = await markMutationAttempted(request, pending, now);
    try {
      await dependencies.loop.setPaused(target.after.loop_id, target.before.paused, request.action_identity, target.before);
    } catch {
      return partialIntent(request, mutated, "ACTION_MUTATION_OUTCOME_UNKNOWN", 1);
    }
    let restored: StrategicActionLoopState | undefined;
    try {
      restored = await dependencies.loop.read(target.after.loop_id);
    } catch {
      return partialIntent(request, mutated, "ACTION_READBACK_UNAVAILABLE", 1);
    }
    if (!restored || !sameProtectedState(restored, target.before)) {
      return blockedIntent(request, mutated, "ACTION_READBACK_MISMATCH", 1);
    }
    return finalizeStateReceipt(request, mutated, restored, "ROLLED_BACK", 1, now);
  }

  if (target.before.kind === "ticket" && target.after.kind === "ticket") {
    if (!dependencies.ticket) return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
    let current: StrategicActionTicketState | undefined;
    try {
      current = await dependencies.ticket.read(target.after.ticket_id);
    } catch {
      return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
    }
    if (!current || !sameProtectedState(current, target.after)) {
      return failure("ROLLBACK_TARGET_INVALID", request.action_identity);
    }
    const pending = await pendingIntent(request, requestSha256, now);
    if (!("schema_version" in pending)) return pending;
    const mutated = await markMutationAttempted(request, pending, now);
    try {
      await dependencies.ticket.setPriority(target.after.ticket_id, target.before.priority, request.action_identity);
    } catch {
      return partialIntent(request, mutated, "ACTION_MUTATION_OUTCOME_UNKNOWN", 1);
    }
    let restored: StrategicActionTicketState | undefined;
    try {
      restored = await dependencies.ticket.read(target.after.ticket_id);
    } catch {
      return partialIntent(request, mutated, "ACTION_READBACK_UNAVAILABLE", 1);
    }
    if (!restored || !sameProtectedState(restored, target.before)) {
      return blockedIntent(request, mutated, "ACTION_READBACK_MISMATCH", 1);
    }
    return finalizeStateReceipt(request, mutated, restored, "ROLLED_BACK", 1, now);
  }
  return failure("ROLLBACK_TARGET_INVALID", request.action_identity);
}

async function statusResult(
  request: StrategicActionRequest,
  requestSha256: string,
): Promise<StrategicActionResult> {
  const intent = await readIntent(request.cwd, request.action_identity);
  if (!intent) return failure("ACTION_STATUS_NOT_FOUND", request.action_identity);
  if (intent.request_sha256 !== requestSha256) return failure("ACTION_REPLAY_CONFLICT", request.action_identity);
  if (intent.receipt_id) {
    const stored = await readReceipt(request.cwd, intent.receipt_id);
    return success(stored.receipt, stored.receiptBytes, 0);
  }
  return failure(
    "ACTION_PENDING",
    request.action_identity,
    intent.state === "blocked" ? "BLOCKED" : "PARTIAL",
    0,
    pendingReceipt(intent),
  );
}

async function recoverPending(
  request: StrategicActionRequest,
  dependencies: Partial<StrategicActionDependencies>,
): Promise<StrategicActionResult | undefined> {
  const intent = await readIntent(request.cwd, request.action_identity);
  if (!intent || intent.receipt_id) return undefined;
  // Blocked mismatch intents must still re-authenticate live state on apply/replay so an
  // eventually-correct readback can finalize without duplicating the mutation.
  const now = dependencies.now ?? (() => new Date().toISOString());
  const selector = request.selector;

  if (selector.operation === "ticket_reuse_or_create") {
    if (!dependencies.ticket || intent.authenticated_before.kind !== "ticket_search") return undefined;
    let found: StrategicActionTicketState[];
    try {
      found = await dependencies.ticket.search({
        root_cause: selector.root_cause,
        action_identity: request.action_identity,
        owner: null,
      });
    } catch {
      return partialIntent(request, intent, "ACTION_READBACK_UNAVAILABLE", 0);
    }
    const matching = found.filter((ticket) => ticket.root_cause === selector.root_cause
      && (ticket.action_identities.length === 0 || ticket.action_identities.includes(request.action_identity))
      && ticket.owner === null);
    if (matching.length === 0) return undefined;
    if (matching.length !== 1) return blockedIntent(request, intent, "ACTION_READBACK_MISMATCH", 0);
    let exact: StrategicActionTicketState | undefined;
    try {
      exact = await dependencies.ticket.read(matching[0]!.ticket_id);
    } catch {
      return partialIntent(request, intent, "ACTION_READBACK_UNAVAILABLE", 0);
    }
    if (!exact || !sameProtectedState(exact, matching[0]!)) {
      return blockedIntent(request, intent, "ACTION_READBACK_MISMATCH", 0);
    }
    return finalizeTicketReceipt(request, intent, exact, 0, now);
  }

  if (selector.operation === "ticket_comment" || selector.operation === "ticket_priority") {
    if (!dependencies.ticket || intent.authenticated_before.kind !== "ticket" || !intent.mutation_attempted) return undefined;
    let live: StrategicActionTicketState | undefined;
    try {
      live = await dependencies.ticket.read(selector.ticket_id);
    } catch {
      return partialIntent(request, intent, "ACTION_READBACK_UNAVAILABLE", 0);
    }
    if (!live) return blockedIntent(request, intent, "ACTION_READBACK_MISMATCH", 0);
    if (ticketMutationReadbackMatches(intent.authenticated_before, live, selector, request.action_identity)) {
      return finalizeTicketReceipt(request, intent, live, 0, now);
    }
    if (sameProtectedState(live, intent.authenticated_before)) return undefined;
    return blockedIntent(request, intent, "ACTION_READBACK_MISMATCH", 0);
  }

  if (selector.operation === "installed_loop_pause") {
    if (!dependencies.loop || intent.authenticated_before.kind !== "installed_loop" || !intent.mutation_attempted) return undefined;
    let live: StrategicActionLoopState | undefined;
    try {
      live = await dependencies.loop.read(selector.loop_id);
    } catch {
      return partialIntent(request, intent, "ACTION_READBACK_UNAVAILABLE", 0);
    }
    if (!live) return blockedIntent(request, intent, "ACTION_READBACK_MISMATCH", 0);
    if (loopReadbackMatches(intent.authenticated_before, live, true)) {
      return finalizeStateReceipt(request, intent, live, "APPLIED", 0, now);
    }
    if (sameProtectedState(live, intent.authenticated_before)) return undefined;
    return blockedIntent(request, intent, "ACTION_READBACK_MISMATCH", 0);
  }

  if (selector.operation === "rollback") {
    if (!intent.mutation_attempted) return undefined;
    const target = await rollbackTarget(request);
    if (!("receipt_id" in target)) return target;
    if (target.before.kind === "installed_loop" && target.after.kind === "installed_loop") {
      if (!dependencies.loop) return undefined;
      let live: StrategicActionLoopState | undefined;
      try {
        live = await dependencies.loop.read(target.after.loop_id);
      } catch {
        return partialIntent(request, intent, "ACTION_READBACK_UNAVAILABLE", 0);
      }
      if (live && sameProtectedState(live, target.before)) {
        return finalizeStateReceipt(request, intent, live, "ROLLED_BACK", 0, now);
      }
      if (live && sameProtectedState(live, target.after)) return undefined;
      return blockedIntent(request, intent, "ACTION_READBACK_MISMATCH", 0);
    }
    if (target.before.kind === "ticket" && target.after.kind === "ticket") {
      if (!dependencies.ticket) return undefined;
      let live: StrategicActionTicketState | undefined;
      try {
        live = await dependencies.ticket.read(target.after.ticket_id);
      } catch {
        return partialIntent(request, intent, "ACTION_READBACK_UNAVAILABLE", 0);
      }
      if (live && sameProtectedState(live, target.before)) {
        return finalizeStateReceipt(request, intent, live, "ROLLED_BACK", 0, now);
      }
      if (live && sameProtectedState(live, target.after)) return undefined;
      return blockedIntent(request, intent, "ACTION_READBACK_MISMATCH", 0);
    }
  }
  return undefined;
}

function actionTicketState(ticket: StrategicTicketRead): StrategicActionTicketState {
  return {
    kind: "ticket",
    ticket_id: ticket.ticket_id,
    title: ticket.title,
    root_cause: ticket.root_cause,
    action_identities: [...ticket.action_identities],
    owner: ticket.owner,
    priority: ticket.priority,
    comments: ticket.comments.map((comment) => ({ ...comment })),
    provider_proof: { ...ticket.provider_proof },
  };
}

function actionTicketCapability(provider: StrategicTicketCapability): StrategicTicketCapability {
  return {
    async search(query) {
      return (await provider.search(query)).map(actionTicketState);
    },
    async read(id) {
      const ticket = await provider.read(id);
      return ticket ? actionTicketState(ticket) : undefined;
    },
    async create(input) {
      return actionTicketState(await provider.create(input));
    },
    async comment(id, content, actionIdentity) {
      return actionTicketState(await provider.comment(id, content, actionIdentity));
    },
    async setPriority(id, priority, actionIdentity) {
      return actionTicketState(await provider.setPriority(id, priority, actionIdentity));
    },
  };
}

async function productionDependencies(
  request: StrategicActionRequest,
): Promise<Partial<StrategicActionDependencies> | StrategicActionFailure> {
  let resolved: Awaited<ReturnType<typeof resolveHarnessGoal>>;
  try {
    resolved = await resolveHarnessGoal(request.cwd);
  } catch {
    return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
  }
  if (!resolved) return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
  try {
    const state = await new HarnessStore(resolved.root).readStateV3();
    const binding = await verifyCoordinationBinding(resolved.root, resolved.goalId);
    const goal = state.goals[resolved.goalId];
    if (!binding || !goal || goal.backend.kind !== "multica"
      || goal.backend.origin !== binding.server_origin
      || goal.backend.workspace_id !== binding.workspace_id
      || goal.backend.parent_issue_id !== binding.parent_id) {
      if (goal?.backend.kind === "github") {
        const provider = providerForState(state, resolved.goalId);
        const loopId = request.expected_before.kind === "installed_loop"
          ? request.expected_before.loop_id
          : request.selector.operation === "installed_loop_pause"
            ? request.selector.loop_id
            : undefined;
        return {
          ...(provider.strategic ? { ticket: actionTicketCapability(provider.strategic) } : {}),
          ...(loopId ? {
            loop: installedLoopAdapter(resolved.root, {
              installation_id: request.authority.installation_id,
              profile: request.authority.profile,
              loop_id: loopId,
            }),
          } : {}),
        };
      }
      return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
    }
    const provider = providerForState(state, resolved.goalId, { profile: binding.profile });
    const loopId = request.expected_before.kind === "installed_loop"
      ? request.expected_before.loop_id
      : request.selector.operation === "installed_loop_pause"
        ? request.selector.loop_id
        : undefined;
    return {
      ...(provider.strategic ? { ticket: actionTicketCapability(provider.strategic) } : {}),
      ...(loopId ? {
        loop: installedLoopAdapter(resolved.root, {
          installation_id: request.authority.installation_id,
          profile: request.authority.profile,
          loop_id: loopId,
        }),
      } : {}),
    };
  } catch {
    return failure("ACTION_PROVIDER_UNAVAILABLE", request.action_identity);
  }
}

export async function apply(input: StrategicActionRequest): Promise<StrategicActionResult> {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return failure("ACTION_SELECTOR_INVALID");
  const request = parsed.data as StrategicActionRequest;
  try {
    assertNoSecrets({
      action: request.selector.action,
      root_cause: request.selector.operation === "ticket_reuse_or_create" ? request.selector.root_cause : undefined,
      ticket_title: request.selector.operation === "ticket_reuse_or_create" ? request.selector.ticket.title : undefined,
      ticket_brief: request.selector.operation === "ticket_reuse_or_create" ? request.selector.ticket.brief : undefined,
      comment: request.selector.operation === "ticket_comment" ? request.selector.content : undefined,
      pause_reason: request.selector.operation === "installed_loop_pause" ? request.selector.reason : undefined,
    });
  } catch {
    return failure("ACTION_SELECTOR_INVALID", request.action_identity);
  }
  const authenticated = await authenticate(request);
  if (!authenticated.ok) return authenticated;
  const injected = strategicActionTestDependencies.getStore();
  const resolvedDependencies = injected ?? await productionDependencies(request);
  if ("ok" in resolvedDependencies) return resolvedDependencies;
  const dependencies = resolvedDependencies;
  const requestSha256 = requestDigest(request);
  const leaseKey = `action-${request.action_identity.slice(-56)}`;
  try {
    await assertSafeContinuationLeaseTree(request.cwd, leaseKey, "ACTION_STATE_UNAVAILABLE");
    return await withCoordinationLease(request.cwd, leaseKey, async () => {
      await ensureActionStorage(request.cwd);
      const replay = await finalizedReplay(request, requestSha256);
      if (replay) return replay;
      if (request.operation === "status") return statusResult(request, requestSha256);
      const recovered = await recoverPending(request, dependencies);
      if (recovered) return recovered;
      if (request.selector.operation === "ticket_reuse_or_create") {
        return applyTicketOwner(request, dependencies);
      }
      if (request.selector.operation === "ticket_comment" || request.selector.operation === "ticket_priority") {
        return applyTicketMutation(request, dependencies);
      }
      if (request.selector.operation === "installed_loop_pause") {
        return applyLoopPause(request, dependencies);
      }
      if (request.selector.operation === "rollback") {
        return applyRollback(request, dependencies);
      }
      return failure("ACTION_SELECTOR_INVALID", request.action_identity);
    }, dependencies.coordination ?? {});
  } catch (error) {
    if (error instanceof Error && error.message === "action_fault_after_receipt_intent_before_receipt_write") throw error;
    if (error instanceof Error && error.message === "ACTION_REPLAY_CONFLICT") {
      return failure("ACTION_REPLAY_CONFLICT", request.action_identity);
    }
    return failure("ACTION_STATE_UNAVAILABLE", request.action_identity);
  }
}

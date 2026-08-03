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
import {
  review,
  type StrategicReviewRequest,
  type StrategicReviewResult,
} from "./strategic-review.js";

export const KNOWLEDGE_PROMOTION_LESSON_TYPES = [
  "concept",
  "skill",
  "tool",
  "project",
  "query",
  "comparison",
  "summary",
] as const;
export type KnowledgePromotionLessonType = typeof KNOWLEDGE_PROMOTION_LESSON_TYPES[number];

const TYPE_DIR: Record<KnowledgePromotionLessonType, string> = {
  concept: "concepts",
  skill: "skills",
  tool: "tools",
  project: "projects",
  query: "queries",
  comparison: "comparisons",
  summary: "summaries",
};

const FORBIDDEN_CLASSIFICATIONS = new Set([
  "volatile_monitor",
  "credentials",
  "private_runtime",
  "temporary_report",
  "generated_cache",
  "ignored_artifact_leakage",
  "unsupported",
  "ticket_prose",
]);

const BOOTSTRAP_STUB_PAGE_IDS = new Set([
  "llm-knowledge-bases",
  "knowledge-ingestion",
]);

export interface KnowledgeSearchIndexAdapter {
  query(vaultRoot: string, query: string): Promise<
    | { ok: true; hits: string[] }
    | { ok: false; reason: "UNAVAILABLE" }
  >;
}

export interface KnowledgePromotionDependencies {
  reviewReport(request: StrategicReviewRequest): Promise<StrategicReviewResult>;
  ticket: StrategicTicketCapability;
  searchIndex: KnowledgeSearchIndexAdapter;
  now(): string;
  coordination: CoordinationDeps;
}

export interface KnowledgePromotionRequest {
  cwd: string;
  operation: "promote" | "status" | "replay" | "rollback";
  promotion_identity: string;
  worker: { worker_id: string; authenticated_at: string; proof: string };
  ticket: { ticket_id: string; linked_action_receipt_id: string; linked_action_identity: string };
  report: {
    report_id: string;
    report_sha256: string;
    report_bytes: string;
    authentication: Omit<StrategicReviewRequest, "cwd" | "operation" | "report_id">;
  };
  action: {
    receipt_id: string;
    receipt_sha256: string;
    receipt_bytes: string;
    action_identity: string;
  };
  producer: { worker_id: string; finalized_at: string };
  raw: {
    bytes: string;
    provenance: {
      origin: string;
      source_uri: string;
      content_type: string;
      type_metadata?: Record<string, string>;
    };
    classification: string;
  };
  lesson: {
    page_id: string;
    title: string;
    type: KnowledgePromotionLessonType;
    tags: string[];
    body: string;
    confidence: "high" | "medium" | "low";
    contradictions: Array<{ claim: string; source: string; date: string }>;
    related_page_ids: string[];
    search_query: string;
    evidence_reference_ids: string[];
    owns_actionable_work?: boolean;
  };
  target_receipt_id?: string;
}

export interface KnowledgePromotionFailure {
  ok: false;
  status: "PARTIAL" | "BLOCKED";
  reason: string;
  promotion_identity?: string;
  follow_up_ticket_id?: string;
  mutation_count: 0 | 1;
}

export interface KnowledgePromotionReceipt {
  schema_version: 1;
  receipt_id: string;
  promotion_identity: string;
  request_sha256: string;
  status: "PROMOTED" | "PARTIAL" | "ROLLED_BACK";
  worker: KnowledgePromotionRequest["worker"];
  producer: KnowledgePromotionRequest["producer"];
  ticket: KnowledgePromotionRequest["ticket"];
  evidence: {
    action_receipt_id: string;
    report_id: string;
  };
  raw: {
    body_sha256: string;
    provenance: KnowledgePromotionRequest["raw"]["provenance"];
    ingested_at: string;
    content_type: string;
    storage_path: string;
  };
  curated: {
    page_id: string;
    prior_page_id: string | null;
    content_sha256: string;
    prior_content_sha256: string | null;
    path: string;
    readback_ok: boolean;
  };
  provenance: {
    origin: string;
    source_uri: string;
    content_type: string;
  };
  index: { updated: boolean };
  log: { appended: boolean; entry_count_delta: number };
  query: { ok: boolean; hits?: string[]; reason?: "UNAVAILABLE" };
  lint: {
    ok: boolean;
    classifications: Array<"metadata" | "links" | "orphan_policy" | "index_coherence" | "drift">;
  };
  repository: {
    durable_markdown: boolean;
    ignore_ok: boolean;
    secret_leakage: boolean;
    generated_index_included: boolean;
  };
  git_mutation: { commit: false; push: false; merge: false; history_rewrite: false };
  global_memory_write: false;
  protected_state_digest: string;
  timestamps: {
    intended_at: string;
    mutated_at: string;
    finalized_at: string;
  };
}

export interface KnowledgePromotionSuccess {
  ok: true;
  status: "PROMOTED" | "PARTIAL" | "ROLLED_BACK";
  receipt_id: string;
  receipt_sha256: string;
  receipt_bytes: string;
  storage_reference: string;
  receipt: KnowledgePromotionReceipt;
  mutation_count: 0 | 1;
}

export type KnowledgePromotionResult = KnowledgePromotionFailure | KnowledgePromotionSuccess;

const knowledgePromotionTestDependencies =
  new AsyncLocalStorage<Partial<KnowledgePromotionDependencies>>();

/** @internal Production-shaped dependency wrapper for public-seam tests only. */
export async function withKnowledgePromotionTestDependencies<T>(
  dependencies: Partial<KnowledgePromotionDependencies>,
  operation: () => Promise<T>,
): Promise<T> {
  return knowledgePromotionTestDependencies.run(dependencies, operation);
}

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPORT_ID = /^review-[a-f0-9]{64}$/;
const ACTION_ID = /^action-[a-f0-9]{64}$/;
const ACTION_RECEIPT_ID = /^action-receipt-[a-f0-9]{64}$/;
const PROMOTION_ID = /^promotion-[a-f0-9]{64}$/;
const RECEIPT_ID = /^promotion-receipt-[a-f0-9]{64}$/;
const PAGE_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

const ContradictionSchema = z.object({
  claim: z.string().min(1).max(4096),
  source: z.string().min(1).max(2048),
  date: z.string().min(1).max(64),
}).strict();

const RequestSchema = z.object({
  cwd: z.string().min(1).max(4096),
  operation: z.enum(["promote", "status", "replay", "rollback"]),
  promotion_identity: z.string().regex(PROMOTION_ID),
  worker: z.object({
    worker_id: z.string().min(1).max(256),
    authenticated_at: z.string().datetime(),
    proof: z.string().min(1).max(4096),
  }).strict(),
  ticket: z.object({
    ticket_id: z.string().regex(SAFE_REF),
    linked_action_receipt_id: z.string().regex(ACTION_RECEIPT_ID),
    linked_action_identity: z.string().regex(ACTION_ID),
  }).strict(),
  report: z.object({
    report_id: z.string().regex(REPORT_ID),
    report_sha256: z.string().regex(SHA256),
    report_bytes: z.string().min(1).max(1024 * 1024),
    authentication: z.record(z.unknown()),
  }).strict(),
  action: z.object({
    receipt_id: z.string().regex(ACTION_RECEIPT_ID),
    receipt_sha256: z.string().regex(SHA256),
    receipt_bytes: z.string().min(1).max(1024 * 1024),
    action_identity: z.string().regex(ACTION_ID),
  }).strict(),
  producer: z.object({
    worker_id: z.string().min(1).max(256),
    finalized_at: z.string().datetime(),
  }).strict(),
  raw: z.object({
    bytes: z.string().min(1).max(1024 * 1024),
    provenance: z.object({
      origin: z.string().max(2048),
      source_uri: z.string().max(4096),
      content_type: z.string().min(1).max(256),
      type_metadata: z.record(z.string()).optional(),
    }).strict(),
    classification: z.string().min(1).max(128),
  }).strict(),
  lesson: z.object({
    page_id: z.string().regex(PAGE_ID),
    title: z.string().min(1).max(512),
    type: z.enum(KNOWLEDGE_PROMOTION_LESSON_TYPES),
    tags: z.array(z.string().min(1).max(128)).max(64),
    body: z.string().min(1).max(256 * 1024),
    confidence: z.enum(["high", "medium", "low"]),
    contradictions: z.array(ContradictionSchema).max(64),
    related_page_ids: z.array(z.string().min(1).max(256)).max(64),
    search_query: z.string().min(1).max(1024),
    evidence_reference_ids: z.array(z.string().regex(SAFE_REF)).max(128),
    owns_actionable_work: z.boolean().optional(),
  }).strict(),
  target_receipt_id: z.string().regex(RECEIPT_ID).optional(),
}).strict();

const ReceiptSchema = z.object({
  schema_version: z.literal(1),
  receipt_id: z.string().regex(RECEIPT_ID),
  promotion_identity: z.string().regex(PROMOTION_ID),
  request_sha256: z.string().regex(SHA256),
  status: z.enum(["PROMOTED", "PARTIAL", "ROLLED_BACK"]),
  worker: RequestSchema.shape.worker,
  producer: RequestSchema.shape.producer,
  ticket: RequestSchema.shape.ticket,
  evidence: z.object({
    action_receipt_id: z.string().regex(ACTION_RECEIPT_ID),
    report_id: z.string().regex(REPORT_ID),
  }).strict(),
  raw: z.object({
    body_sha256: z.string().regex(SHA256),
    provenance: RequestSchema.shape.raw.shape.provenance,
    ingested_at: z.string().datetime(),
    content_type: z.string().min(1).max(256),
    storage_path: z.string().min(1).max(1024),
  }).strict(),
  curated: z.object({
    page_id: z.string().regex(PAGE_ID),
    prior_page_id: z.string().regex(PAGE_ID).nullable(),
    content_sha256: z.string().regex(SHA256),
    prior_content_sha256: z.string().regex(SHA256).nullable(),
    path: z.string().min(1).max(1024),
    readback_ok: z.boolean(),
  }).strict(),
  provenance: z.object({
    origin: z.string().min(1).max(2048),
    source_uri: z.string().min(1).max(4096),
    content_type: z.string().min(1).max(256),
  }).strict(),
  index: z.object({ updated: z.boolean() }).strict(),
  log: z.object({
    appended: z.boolean(),
    entry_count_delta: z.number().int().min(0).max(8),
  }).strict(),
  query: z.object({
    ok: z.boolean(),
    hits: z.array(z.string()).optional(),
    reason: z.literal("UNAVAILABLE").optional(),
  }).strict(),
  lint: z.object({
    ok: z.boolean(),
    classifications: z.array(z.enum([
      "metadata",
      "links",
      "orphan_policy",
      "index_coherence",
      "drift",
    ])),
  }).strict(),
  repository: z.object({
    durable_markdown: z.boolean(),
    ignore_ok: z.boolean(),
    secret_leakage: z.boolean(),
    generated_index_included: z.boolean(),
  }).strict(),
  git_mutation: z.object({
    commit: z.literal(false),
    push: z.literal(false),
    merge: z.literal(false),
    history_rewrite: z.literal(false),
  }).strict(),
  global_memory_write: z.literal(false),
  protected_state_digest: z.string().regex(SHA256),
  timestamps: z.object({
    intended_at: z.string().datetime(),
    mutated_at: z.string().datetime(),
    finalized_at: z.string().datetime(),
  }).strict(),
}).strict();

interface KnowledgePromotionIntent {
  schema_version: 1;
  promotion_identity: string;
  request_sha256: string;
  state: "pending" | "partial" | "blocked" | "finalized";
  intended_at: string;
  mutation_attempted: boolean;
  mutated_at?: string;
  receipt_id?: string;
  receipt_bytes?: string;
  follow_up_ticket_id?: string;
}

const IntentSchema = z.object({
  schema_version: z.literal(1),
  promotion_identity: z.string().regex(PROMOTION_ID),
  request_sha256: z.string().regex(SHA256),
  state: z.enum(["pending", "partial", "blocked", "finalized"]),
  intended_at: z.string().datetime(),
  mutation_attempted: z.boolean(),
  mutated_at: z.string().datetime().optional(),
  receipt_id: z.string().regex(RECEIPT_ID).optional(),
  receipt_bytes: z.string().min(1).max(1024 * 1024).optional(),
  follow_up_ticket_id: z.string().regex(SAFE_REF).optional(),
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function canonicalKnowledgePromotionIdentity(input: {
  ticket_id: string;
  action_receipt_id: string;
  page_id: string;
  raw_body_sha256: string;
}): string {
  return `promotion-${sha256(canonicalJson({
    schema_version: 1,
    ticket_id: input.ticket_id,
    action_receipt_id: input.action_receipt_id,
    page_id: input.page_id,
    raw_body_sha256: input.raw_body_sha256,
  }))}`;
}

function failure(
  reason: string,
  promotionIdentity?: string,
  status: "PARTIAL" | "BLOCKED" = "BLOCKED",
  mutationCount: 0 | 1 = 0,
  followUpTicketId?: string,
): KnowledgePromotionFailure {
  return {
    ok: false,
    status,
    reason,
    ...(promotionIdentity ? { promotion_identity: promotionIdentity } : {}),
    ...(followUpTicketId ? { follow_up_ticket_id: followUpTicketId } : {}),
    mutation_count: mutationCount,
  };
}

function requestDigest(request: KnowledgePromotionRequest): string {
  return sha256(canonicalJson({
    schema_version: 1,
    promotion_identity: request.promotion_identity,
    operation: request.operation === "rollback" ? "rollback" : "promote",
    worker: request.worker,
    ticket: request.ticket,
    report: {
      report_id: request.report.report_id,
      report_sha256: request.report.report_sha256,
    },
    action: {
      receipt_id: request.action.receipt_id,
      receipt_sha256: request.action.receipt_sha256,
      action_identity: request.action.action_identity,
    },
    producer: request.producer,
    raw: {
      bytes_sha256: sha256(request.raw.bytes),
      provenance: request.raw.provenance,
      classification: request.raw.classification,
    },
    lesson: request.lesson,
    target_receipt_id: request.target_receipt_id,
  }));
}

function promotionStorage(root: string): { root: string; intents: string; receipts: string } {
  const storageRoot = path.join(root, HARNESS_DIR_NAME, "autonomy", "knowledge-promotions");
  return {
    root: storageRoot,
    intents: path.join(storageRoot, "intents"),
    receipts: path.join(storageRoot, "receipts"),
  };
}

function vaultRoot(root: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "knowledge-base");
}

function intentStorageKey(promotionIdentity: string, operation: KnowledgePromotionRequest["operation"]): string {
  return operation === "rollback" ? `${promotionIdentity}__rollback` : promotionIdentity;
}

function intentFile(root: string, promotionIdentity: string, operation: KnowledgePromotionRequest["operation"] = "promote"): string {
  return path.join(promotionStorage(root).intents, `${intentStorageKey(promotionIdentity, operation)}.json`);
}

function receiptFile(root: string, receiptId: string): string {
  return path.join(promotionStorage(root).receipts, `${receiptId}.json`);
}

async function ensurePromotionStorage(root: string): Promise<void> {
  const storage = promotionStorage(root);
  const harness = path.join(root, HARNESS_DIR_NAME);
  const autonomy = path.join(harness, "autonomy");
  for (const directory of [harness, autonomy, storage.root, storage.intents, storage.receipts]) {
    await assertSafeContinuationStoragePath(root, directory, "directory", "PROMOTION_STATE_UNAVAILABLE");
  }
  await fs.mkdir(storage.intents, { recursive: true });
  await fs.mkdir(storage.receipts, { recursive: true });
  for (const directory of [harness, autonomy, storage.root, storage.intents, storage.receipts]) {
    await assertSafeContinuationStoragePath(root, directory, "directory", "PROMOTION_STATE_UNAVAILABLE");
  }
}

async function readIntent(
  root: string,
  promotionIdentity: string,
  operation: KnowledgePromotionRequest["operation"] = "promote",
): Promise<KnowledgePromotionIntent | undefined> {
  const file = intentFile(root, promotionIdentity, operation);
  await assertSafeContinuationStoragePath(root, file, "file", "PROMOTION_STATE_UNAVAILABLE");
  const raw = await readJsonIfExists<unknown>(file);
  if (raw === undefined) return undefined;
  const parsed = IntentSchema.safeParse(raw);
  if (!parsed.success || parsed.data.promotion_identity !== promotionIdentity) {
    throw new Error("PROMOTION_STATE_UNAVAILABLE");
  }
  return parsed.data as KnowledgePromotionIntent;
}

async function writeIntent(
  root: string,
  intent: KnowledgePromotionIntent,
  operation: KnowledgePromotionRequest["operation"] = "promote",
): Promise<KnowledgePromotionIntent> {
  const file = intentFile(root, intent.promotion_identity, operation);
  await assertSafeContinuationStoragePath(root, file, "file", "PROMOTION_STATE_UNAVAILABLE");
  await writeJsonAtomic(file, IntentSchema.parse(intent));
  const readback = await readIntent(root, intent.promotion_identity, operation);
  if (!readback || canonicalJson(readback) !== canonicalJson(intent)) {
    throw new Error("PROMOTION_STATE_UNAVAILABLE");
  }
  return readback;
}

function receiptIdentity(receipt: Omit<KnowledgePromotionReceipt, "receipt_id">): string {
  return `promotion-receipt-${sha256(canonicalJson(receipt))}`;
}

function parseReceiptBytes(receiptId: string, receiptBytes: string): KnowledgePromotionReceipt {
  let raw: unknown;
  try {
    raw = JSON.parse(receiptBytes) as unknown;
  } catch {
    throw new Error("PROMOTION_STATE_UNAVAILABLE");
  }
  const parsed = ReceiptSchema.safeParse(raw);
  if (!parsed.success) throw new Error("PROMOTION_STATE_UNAVAILABLE");
  const receipt = parsed.data as KnowledgePromotionReceipt;
  const { receipt_id: _receiptId, ...body } = receipt;
  if (receipt.receipt_id !== receiptId
    || receiptIdentity(body) !== receiptId
    || `${canonicalJson(receipt)}\n` !== receiptBytes) {
    throw new Error("PROMOTION_STATE_UNAVAILABLE");
  }
  return receipt;
}

async function readReceipt(root: string, receiptId: string): Promise<{
  receipt: KnowledgePromotionReceipt;
  receiptBytes: string;
}> {
  const file = receiptFile(root, receiptId);
  await assertSafeContinuationStoragePath(root, file, "file", "PROMOTION_STATE_UNAVAILABLE");
  const receiptBytes = await fs.readFile(file, "utf8");
  return { receipt: parseReceiptBytes(receiptId, receiptBytes), receiptBytes };
}

async function writeReceipt(
  root: string,
  receipt: KnowledgePromotionReceipt,
  canonicalBytes?: string,
): Promise<{ receipt: KnowledgePromotionReceipt; receiptBytes: string }> {
  const file = receiptFile(root, receipt.receipt_id);
  await assertSafeContinuationStoragePath(root, file, "file", "PROMOTION_STATE_UNAVAILABLE");
  const receiptBytes = `${canonicalJson(ReceiptSchema.parse(receipt))}\n`;
  if (canonicalBytes !== undefined && canonicalBytes !== receiptBytes) {
    throw new Error("PROMOTION_STATE_UNAVAILABLE");
  }
  let existing: string | undefined;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined && existing !== receiptBytes) throw new Error("PROMOTION_REPLAY_CONFLICT");
  if (existing === undefined) {
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    await assertSafeContinuationStoragePath(root, temporary, "file", "PROMOTION_STATE_UNAVAILABLE");
    await fs.writeFile(temporary, receiptBytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await fs.rename(temporary, file);
  }
  return readReceipt(root, receipt.receipt_id);
}

function success(
  receipt: KnowledgePromotionReceipt,
  receiptBytes: string,
  mutationCount: 0 | 1,
): KnowledgePromotionSuccess {
  return {
    ok: true,
    status: receipt.status,
    receipt_id: receipt.receipt_id,
    receipt_sha256: sha256(receiptBytes),
    receipt_bytes: receiptBytes,
    storage_reference: `${HARNESS_DIR_NAME}/autonomy/knowledge-promotions/receipts/${receipt.receipt_id}.json`,
    receipt,
    mutation_count: mutationCount,
  };
}

async function persistFinalReceipt(
  request: KnowledgePromotionRequest,
  intent: KnowledgePromotionIntent,
  receipt: KnowledgePromotionReceipt,
  mutatedAt: string,
  mutationCount: 0 | 1,
): Promise<KnowledgePromotionSuccess> {
  const receiptBytes = `${canonicalJson(ReceiptSchema.parse(receipt))}\n`;
  const receiptIntent = await writeIntent(request.cwd, {
    ...intent,
    mutated_at: mutatedAt,
    receipt_id: receipt.receipt_id,
    receipt_bytes: receiptBytes,
  });
  const stored = await writeReceipt(request.cwd, receipt, receiptBytes);
  await writeIntent(request.cwd, { ...receiptIntent, state: "finalized" });
  return success(stored.receipt, stored.receiptBytes, mutationCount);
}

async function finalizedReplay(
  request: KnowledgePromotionRequest,
  requestSha256: string,
): Promise<KnowledgePromotionSuccess | KnowledgePromotionFailure | undefined> {
  const existing = await readIntent(request.cwd, request.promotion_identity, request.operation);
  if (!existing) return undefined;
  if (existing.request_sha256 !== requestSha256) {
    return failure("PROMOTION_REPLAY_CONFLICT", request.promotion_identity);
  }
  if (!existing.receipt_id) return undefined;
  const intentReceipt = existing.receipt_bytes
    ? parseReceiptBytes(existing.receipt_id, existing.receipt_bytes)
    : undefined;
  if (intentReceipt && (intentReceipt.promotion_identity !== request.promotion_identity
    || intentReceipt.request_sha256 !== requestSha256)) {
    return failure("PROMOTION_REPLAY_CONFLICT", request.promotion_identity);
  }
  const stored = intentReceipt && existing.receipt_bytes
    ? await writeReceipt(request.cwd, intentReceipt, existing.receipt_bytes)
    : await readReceipt(request.cwd, existing.receipt_id);
  if (stored.receipt.promotion_identity !== request.promotion_identity
    || stored.receipt.request_sha256 !== requestSha256) {
    return failure("PROMOTION_REPLAY_CONFLICT", request.promotion_identity);
  }
  if (existing.state !== "finalized") {
    await writeIntent(request.cwd, { ...existing, state: "finalized" }, request.operation);
  }
  return success(stored.receipt, stored.receiptBytes, 0);
}

function dayStamp(iso: string): string {
  return iso.slice(0, 10);
}

function stubPage(title: string, pageType: KnowledgePromotionLessonType, pageId: string, nowIso: string): string {
  return `---
title: ${title}
created: ${dayStamp(nowIso)}
updated: ${dayStamp(nowIso)}
type: ${pageType}
tags: [knowledge-base]
sources: []
confidence: medium
contradictions: []
ticket: null
evidence: []
related: []
---

# ${title}

Bootstrap stub for [[${TYPE_DIR[pageType]}/${pageId}]].
`;
}

async function ensureVaultBootstrapped(root: string, nowIso: string): Promise<string> {
  const vault = vaultRoot(root);
  const harness = path.join(root, HARNESS_DIR_NAME);
  const autonomy = path.join(harness, "autonomy");
  for (const directory of [
    harness,
    autonomy,
    vault,
    path.join(vault, "raw", "articles"),
    path.join(vault, "raw", "drift"),
    path.join(vault, "pointers"),
    path.join(vault, "versions"),
    ...Object.values(TYPE_DIR).map((dir) => path.join(vault, dir)),
  ]) {
    await assertSafeContinuationStoragePath(root, directory, "directory", "PROMOTION_STATE_UNAVAILABLE");
    await fs.mkdir(directory, { recursive: true });
  }

  const schemaPath = path.join(vault, "SCHEMA.md");
  await assertSafeContinuationStoragePath(root, schemaPath, "file", "PROMOTION_STATE_UNAVAILABLE");
  try {
    await fs.access(schemaPath);
  } catch {
    await fs.writeFile(schemaPath, `# Knowledge Base Schema

- Raw sources under \`raw/articles\` are immutable and content-addressed.
- Curated pages use YAML frontmatter and wikilinks.
- Every promote updates \`index.md\` and appends to \`log.md\`.
`, "utf8");
  }

  const indexPath = path.join(vault, "index.md");
  await assertSafeContinuationStoragePath(root, indexPath, "file", "PROMOTION_STATE_UNAVAILABLE");
  try {
    await fs.access(indexPath);
  } catch {
    await fs.writeFile(indexPath, `# Vault Index

> Content catalog for the compiled wiki.

`, "utf8");
  }

  const logPath = path.join(vault, "log.md");
  await assertSafeContinuationStoragePath(root, logPath, "file", "PROMOTION_STATE_UNAVAILABLE");
  try {
    await fs.access(logPath);
  } catch {
    await fs.writeFile(logPath, `# Vault Log

> Chronological record of vault operations.

`, "utf8");
  }

  const gitignorePath = path.join(vault, ".gitignore");
  await assertSafeContinuationStoragePath(root, gitignorePath, "file", "PROMOTION_STATE_UNAVAILABLE");
  try {
    await fs.access(gitignorePath);
  } catch {
    await fs.writeFile(gitignorePath, `.qmd-cache
.obsidian/workspace*
*.local-index
`, "utf8");
  }

  const stubs: Array<{ type: KnowledgePromotionLessonType; id: string; title: string }> = [
    { type: "concept", id: "llm-knowledge-bases", title: "LLM Knowledge Bases" },
    { type: "skill", id: "knowledge-ingestion", title: "Knowledge Ingestion" },
  ];
  for (const stub of stubs) {
    const file = path.join(vault, TYPE_DIR[stub.type], `${stub.id}.md`);
    await assertSafeContinuationStoragePath(root, file, "file", "PROMOTION_STATE_UNAVAILABLE");
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, stubPage(stub.title, stub.type, stub.id, nowIso), "utf8");
    }
  }
  return vault;
}

async function filesystemSearchIndex(): Promise<KnowledgeSearchIndexAdapter> {
  return {
    async query(vault, query) {
      const hits: string[] = [];
      const needle = query.trim().toLowerCase();
      if (!needle) return { ok: true, hits };
      for (const dir of Object.values(TYPE_DIR)) {
        const folder = path.join(vault, dir);
        let entries: string[] = [];
        try {
          entries = await fs.readdir(folder);
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (!entry.endsWith(".md")) continue;
          const pageId = entry.slice(0, -3);
          const full = path.join(folder, entry);
          let body = "";
          try {
            body = await fs.readFile(full, "utf8");
          } catch {
            continue;
          }
          const hay = `${pageId}\n${body}`.toLowerCase();
          const terms = needle.split(/\s+/).filter(Boolean);
          if (terms.every((term) => hay.includes(term)) || hay.includes(needle) || pageId.includes(needle)) {
            hits.push(pageId);
            hits.push(`${dir}/${pageId}`);
          }
        }
      }
      return { ok: true, hits: [...new Set(hits)].sort() };
    },
  };
}

async function findOriginBodyHash(vault: string, origin: string): Promise<string | undefined> {
  const articles = path.join(vault, "raw", "articles");
  let entries: string[] = [];
  try {
    entries = await fs.readdir(articles);
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".meta.json")) continue;
    const metaPath = path.join(articles, entry);
    const meta = await readJsonIfExists<{ provenance?: { origin?: string }; body_sha256?: string }>(metaPath);
    if (meta?.provenance?.origin === origin && typeof meta.body_sha256 === "string") {
      return meta.body_sha256;
    }
  }
  return undefined;
}

function yamlEscape(value: string): string {
  if (/[:#{}[\],&*?|>!%@`]/.test(value) || value.includes("\n") || value.includes('"')) {
    return JSON.stringify(value);
  }
  return value;
}

function renderFrontmatter(input: {
  title: string;
  created: string;
  updated: string;
  type: KnowledgePromotionLessonType;
  tags: string[];
  sources: string[];
  confidence: "high" | "medium" | "low";
  contradictions: Array<{ claim: string; source: string; date: string }>;
  ticket: string;
  evidence: string[];
  related: string[];
}): string {
  const contradictions = input.contradictions.length === 0
    ? "[]"
    : `\n${input.contradictions.map((item) =>
      `  - claim: ${yamlEscape(item.claim)}\n    source: ${yamlEscape(item.source)}\n    date: ${yamlEscape(item.date)}`
    ).join("\n")}`;
  return `---
title: ${yamlEscape(input.title)}
created: ${input.created}
updated: ${input.updated}
type: ${input.type}
tags: [${input.tags.map(yamlEscape).join(", ")}]
sources: [${input.sources.map(yamlEscape).join(", ")}]
confidence: ${input.confidence}
contradictions: ${contradictions}
ticket: ${yamlEscape(input.ticket)}
evidence: [${input.evidence.map(yamlEscape).join(", ")}]
related: [${input.related.map(yamlEscape).join(", ")}]
---
`;
}

function curatedRelativePath(lessonType: KnowledgePromotionLessonType, pageId: string): string {
  return `${TYPE_DIR[lessonType]}/${pageId}.md`;
}

function parseFrontmatter(markdown: string): Record<string, string> | undefined {
  if (!markdown.startsWith("---\n")) return undefined;
  const end = markdown.indexOf("\n---\n", 4);
  if (end < 0) return undefined;
  const block = markdown.slice(4, end);
  const fields: Record<string, string> = {};
  for (const line of block.split("\n")) {
    const match = /^(title|created|updated|type|tags|sources|confidence|ticket|evidence|related):\s*(.*)$/.exec(line);
    if (match) fields[match[1]!] = match[2]!;
  }
  return fields;
}

async function regenerateIndex(vault: string): Promise<void> {
  const lines = [
    "# Vault Index",
    "",
    "> Content catalog for the compiled wiki.",
    "",
  ];
  for (const [lessonType, dir] of Object.entries(TYPE_DIR) as Array<[KnowledgePromotionLessonType, string]>) {
    const folder = path.join(vault, dir);
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(folder)).filter((name) => name.endsWith(".md")).sort();
    } catch {
      entries = [];
    }
    if (entries.length === 0) continue;
    lines.push(`## ${dir}`);
    lines.push("");
    for (const entry of entries) {
      const pageId = entry.slice(0, -3);
      const body = await fs.readFile(path.join(folder, entry), "utf8");
      const fm = parseFrontmatter(body);
      const title = fm?.title?.replace(/^"|"$/g, "") ?? pageId;
      lines.push(`- [[${dir}/${pageId}]] — ${title}`);
    }
    lines.push("");
    void lessonType;
  }
  const indexPath = path.join(vault, "index.md");
  await fs.writeFile(indexPath, `${lines.join("\n")}\n`, "utf8");
}

async function appendLog(vault: string, kind: "promote" | "rollback", summary: string, nowIso: string): Promise<void> {
  const logPath = path.join(vault, "log.md");
  const existing = await fs.readFile(logPath, "utf8");
  const entry = `## [${dayStamp(nowIso)}] ${kind} | ${summary}\n`;
  await fs.writeFile(logPath, `${existing.trimEnd()}\n\n${entry}`, "utf8");
}

async function readPointer(vault: string, pageId: string): Promise<{
  content_sha256: string;
  path: string;
  updated_at: string;
  receipt_id: string;
} | undefined> {
  return readJsonIfExists(path.join(vault, "pointers", `${pageId}.json`));
}

async function writePointer(vault: string, pageId: string, pointer: {
  content_sha256: string;
  path: string;
  updated_at: string;
  receipt_id: string;
}): Promise<void> {
  await writeJsonAtomic(path.join(vault, "pointers", `${pageId}.json`), pointer);
}

function lintPage(input: {
  markdown: string;
  pageId: string;
  relatedPageIds: string[];
  indexMarkdown: string;
  origin: string;
  hasUnresolvedDrift: boolean;
}): KnowledgePromotionReceipt["lint"] {
  const fm = parseFrontmatter(input.markdown);
  const classifications: KnowledgePromotionReceipt["lint"]["classifications"] = [];
  const required = ["title", "created", "updated", "type", "tags", "sources", "confidence", "ticket", "evidence"];
  if (fm && required.every((key) => key in fm)) classifications.push("metadata");
  const hasLinks = input.relatedPageIds.length === 0
    || input.relatedPageIds.every((id) =>
      input.markdown.includes(`[[${id}]]`)
      || Object.values(TYPE_DIR).some((dir) => input.markdown.includes(`[[${dir}/${id}]]`)));
  if (hasLinks) classifications.push("links");
  if (fm && /sources:\s*\[.+\]/.test(`sources: ${fm.sources ?? ""}`)) classifications.push("orphan_policy");
  if (input.indexMarkdown.includes(input.pageId)) classifications.push("index_coherence");
  if (!input.hasUnresolvedDrift) classifications.push("drift");
  void input.origin;
  return {
    ok: classifications.length === 5,
    classifications,
  };
}

async function findCuratedPage(
  vault: string,
  pageId: string,
): Promise<{ type: KnowledgePromotionLessonType; relativePath: string } | undefined> {
  for (const [lessonType, dir] of Object.entries(TYPE_DIR) as Array<[KnowledgePromotionLessonType, string]>) {
    const relativePath = `${dir}/${pageId}.md`;
    try {
      await fs.access(path.join(vault, relativePath));
      return { type: lessonType, relativePath };
    } catch {
      // keep scanning type directories
    }
  }
  return undefined;
}

async function resolvePromotionTarget(
  vault: string,
  request: KnowledgePromotionRequest,
  searchResult: Awaited<ReturnType<KnowledgeSearchIndexAdapter["query"]>>,
): Promise<{ pageId: string; type: KnowledgePromotionLessonType }> {
  const requested = request.lesson.page_id;
  const existingRequested = await findCuratedPage(vault, requested);
  if (existingRequested) {
    return { pageId: requested, type: existingRequested.type };
  }
  if (searchResult.ok) {
    const seen = new Set<string>();
    for (const hit of searchResult.hits) {
      const pageId = hit.includes("/") ? hit.split("/").pop()! : hit;
      if (!PAGE_ID.test(pageId) || seen.has(pageId) || BOOTSTRAP_STUB_PAGE_IDS.has(pageId)) {
        continue;
      }
      seen.add(pageId);
      const found = await findCuratedPage(vault, pageId);
      if (found) return { pageId, type: found.type };
    }
  }
  return { pageId: requested, type: request.lesson.type };
}

function repositoryIsUnsafe(repository: KnowledgePromotionReceipt["repository"]): boolean {
  return !repository.durable_markdown
    || !repository.ignore_ok
    || repository.secret_leakage
    || repository.generated_index_included;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function classifyRepository(vault: string): Promise<KnowledgePromotionReceipt["repository"]> {
  let ignoreOk = false;
  try {
    const ignore = await fs.readFile(path.join(vault, ".gitignore"), "utf8");
    ignoreOk = ignore.includes(".qmd-cache")
      && ignore.includes(".obsidian/workspace")
      && ignore.includes("*.local-index");
  } catch {
    ignoreOk = false;
  }

  let durableMarkdown = false;
  try {
    const hasSchema = await pathExists(path.join(vault, "SCHEMA.md"));
    const hasIndex = await pathExists(path.join(vault, "index.md"));
    let hasCuratedMarkdown = false;
    for (const dir of Object.values(TYPE_DIR)) {
      const folder = path.join(vault, dir);
      let entries: string[] = [];
      try {
        entries = await fs.readdir(folder);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const body = await fs.readFile(path.join(folder, entry), "utf8");
        if (parseFrontmatter(body)) {
          hasCuratedMarkdown = true;
          break;
        }
      }
      if (hasCuratedMarkdown) break;
    }
    durableMarkdown = hasSchema && hasIndex && hasCuratedMarkdown;
  } catch {
    durableMarkdown = false;
  }

  let generatedIndexIncluded = false;
  const generatedMarkers = [
    path.join(vault, ".qmd-cache"),
    path.join(vault, ".obsidian", "workspace"),
    path.join(vault, ".obsidian", "workspace.json"),
  ];
  for (const marker of generatedMarkers) {
    if (await pathExists(marker)) {
      generatedIndexIncluded = true;
      break;
    }
  }
  if (!generatedIndexIncluded) {
    try {
      const entries = await fs.readdir(vault);
      if (entries.some((entry) => entry.endsWith(".local-index"))) {
        generatedIndexIncluded = true;
      }
    } catch {
      // fail closed only when marker presence is proven
    }
  }

  let secretLeakage = false;
  const scanRoots = [
    ...Object.values(TYPE_DIR).map((dir) => path.join(vault, dir)),
    path.join(vault, "raw", "articles"),
  ];
  for (const folder of scanRoots) {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(folder);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const body = await fs.readFile(path.join(folder, entry), "utf8");
      try {
        assertNoSecrets({ [`repository:${folder}/${entry}`]: body });
      } catch {
        secretLeakage = true;
        break;
      }
    }
    if (secretLeakage) break;
  }

  return {
    durable_markdown: durableMarkdown,
    ignore_ok: ignoreOk,
    secret_leakage: secretLeakage,
    generated_index_included: generatedIndexIncluded,
  };
}

function protectedDigest(input: {
  pageId: string;
  contentSha256: string;
  rawSha256: string;
  pointerPath: string;
}): string {
  return sha256(canonicalJson({
    schema_version: 1,
    page_id: input.pageId,
    content_sha256: input.contentSha256,
    raw_body_sha256: input.rawSha256,
    path: input.pointerPath,
  }));
}

function parseActionReceipt(action: KnowledgePromotionRequest["action"]): {
  ok: true;
  evidenceIds: string[];
} | { ok: false } {
  if (sha256(action.receipt_bytes) !== action.receipt_sha256) return { ok: false };
  let raw: unknown;
  try {
    raw = JSON.parse(action.receipt_bytes) as unknown;
  } catch {
    return { ok: false };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false };
  const row = raw as Record<string, unknown>;
  if (row.receipt_id !== action.receipt_id) return { ok: false };
  if (row.action_identity !== action.action_identity) return { ok: false };
  if (row.status !== "APPLIED") return { ok: false };
  const provenance = row.provenance;
  const evidenceIds = provenance && typeof provenance === "object" && !Array.isArray(provenance)
    && Array.isArray((provenance as { evidence_reference_ids?: unknown }).evidence_reference_ids)
    ? (provenance as { evidence_reference_ids: unknown[] }).evidence_reference_ids
      .filter((id): id is string => typeof id === "string")
    : [];
  return { ok: true, evidenceIds };
}

async function authenticateEvidence(
  request: KnowledgePromotionRequest,
  dependencies: Partial<KnowledgePromotionDependencies>,
): Promise<
  | { ok: true; factIds: Set<string>; profile: string; domain: string }
  | KnowledgePromotionFailure
> {
  const action = parseActionReceipt(request.action);
  if (!action.ok) {
    return failure("LESSON_NOT_VERIFIED", request.promotion_identity);
  }

  let replay: StrategicReviewResult;
  try {
    replay = await (dependencies.reviewReport ?? review)({
      ...(request.report.authentication as Omit<StrategicReviewRequest, "cwd" | "operation" | "report_id">),
      cwd: request.cwd,
      operation: "replay",
      report_id: request.report.report_id,
    });
  } catch (error) {
    return failure("LESSON_NOT_VERIFIED", request.promotion_identity);
  }
  if (!replay.ok
    || replay.status === "SNAPSHOT"
    || !("report" in replay)
    || replay.report_id !== request.report.report_id
    || replay.report_sha256 !== request.report.report_sha256
    || replay.report_bytes !== request.report.report_bytes) {
    return failure("LESSON_NOT_VERIFIED", request.promotion_identity);
  }

  const auth = request.report.authentication as {
    profile?: string;
    authority?: { profile?: string; domain?: string };
  };
  const profile = auth.profile ?? auth.authority?.profile;
  const domain = auth.authority?.domain ?? ("report" in replay ? replay.report.authority.domain : undefined);
  if (!profile || !domain) return failure("LESSON_NOT_VERIFIED", request.promotion_identity);
  if (request.worker.proof !== `knowledge-promotion/v1/${profile}/${domain}`) {
    return failure("LESSON_NOT_VERIFIED", request.promotion_identity);
  }

  const factIds = new Set(
    ("report" in replay && replay.report.mode === "normal"
      ? replay.report.evidence.references
        .filter((reference) => reference.classification === "FACT")
        .map((reference) => reference.id)
      : []),
  );
  for (const id of action.evidenceIds) {
    if (factIds.has(id) === false && action.evidenceIds.length > 0) {
      // Action provenance may list FACT-backed ids; require intersection with report FACT set when present.
    }
  }
  const lessonIds = request.lesson.evidence_reference_ids;
  if (lessonIds.length === 0 || lessonIds.some((id) => !factIds.has(id))) {
    return failure("LESSON_NOT_VERIFIED", request.promotion_identity);
  }
  // Prefer action-linked FACT evidence when action lists them.
  if (action.evidenceIds.length > 0
    && lessonIds.some((id) => !action.evidenceIds.includes(id) || !factIds.has(id))) {
    return failure("LESSON_NOT_VERIFIED", request.promotion_identity);
  }
  return { ok: true, factIds, profile, domain };
}

async function authenticateTicket(
  request: KnowledgePromotionRequest,
  dependencies: Partial<KnowledgePromotionDependencies>,
): Promise<StrategicTicketRead | KnowledgePromotionFailure> {
  if (!dependencies.ticket) return failure("PROMOTION_TICKET_REQUIRED", request.promotion_identity);
  let ticket: StrategicTicketRead | undefined;
  try {
    ticket = await dependencies.ticket.read(request.ticket.ticket_id);
  } catch {
    return failure("PROMOTION_TICKET_REQUIRED", request.promotion_identity);
  }
  if (!ticket || ticket.ticket_id !== request.ticket.ticket_id) {
    return failure("PROMOTION_TICKET_REQUIRED", request.promotion_identity);
  }
  if (ticket.status === "done" || ticket.status === "cancelled") {
    return failure("PROMOTION_TICKET_REQUIRED", request.promotion_identity);
  }
  const linkedByIdentity = ticket.action_identities.includes(request.ticket.linked_action_identity);
  const marker = `promotion-of:${request.ticket.linked_action_receipt_id}`;
  const linkedByComment = ticket.comments.some((comment) => comment.content.includes(marker));
  if (!linkedByIdentity && !linkedByComment) {
    return failure("PROMOTION_TICKET_REQUIRED", request.promotion_identity);
  }
  return ticket;
}

async function productionDependencies(
  request: KnowledgePromotionRequest,
): Promise<Partial<KnowledgePromotionDependencies> | KnowledgePromotionFailure> {
  let resolved: Awaited<ReturnType<typeof resolveHarnessGoal>>;
  try {
    resolved = await resolveHarnessGoal(request.cwd);
  } catch {
    return failure("PROMOTION_TICKET_REQUIRED", request.promotion_identity);
  }
  if (!resolved) return failure("PROMOTION_TICKET_REQUIRED", request.promotion_identity);
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
        return {
          ...(provider.strategic ? { ticket: provider.strategic } : {}),
          searchIndex: await filesystemSearchIndex(),
        };
      }
      return {
        searchIndex: await filesystemSearchIndex(),
      };
    }
    const provider = providerForState(state, resolved.goalId, { profile: binding.profile });
    return {
      ...(provider.strategic ? { ticket: provider.strategic } : {}),
      searchIndex: await filesystemSearchIndex(),
    };
  } catch {
    return {
      searchIndex: await filesystemSearchIndex(),
    };
  }
}

async function writeRawImmutable(
  root: string,
  vault: string,
  request: KnowledgePromotionRequest,
  bodySha256: string,
  ingestedAt: string,
): Promise<string> {
  const relative = `raw/articles/${bodySha256}.md`;
  const rawFile = path.join(vault, relative);
  const metaFile = path.join(vault, `raw/articles/${bodySha256}.meta.json`);
  await assertSafeContinuationStoragePath(root, rawFile, "file", "PROMOTION_STATE_UNAVAILABLE");
  await assertSafeContinuationStoragePath(root, metaFile, "file", "PROMOTION_STATE_UNAVAILABLE");
  let existing: string | undefined;
  try {
    existing = await fs.readFile(rawFile, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined && existing !== request.raw.bytes) {
    throw new Error("PROMOTION_REPLAY_CONFLICT");
  }
  if (existing === undefined) {
    const temporary = `${rawFile}.${process.pid}.${randomUUID()}.tmp`;
    await assertSafeContinuationStoragePath(root, temporary, "file", "PROMOTION_STATE_UNAVAILABLE");
    await fs.writeFile(temporary, request.raw.bytes, { encoding: "utf8", flag: "wx" });
    await fs.rename(temporary, rawFile);
  }
  const meta = {
    body_sha256: bodySha256,
    provenance: request.raw.provenance,
    ingested_at: ingestedAt,
    content_type: request.raw.provenance.content_type,
    classification: request.raw.classification,
  };
  const existingMeta = await readJsonIfExists<unknown>(metaFile);
  if (existingMeta === undefined) {
    await writeJsonAtomic(metaFile, meta);
  } else if (canonicalJson(existingMeta) !== canonicalJson(meta)
    && (existingMeta as { body_sha256?: string }).body_sha256 !== bodySha256) {
    // Keep first meta immutable when body matches.
  }
  const readback = await fs.readFile(rawFile, "utf8");
  if (readback !== request.raw.bytes) throw new Error("PROMOTION_STATE_UNAVAILABLE");
  return relative;
}

async function handleDrift(
  request: KnowledgePromotionRequest,
  dependencies: Partial<KnowledgePromotionDependencies>,
  vault: string,
  bodySha256: string,
  existingHash: string,
  nowIso: string,
): Promise<KnowledgePromotionFailure> {
  const driftId = `drift-${sha256(canonicalJson({
    origin: request.raw.provenance.origin,
    prior: existingHash,
    next: bodySha256,
  }))}`;
  const driftPath = path.join(vault, "raw", "drift", `${driftId}.json`);
  await assertSafeContinuationStoragePath(request.cwd, driftPath, "file", "PROMOTION_STATE_UNAVAILABLE");
  const existingDrift = await readJsonIfExists<unknown>(driftPath);
  if (existingDrift === undefined) {
    await writeJsonAtomic(driftPath, {
      id: driftId,
      origin: request.raw.provenance.origin,
      prior_body_sha256: existingHash,
      attempted_body_sha256: bodySha256,
      detected_at: nowIso,
      promotion_identity: request.promotion_identity,
    });
  }
  if (!dependencies.ticket) {
    return failure("RAW_CONTENT_DRIFT", request.promotion_identity, "BLOCKED", 0);
  }
  const rootCause = `knowledge-raw-drift:${request.raw.provenance.origin}`;
  let followUp: StrategicTicketRead;
  try {
    const found = await dependencies.ticket.search({
      root_cause: rootCause,
      action_identity: request.ticket.linked_action_identity,
      owner: null,
    });
    const reuse = found.find((ticket) =>
      ticket.root_cause === rootCause
      && ticket.title.toLowerCase().includes("drift")
      && ticket.status !== "done"
      && ticket.status !== "cancelled");
    followUp = reuse ?? await dependencies.ticket.create({
      title: `Investigate knowledge raw content drift for ${request.raw.provenance.origin}`,
      brief: `Prior raw hash ${existingHash} conflicts with attempted hash ${bodySha256}.`,
      acceptance: ["Preserve prior raw object", "Decide whether to promote under a new identity"],
      root_cause: rootCause,
      action_identity: request.ticket.linked_action_identity,
      owner: null,
    });
  } catch {
    return failure("RAW_CONTENT_DRIFT", request.promotion_identity, "BLOCKED", 0);
  }
  return failure("RAW_CONTENT_DRIFT", request.promotion_identity, "BLOCKED", 0, followUp.ticket_id);
}

async function writeCuratedPage(
  root: string,
  vault: string,
  request: KnowledgePromotionRequest,
  rawRelative: string,
  nowIso: string,
  receiptIdPlaceholder: string,
  target: { pageId: string; type: KnowledgePromotionLessonType },
): Promise<{
  relativePath: string;
  contentSha256: string;
  priorPageId: string | null;
  priorContentSha256: string | null;
  markdown: string;
  readbackOk: boolean;
  pageId: string;
}> {
  const relativePath = curatedRelativePath(target.type, target.pageId);
  const absolute = path.join(vault, relativePath);
  await assertSafeContinuationStoragePath(root, absolute, "file", "PROMOTION_STATE_UNAVAILABLE");
  const pointer = await readPointer(vault, target.pageId);
  let priorContent: string | undefined;
  try {
    priorContent = await fs.readFile(absolute, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const priorPageId = priorContent !== undefined || pointer ? target.pageId : null;
  const priorContentSha256 = priorContent !== undefined ? sha256(priorContent) : null;
  if (priorContent !== undefined && priorContentSha256) {
    const versionDir = path.join(vault, "versions", target.pageId);
    await assertSafeContinuationStoragePath(root, versionDir, "directory", "PROMOTION_STATE_UNAVAILABLE");
    await fs.mkdir(versionDir, { recursive: true });
    const versionFile = path.join(versionDir, `${priorContentSha256}.md`);
    await assertSafeContinuationStoragePath(root, versionFile, "file", "PROMOTION_STATE_UNAVAILABLE");
    try {
      await fs.access(versionFile);
    } catch {
      await fs.writeFile(versionFile, priorContent, "utf8");
    }
  }

  const relatedLinks = request.lesson.related_page_ids.map((id) => `[[${id.split("/").pop()}]]`);
  const created = priorContent
    ? (parseFrontmatter(priorContent)?.created ?? dayStamp(nowIso))
    : dayStamp(nowIso);
  const frontmatter = renderFrontmatter({
    title: request.lesson.title,
    created,
    updated: dayStamp(nowIso),
    type: target.type,
    tags: request.lesson.tags,
    sources: [rawRelative],
    confidence: request.lesson.confidence,
    contradictions: request.lesson.contradictions,
    ticket: request.ticket.ticket_id,
    evidence: [request.action.receipt_id, request.report.report_id],
    related: relatedLinks.map((link) => link.replace(/^\[\[|\]\]$/g, "")),
  });
  const body = `${request.lesson.body.trim()}\n\n## Related\n\n${relatedLinks.map((link) => `- ${link}`).join("\n")}\n`;
  const markdown = `${frontmatter}\n${body}`;
  await fs.writeFile(absolute, markdown, "utf8");
  const readback = await fs.readFile(absolute, "utf8");
  const readbackOk = readback === markdown;
  const contentSha256 = sha256(markdown);
  await writePointer(vault, target.pageId, {
    content_sha256: contentSha256,
    path: relativePath,
    updated_at: nowIso,
    receipt_id: receiptIdPlaceholder,
  });
  return {
    relativePath,
    contentSha256,
    priorPageId,
    priorContentSha256,
    markdown,
    readbackOk,
    pageId: target.pageId,
  };
}

async function applyPromote(
  request: KnowledgePromotionRequest,
  dependencies: Partial<KnowledgePromotionDependencies>,
  requestSha256: string,
): Promise<KnowledgePromotionResult> {
  if (request.raw.classification === "speculative") {
    return failure("LESSON_NOT_VERIFIED", request.promotion_identity);
  }
  if (!request.raw.provenance.origin
    || !request.raw.provenance.source_uri
    || !request.raw.provenance.content_type) {
    return failure("PROMOTION_PROVENANCE_REQUIRED", request.promotion_identity);
  }
  if (FORBIDDEN_CLASSIFICATIONS.has(request.raw.classification)
    || request.lesson.owns_actionable_work === true) {
    return failure("PROMOTION_CONTENT_FORBIDDEN", request.promotion_identity);
  }
  try {
    assertNoSecrets({
      raw_bytes: request.raw.bytes,
      lesson_title: request.lesson.title,
      lesson_body: request.lesson.body,
    });
  } catch {
    return failure("PROMOTION_CONTENT_FORBIDDEN", request.promotion_identity);
  }

  const ticket = await authenticateTicket(request, dependencies);
  if ("ok" in ticket) return ticket;

  if (request.worker.worker_id === request.producer.worker_id
    || request.worker.authenticated_at <= request.producer.finalized_at) {
    return failure("LATER_WORKER_REQUIRED", request.promotion_identity);
  }

  const authenticated = await authenticateEvidence(request, dependencies);
  if (!authenticated.ok) return authenticated;

  const bodySha256 = sha256(request.raw.bytes);
  const expectedIdentity = canonicalKnowledgePromotionIdentity({
    ticket_id: request.ticket.ticket_id,
    action_receipt_id: request.action.receipt_id,
    page_id: request.lesson.page_id,
    raw_body_sha256: bodySha256,
  });
  if (expectedIdentity !== request.promotion_identity) {
    return failure("LESSON_NOT_VERIFIED", request.promotion_identity);
  }

  const now = dependencies.now ?? (() => new Date().toISOString());
  const nowIso = now();
  const vault = await ensureVaultBootstrapped(request.cwd, nowIso);

  const existingOriginHash = await findOriginBodyHash(vault, request.raw.provenance.origin);
  if (existingOriginHash && existingOriginHash !== bodySha256) {
    return handleDrift(request, dependencies, vault, bodySha256, existingOriginHash, nowIso);
  }

  // Search existing curated pages before create/update.
  const search = dependencies.searchIndex ?? await filesystemSearchIndex();
  const searchResult = await search.query(vault, request.lesson.search_query);
  const target = await resolvePromotionTarget(vault, request, searchResult);
  const repository = await classifyRepository(vault);
  if (repositoryIsUnsafe(repository)) {
    return failure("REPOSITORY_CLASSIFICATION_UNSAFE", request.promotion_identity);
  }

  let intent = await readIntent(request.cwd, request.promotion_identity, request.operation);
  if (intent) {
    if (intent.request_sha256 !== requestSha256) {
      return failure("PROMOTION_REPLAY_CONFLICT", request.promotion_identity);
    }
  } else {
    intent = await writeIntent(request.cwd, {
      schema_version: 1,
      promotion_identity: request.promotion_identity,
      request_sha256: requestSha256,
      state: "pending",
      intended_at: nowIso,
      mutation_attempted: false,
    }, request.operation);
  }

  const mutatedAt = now();
  intent = await writeIntent(request.cwd, {
    ...intent,
    mutation_attempted: true,
    mutated_at: intent.mutated_at ?? mutatedAt,
  }, request.operation);

  const rawRelative = await writeRawImmutable(request.cwd, vault, request, bodySha256, mutatedAt);
  const provisionalReceiptId = `promotion-receipt-${"0".repeat(64)}`;
  const curated = await writeCuratedPage(
    request.cwd,
    vault,
    request,
    rawRelative,
    mutatedAt,
    provisionalReceiptId,
    target,
  );
  await regenerateIndex(vault);
  await appendLog(vault, "promote", `${target.pageId} ${request.lesson.title}`, mutatedAt);

  const queryAdapter = dependencies.searchIndex ?? await filesystemSearchIndex();
  const query = await queryAdapter.query(vault, request.lesson.search_query);
  const indexMarkdown = await fs.readFile(path.join(vault, "index.md"), "utf8");
  const unresolvedDrift = false;
  const lint = lintPage({
    markdown: curated.markdown,
    pageId: target.pageId,
    relatedPageIds: request.lesson.related_page_ids,
    indexMarkdown,
    origin: request.raw.provenance.origin,
    hasUnresolvedDrift: unresolvedDrift,
  });
  const queryField: KnowledgePromotionReceipt["query"] = query.ok
    ? { ok: true, hits: query.hits }
    : { ok: false, reason: "UNAVAILABLE" };
  const status: KnowledgePromotionReceipt["status"] =
    curated.readbackOk && query.ok ? "PROMOTED" : curated.readbackOk ? "PARTIAL" : "PARTIAL";
  if (!curated.readbackOk) {
    await writeIntent(request.cwd, { ...intent, state: "partial" }, request.operation);
    return failure("KNOWLEDGE_READBACK_FAILED", request.promotion_identity, "PARTIAL", 1);
  }

  const body: Omit<KnowledgePromotionReceipt, "receipt_id"> = {
    schema_version: 1,
    promotion_identity: request.promotion_identity,
    request_sha256: requestSha256,
    status,
    worker: request.worker,
    producer: request.producer,
    ticket: request.ticket,
    evidence: {
      action_receipt_id: request.action.receipt_id,
      report_id: request.report.report_id,
    },
    raw: {
      body_sha256: bodySha256,
      provenance: request.raw.provenance,
      ingested_at: mutatedAt,
      content_type: request.raw.provenance.content_type,
      storage_path: rawRelative,
    },
    curated: {
      page_id: target.pageId,
      prior_page_id: curated.priorPageId,
      content_sha256: curated.contentSha256,
      prior_content_sha256: curated.priorContentSha256,
      path: curated.relativePath,
      readback_ok: curated.readbackOk,
    },
    provenance: {
      origin: request.raw.provenance.origin,
      source_uri: request.raw.provenance.source_uri,
      content_type: request.raw.provenance.content_type,
    },
    index: { updated: true },
    log: { appended: true, entry_count_delta: 1 },
    query: queryField,
    lint,
    repository,
    git_mutation: { commit: false, push: false, merge: false, history_rewrite: false },
    global_memory_write: false,
    protected_state_digest: protectedDigest({
      pageId: target.pageId,
      contentSha256: curated.contentSha256,
      rawSha256: bodySha256,
      pointerPath: curated.relativePath,
    }),
    timestamps: {
      intended_at: intent.intended_at,
      mutated_at: mutatedAt,
      finalized_at: now(),
    },
  };
  const receiptId = receiptIdentity(body);
  const receipt: KnowledgePromotionReceipt = { ...body, receipt_id: receiptId };
  await writePointer(vault, target.pageId, {
    content_sha256: curated.contentSha256,
    path: curated.relativePath,
    updated_at: mutatedAt,
    receipt_id: receiptId,
  });
  return persistFinalReceipt(request, intent, receipt, mutatedAt, 1);
}

async function applyRollback(
  request: KnowledgePromotionRequest,
  dependencies: Partial<KnowledgePromotionDependencies>,
  requestSha256: string,
): Promise<KnowledgePromotionResult> {
  if (!request.target_receipt_id) {
    return failure("LESSON_NOT_VERIFIED", request.promotion_identity);
  }
  const ticket = await authenticateTicket(request, dependencies);
  if ("ok" in ticket) return ticket;
  if (request.worker.worker_id === request.producer.worker_id
    || request.worker.authenticated_at <= request.producer.finalized_at) {
    return failure("LATER_WORKER_REQUIRED", request.promotion_identity);
  }
  const authenticated = await authenticateEvidence(request, dependencies);
  if (!authenticated.ok) return authenticated;

  const now = dependencies.now ?? (() => new Date().toISOString());
  const nowIso = now();
  const vault = await ensureVaultBootstrapped(request.cwd, nowIso);
  const target = await readReceipt(request.cwd, request.target_receipt_id);
  const pageId = target.receipt.curated.page_id;
  const absolute = path.join(vault, target.receipt.curated.path);
  await assertSafeContinuationStoragePath(request.cwd, absolute, "file", "PROMOTION_STATE_UNAVAILABLE");

  let intent = await readIntent(request.cwd, request.promotion_identity, request.operation);
  if (intent && intent.request_sha256 !== requestSha256) {
    return failure("PROMOTION_REPLAY_CONFLICT", request.promotion_identity);
  }
  if (!intent) {
    intent = await writeIntent(request.cwd, {
      schema_version: 1,
      promotion_identity: request.promotion_identity,
      request_sha256: requestSha256,
      state: "pending",
      intended_at: nowIso,
      mutation_attempted: false,
    }, request.operation);
  }
  const mutatedAt = now();
  intent = await writeIntent(request.cwd, {
    ...intent,
    mutation_attempted: true,
    mutated_at: intent.mutated_at ?? mutatedAt,
  }, request.operation);

  const priorSha = target.receipt.curated.prior_content_sha256;
  if (priorSha) {
    const versionFile = path.join(vault, "versions", pageId, `${priorSha}.md`);
    const priorMarkdown = await fs.readFile(versionFile, "utf8");
    await fs.writeFile(absolute, priorMarkdown, "utf8");
    await writePointer(vault, pageId, {
      content_sha256: priorSha,
      path: target.receipt.curated.path,
      updated_at: mutatedAt,
      receipt_id: request.target_receipt_id,
    });
  } else {
    try {
      await fs.unlink(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const pointerFile = path.join(vault, "pointers", `${pageId}.json`);
    try {
      await fs.unlink(pointerFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await regenerateIndex(vault);
  await appendLog(vault, "rollback", `${pageId} from ${request.target_receipt_id}`, mutatedAt);

  const contentSha256 = priorSha ?? sha256("");
  let rolledMarkdown = "";
  try {
    rolledMarkdown = await fs.readFile(absolute, "utf8");
  } catch {
    rolledMarkdown = "";
  }
  const queryAdapter = dependencies.searchIndex ?? await filesystemSearchIndex();
  const query = await queryAdapter.query(vault, request.lesson.search_query);
  const indexMarkdown = await fs.readFile(path.join(vault, "index.md"), "utf8");
  const lint = lintPage({
    markdown: rolledMarkdown,
    pageId,
    relatedPageIds: request.lesson.related_page_ids,
    indexMarkdown,
    origin: request.raw.provenance.origin,
    hasUnresolvedDrift: false,
  });
  const queryField: KnowledgePromotionReceipt["query"] = query.ok
    ? { ok: true, hits: query.hits }
    : { ok: false, reason: "UNAVAILABLE" };
  const repository = await classifyRepository(vault);
  if (repositoryIsUnsafe(repository)) {
    return failure("REPOSITORY_CLASSIFICATION_UNSAFE", request.promotion_identity, "BLOCKED", 1);
  }
  const body: Omit<KnowledgePromotionReceipt, "receipt_id"> = {
    schema_version: 1,
    promotion_identity: request.promotion_identity,
    request_sha256: requestSha256,
    status: "ROLLED_BACK",
    worker: request.worker,
    producer: request.producer,
    ticket: request.ticket,
    evidence: {
      action_receipt_id: request.action.receipt_id,
      report_id: request.report.report_id,
    },
    raw: target.receipt.raw,
    curated: {
      page_id: pageId,
      prior_page_id: target.receipt.curated.page_id,
      content_sha256: contentSha256,
      prior_content_sha256: target.receipt.curated.content_sha256,
      path: target.receipt.curated.path,
      readback_ok: true,
    },
    provenance: target.receipt.provenance,
    index: { updated: true },
    log: { appended: true, entry_count_delta: 1 },
    query: queryField,
    lint,
    repository,
    git_mutation: { commit: false, push: false, merge: false, history_rewrite: false },
    global_memory_write: false,
    protected_state_digest: protectedDigest({
      pageId,
      contentSha256,
      rawSha256: target.receipt.raw.body_sha256,
      pointerPath: target.receipt.curated.path,
    }),
    timestamps: {
      intended_at: intent.intended_at,
      mutated_at: mutatedAt,
      finalized_at: now(),
    },
  };
  const receipt: KnowledgePromotionReceipt = { ...body, receipt_id: receiptIdentity(body) };
  return persistFinalReceipt(request, intent, receipt, mutatedAt, 1);
}

async function statusResult(
  request: KnowledgePromotionRequest,
  requestSha256: string,
): Promise<KnowledgePromotionResult> {
  const existing = await readIntent(request.cwd, request.promotion_identity, "promote")
    ?? await readIntent(request.cwd, request.promotion_identity, request.operation);
  if (!existing) return failure("PROMOTION_TICKET_REQUIRED", request.promotion_identity);
  if (existing.receipt_id && existing.state === "finalized") {
    const stored = existing.receipt_bytes
      ? {
        receipt: parseReceiptBytes(existing.receipt_id, existing.receipt_bytes),
        receiptBytes: existing.receipt_bytes,
      }
      : await readReceipt(request.cwd, existing.receipt_id);
    return success(stored.receipt, stored.receiptBytes, 0);
  }
  if (existing.request_sha256 !== requestSha256) {
    return failure("PROMOTION_REPLAY_CONFLICT", request.promotion_identity);
  }
  return failure("PROMOTION_TICKET_REQUIRED", request.promotion_identity, "PARTIAL", 0);
}

export async function promote(input: KnowledgePromotionRequest): Promise<KnowledgePromotionResult> {
  const parsed = RequestSchema.safeParse(input);
  if (!parsed.success) return failure("LESSON_NOT_VERIFIED");
  const request = parsed.data as KnowledgePromotionRequest;
  try {
    assertNoSecrets({
      raw_bytes: request.raw.bytes,
      lesson_title: request.lesson.title,
      lesson_body: request.lesson.body,
    });
  } catch {
    return failure("PROMOTION_CONTENT_FORBIDDEN", request.promotion_identity);
  }

  const injected = knowledgePromotionTestDependencies.getStore();
  const resolvedDependencies = injected ?? await productionDependencies(request);
  if (resolvedDependencies && "ok" in resolvedDependencies && resolvedDependencies.ok === false) {
    return resolvedDependencies;
  }
  const dependencies = (resolvedDependencies ?? {}) as Partial<KnowledgePromotionDependencies>;
  const requestSha256 = requestDigest(request);
  const leaseKey = `promo-${request.promotion_identity.slice(-56)}`;
  try {
    await assertSafeContinuationLeaseTree(request.cwd, leaseKey, "PROMOTION_STATE_UNAVAILABLE");
    return await withCoordinationLease(request.cwd, leaseKey, async () => {
      await ensurePromotionStorage(request.cwd);
      const replay = await finalizedReplay(request, requestSha256);
      if (replay) return replay;
      if (request.operation === "status") return statusResult(request, requestSha256);
      if (request.operation === "rollback") {
        return applyRollback(request, dependencies, requestSha256);
      }
      return applyPromote(request, dependencies, requestSha256);
    }, dependencies.coordination ?? {});
  } catch (error) {
    if (error instanceof Error && error.message === "PROMOTION_REPLAY_CONFLICT") {
      return failure("PROMOTION_REPLAY_CONFLICT", request.promotion_identity);
    }
    if (error instanceof Error && error.message === "PROMOTION_STATE_UNAVAILABLE") {
      return failure("PROMOTION_STATE_UNAVAILABLE", request.promotion_identity);
    }
    return failure("PROMOTION_STATE_UNAVAILABLE", request.promotion_identity);
  }
}

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { TextDecoder } from "node:util";
import { z } from "zod";
import {
  CoordinationError,
  assertNoSecrets,
  ghChildEnv,
  resolveHarnessGoal,
  spawnGh,
  spawnMultica,
  verifyCoordinationBinding,
  withCoordinationLease,
  type CoordinationBinding,
  type CoordinationDeps,
  type GhResult,
  type GhRunner,
  type MulticaResult,
  type MulticaRunner,
  type ResolvedHarnessGoal,
} from "./coordination.js";
import { assertSafeContinuationLeaseTree, assertSafeContinuationStoragePath } from "../continuation/storage-safety.js";
import {
  loadContinuationClosureVerdict,
  type ContinuationProofBinding,
} from "../continuation/closure.js";
import type { CanonicalContinuationVerdict } from "../continuation/shadow.js";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import { explicitIssueNotFound, githubTicketProvider } from "../tickets/provider.js";
import { HarnessStore } from "../state/store.js";
import type { TicketBackendT } from "../schema/v3.js";
import {
  PmSchedulerOriginSelectorSchema,
  type PmSchedulerOriginSelector,
  type TrustedPmSchedulerOriginReadback,
} from "./pm-scheduler-origin.js";
import {
  PmActorOriginSelectorSchema,
  readProjectedPmActorOrigin,
  type PmActorOriginSelector,
  type TrustedPmActorOriginReadback,
} from "./pm-actor-origin.js";
import {
  PM_INSTALLED_LOOP_ID,
  PM_INSTALLED_LOOP_PROFILE,
  installedLoopPauseFromValue,
  installedLoopPauseStatePath,
  readInstalledLoopPause,
  type InstalledLoopPauseReader,
} from "./installed-loop-state.js";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PrioritySchema = z.enum(["urgent", "high", "medium", "low"]);

export interface PmExecutionStore {
  readonly resolved: ResolvedHarnessGoal;
  assertPath(target: string, finalKind: "directory" | "file" | "any", failureCode: string): Promise<void>;
  assertLease(key: string, failureCode: string): Promise<void>;
  withLease<T>(key: string, operation: () => Promise<T>): Promise<T>;
  readJson<T>(file: string): Promise<T | undefined>;
  writeJson(file: string, value: unknown): Promise<void>;
  readArtifact(file: string, maxBytes: number, afterFirstRead?: () => void | Promise<void>): Promise<Buffer>;
}

interface PmExecutionDeps {
  executionStore?: PmExecutionStore;
  readInstalledLoopState?: InstalledLoopPauseReader;
}

async function resolvePmGoal(
  cwd: string,
  goal: string | undefined,
  deps: CoordinationDeps & PmExecutionDeps,
): Promise<ResolvedHarnessGoal | undefined> {
  if (deps.executionStore) {
    if (goal && goal !== deps.executionStore.resolved.goalId) fail("goal_mismatch", "pinned goal does not match the active goal");
    return deps.executionStore.resolved;
  }
  return resolveHarnessGoal(cwd, goal, deps.gitProbe);
}

async function executionAssertPath(
  root: string,
  target: string,
  finalKind: "directory" | "file" | "any",
  failureCode: string,
  store?: PmExecutionStore,
): Promise<void> {
  if (store) return store.assertPath(target, finalKind, failureCode);
  return assertSafeContinuationStoragePath(root, target, finalKind, failureCode);
}

async function executionReadJson<T>(file: string, store?: PmExecutionStore): Promise<T | undefined> {
  return store ? store.readJson<T>(file) : readJsonIfExists<T>(file);
}

async function executionWriteJson(file: string, value: unknown, store?: PmExecutionStore): Promise<void> {
  return store ? store.writeJson(file, value) : writeJsonAtomic(file, value);
}
const CandidateSchema = z.object({
  id: z.string().regex(SAFE_REF),
  root_key: z.string().regex(SAFE_REF),
  priority: PrioritySchema,
  updated_at: z.string().datetime(),
  active: z.boolean(),
  material: z.boolean(),
  concrete_acceptance: z.boolean(),
  dependencies_satisfied: z.boolean(),
  safe_authority: z.boolean(),
  clear: z.boolean(),
}).strict();

export type PmCandidate = z.infer<typeof CandidateSchema>;

const BriefSchema = z.object({
  objective: z.string().min(1).max(8192),
  non_goals: z.array(z.string().min(1).max(4096)).min(1).max(32),
  acceptance: z.array(z.string().min(1).max(4096)).min(1).max(32),
  evidence: z.array(z.string().min(1).max(4096)).min(1).max(32),
  first_steps: z.array(z.string().min(1).max(4096)).min(1).max(12),
  verification: z.array(z.string().min(1).max(4096)).min(1).max(32),
  capability_cost_rationale: z.string().min(1).max(4096),
  safety_rollback: z.string().min(1).max(4096),
  risks: z.array(z.string().min(1).max(4096)).min(1).max(32),
  handoff_contract: z.string().min(1).max(4096),
}).strict();

const PrepareInputSchema = z.object({
  cwd: z.string().min(1).max(4096),
  goal: z.string().regex(SAFE_REF).optional(),
  producer_slot: z.string().regex(SAFE_REF),
  invocation_key: z.string().regex(SAFE_REF),
  run_id: z.string().regex(SAFE_REF),
  session_id: z.string().regex(SAFE_REF),
  brief: BriefSchema,
}).strict();

export type PreparePmInput = z.input<typeof PrepareInputSchema>;
export type PmBrief = z.infer<typeof BriefSchema>;

const CandidateDecisionSchema = z.object({
  id: z.string(),
  root_key: z.string(),
  eligible: z.boolean(),
  reason_codes: z.array(z.string()),
}).strict();

const DecisionSchema = z.object({
  outcome: z.enum(["selected", "no_selection", "blocked"]),
  reason_code: z.string(),
  selected_id: z.string().optional(),
  selected_root_key: z.string().optional(),
  candidates: z.array(CandidateDecisionSchema),
}).strict();

const AnnotationSchema = z.object({
  id: z.string().min(1),
  issue_id: z.string().min(1),
  key: z.string().min(1),
  content: z.string().min(1),
}).strict();

export type PmProviderAnnotation = z.infer<typeof AnnotationSchema>;

export interface PmProvider {
  listCandidates(): Promise<PmCandidate[]>;
  annotate(candidateId: string, key: string, content: string): Promise<PmProviderAnnotation>;
  readAnnotation?(candidateId: string, key: string, content: string): Promise<PmProviderAnnotation | undefined>;
  readTicketProof?(ticketId: string): Promise<PmLiveTicketProof | undefined>;
  readCorrection?(ticketId: string, key: string, request: PmCorrectionRequest): Promise<PmCorrectionReference | undefined>;
  ensureCorrection?(ticketId: string, key: string, request: PmCorrectionRequest): Promise<PmCorrectionReference>;
}

function providerFail(message: string): never {
  return fail("pm_provider_malformed", message);
}

function providerObject(result: MulticaResult, label: string): Record<string, unknown> {
  if (Buffer.byteLength(result.stdout, "utf8") > 1024 * 1024) fail("pm_provider_output_too_large", `${label} exceeded the output bound`);
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch {
    return providerFail(`${label} returned malformed JSON`);
  }
}

function providerArray(result: MulticaResult, label: string, field?: string): Record<string, unknown>[] {
  if (Buffer.byteLength(result.stdout, "utf8") > 1024 * 1024) fail("pm_provider_output_too_large", `${label} exceeded the output bound`);
  try {
    const value: unknown = JSON.parse(result.stdout);
    const rows = Array.isArray(value)
      ? value
      : field && value && typeof value === "object" && Array.isArray((value as Record<string, unknown>)[field])
        ? (value as Record<string, unknown>)[field] as unknown[]
        : undefined;
    if (!rows || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new Error("array required");
    return rows as Record<string, unknown>[];
  } catch {
    return providerFail(`${label} returned malformed JSON`);
  }
}

function providerString(row: Record<string, unknown>, key: string): string | undefined {
  const value = row[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  const nested = row[key.replace(/_id$/, "")];
  return nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).id === "string"
    ? String((nested as Record<string, unknown>).id).trim() || undefined
    : undefined;
}

interface CorrectionMarkers {
  key: string;
  ticketId: string;
  rootCauseKey: string;
  strength: "equal" | "stronger";
  capabilityId: string;
  capabilityRank: number;
}

function hasExactCorrectionMarkers(description: string | undefined, expected: CorrectionMarkers): boolean {
  if (!description) return false;
  const markers = new Map<string, string[]>();
  for (const line of description.split(/\r?\n/)) {
    const match = /^([A-Za-z][A-Za-z0-9-]*): (.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!;
    markers.set(name, [...markers.get(name) ?? [], match[2]!]);
  }
  const exact = (name: string, value: string): boolean => {
    const matches = markers.get(name);
    return matches?.length === 1 && matches[0] === value;
  };
  return exact("PM-Correction-Key", expected.key)
    && exact("PM-Source-Ticket", expected.ticketId)
    && exact("PM-Root-Cause", expected.rootCauseKey)
    && exact("PM-Strength", expected.strength)
    && exact("PM-Required-Capability", expected.capabilityId)
    && exact("PM-Required-Capability-Rank", String(expected.capabilityRank));
}

function correctionContent(ticketId: string, key: string, request: PmCorrectionRequest): string {
  return [
    `PM-Correction-Key: ${key}`,
    `PM-Source-Ticket: ${ticketId}`,
    `PM-Root-Cause: ${request.root_cause_key}`,
    `PM-Strength: ${request.strength}`,
    `PM-Required-Capability: ${request.required_capability.id}`,
    `PM-Required-Capability-Rank: ${request.required_capability.rank}`,
    "", request.title,
    "", "## Acceptance", ...request.acceptance.map((item) => `- ${item}`),
    "", "## Verification", ...request.verification.map((item) => `- ${item}`),
    "", "## Rollback", request.rollback,
  ].join("\n");
}

function candidateFromProvider(row: Record<string, unknown>): PmCandidate {
  const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? row.metadata as Record<string, unknown>
    : {};
  const field = (key: string): unknown => row[key] ?? metadata[key];
  const parsed = CandidateSchema.safeParse({
    id: providerString(row, "id") ?? providerString(row, "identifier"),
    root_key: field("root_cause_key"),
    priority: row.priority,
    updated_at: row.updated_at,
    active: field("active"),
    material: field("material"),
    concrete_acceptance: field("concrete_acceptance"),
    dependencies_satisfied: field("dependencies_satisfied"),
    safe_authority: field("safe_authority"),
    clear: field("clear"),
  });
  if (!parsed.success) return providerFail("candidate snapshot lacks explicit canonical eligibility fields");
  return parsed.data;
}

async function defaultPmProvider(
  cwd: string,
  goal: string | undefined,
  deps: CoordinationDeps,
): Promise<PmProvider> {
  const resolved = await resolveHarnessGoal(cwd, goal, deps.gitProbe);
  if (!resolved) fail("pm_binding_missing", "PM prepare requires a verified harness goal");
  const state = await new HarnessStore(resolved.root).readStateV3();
  const goalRecord = state.goals[resolved.goalId];
  if (goalRecord?.backend.kind === "github") {
    return githubPmProvider(goalRecord.backend, deps.ghRunner ?? spawnGh, deps.env ?? process.env);
  }
  const runner: MulticaRunner = deps.runner ?? spawnMultica;
  const env = deps.env ?? process.env;
  const binding = await verifyCoordinationBinding(cwd, goal, { ...deps, runner, env });
  if (!binding) fail("pm_binding_missing", "PM prepare requires a verified coordination binding");
  return multicaPmProvider(binding, runner, env);
}

export function githubPmProvider(
  backend: Extract<TicketBackendT, { kind: "github" }>,
  runner: GhRunner = spawnGh,
  env: NodeJS.ProcessEnv = process.env,
): PmProvider {
  const tickets = githubTicketProvider(backend, { runner, env, goalId: `goal-${backend.parent_issue_number}` });
  const parent = String(backend.parent_issue_number);
  const readCorrection = async (ticketId: string, key: string, request: PmCorrectionRequest): Promise<PmCorrectionReference | undefined> => {
    const content = correctionContent(ticketId, key, request);
    const listed = await tickets.list(`goal-${backend.parent_issue_number}`);
    const matches = listed.filter((ticket) => (ticket.brief ?? "").includes(content.slice(0, 80)) || ticket.title === request.title);
    if (matches.length > 1) fail("pm_review_correction_fanout", "provider contains duplicate canonical PM corrections");
    if (!matches[0]) return undefined;
    return {
      reference_id: matches[0].id,
      key,
      root_cause_key: request.root_cause_key,
      strength: request.strength,
      required_capability: request.required_capability,
    };
  };
  return {
    async listCandidates() {
      return (await tickets.list(`goal-${backend.parent_issue_number}`)).map((ticket) => ({
        id: ticket.id,
        identifier: ticket.id,
        title: ticket.title,
        description: [ticket.brief ?? "", "", "## Acceptance", ...ticket.acceptance.map((item) => `- ${item}`)].join("\n"),
        status: ticket.status,
        parent_issue_id: parent,
        parent_id: parent,
      })).map(candidateFromProvider);
    },
    async annotate(candidateId, key, content) {
      const commentId = await tickets.addEvidence(candidateId, content, key);
      if (!commentId) fail("pm_provider_readback_failed", "GitHub PM annotation lacked identity");
      return { id: commentId, issue_id: candidateId, key, content };
    },
    async readAnnotation(candidateId, key, content) {
      const row = await tickets.strategic?.read(candidateId);
      const match = row?.comments.find((comment) => comment.content === content);
      if (!match) return undefined;
      return { id: match.id, issue_id: candidateId, key, content };
    },
    async readTicketProof(ticketId) {
      const proof = await tickets.readProof(ticketId);
      if (proof.kind !== "found") return undefined;
      return parsePmLiveTicketProof(proof.proof);
    },
    readCorrection,
    async ensureCorrection(ticketId, key, request) {
      const existing = await readCorrection(ticketId, key, request);
      if (existing) return existing;
      const content = correctionContent(ticketId, key, request);
      const created = await tickets.create(`goal-${backend.parent_issue_number}`, {
        title: request.title,
        brief: content,
        acceptance: [],
      });
      const reference = await readCorrection(ticketId, key, request);
      if (!reference || reference.reference_id !== created.id) {
        fail("pm_provider_readback_failed", "GitHub PM correction did not survive exact live readback");
      }
      return reference;
    },
  };
}

export function multicaPmProvider(
  binding: CoordinationBinding,
  runner: MulticaRunner = spawnMultica,
  env: NodeJS.ProcessEnv = process.env,
): PmProvider {
  const base: string[] = [];
  if (binding.profile) base.push("--profile", binding.profile);
  base.push("--server-url", binding.server_origin, "--workspace-id", binding.workspace_id);
  const invoke = (argv: string[], stdin?: string): Promise<MulticaResult> => runner({
    executable: "multica",
    argv: [...base, ...argv],
    env,
    ...(stdin === undefined ? {} : { stdin }),
    shell: false,
    windowsHide: true,
  });
  const readCorrection = async (ticketId: string, key: string, request: PmCorrectionRequest): Promise<PmCorrectionReference | undefined> => {
    const content = correctionContent(ticketId, key, request);
    const listed = providerArray(
      await invoke(["issue", "list", "--output", "json", "--limit", "200"]),
      "PM correction list",
      "issues",
    );
    const matches = listed.filter((row) => {
      const parent = providerString(row, "parent_issue_id") ?? providerString(row, "parent_id");
      return parent?.toLowerCase() === binding.parent_id.toLowerCase() && providerString(row, "description") === content;
    });
    if (matches.length > 1) fail("pm_review_correction_fanout", "provider contains duplicate canonical PM corrections");
    const referenceId = matches[0] && (providerString(matches[0], "id") ?? providerString(matches[0], "identifier"));
    if (!referenceId) return undefined;
    const readback = providerObject(await invoke(["issue", "get", referenceId, "--output", "json"]), "PM correction readback");
    const readbackId = providerString(readback, "id") ?? providerString(readback, "identifier");
    const parentId = providerString(readback, "parent_issue_id") ?? providerString(readback, "parent_id");
    const description = providerString(readback, "description");
    const expectedMarkers: CorrectionMarkers = { key, ticketId, rootCauseKey: request.root_cause_key,
      strength: request.strength, capabilityId: request.required_capability.id, capabilityRank: request.required_capability.rank };
    if (![readbackId, providerString(readback, "identifier")].some((value) => value?.toLowerCase() === referenceId.toLowerCase())
      || parentId?.toLowerCase() !== binding.parent_id.toLowerCase() || description !== content
      || !hasExactCorrectionMarkers(description, expectedMarkers)) {
      fail("pm_provider_readback_failed", "PM correction did not survive exact live readback");
    }
    return { reference_id: referenceId, key, root_cause_key: request.root_cause_key,
      strength: request.strength, required_capability: request.required_capability };
  };
  return {
    async listCandidates() {
      return providerArray(
        await invoke(["issue", "list", "--output", "json", "--limit", "200"]),
        "PM candidate list",
        "issues",
      ).filter((row) => {
        const parent = providerString(row, "parent_issue_id") ?? providerString(row, "parent_id");
        return parent?.toLowerCase() === binding.parent_id;
      }).map(candidateFromProvider);
    },
    async annotate(candidateId, key, content) {
      const exact = (row: Record<string, unknown>): boolean => providerString(row, "content") === content;
      let comments = providerArray(
        await invoke(["issue", "comment", "list", candidateId, "--output", "json"]),
        "PM annotation readback",
      ).filter(exact);
      if (comments.length > 1) fail("pm_provider_readback_failed", "provider returned duplicate PM annotations");
      if (comments.length === 0) {
        const created = providerObject(await invoke([
          "issue", "comment", "add", candidateId,
          "--content-stdin", "--output", "json",
        ], content), "PM annotation create");
        if (!providerString(created, "id") || !exact(created)) {
          fail("pm_provider_readback_failed", "provider create did not echo the PM annotation content");
        }
        comments = providerArray(
          await invoke(["issue", "comment", "list", candidateId, "--output", "json"]),
          "PM annotation readback",
        ).filter(exact);
      }
      if (comments.length !== 1) fail("pm_provider_readback_failed", "provider annotation did not survive exact readback");
      const row = comments[0]!;
      const id = providerString(row, "id");
      const issueId = providerString(row, "issue_id");
      if (!id || !issueId) fail("pm_provider_readback_failed", "provider annotation readback lacks identity");
      return { id, issue_id: issueId, key, content };
    },
    async readAnnotation(candidateId, key, content) {
      const matches = providerArray(
        await invoke(["issue", "comment", "list", candidateId, "--output", "json"]),
        "PM annotation readback",
      ).filter((row) => providerString(row, "content") === content);
      if (matches.length > 1) fail("pm_provider_readback_failed", "provider returned duplicate PM annotations");
      if (matches.length === 0) return undefined;
      const row = matches[0]!; const id = providerString(row, "id"); const issueId = providerString(row, "issue_id");
      if (!id || !issueId || issueId.toLowerCase() !== candidateId.toLowerCase()) {
        fail("pm_provider_readback_failed", "provider annotation readback lacks exact identity");
      }
      return { id, issue_id: issueId, key, content };
    },
    async readTicketProof(ticketId) {
      let row: Record<string, unknown>;
      try {
        row = providerObject(await invoke(["issue", "get", ticketId, "--output", "json"]), "PM ticket proof");
      } catch (error) {
        if (explicitIssueNotFound(error, ticketId)) return undefined;
        throw error;
      }
      const id = providerString(row, "id") ?? providerString(row, "identifier");
      const parentId = providerString(row, "parent_issue_id") ?? providerString(row, "parent_id");
      const status = providerString(row, "status");
      if (!id || ![id, providerString(row, "identifier")].some((value) => value?.toLowerCase() === ticketId.toLowerCase())
        || !parentId || !status) {
        fail("pm_provider_readback_failed", "PM ticket proof lacks canonical identity");
      }
      const comments = providerArray(
        await invoke(["issue", "comment", "list", ticketId, "--output", "json"]),
        "PM ticket evidence readback",
      );
      const title = providerString(row, "title");
      const description = providerString(row, "description");
      return parsePmLiveTicketProof({
        ticket_id: ticketId,
        configured_parent_id: binding.parent_id,
        parent_id: parentId,
        status,
        content_strings: [title, description].filter((value): value is string => Boolean(value)),
        evidence_reference_ids: comments.map((comment) => providerString(comment, "id")).filter((value): value is string => Boolean(value)).sort(),
        readback_at: new Date().toISOString(),
      });
    },
    readCorrection,
    async ensureCorrection(ticketId, key, request) {
      const content = correctionContent(ticketId, key, request);
      let reference = await readCorrection(ticketId, key, request);
      if (!reference) {
        const created = providerObject(await invoke([
          "issue", "create", "--title", request.title, "--description-stdin", "--status", "todo",
          "--parent", binding.parent_id, "--output", "json",
        ], content), "PM correction create");
        const referenceId = providerString(created, "id") ?? providerString(created, "identifier");
        if (!referenceId) fail("pm_provider_readback_failed", "PM correction create lacks canonical identity");
        reference = await readCorrection(ticketId, key, request);
      }
      if (!reference) fail("pm_provider_readback_failed", "PM correction did not survive exact live readback");
      return reference;
    },
  };
}

const ReceiptCoreSchema = z.object({
  schema_version: z.literal(1),
  receipt_id: z.string().regex(/^pm-[0-9a-f]{32}$/),
  goal_id: z.string(),
  producer_slot: z.string(),
  invocation_key: z.string(),
  canonical_input_sha256: z.string().regex(SHA256),
  candidate_snapshot_sha256: z.string().regex(SHA256),
  state: z.enum(["prepared", "claimed", "no_selection", "blocked"]),
  decision: DecisionSchema,
  brief: BriefSchema,
  claim_authorized: z.boolean(),
  observed_provenance: z.array(z.object({ run_id: z.string(), session_id: z.string() }).strict()),
  provider_annotation: AnnotationSchema.optional(),
}).strict();

const ReceiptSchema = ReceiptCoreSchema.extend({
  protected_state_sha256: z.string().regex(SHA256),
}).strict();

export type PmPrepareReceipt = z.infer<typeof ReceiptSchema>;

const PrepareProvenanceSchema = z.array(z.object({
  run_id: z.string().regex(SAFE_REF),
  session_id: z.string().regex(SAFE_REF),
}).strict()).min(1);

export type PmPrepareProjectionInput = {
  receipt: PmPrepareReceipt;
  observed_provenance: PmPrepareReceipt["observed_provenance"];
  provider_annotation?: PmProviderAnnotation;
} | {
  goal_id: string;
  producer_slot: string;
  invocation_key: string;
  brief: PmBrief;
  candidates: PmCandidate[];
  observed_provenance: PmPrepareReceipt["observed_provenance"];
  provider_annotation?: PmProviderAnnotation;
};

export interface PmPrepareProjection {
  receipt: PmPrepareReceipt;
  annotation?: {
    candidate_id: string;
    key: string;
    content: string;
  };
}

export interface PreparePmDeps extends CoordinationDeps, PmExecutionDeps {
  provider?: PmProvider;
  faultAt?: "before_write" | "after_write_before_mutation" | "after_mutation_before_finalize";
}

function fail(code: string, message: string): never {
  throw new CoordinationError(code, message);
}

async function assertPmLoopActive(root: string, deps: PmExecutionDeps): Promise<void> {
  const selector = { profile: PM_INSTALLED_LOOP_PROFILE, loop_id: PM_INSTALLED_LOOP_ID };
  const state = deps.readInstalledLoopState
    ? await deps.readInstalledLoopState(root, selector)
    : deps.executionStore
      ? await (async () => {
          const file = installedLoopPauseStatePath(root, selector.loop_id);
          await deps.executionStore!.assertPath(file, "file", "INSTALLED_LOOP_STATE_UNAVAILABLE");
          return installedLoopPauseFromValue(await deps.executionStore!.readJson<unknown>(file), selector);
        })()
      : await readInstalledLoopPause(root, selector);
  if (state.profile !== PM_INSTALLED_LOOP_PROFILE || state.loop_id !== PM_INSTALLED_LOOP_ID) {
    fail("pm_loop_state_invalid", "installed PM loop state does not match its installation-owned selector");
  }
  if (state.paused) fail("pm_loop_paused", "installed PM loop is paused");
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
}

function canonicalList(values: string[], ordered = false): string[] {
  const normalized = values.map(normalizeText).filter(Boolean);
  return ordered ? [...new Set(normalized)] : [...new Set(normalized)].sort();
}

function canonicalBrief(brief: PmBrief): PmBrief {
  return {
    objective: normalizeText(brief.objective),
    non_goals: canonicalList(brief.non_goals),
    acceptance: canonicalList(brief.acceptance),
    evidence: canonicalList(brief.evidence),
    first_steps: canonicalList(brief.first_steps, true),
    verification: canonicalList(brief.verification),
    capability_cost_rationale: normalizeText(brief.capability_cost_rationale),
    safety_rollback: normalizeText(brief.safety_rollback),
    risks: canonicalList(brief.risks),
    handoff_contract: normalizeText(brief.handoff_contract),
  };
}

function scanBrief(brief: PmBrief): void {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(brief)) {
    if (typeof value === "string") fields[key] = value;
    else value.forEach((item, index) => { fields[`${key}[${index}]`] = item; });
  }
  assertNoSecrets(fields);
}

function priorityRank(priority: PmCandidate["priority"]): number {
  return { urgent: 0, high: 1, medium: 2, low: 3 }[priority];
}

function compareCandidates(a: PmCandidate, b: PmCandidate): number {
  return priorityRank(a.priority) - priorityRank(b.priority)
    || a.updated_at.localeCompare(b.updated_at)
    || a.id.localeCompare(b.id);
}

function ineligibility(candidate: PmCandidate): string[] {
  const reasons: string[] = [];
  if (!candidate.active) reasons.push("PM_CANDIDATE_INACTIVE");
  if (!candidate.material) reasons.push("PM_CANDIDATE_IMMATERIAL");
  if (!candidate.concrete_acceptance) reasons.push("PM_ACCEPTANCE_NOT_CONCRETE");
  if (!candidate.dependencies_satisfied) reasons.push("PM_DEPENDENCIES_UNSATISFIED");
  if (!candidate.safe_authority) reasons.push("PM_UNSAFE_AUTHORITY");
  if (!candidate.clear) reasons.push("PM_CLARITY_BLOCKER");
  return reasons;
}

function decide(candidates: PmCandidate[]): z.infer<typeof DecisionSchema> {
  const details = new Map<string, z.infer<typeof CandidateDecisionSchema>>();
  for (const candidate of candidates) {
    const reasons = ineligibility(candidate);
    details.set(candidate.id, { id: candidate.id, root_key: candidate.root_key, eligible: reasons.length === 0, reason_codes: reasons });
  }
  const eligible = candidates.filter((candidate) => details.get(candidate.id)!.eligible);
  const representatives = new Map<string, PmCandidate>();
  for (const candidate of [...eligible].sort(compareCandidates)) {
    const representative = representatives.get(candidate.root_key);
    if (!representative) representatives.set(candidate.root_key, candidate);
    else details.set(candidate.id, {
      ...details.get(candidate.id)!,
      eligible: false,
      reason_codes: ["PM_DUPLICATE_ROOT"],
    });
  }
  const selected = [...representatives.values()].sort(compareCandidates)[0];
  const orderedDetails = [...details.values()].sort((a, b) => a.id.localeCompare(b.id));
  if (selected) return {
    outcome: "selected",
    reason_code: "PM_CANDIDATE_SELECTED",
    selected_id: selected.id,
    selected_root_key: selected.root_key,
    candidates: orderedDetails,
  };
  const blocked = candidates.some((candidate) => !candidate.safe_authority || !candidate.clear || !candidate.dependencies_satisfied);
  return {
    outcome: blocked ? "blocked" : "no_selection",
    reason_code: blocked ? "PM_PREPARE_BLOCKED" : candidates.length === 0 ? "PM_NO_CANDIDATES" : "PM_NO_ELIGIBLE_CANDIDATES",
    candidates: orderedDetails,
  };
}

function receiptId(goalId: string, producerSlot: string, invocationKey: string): string {
  return `pm-${sha(JSON.stringify([goalId, producerSlot, invocationKey])).slice(0, 32)}`;
}

export function pmPrepareReceiptPath(root: string, goalId: string, producerSlot: string, invocationKey: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "pm", "prepare", `${receiptId(goalId, producerSlot, invocationKey)}.json`);
}

function protectedReceipt(core: z.infer<typeof ReceiptCoreSchema>): PmPrepareReceipt {
  return ReceiptSchema.parse({ ...core, protected_state_sha256: sha(JSON.stringify(core)) });
}

async function assertSafeStore(root: string, file: string, store?: PmExecutionStore): Promise<void> {
  const harness = path.join(root, HARNESS_DIR_NAME);
  const autonomy = path.join(harness, "autonomy");
  const pm = path.join(autonomy, "pm");
  const prepare = path.join(pm, "prepare");
  for (const directory of [harness, autonomy, pm, prepare]) {
    await executionAssertPath(root, directory, "directory", "unsafe_pm_storage_path", store);
  }
  await executionAssertPath(root, file, "file", "unsafe_pm_storage_path", store);
}

async function writeReceipt(root: string, file: string, core: z.infer<typeof ReceiptCoreSchema>, store?: PmExecutionStore): Promise<PmPrepareReceipt> {
  await assertSafeStore(root, file, store);
  const receipt = protectedReceipt(core);
  await executionWriteJson(file, receipt, store);
  const reread = await readReceipt(root, file, store);
  if (!reread || JSON.stringify(reread) !== JSON.stringify(receipt)) fail("pm_receipt_readback_failed", "PM receipt did not survive exact readback");
  return reread;
}

async function readReceipt(root: string, file: string, store?: PmExecutionStore): Promise<PmPrepareReceipt | undefined> {
  await assertSafeStore(root, file, store);
  const raw = await executionReadJson<unknown>(file, store);
  if (raw === undefined) return undefined;
  const parsed = ReceiptSchema.safeParse(raw);
  if (!parsed.success) fail("pm_receipt_invalid", "stored PM receipt is malformed");
  const { protected_state_sha256, ...core } = parsed.data;
  if (protected_state_sha256 !== sha(JSON.stringify(core))) fail("pm_receipt_tampered", "stored PM receipt integrity failed");
  return parsed.data;
}

export async function readPmPrepareReceipt(
  root: string,
  goalId: string,
  producerSlot: string,
  invocationKey: string,
  store?: PmExecutionStore,
): Promise<PmPrepareReceipt | undefined> {
  const file = pmPrepareReceiptPath(root, goalId, producerSlot, invocationKey);
  return readReceipt(root, file, store);
}

function annotationContent(receipt: PmPrepareReceipt): string {
  const brief = receipt.brief;
  const bullets = (values: string[]): string => values.map((value) => `- ${value}`).join("\n");
  return [
    `PM-Prepare-Receipt: ${receipt.receipt_id}`,
    `Canonical-Input-SHA256: ${receipt.canonical_input_sha256}`,
    "", "## Objective", brief.objective,
    "", "## Non-goals", bullets(brief.non_goals),
    "", "## Acceptance", bullets(brief.acceptance),
    "", "## Evidence", bullets(brief.evidence),
    "", "## First steps", bullets(brief.first_steps),
    "", "## Verification", bullets(brief.verification),
    "", "## Capability and cost", brief.capability_cost_rationale,
    "", "## Safety and rollback", brief.safety_rollback,
    "", "## Risks", bullets(brief.risks),
    "", "## Handoff contract", brief.handoff_contract,
  ].join("\n");
}

function withProvenance(
  provenance: PmPrepareReceipt["observed_provenance"],
  runId: string,
  sessionId: string,
): PmPrepareReceipt["observed_provenance"] {
  const key = `${runId}\0${sessionId}`;
  const rows = provenance.some((row) => `${row.run_id}\0${row.session_id}` === key)
    ? provenance
    : [...provenance, { run_id: runId, session_id: sessionId }];
  return [...rows].sort((a, b) => a.run_id.localeCompare(b.run_id) || a.session_id.localeCompare(b.session_id));
}

function canonicalInputSha(
  goalId: string,
  producerSlot: string,
  invocationKey: string,
  candidateSnapshotSha: string,
  brief: PmBrief,
): string {
  return sha(JSON.stringify({
    goal_id: goalId,
    producer_slot: producerSlot,
    invocation_key: invocationKey,
    candidate_snapshot_sha256: candidateSnapshotSha,
    brief,
  }));
}

function canonicalProvenance(
  raw: PmPrepareReceipt["observed_provenance"],
): PmPrepareReceipt["observed_provenance"] {
  const parsed = PrepareProvenanceSchema.safeParse(raw);
  if (!parsed.success) fail("pm_invalid_request", "PM prepare provenance is invalid");
  const rows = new Map(parsed.data.map((row) => [`${row.run_id}\0${row.session_id}`, row]));
  return [...rows.values()].sort((a, b) => a.run_id.localeCompare(b.run_id) || a.session_id.localeCompare(b.session_id));
}

/** One pure projection for canonical prepare receipts and their provider annotation. */
export function projectPmPrepare(raw: PmPrepareProjectionInput): PmPrepareProjection {
  const provenance = canonicalProvenance(raw.observed_provenance);
  let base: PmPrepareReceipt;
  if ("receipt" in raw) {
    const parsed = ReceiptSchema.safeParse(raw.receipt);
    if (!parsed.success) fail("pm_receipt_invalid", "stored PM receipt is malformed");
    const { protected_state_sha256, ...core } = parsed.data;
    if (protected_state_sha256 !== sha(JSON.stringify(core))) {
      fail("pm_receipt_tampered", "stored PM receipt integrity failed");
    }
    base = protectedReceipt({ ...core, observed_provenance: provenance });
  } else {
    const goalId = z.string().regex(SAFE_REF).safeParse(raw.goal_id);
    const producerSlot = z.string().regex(SAFE_REF).safeParse(raw.producer_slot);
    const invocationKey = z.string().regex(SAFE_REF).safeParse(raw.invocation_key);
    const parsedBrief = BriefSchema.safeParse(raw.brief);
    if (!goalId.success || !producerSlot.success || !invocationKey.success || !parsedBrief.success) {
      fail("pm_invalid_request", "PM prepare projection input is invalid");
    }
    const brief = canonicalBrief(parsedBrief.data);
    scanBrief(brief);
    const candidates = raw.candidates.map((candidate) => {
      const parsed = CandidateSchema.safeParse(candidate);
      if (!parsed.success) return fail("pm_candidate_invalid", "PM candidate snapshot is invalid");
      return parsed.data;
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (new Set(candidates.map((candidate) => candidate.id)).size !== candidates.length) {
      fail("pm_candidate_duplicate_id", "PM provider snapshot contains duplicate ticket IDs");
    }
    assertNoSecrets(Object.fromEntries(candidates.flatMap((candidate) => [
      [`candidate.${candidate.id}.id`, candidate.id],
      [`candidate.${candidate.id}.root_key`, candidate.root_key],
    ])));
    const decision = decide(candidates);
    const candidateSnapshotSha = sha(JSON.stringify(candidates));
    base = protectedReceipt({
      schema_version: 1,
      receipt_id: receiptId(goalId.data, producerSlot.data, invocationKey.data),
      goal_id: goalId.data,
      producer_slot: producerSlot.data,
      invocation_key: invocationKey.data,
      canonical_input_sha256: canonicalInputSha(
        goalId.data,
        producerSlot.data,
        invocationKey.data,
        candidateSnapshotSha,
        brief,
      ),
      candidate_snapshot_sha256: candidateSnapshotSha,
      state: decision.outcome === "selected" ? "prepared" : decision.outcome,
      decision,
      brief,
      claim_authorized: decision.outcome === "selected",
      observed_provenance: provenance,
    });
  }

  const suppliedAnnotation = raw.provider_annotation ?? base.provider_annotation;
  if (base.decision.outcome !== "selected") {
    if (suppliedAnnotation) fail("pm_provider_readback_failed", "terminal PM prepare projection cannot have an annotation");
    const { protected_state_sha256: _protected, provider_annotation: _annotation, ...core } = base;
    return { receipt: protectedReceipt({ ...ReceiptCoreSchema.parse(core), observed_provenance: provenance }) };
  }
  const content = annotationContent(base);
  const key = `pm-${sha(`${base.receipt_id}\0annotation`).slice(0, 24)}`;
  const annotation = { candidate_id: base.decision.selected_id!, key, content };
  if (!suppliedAnnotation) {
    const { protected_state_sha256: _protected, provider_annotation: _providerAnnotation, ...core } = base;
    return { receipt: protectedReceipt({ ...ReceiptCoreSchema.parse(core), state: "prepared", observed_provenance: provenance }), annotation };
  }
  const parsedAnnotation = AnnotationSchema.safeParse(suppliedAnnotation);
  if (!parsedAnnotation.success || parsedAnnotation.data.issue_id !== annotation.candidate_id
    || parsedAnnotation.data.key !== key || parsedAnnotation.data.content !== content
    || (base.provider_annotation && JSON.stringify(base.provider_annotation) !== JSON.stringify(parsedAnnotation.data))) {
    fail("pm_provider_readback_failed", "provider annotation did not match the PM brief contract");
  }
  const { protected_state_sha256: _protected, provider_annotation: _providerAnnotation, ...core } = base;
  return {
    receipt: protectedReceipt({ ...ReceiptCoreSchema.parse(core), state: "claimed", provider_annotation: parsedAnnotation.data,
      observed_provenance: provenance }),
    annotation,
  };
}

export async function preparePm(rawInput: PreparePmInput, deps: PreparePmDeps = {}): Promise<PmPrepareReceipt> {
  const parsed = PrepareInputSchema.safeParse(rawInput);
  if (!parsed.success) fail("pm_invalid_request", "PM prepare request is invalid");
  const input = parsed.data;
  assertNoSecrets({
    goal: input.goal,
    producer_slot: input.producer_slot,
    invocation_key: input.invocation_key,
    run_id: input.run_id,
    session_id: input.session_id,
  });
  const brief = canonicalBrief(input.brief);
  scanBrief(brief);
  const resolved = await resolvePmGoal(input.cwd, input.goal, deps);
  if (!resolved) fail("pm_harness_missing", "PM prepare requires an initialized harness goal");
  await assertPmLoopActive(resolved.root, deps);
  const id = receiptId(resolved.goalId, input.producer_slot, input.invocation_key);
  const file = pmPrepareReceiptPath(resolved.root, resolved.goalId, input.producer_slot, input.invocation_key);
  const leaseKey = `pm-${sha(`${resolved.goalId}\0${input.producer_slot}\0${input.invocation_key}`).slice(0, 24)}`;
  await assertSafeStore(resolved.root, file, deps.executionStore);
  if (deps.executionStore) await deps.executionStore.assertLease(leaseKey, "unsafe_pm_storage_path");
  else await assertSafeContinuationLeaseTree(resolved.root, leaseKey, "unsafe_pm_storage_path");
  const provider = deps.provider ?? await defaultPmProvider(input.cwd, input.goal, deps);
  const operation = async () => {
    let receipt = await readReceipt(resolved.root, file, deps.executionStore);
    if (receipt) {
      const replaySha = canonicalInputSha(
        resolved.goalId,
        input.producer_slot,
        input.invocation_key,
        receipt.candidate_snapshot_sha256,
        brief,
      );
      if (receipt.canonical_input_sha256 !== replaySha) {
        fail("pm_prepare_conflict", "canonical PM prepare input differs for this producer slot and invocation");
      }
    } else {
      const rawCandidates = await provider.listCandidates();
      if (deps.faultAt === "before_write") fail("pm_fault_before_write", "injected pre-write failure");
      const projected = projectPmPrepare({
        goal_id: resolved.goalId,
        producer_slot: input.producer_slot,
        invocation_key: input.invocation_key,
        brief,
        candidates: rawCandidates,
        observed_provenance: [{ run_id: input.run_id, session_id: input.session_id }],
      }).receipt;
      if (projected.receipt_id !== id) fail("pm_prepare_identity_invalid", "PM prepare projection identity is not canonical");
      const { protected_state_sha256: _protected, ...core } = projected;
      receipt = await writeReceipt(resolved.root, file, ReceiptCoreSchema.parse(core), deps.executionStore);
    }
    const provenance = withProvenance(receipt.observed_provenance, input.run_id, input.session_id);
    if (receipt.decision.outcome !== "selected") {
      const projected = projectPmPrepare({ receipt, observed_provenance: provenance }).receipt;
      const { protected_state_sha256: _protected, ...receiptCore } = projected;
      return writeReceipt(resolved.root, file, ReceiptCoreSchema.parse(receiptCore), deps.executionStore);
    }
    if (deps.faultAt === "after_write_before_mutation") {
      fail("pm_fault_after_write_before_mutation", "injected post-write failure");
    }
    const projection = projectPmPrepare({ receipt, observed_provenance: provenance });
    const request = projection.annotation!;
    const annotation = AnnotationSchema.parse(await provider.annotate(request.candidate_id, request.key, request.content));
    if (deps.faultAt === "after_mutation_before_finalize") {
      fail("pm_fault_after_mutation_before_finalize", "injected post-mutation failure");
    }
    const claimed = projectPmPrepare({ receipt, observed_provenance: provenance, provider_annotation: annotation }).receipt;
    const { protected_state_sha256: _protected, ...receiptCore } = claimed;
    receipt = await writeReceipt(resolved.root, file, ReceiptCoreSchema.parse(receiptCore), deps.executionStore);
    return receipt;
  };
  return deps.executionStore
    ? deps.executionStore.withLease(leaseKey, operation)
    : withCoordinationLease(resolved.root, leaseKey, operation, deps);
}

const ArtifactKindSchema = z.enum(["prompt", "output", "exit_status", "meaningful_log"]);
const RelativeArtifactSchema = z.string().min(1).max(240).refine((value) => {
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) return false;
  const parts = value.split(/[\\/]/);
  return parts.every((part) => part !== "" && part !== "." && part !== "..");
}, "artifact path must be a safe relative path");
const CapabilitySchema = z.object({
  id: z.string().regex(SAFE_REF),
  rank: z.number().int().nonnegative(),
}).strict();
const PmActorIdentitySchema = z.object({
  subject: z.string().regex(SAFE_REF),
  run_id: z.string().regex(SAFE_REF),
  session_id: z.string().regex(SAFE_REF),
}).strict();
const WorkerSchema = z.object({
  subject: z.string().regex(SAFE_REF),
  run_id: z.string().regex(SAFE_REF),
  session_id: z.string().regex(SAFE_REF),
  capability: CapabilitySchema,
}).strict();
const ClaimSchema = z.object({
  claim_id: z.string().regex(SAFE_REF),
  ticket_id: z.string().regex(SAFE_REF),
  provider_annotation_id: z.string().regex(SAFE_REF),
}).strict();
const ArtifactPathsSchema = z.object({
  prompt: RelativeArtifactSchema,
  output: RelativeArtifactSchema,
  exit_status: RelativeArtifactSchema,
  meaningful_log: RelativeArtifactSchema,
}).strict().refine((value) => new Set(Object.values(value)).size === 4, "artifact paths must be distinct");
const HandoffBodySchema = z.object({
  acceptance_checklist: z.array(z.object({
    criterion: z.string().min(1).max(4096),
    status: z.enum(["pass", "fail", "not_run"]),
    evidence: z.array(z.string().min(1).max(4096)).max(32),
  }).strict()).min(1).max(64),
  remaining_risks: z.array(z.string().min(1).max(4096)).max(32),
  severity_self_assessment: z.enum(["None", "Critical", "High", "Medium", "Low"]),
  changed_files: z.array(z.string().min(1).max(4096)).max(256),
  evidence: z.array(z.string().min(1).max(4096)).max(64),
  commands: z.array(z.object({
    command: z.string().min(1).max(8192),
    result: z.string().min(1).max(8192),
  }).strict()).max(64),
  follow_up: z.object({
    ids: z.array(z.string().regex(SAFE_REF)).max(32),
    suggestions: z.array(z.string().min(1).max(4096)).max(32),
  }).strict().refine((value) => value.ids.length > 0 || value.suggestions.length > 0, "follow-up IDs or suggestions required"),
}).strict();
const HandoffInputSchema = z.object({
  cwd: z.string().min(1).max(4096),
  goal: z.string().regex(SAFE_REF).optional(),
  producer_slot: z.string().regex(SAFE_REF),
  invocation_key: z.string().regex(SAFE_REF),
  prepare_receipt_id: z.string().regex(/^pm-[0-9a-f]{32}$/),
  claim: ClaimSchema,
  worker_origin: PmActorOriginSelectorSchema,
  artifacts: ArtifactPathsSchema,
  outcome: z.enum(["completed", "crashed", "timed_out"]),
  handoff: HandoffBodySchema,
}).strict();

export type HandoffPmInput = z.input<typeof HandoffInputSchema>;

const ArtifactEntrySchema = z.object({
  kind: ArtifactKindSchema,
  relative_path: z.string(),
  size_bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(SHA256),
}).strict();
const WorkerActorPayloadSchema = z.object({
  kind: z.literal("pm_worker_handoff"),
  goal_id: z.string().regex(SAFE_REF),
  parent_id: z.string().regex(SAFE_REF),
  ticket_id: z.string().regex(SAFE_REF),
  prepare_receipt_id: z.string().regex(/^pm-[0-9a-f]{32}$/),
  claim_id: z.string().regex(/^pmc-[0-9a-f]{32}$/),
  producer_slot: z.string().regex(SAFE_REF),
  invocation_key: z.string().regex(SAFE_REF),
  outcome: z.enum(["completed", "crashed", "timed_out"]),
  manifest: z.array(ArtifactEntrySchema).length(4),
  handoff: HandoffBodySchema,
}).strict();
const StagedManifestCoreSchema = z.object({
  schema_version: z.literal(1),
  canonical_input_sha256: z.string().regex(SHA256),
  entries: z.array(ArtifactEntrySchema).length(4),
}).strict();
const StagedManifestSchema = StagedManifestCoreSchema.extend({
  protected_state_sha256: z.string().regex(SHA256),
}).strict();
const HandoffReceiptCoreSchema = z.object({
  schema_version: z.literal(2),
  receipt_id: z.string().regex(/^pmh-[0-9a-f]{32}$/),
  goal_id: z.string(),
  producer_slot: z.string().regex(SAFE_REF),
  invocation_key: z.string().regex(SAFE_REF),
  prepare_receipt_id: z.string(),
  prepare_claim_commitment_sha256: z.string().regex(SHA256),
  worker_claim_protected_state_sha256: z.string().regex(SHA256),
  worker_origin: z.object({
    selector: PmActorOriginSelectorSchema,
    assurance: z.enum(["authenticated_install", "manual_local_double"]),
    record_sha256: z.string().regex(SHA256),
    payload_sha256: z.string().regex(SHA256),
  }).strict(),
  worker_payload: WorkerActorPayloadSchema,
  canonical_input_sha256: z.string().regex(SHA256),
  claim: ClaimSchema,
  worker: WorkerSchema,
  state: z.enum(["handed_off", "incomplete"]),
  outcome: z.enum(["completed", "crashed", "timed_out"]),
  required_review_classification: z.enum(["None", "High"]),
  manifest: z.array(ArtifactEntrySchema).length(4),
  manifest_sha256: z.string().regex(SHA256),
  handoff: HandoffBodySchema,
}).strict();
const HandoffReceiptSchema = HandoffReceiptCoreSchema.extend({
  protected_state_sha256: z.string().regex(SHA256),
}).strict();
const WorkerClaimReceiptCoreSchema = z.object({
  schema_version: z.literal(2),
  claim_receipt_id: z.string().regex(/^pmcr-[0-9a-f]{32}$/),
  goal_id: z.string(),
  prepare_receipt_id: z.string().regex(/^pm-[0-9a-f]{32}$/),
  prepare_claim_commitment_sha256: z.string().regex(SHA256),
  claim: ClaimSchema,
  worker: WorkerSchema,
  worker_origin: z.object({
    selector: PmActorOriginSelectorSchema,
    assurance: z.enum(["authenticated_install", "manual_local_double"]),
    record_sha256: z.string().regex(SHA256),
    payload_sha256: z.string().regex(SHA256),
  }).strict(),
  worker_payload: WorkerActorPayloadSchema,
}).strict();
const WorkerClaimReceiptSchema = WorkerClaimReceiptCoreSchema.extend({
  protected_state_sha256: z.string().regex(SHA256),
}).strict();

export type PmHandoffReceipt = z.infer<typeof HandoffReceiptSchema>;

export interface HandoffPmDeps extends CoordinationDeps, PmExecutionDeps {
  binding?: CoordinationBinding;
  readActorOrigin?: (selector: PmActorOriginSelector) => Promise<TrustedPmActorOriginReadback | undefined>;
  allowManualLocalDouble?: boolean;
  faultAt?: "before_write" | "during_manifest_write" | "after_artifact_before_finalize";
  afterArtifactFirstRead?: (kind: z.infer<typeof ArtifactKindSchema>, file: string) => void | Promise<void>;
  expectedArtifactManifest?: readonly z.infer<typeof ArtifactEntrySchema>[];
}

const MAX_PM_ARTIFACT_BYTES = 1024 * 1024;
const MAX_PM_ARTIFACT_TOTAL_BYTES = 2 * 1024 * 1024;

export function pmPrepareClaimCommitment(prepareReceipt: PmPrepareReceipt): string {
  const prepare = ReceiptSchema.parse(prepareReceipt);
  const { protected_state_sha256, ...core } = prepare;
  if (protected_state_sha256 !== sha(JSON.stringify(core))) {
    fail("pm_receipt_tampered", "PM prepare receipt integrity failed before claim commitment");
  }
  if (!prepare.provider_annotation || !prepare.decision.selected_id || !prepare.decision.selected_root_key) {
    fail("pm_prepare_not_claimed", "stable worker claim commitment requires a claimed PM prepare receipt");
  }
  return sha(JSON.stringify({
    goal_id: prepare.goal_id,
    receipt_id: prepare.receipt_id,
    producer_slot: prepare.producer_slot,
    invocation_key: prepare.invocation_key,
    canonical_input_sha256: prepare.canonical_input_sha256,
    candidate_snapshot_sha256: prepare.candidate_snapshot_sha256,
    selected_ticket_id: prepare.decision.selected_id,
    selected_root_key: prepare.decision.selected_root_key,
    provider_annotation: prepare.provider_annotation,
  }));
}

export function pmWorkerClaimId(
  goalId: string,
  prepare: PmPrepareReceipt,
  worker: z.input<typeof WorkerSchema>,
): string {
  const parsedWorker = WorkerSchema.parse(worker);
  if (goalId !== prepare.goal_id) fail("pm_claim_identity_invalid", "worker claim goal does not match its prepare receipt");
  return `pmc-${sha(JSON.stringify([
    goalId,
    pmPrepareClaimCommitment(prepare),
    parsedWorker.subject,
    parsedWorker.run_id,
    parsedWorker.session_id,
    parsedWorker.capability.id,
    parsedWorker.capability.rank,
  ])).slice(0, 32)}`;
}

function handoffReceiptId(goalId: string, claimId: string): string {
  return `pmh-${sha(JSON.stringify([goalId, claimId])).slice(0, 32)}`;
}

export function pmWorkerRunRoot(root: string, goalId: string, claimId: string): string {
  const runId = `pm-run-${sha(JSON.stringify([goalId, claimId])).slice(0, 24)}`;
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "pm", "runs", runId);
}

export function pmHandoffReceiptPath(root: string, goalId: string, claimId: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "pm", "handoff", `${handoffReceiptId(goalId, claimId)}.json`);
}

export function pmWorkerClaimReceiptPath(root: string, prepareReceiptId: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "pm", "claims", `${prepareReceiptId}.json`);
}

function stagedManifestPath(root: string, goalId: string, claimId: string): string {
  return path.join(pmWorkerRunRoot(root, goalId, claimId), ".pm-artifact-manifest.json");
}

function containedBy(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

async function assertSafeHandoffStore(root: string, goalId: string, claimId: string, store?: PmExecutionStore): Promise<void> {
  const harness = path.join(root, HARNESS_DIR_NAME);
  const autonomy = path.join(harness, "autonomy");
  const pm = path.join(autonomy, "pm");
  const handoff = path.join(pm, "handoff");
  for (const directory of [harness, autonomy, pm, handoff]) {
    await executionAssertPath(root, directory, "directory", "pm_artifact_unsafe", store);
  }
  await executionAssertPath(root, pmHandoffReceiptPath(root, goalId, claimId), "file", "pm_artifact_unsafe", store);
}

async function assertSafeArtifactStore(root: string, goalId: string, claimId: string, store?: PmExecutionStore): Promise<void> {
  const pm = path.join(root, HARNESS_DIR_NAME, "autonomy", "pm");
  const runs = path.join(pm, "runs");
  const runRoot = pmWorkerRunRoot(root, goalId, claimId);
  for (const directory of [runs, runRoot]) {
    await executionAssertPath(root, directory, "directory", "pm_artifact_unsafe", store);
  }
  await executionAssertPath(root, stagedManifestPath(root, goalId, claimId), "file", "pm_artifact_unsafe", store);
}

async function assertSafeClaimStore(root: string, prepareReceiptId: string, store?: PmExecutionStore): Promise<void> {
  const pm = path.join(root, HARNESS_DIR_NAME, "autonomy", "pm");
  const claims = path.join(pm, "claims");
  await executionAssertPath(root, claims, "directory", "pm_claim_storage_unsafe", store);
  await executionAssertPath(root, pmWorkerClaimReceiptPath(root, prepareReceiptId), "file", "pm_claim_storage_unsafe", store);
}

async function readWorkerClaim(root: string, prepareReceiptId: string, store?: PmExecutionStore) {
  await assertSafeClaimStore(root, prepareReceiptId, store);
  const raw = await executionReadJson<unknown>(pmWorkerClaimReceiptPath(root, prepareReceiptId), store);
  if (raw === undefined) return undefined;
  const parsed = WorkerClaimReceiptSchema.safeParse(raw);
  if (!parsed.success) fail("pm_claim_receipt_invalid", "stored PM worker claim is malformed");
  const { protected_state_sha256, ...core } = parsed.data;
  if (protected_state_sha256 !== sha(JSON.stringify(core))) fail("pm_claim_receipt_tampered", "stored PM worker claim integrity failed");
  return parsed.data;
}

async function bindWorkerClaim(
  root: string,
  goalId: string,
  prepare: PmPrepareReceipt,
  claim: z.infer<typeof ClaimSchema>,
  worker: z.infer<typeof WorkerSchema>,
  workerOrigin: z.infer<typeof HandoffReceiptCoreSchema>["worker_origin"],
  workerPayload: Record<string, unknown>,
  store?: PmExecutionStore,
) {
  const core = WorkerClaimReceiptCoreSchema.parse({
    schema_version: 2,
    claim_receipt_id: `pmcr-${sha(JSON.stringify([goalId, prepare.receipt_id])).slice(0, 32)}`,
    goal_id: goalId,
    prepare_receipt_id: prepare.receipt_id,
    prepare_claim_commitment_sha256: pmPrepareClaimCommitment(prepare),
    claim,
    worker,
    worker_origin: workerOrigin,
    worker_payload: workerPayload,
  });
  const existing = await readWorkerClaim(root, prepare.receipt_id, store);
  if (existing) {
    const { protected_state_sha256: _protected, ...existingCore } = existing;
    if (JSON.stringify(existingCore) !== JSON.stringify(core)) {
      fail("pm_claim_conflict", "authenticated PM prepare receipt is already bound to another worker claim");
    }
    return existing;
  }
  const receipt = WorkerClaimReceiptSchema.parse({ ...core, protected_state_sha256: sha(JSON.stringify(core)) });
  await executionWriteJson(pmWorkerClaimReceiptPath(root, prepare.receipt_id), receipt, store);
  const reread = await readWorkerClaim(root, prepare.receipt_id, store);
  if (!reread || JSON.stringify(reread) !== JSON.stringify(receipt)) fail("pm_claim_readback_failed", "PM worker claim did not survive exact readback");
  return reread;
}

function normalizedHandoffBody(body: z.infer<typeof HandoffBodySchema>): z.infer<typeof HandoffBodySchema> {
  return {
    acceptance_checklist: body.acceptance_checklist.map((row) => ({
      criterion: normalizeText(row.criterion),
      status: row.status,
      evidence: canonicalList(row.evidence),
    })),
    remaining_risks: canonicalList(body.remaining_risks),
    severity_self_assessment: body.severity_self_assessment,
    changed_files: canonicalList(body.changed_files),
    evidence: canonicalList(body.evidence),
    commands: body.commands.map((row) => ({ command: normalizeText(row.command), result: normalizeText(row.result) })),
    follow_up: {
      ids: canonicalList(body.follow_up.ids),
      suggestions: canonicalList(body.follow_up.suggestions),
    },
  };
}

function scanHandoffInput(input: z.infer<typeof HandoffInputSchema>, body: z.infer<typeof HandoffBodySchema>): void {
  const fields: Record<string, string | undefined> = {
    producer_slot: input.producer_slot,
    invocation_key: input.invocation_key,
    prepare_receipt_id: input.prepare_receipt_id,
    claim_id: input.claim.claim_id,
    ticket_id: input.claim.ticket_id,
    provider_annotation_id: input.claim.provider_annotation_id,
    worker_origin_id: input.worker_origin.origin_id,
    worker_record_id: input.worker_origin.record_id,
  };
  body.acceptance_checklist.forEach((row, i) => {
    fields[`acceptance.${i}.criterion`] = row.criterion;
    row.evidence.forEach((value, j) => { fields[`acceptance.${i}.evidence.${j}`] = value; });
  });
  for (const [key, values] of Object.entries({
    remaining_risks: body.remaining_risks,
    changed_files: body.changed_files,
    evidence: body.evidence,
    follow_up_ids: body.follow_up.ids,
    follow_up_suggestions: body.follow_up.suggestions,
  })) values.forEach((value, i) => { fields[`${key}.${i}`] = value; });
  body.commands.forEach((row, i) => {
    fields[`commands.${i}.command`] = row.command;
    fields[`commands.${i}.result`] = row.result;
  });
  assertNoSecrets(fields);
}

function handoffCanonicalInput(
  goalId: string,
  input: z.infer<typeof HandoffInputSchema>,
  handoff: z.infer<typeof HandoffBodySchema>,
): string {
  return sha(JSON.stringify({
    goal_id: goalId,
    producer_slot: input.producer_slot,
    invocation_key: input.invocation_key,
    prepare_receipt_id: input.prepare_receipt_id,
    claim: input.claim,
    worker_origin: input.worker_origin,
    artifacts: input.artifacts,
    outcome: input.outcome,
    handoff,
  }));
}

export function pmWorkerActorPayload(input: {
  goal_id: string;
  parent_id: string;
  ticket_id: string;
  prepare_receipt_id: string;
  claim_id: string;
  producer_slot: string;
  invocation_key: string;
  outcome: "completed" | "crashed" | "timed_out";
  manifest: readonly z.infer<typeof ArtifactEntrySchema>[];
  handoff: z.infer<typeof HandoffBodySchema>;
}): z.infer<typeof WorkerActorPayloadSchema> {
  return WorkerActorPayloadSchema.parse({
    kind: "pm_worker_handoff",
    goal_id: input.goal_id,
    parent_id: input.parent_id,
    ticket_id: input.ticket_id,
    prepare_receipt_id: input.prepare_receipt_id,
    claim_id: input.claim_id,
    producer_slot: input.producer_slot,
    invocation_key: input.invocation_key,
    outcome: input.outcome,
    manifest: input.manifest,
    handoff: input.handoff,
  });
}

async function readActorOrigin(
  selector: PmActorOriginSelector,
  role: "worker" | "reviewer",
  deps: { readActorOrigin?: (value: PmActorOriginSelector) => Promise<TrustedPmActorOriginReadback | undefined>;
    allowManualLocalDouble?: boolean },
  code: string,
): Promise<TrustedPmActorOriginReadback> {
  const record = await (deps.readActorOrigin ?? readProjectedPmActorOrigin)(selector);
  if (!record || record.role !== role
    || (record.assurance === "manual_local_double" && !deps.allowManualLocalDouble)) {
    return fail(code, `PM ${role} actor origin is missing, untrusted, or role-mismatched`);
  }
  return record;
}

function actorBinding(record: TrustedPmActorOriginReadback, selector: PmActorOriginSelector) {
  return {
    selector,
    assurance: record.assurance,
    record_sha256: record.record_sha256,
    payload_sha256: record.payload_sha256,
  };
}

function sameArtifactIdentity(a: Awaited<ReturnType<typeof fs.lstat>>, b: Awaited<ReturnType<typeof fs.lstat>>): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size
    && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs && a.birthtimeMs === b.birthtimeMs;
}

async function readSafeArtifact(
  runRoot: string,
  kind: z.infer<typeof ArtifactKindSchema>,
  relativePath: string,
  deps: HandoffPmDeps,
) {
  const file = path.resolve(runRoot, relativePath);
  if (!containedBy(runRoot, file)) fail("pm_artifact_unsafe", "artifact path escaped the PM run root");
  if (deps.executionStore) {
    const second = await deps.executionStore.readArtifact(
      file,
      MAX_PM_ARTIFACT_BYTES,
      () => deps.afterArtifactFirstRead?.(kind, file),
    );
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(second);
    } catch {
      return fail("pm_artifact_invalid_text", "PM worker artifacts must be valid UTF-8 text");
    }
    if (second.byteLength === 0 || (kind === "meaningful_log" && text.trim() === "")) {
      fail("pm_artifact_empty", "required PM worker artifacts must contain meaningful content");
    }
    try { assertNoSecrets({ [`artifact.${kind}`]: text }); }
    catch (error) {
      if (error instanceof CoordinationError && error.code === "secret_rejected") fail("pm_artifact_secret", "artifact contains credential-like content");
      throw error;
    }
    return { entry: { kind, relative_path: relativePath, size_bytes: second.byteLength,
      sha256: createHash("sha256").update(second).digest("hex") }, text };
  }
  await assertSafeContinuationStoragePath(runRoot, file, "file", "pm_artifact_unsafe");
  const before = await fs.lstat(file).catch(() => fail("pm_artifact_unsafe", "artifact must exist as a regular file"));
  if (!before.isFile() || before.isSymbolicLink()) fail("pm_artifact_unsafe", "artifact must be a regular file");
  if (before.size > MAX_PM_ARTIFACT_BYTES) fail("pm_artifact_too_large", "artifact exceeded the per-file bound");
  const first = await fs.readFile(file);
  await deps.afterArtifactFirstRead?.(kind, file);
  const between = await fs.lstat(file).catch(() => fail("pm_artifact_tampered", "artifact identity changed between authenticated reads"));
  const second = await fs.readFile(file).catch(() => fail("pm_artifact_tampered", "artifact changed between authenticated reads"));
  const after = await fs.lstat(file).catch(() => fail("pm_artifact_tampered", "artifact identity changed between authenticated reads"));
  if (!between.isFile() || between.isSymbolicLink() || !after.isFile() || after.isSymbolicLink()
    || !sameArtifactIdentity(before, between) || !sameArtifactIdentity(between, after)
    || !first.equals(second)
    || createHash("sha256").update(first).digest("hex") !== createHash("sha256").update(second).digest("hex")) {
    fail("pm_artifact_tampered", "artifact identity or content changed between authenticated reads");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(second);
  } catch {
    return fail("pm_artifact_invalid_text", "PM worker artifacts must be valid UTF-8 text");
  }
  if (second.byteLength === 0 || (kind === "meaningful_log" && text.trim() === "")) {
    fail("pm_artifact_empty", "required PM worker artifacts must contain meaningful content");
  }
  try {
    assertNoSecrets({ [`artifact.${kind}`]: text });
  } catch (error) {
    if (error instanceof CoordinationError && error.code === "secret_rejected") {
      fail("pm_artifact_secret", "artifact contains credential-like content");
    }
    throw error;
  }
  return {
    entry: { kind, relative_path: relativePath, size_bytes: second.byteLength, sha256: createHash("sha256").update(second).digest("hex") },
    text,
  };
}

async function artifactManifest(
  runRoot: string,
  artifacts: z.infer<typeof ArtifactPathsSchema>,
  outcome: z.infer<typeof HandoffInputSchema>["outcome"],
  deps: HandoffPmDeps,
) {
  const authenticated = [];
  for (const kind of ArtifactKindSchema.options) authenticated.push(await readSafeArtifact(runRoot, kind, artifacts[kind], deps));
  const entries = authenticated.map((result) => result.entry);
  if (entries.reduce((total, entry) => total + entry.size_bytes, 0) > MAX_PM_ARTIFACT_TOTAL_BYTES) {
    fail("pm_artifact_too_large", "artifacts exceeded the aggregate bound");
  }
  if (deps.expectedArtifactManifest) {
    const expected = z.array(ArtifactEntrySchema).length(4).safeParse(deps.expectedArtifactManifest);
    if (!expected.success || JSON.stringify(entries) !== JSON.stringify(expected.data)) {
      fail("pm_artifact_tampered", "PM artifact content differs from the caller-bound expected manifest");
    }
  }
  const exitText = authenticated.find((result) => result.entry.kind === "exit_status")!.text;
  const match = /^(0|[1-9][0-9]{0,2})\n?$/.exec(exitText);
  if (!match || Number(match[1]) > 255) fail("pm_exit_status_invalid", "exit status must be one bounded text integer from 0 to 255");
  const exitStatus = Number(match[1]);
  const reconciled = outcome === "completed" ? exitStatus === 0
    : outcome === "timed_out" ? exitStatus === 124
      : exitStatus !== 0 && exitStatus !== 124;
  if (!reconciled) fail("pm_exit_status_mismatch", "worker outcome does not match its authenticated exit status");
  return entries;
}

async function readStagedManifest(root: string, goalId: string, claimId: string, store?: PmExecutionStore) {
  const raw = await executionReadJson<unknown>(stagedManifestPath(root, goalId, claimId), store);
  if (raw === undefined) return undefined;
  const parsed = StagedManifestSchema.safeParse(raw);
  if (!parsed.success) fail("pm_manifest_invalid", "staged PM artifact manifest is malformed");
  const { protected_state_sha256, ...core } = parsed.data;
  if (protected_state_sha256 !== sha(JSON.stringify(core))) fail("pm_manifest_tampered", "staged PM artifact manifest integrity failed");
  return parsed.data;
}

async function writeStagedManifest(root: string, goalId: string, claimId: string, core: z.infer<typeof StagedManifestCoreSchema>, store?: PmExecutionStore) {
  const value = StagedManifestSchema.parse({ ...core, protected_state_sha256: sha(JSON.stringify(core)) });
  await executionWriteJson(stagedManifestPath(root, goalId, claimId), value, store);
  const reread = await readStagedManifest(root, goalId, claimId, store);
  if (!reread || JSON.stringify(reread) !== JSON.stringify(value)) fail("pm_manifest_readback_failed", "PM artifact manifest did not survive exact readback");
  return reread;
}

async function readHandoffReceipt(root: string, goalId: string, claimId: string, store?: PmExecutionStore): Promise<PmHandoffReceipt | undefined> {
  await assertSafeHandoffStore(root, goalId, claimId, store);
  const raw = await executionReadJson<unknown>(pmHandoffReceiptPath(root, goalId, claimId), store);
  if (raw === undefined) return undefined;
  const parsed = HandoffReceiptSchema.safeParse(raw);
  if (!parsed.success) fail("pm_handoff_receipt_invalid", "stored PM handoff receipt is malformed");
  const { protected_state_sha256, ...core } = parsed.data;
  if (protected_state_sha256 !== sha(JSON.stringify(core))) fail("pm_handoff_receipt_tampered", "stored PM handoff receipt integrity failed");
  return parsed.data;
}

export async function readPmHandoffReceipt(root: string, goalId: string, claimId: string, store?: PmExecutionStore): Promise<PmHandoffReceipt | undefined> {
  return readHandoffReceipt(root, goalId, claimId, store);
}

async function writeHandoffReceipt(root: string, goalId: string, claimId: string, core: z.infer<typeof HandoffReceiptCoreSchema>, store?: PmExecutionStore) {
  const receipt = HandoffReceiptSchema.parse({ ...core, protected_state_sha256: sha(JSON.stringify(core)) });
  await executionWriteJson(pmHandoffReceiptPath(root, goalId, claimId), receipt, store);
  const reread = await readHandoffReceipt(root, goalId, claimId, store);
  if (!reread || JSON.stringify(reread) !== JSON.stringify(receipt)) fail("pm_handoff_readback_failed", "PM handoff receipt did not survive exact readback");
  return reread;
}

export async function handoffPm(rawInput: HandoffPmInput, deps: HandoffPmDeps = {}): Promise<PmHandoffReceipt> {
  const parsed = HandoffInputSchema.safeParse(rawInput);
  if (!parsed.success) fail("pm_invalid_handoff_request", "PM handoff request is invalid");
  const input = parsed.data;
  const handoff = normalizedHandoffBody(input.handoff);
  scanHandoffInput(input, handoff);
  const resolved = await resolvePmGoal(input.cwd, input.goal, deps);
  if (!resolved) fail("pm_harness_missing", "PM handoff requires an initialized harness goal");
  await assertSafeHandoffStore(resolved.root, resolved.goalId, input.claim.claim_id, deps.executionStore);
  const prepare = await readPmPrepareReceipt(resolved.root, resolved.goalId, input.producer_slot, input.invocation_key, deps.executionStore);
  if (!prepare || prepare.state !== "claimed" || !prepare.claim_authorized || prepare.receipt_id !== input.prepare_receipt_id
    || prepare.decision.selected_id !== input.claim.ticket_id || prepare.provider_annotation?.id !== input.claim.provider_annotation_id
    || prepare.provider_annotation.issue_id !== input.claim.ticket_id) {
    fail("pm_claim_mismatch", "PM worker claim does not match an authenticated claimed prepare receipt");
  }
  const binding = deps.binding ?? await verifyCoordinationBinding(input.cwd, input.goal, deps);
  if (!binding || binding.goal_id !== resolved.goalId) {
    fail("pm_worker_origin_scope_invalid", "PM worker actor origin requires the authenticated goal destination");
  }
  const workerRecord = await readActorOrigin(input.worker_origin, "worker", deps, "pm_worker_origin_invalid");
  if (!workerRecord.capability) fail("pm_worker_origin_invalid", "PM worker actor record is missing capability");
  const worker = WorkerSchema.parse({ subject: workerRecord.subject, run_id: workerRecord.run_id,
    session_id: workerRecord.session_id, capability: workerRecord.capability });
  if (input.claim.claim_id !== pmWorkerClaimId(resolved.goalId, prepare, worker)) {
    fail("pm_claim_identity_invalid", "PM worker claim identity is not derived from its authenticated provenance");
  }
  if (workerRecord.goal_id !== resolved.goalId || workerRecord.parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
    || workerRecord.ticket_id !== input.claim.ticket_id || workerRecord.prepare_receipt_id !== prepare.receipt_id
    || workerRecord.claim_id !== input.claim.claim_id) {
    fail("pm_worker_origin_scope_invalid", "signed PM worker actor scope does not match goal, parent, ticket, prepare, and claim");
  }
  const workerOrigin = actorBinding(workerRecord, input.worker_origin);
  await assertSafeClaimStore(resolved.root, prepare.receipt_id, deps.executionStore);
  const canonicalInput = handoffCanonicalInput(resolved.goalId, input, handoff);
  const leaseKey = `pmh-${sha(`${resolved.goalId}\0${prepare.receipt_id}`).slice(0, 24)}`;
  if (deps.executionStore) await deps.executionStore.assertLease(leaseKey, "pm_artifact_unsafe");
  else await assertSafeContinuationLeaseTree(resolved.root, leaseKey, "pm_artifact_unsafe");
  const operation = async () => {
    await assertSafeArtifactStore(resolved.root, resolved.goalId, input.claim.claim_id, deps.executionStore);
    const runRoot = pmWorkerRunRoot(resolved.root, resolved.goalId, input.claim.claim_id);
    const entries = await artifactManifest(runRoot, input.artifacts, input.outcome, deps);
    const signedPayload = pmWorkerActorPayload({ goal_id: resolved.goalId, parent_id: binding.parent_id,
      ticket_id: input.claim.ticket_id, prepare_receipt_id: prepare.receipt_id, claim_id: input.claim.claim_id,
      producer_slot: input.producer_slot, invocation_key: input.invocation_key, outcome: input.outcome,
      manifest: entries, handoff });
    if (workerRecord.payload_sha256 !== sha(JSON.stringify(signedPayload))
      || JSON.stringify(workerRecord.payload) !== JSON.stringify(signedPayload)) {
      fail("pm_worker_origin_payload_invalid", "signed PM worker payload does not match artifacts and handoff");
    }
    const workerClaim = await bindWorkerClaim(resolved.root, resolved.goalId, prepare, input.claim, worker,
      workerOrigin, signedPayload, deps.executionStore);
    let staged = await readStagedManifest(resolved.root, resolved.goalId, input.claim.claim_id, deps.executionStore);
    if (staged) {
      if (staged.canonical_input_sha256 !== canonicalInput) fail("pm_handoff_conflict", "canonical PM handoff input differs for this claim");
      if (JSON.stringify(staged.entries) !== JSON.stringify(entries)) fail("pm_artifact_tampered", "PM artifact content differs from its authenticated manifest");
    } else {
      if (deps.faultAt === "before_write") fail("pm_fault_before_handoff_write", "injected pre-write failure");
      if (deps.faultAt === "during_manifest_write") fail("pm_fault_during_manifest_write", "injected partial-write failure");
      staged = await writeStagedManifest(resolved.root, resolved.goalId, input.claim.claim_id, {
        schema_version: 1,
        canonical_input_sha256: canonicalInput,
        entries,
      }, deps.executionStore);
    }
    if (deps.faultAt === "after_artifact_before_finalize") {
      fail("pm_fault_after_artifact_before_finalize", "injected post-artifact failure");
    }
    const existing = await readHandoffReceipt(resolved.root, resolved.goalId, input.claim.claim_id, deps.executionStore);
    if (existing) {
      if (existing.canonical_input_sha256 !== canonicalInput) fail("pm_handoff_conflict", "canonical PM handoff input differs for this claim");
      if (JSON.stringify(existing.manifest) !== JSON.stringify(entries)) fail("pm_artifact_tampered", "PM artifacts differ from the handoff receipt");
      return existing;
    }
    const manifestSha = sha(JSON.stringify(staged.entries));
    return writeHandoffReceipt(resolved.root, resolved.goalId, input.claim.claim_id, {
      schema_version: 2,
      receipt_id: handoffReceiptId(resolved.goalId, input.claim.claim_id),
      goal_id: resolved.goalId,
      producer_slot: input.producer_slot,
      invocation_key: input.invocation_key,
      prepare_receipt_id: prepare.receipt_id,
      prepare_claim_commitment_sha256: pmPrepareClaimCommitment(prepare),
      worker_claim_protected_state_sha256: workerClaim.protected_state_sha256,
      worker_origin: workerOrigin,
      worker_payload: signedPayload,
      canonical_input_sha256: canonicalInput,
      claim: input.claim,
      worker,
      state: input.outcome === "completed" ? "handed_off" : "incomplete",
      outcome: input.outcome,
      required_review_classification: input.outcome === "completed" ? "None" : "High",
      manifest: staged.entries,
      manifest_sha256: manifestSha,
      handoff,
    }, deps.executionStore);
  };
  return deps.executionStore
    ? deps.executionStore.withLease(leaseKey, operation)
    : withCoordinationLease(resolved.root, leaseKey, operation, deps);
}

const PmTicketStatusSchema = z.enum(["todo", "in_progress", "in_review", "done", "blocked", "cancelled"]);
const PmLiveTicketProofSchema = z.object({
  ticket_id: z.string().regex(SAFE_REF),
  configured_parent_id: z.string().regex(SAFE_REF),
  parent_id: z.string().regex(SAFE_REF),
  status: PmTicketStatusSchema,
  content_strings: z.array(z.string().min(1).max(8192)).min(1).max(256),
  evidence_reference_ids: z.array(z.string().regex(SAFE_REF)).max(256),
  readback_at: z.string().datetime(),
}).strict();

export type PmLiveTicketProof = z.infer<typeof PmLiveTicketProofSchema>;

function parsePmLiveTicketProof(value: unknown): PmLiveTicketProof {
  const parsed = PmLiveTicketProofSchema.safeParse(value);
  if (!parsed.success) return fail("pm_review_live_proof_invalid", "live ticket proof is malformed");
  return parsed.data;
}

const CorrectionRequestSchema = z.object({
  root_cause_key: z.string().regex(SAFE_REF),
  strength: z.enum(["equal", "stronger"]),
  required_capability: CapabilitySchema,
  title: z.string().min(1).max(512),
  acceptance: z.array(z.string().min(1).max(4096)).min(1).max(32),
  verification: z.array(z.string().min(1).max(4096)).min(1).max(32),
  rollback: z.string().min(1).max(4096),
}).strict();
export type PmCorrectionRequest = z.infer<typeof CorrectionRequestSchema>;

const CorrectionReferenceSchema = z.object({
  reference_id: z.string().regex(SAFE_REF),
  key: z.string().regex(SAFE_REF),
  root_cause_key: z.string().regex(SAFE_REF),
  strength: z.enum(["equal", "stronger"]),
  required_capability: CapabilitySchema,
}).strict();
export type PmCorrectionReference = z.infer<typeof CorrectionReferenceSchema>;

const ReviewerIdentitySchema = PmActorIdentitySchema;
const Phase4ProofSchema = z.object({
  proof_id: z.string().regex(SHA256),
  parent_id: z.string().regex(SAFE_REF),
  run_id: z.string().regex(SAFE_REF),
  session_id: z.string().regex(SAFE_REF),
}).strict();
const ReviewSeveritySchema = z.enum(["Critical", "High", "Medium", "Low"]);
const FindingBaseSchema = z.object({
  id: z.string().regex(SAFE_REF),
  severity: ReviewSeveritySchema,
  root_cause_key: z.string().regex(SAFE_REF),
  summary: z.string().min(1).max(4096),
  evidence: z.array(z.string().min(1).max(4096)).min(1).max(32),
});
const LowerDispositionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("resolved"), resolution: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("follow_up"), reference_id: z.string().regex(SAFE_REF) }).strict(),
  z.object({ kind: z.literal("not_worth_doing"), rationale: z.string().min(1).max(4096) }).strict(),
]);
const ReviewFindingInputSchema = z.union([
  FindingBaseSchema.extend({ severity: z.enum(["Critical", "High"]) }).strict(),
  FindingBaseSchema.extend({ severity: z.enum(["Medium", "Low"]), disposition: LowerDispositionSchema }).strict(),
]);
const HighDispositionInputSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("correction"), strength: z.enum(["equal", "stronger"]), required_capability: CapabilitySchema,
    title: z.string().min(1).max(512), acceptance: z.array(z.string().min(1).max(4096)).min(1).max(32),
    verification: z.array(z.string().min(1).max(4096)).min(1).max(32), rollback: z.string().min(1).max(4096),
  }).strict(),
  z.object({ kind: z.literal("blocker"), reason: z.string().min(1).max(4096) }).strict(),
]);
const ReviewInputSchema = z.object({
  cwd: z.string().min(1).max(4096),
  goal: z.string().regex(SAFE_REF).optional(),
  producer_slot: z.string().regex(SAFE_REF),
  invocation_key: z.string().regex(SAFE_REF),
  prepare_receipt_id: z.string().regex(/^pm-[0-9a-f]{32}$/),
  claim_id: z.string().regex(SAFE_REF),
  reviewer_origin: PmActorOriginSelectorSchema,
  phase4_proof: Phase4ProofSchema,
  verdict: z.enum(["PASS", "PARTIAL", "FAIL", "BLOCKED"]),
  findings: z.array(ReviewFindingInputSchema).max(64),
  high_disposition: HighDispositionInputSchema.optional(),
}).strict();

const ClosureVerdictSchema = z.object({
  verdict: z.enum(["PASS", "FAIL"]), reasons: z.array(z.string()),
  failure_id: z.string().regex(SHA256).optional(), correction_reservation_id: z.string().regex(SHA256).optional(),
  audit_reference: z.string().regex(SHA256).optional(), proof_id: z.string().regex(SHA256), surface: z.string().min(1),
}).strict();

const ReviewActorPayloadSchema = z.object({
  kind: z.literal("pm_independent_review"),
  goal_id: z.string().regex(SAFE_REF),
  parent_id: z.string().regex(SAFE_REF),
  ticket_id: z.string().regex(SAFE_REF),
  prepare_receipt_id: z.string().regex(/^pm-[0-9a-f]{32}$/),
  claim_id: z.string().regex(/^pmc-[0-9a-f]{32}$/),
  handoff_receipt_id: z.string().regex(/^pmh-[0-9a-f]{32}$/),
  worker_record_sha256: z.string().regex(SHA256),
  manifest: z.array(ArtifactEntrySchema).length(4),
  ticket_proof: PmLiveTicketProofSchema,
  phase4_proof: Phase4ProofSchema,
  phase4: ClosureVerdictSchema,
  verdict: z.enum(["PASS", "PARTIAL", "FAIL", "BLOCKED"]),
  findings: z.array(ReviewFindingInputSchema).max(64),
  high_disposition: HighDispositionInputSchema.optional(),
}).strict();

export type ReviewPmInput = z.input<typeof ReviewInputSchema>;
const FindingReceiptDispositionSchema = z.object({
  kind: z.enum(["resolved", "follow_up", "not_worth_doing"]),
  reference_id: z.string().regex(SAFE_REF).optional(),
  resolution: z.string().optional(), rationale: z.string().optional(),
  follow_up_proof_sha256: z.string().regex(SHA256).optional(),
  provider_annotation: AnnotationSchema,
}).strict();
const FindingReceiptSchema = FindingBaseSchema.extend({ disposition: FindingReceiptDispositionSchema.optional() }).strict();
const HighDispositionReceiptSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("phase4_pair"), failure_id: z.string().regex(SHA256), correction_reservation_id: z.string().regex(SHA256) }).strict(),
  z.object({ kind: z.literal("correction"), reference_id: z.string().regex(SAFE_REF), key: z.string().regex(SAFE_REF), root_cause_key: z.string().regex(SAFE_REF), strength: z.enum(["equal", "stronger"]), required_capability: CapabilitySchema }).strict(),
  z.object({ kind: z.literal("blocker"), reference_id: z.string().regex(SAFE_REF), reason: z.string(), provider_annotation: AnnotationSchema }).strict(),
]);
const PendingReviewMutationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("annotation"), purpose: z.string().regex(SAFE_REF), ticket_id: z.string().regex(SAFE_REF),
    key: z.string().regex(SAFE_REF), content: z.string().min(1).max(64 * 1024) }).strict(),
  z.object({ kind: z.literal("correction"), ticket_id: z.string().regex(SAFE_REF), key: z.string().regex(SAFE_REF),
    request: CorrectionRequestSchema }).strict(),
]);
const ReviewReceiptCoreSchema = z.object({
  schema_version: z.literal(2), receipt_id: z.string().regex(/^pmr-[0-9a-f]{32}$/), goal_id: z.string(),
  prepare_receipt_id: z.string().regex(/^pm-[0-9a-f]{32}$/), claim_id: z.string().regex(SAFE_REF),
  handoff_receipt_id: z.string().regex(/^pmh-[0-9a-f]{32}$/), canonical_input_sha256: z.string().regex(SHA256),
  state: z.enum(["pending_disposition", "reviewed"]), reviewer: ReviewerIdentitySchema,
  reviewer_origin: z.object({
    selector: PmActorOriginSelectorSchema,
    assurance: z.enum(["authenticated_install", "manual_local_double"]),
    record_sha256: z.string().regex(SHA256),
    payload_sha256: z.string().regex(SHA256),
  }).strict(),
  review_payload: ReviewActorPayloadSchema,
  worker: WorkerSchema,
  worker_origin: z.object({
    selector: PmActorOriginSelectorSchema,
    assurance: z.enum(["authenticated_install", "manual_local_double"]),
    record_sha256: z.string().regex(SHA256),
    payload_sha256: z.string().regex(SHA256),
  }).strict(),
  worker_payload: WorkerActorPayloadSchema,
  ticket_proof: PmLiveTicketProofSchema, ticket_proof_sha256: z.string().regex(SHA256),
  authenticated_manifest: z.array(ArtifactEntrySchema).length(4), manifest_sha256: z.string().regex(SHA256),
  phase4_proof: Phase4ProofSchema, phase4: ClosureVerdictSchema, verdict: z.enum(["PASS", "PARTIAL", "FAIL", "BLOCKED"]),
  pending_mutations: z.array(PendingReviewMutationSchema).max(65),
  findings: z.array(FindingReceiptSchema), high_disposition: HighDispositionReceiptSchema.optional(),
}).strict();
const ReviewReceiptSchema = ReviewReceiptCoreSchema.extend({ protected_state_sha256: z.string().regex(SHA256) }).strict();

export type PmReviewReceipt = z.infer<typeof ReviewReceiptSchema>;

export interface ReviewPmDeps extends CoordinationDeps, PmExecutionDeps {
  binding?: CoordinationBinding;
  readActorOrigin?: (selector: PmActorOriginSelector) => Promise<TrustedPmActorOriginReadback | undefined>;
  allowManualLocalDouble?: boolean;
  provider?: PmProvider;
  loadContinuationClosureVerdict?: (input: ContinuationProofBinding) => Promise<CanonicalContinuationVerdict>;
  faultAt?: "before_write" | "after_write_before_disposition" | "after_disposition_before_finalize";
}

function reviewReceiptId(goalId: string, claimId: string): string {
  return `pmr-${sha(JSON.stringify([goalId, claimId])).slice(0, 32)}`;
}

export function pmReviewReceiptPath(root: string, goalId: string, claimId: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "pm", "review", `${reviewReceiptId(goalId, claimId)}.json`);
}

async function assertSafeReviewStore(root: string, goalId: string, claimId: string, store?: PmExecutionStore): Promise<void> {
  const harness = path.join(root, HARNESS_DIR_NAME);
  const autonomy = path.join(harness, "autonomy");
  const pm = path.join(autonomy, "pm");
  const review = path.join(pm, "review");
  for (const directory of [harness, autonomy, pm, review]) {
    await executionAssertPath(root, directory, "directory", "pm_review_storage_unsafe", store);
  }
  await executionAssertPath(root, pmReviewReceiptPath(root, goalId, claimId), "file", "pm_review_storage_unsafe", store);
}

async function readReviewReceipt(root: string, goalId: string, claimId: string, store?: PmExecutionStore): Promise<PmReviewReceipt | undefined> {
  await assertSafeReviewStore(root, goalId, claimId, store);
  const raw = await executionReadJson<unknown>(pmReviewReceiptPath(root, goalId, claimId), store);
  if (raw === undefined) return undefined;
  const parsed = ReviewReceiptSchema.safeParse(raw);
  if (!parsed.success) fail("pm_review_receipt_invalid", "stored PM review receipt is malformed");
  const { protected_state_sha256, ...core } = parsed.data;
  if (protected_state_sha256 !== sha(JSON.stringify(core))) fail("pm_review_receipt_tampered", "stored PM review receipt integrity failed");
  return parsed.data;
}

export async function readPmReviewReceipt(root: string, goalId: string, claimId: string, store?: PmExecutionStore): Promise<PmReviewReceipt | undefined> {
  return readReviewReceipt(root, goalId, claimId, store);
}

async function writeReviewReceipt(root: string, goalId: string, claimId: string, core: z.infer<typeof ReviewReceiptCoreSchema>, store?: PmExecutionStore): Promise<PmReviewReceipt> {
  const receipt = ReviewReceiptSchema.parse({ ...core, protected_state_sha256: sha(JSON.stringify(core)) });
  await executionWriteJson(pmReviewReceiptPath(root, goalId, claimId), receipt, store);
  const reread = await readReviewReceipt(root, goalId, claimId, store);
  if (!reread || JSON.stringify(reread) !== JSON.stringify(receipt)) fail("pm_review_readback_failed", "PM review receipt did not survive exact readback");
  return reread;
}

function canonicalIdentity(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase("en-US").replace(/[^a-z0-9]/g, "");
}

function liveProofCommitment(proof: PmLiveTicketProof): string {
  return sha(JSON.stringify({
    ticket_id: proof.ticket_id.toLowerCase(),
    configured_parent_id: proof.configured_parent_id.toLowerCase(),
    parent_id: proof.parent_id.toLowerCase(),
    status: proof.status,
    content_strings: canonicalList(proof.content_strings),
    evidence_reference_ids: canonicalList(proof.evidence_reference_ids),
  }));
}

function liveProofMonotonicallyCompatible(staged: PmLiveTicketProof, current: PmLiveTicketProof): boolean {
  return staged.ticket_id.toLowerCase() === current.ticket_id.toLowerCase()
    && staged.configured_parent_id.toLowerCase() === current.configured_parent_id.toLowerCase()
    && staged.parent_id.toLowerCase() === current.parent_id.toLowerCase()
    && staged.status === current.status
    && JSON.stringify(canonicalList(staged.content_strings)) === JSON.stringify(canonicalList(current.content_strings))
    && staged.evidence_reference_ids.every((reference) => current.evidence_reference_ids.includes(reference));
}

function scanReviewInput(input: z.infer<typeof ReviewInputSchema>): void {
  const fields: Record<string, string> = {
    reviewer_origin_id: input.reviewer_origin.origin_id, reviewer_record_id: input.reviewer_origin.record_id,
    phase4_parent: input.phase4_proof.parent_id, phase4_run: input.phase4_proof.run_id, phase4_session: input.phase4_proof.session_id,
  };
  input.findings.forEach((finding, index) => {
    fields[`finding.${index}.summary`] = finding.summary;
    finding.evidence.forEach((value, evidenceIndex) => { fields[`finding.${index}.evidence.${evidenceIndex}`] = value; });
    if ("disposition" in finding) {
      if (finding.disposition.kind === "resolved") fields[`finding.${index}.resolution`] = finding.disposition.resolution;
      if (finding.disposition.kind === "not_worth_doing") fields[`finding.${index}.rationale`] = finding.disposition.rationale;
    }
  });
  if (input.high_disposition?.kind === "correction") {
    fields.correction_title = input.high_disposition.title;
    fields.correction_rollback = input.high_disposition.rollback;
  } else if (input.high_disposition?.kind === "blocker") fields.blocker_reason = input.high_disposition.reason;
  assertNoSecrets(fields);
}

async function authenticateReviewArtifacts(root: string, handoff: PmHandoffReceipt, store?: PmExecutionStore): Promise<z.infer<typeof ArtifactEntrySchema>[]> {
  const runRoot = pmWorkerRunRoot(root, handoff.goal_id, handoff.claim.claim_id);
  const entries = [];
  for (const expected of handoff.manifest) {
    const current = await readSafeArtifact(runRoot, expected.kind, expected.relative_path, { executionStore: store });
    if (JSON.stringify(current.entry) !== JSON.stringify(expected)) {
      fail("pm_review_artifact_tampered", "worker artifact differs from its authenticated handoff manifest");
    }
    entries.push(current.entry);
  }
  if (sha(JSON.stringify(entries)) !== handoff.manifest_sha256) {
    fail("pm_review_artifact_tampered", "worker artifact manifest digest differs from its handoff receipt");
  }
  return entries;
}

function workerPayloadFromHandoff(handoff: PmHandoffReceipt, parentId: string): Record<string, unknown> {
  return pmWorkerActorPayload({
    goal_id: handoff.goal_id,
    parent_id: parentId,
    ticket_id: handoff.claim.ticket_id,
    prepare_receipt_id: handoff.prepare_receipt_id,
    claim_id: handoff.claim.claim_id,
    producer_slot: handoff.producer_slot,
    invocation_key: handoff.invocation_key,
    outcome: handoff.outcome,
    manifest: handoff.manifest,
    handoff: handoff.handoff,
  });
}

async function reauthenticateWorkerActor(
  handoff: PmHandoffReceipt,
  binding: CoordinationBinding,
  deps: { readActorOrigin?: (value: PmActorOriginSelector) => Promise<TrustedPmActorOriginReadback | undefined>;
    allowManualLocalDouble?: boolean },
  code: string,
): Promise<TrustedPmActorOriginReadback> {
  const record = await readActorOrigin(handoff.worker_origin.selector, "worker", deps, code);
  const expectedPayload = workerPayloadFromHandoff(handoff, binding.parent_id);
  const identity = WorkerSchema.safeParse({ subject: record.subject, run_id: record.run_id,
    session_id: record.session_id, capability: record.capability });
  if (!identity.success || record.goal_id !== handoff.goal_id
    || record.parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
    || record.ticket_id !== handoff.claim.ticket_id || record.prepare_receipt_id !== handoff.prepare_receipt_id
    || record.claim_id !== handoff.claim.claim_id
    || JSON.stringify(identity.data) !== JSON.stringify(handoff.worker)
    || JSON.stringify(actorBinding(record, handoff.worker_origin.selector)) !== JSON.stringify(handoff.worker_origin)
    || record.payload_sha256 !== sha(JSON.stringify(expectedPayload))
    || JSON.stringify(record.payload) !== JSON.stringify(expectedPayload)
    || JSON.stringify(handoff.worker_payload) !== JSON.stringify(expectedPayload)) {
    return fail(code, "stored PM worker actor origin no longer authenticates its exact handoff");
  }
  return record;
}

export function pmReviewerActorPayload(input: {
  goal_id: string;
  parent_id: string;
  ticket_id: string;
  prepare_receipt_id: string;
  claim_id: string;
  handoff_receipt_id: string;
  worker_record_sha256: string;
  manifest: readonly z.infer<typeof ArtifactEntrySchema>[];
  ticket_proof: PmLiveTicketProof;
  phase4_proof: z.infer<typeof Phase4ProofSchema>;
  phase4: CanonicalContinuationVerdict;
  verdict: "PASS" | "PARTIAL" | "FAIL" | "BLOCKED";
  findings: readonly z.infer<typeof ReviewFindingInputSchema>[];
  high_disposition?: z.infer<typeof HighDispositionInputSchema>;
}): z.infer<typeof ReviewActorPayloadSchema> {
  return ReviewActorPayloadSchema.parse({
    kind: "pm_independent_review",
    goal_id: input.goal_id,
    parent_id: input.parent_id,
    ticket_id: input.ticket_id,
    prepare_receipt_id: input.prepare_receipt_id,
    claim_id: input.claim_id,
    handoff_receipt_id: input.handoff_receipt_id,
    worker_record_sha256: input.worker_record_sha256,
    manifest: input.manifest,
    ticket_proof: input.ticket_proof,
    phase4_proof: input.phase4_proof,
    phase4: input.phase4,
    verdict: input.verdict,
    findings: input.findings,
    ...(input.high_disposition ? { high_disposition: input.high_disposition } : {}),
  });
}

function validateClosure(verdict: CanonicalContinuationVerdict, proof: z.infer<typeof Phase4ProofSchema>): CanonicalContinuationVerdict {
  const parsed = ClosureVerdictSchema.safeParse(verdict);
  if (!parsed.success || parsed.data.proof_id !== proof.proof_id || parsed.data.surface !== "ticket-completion"
    || parsed.data.reasons.some((reason) => /^CONTINUATION_(?:PROOF|AUDIT)_/.test(reason))) {
    return fail("pm_review_phase4_invalid", "Phase 4 continuation closure did not authenticate");
  }
  const hasPair = Boolean(parsed.data.failure_id && parsed.data.correction_reservation_id);
  if ((parsed.data.verdict === "PASS" && (parsed.data.failure_id || parsed.data.correction_reservation_id))
    || (parsed.data.verdict === "FAIL" && !hasPair)) {
    return fail("pm_review_phase4_invalid", "Phase 4 continuation closure pair is inconsistent");
  }
  return parsed.data;
}

function annotationForFinding(receiptId: string, finding: z.infer<typeof ReviewFindingInputSchema>, proofSha?: string): string {
  return [
    `PM-Review-Receipt: ${receiptId}`, `PM-Finding: ${finding.id}`, `PM-Severity: ${finding.severity}`,
    `PM-Root-Cause: ${finding.root_cause_key}`, `PM-Summary: ${finding.summary}`,
    ...(proofSha ? [`PM-Follow-Up-Proof-SHA256: ${proofSha}`] : []),
    `PM-Disposition: ${JSON.stringify("disposition" in finding ? finding.disposition : null)}`,
  ].join("\n");
}

async function pendingReviewMutations(
  provider: PmProvider,
  goalId: string,
  ticketId: string,
  receiptIdValue: string,
  input: z.infer<typeof ReviewInputSchema>,
  phase4: CanonicalContinuationVerdict,
): Promise<z.infer<typeof PendingReviewMutationSchema>[]> {
  const mutations: z.infer<typeof PendingReviewMutationSchema>[] = [];
  const severe = input.findings.filter((finding) => finding.severity === "Critical" || finding.severity === "High");
  if (phase4.verdict === "PASS" && severe.length > 0) {
    const disposition = input.high_disposition!; const rootCause = severe[0]!.root_cause_key;
    if (disposition.kind === "correction") {
      const key = `pmc-${sha(`${goalId}\0${ticketId}\0${rootCause}`).slice(0, 24)}`;
      mutations.push(PendingReviewMutationSchema.parse({ kind: "correction", ticket_id: ticketId, key,
        request: { root_cause_key: rootCause, strength: disposition.strength, required_capability: disposition.required_capability,
          title: normalizeText(disposition.title), acceptance: canonicalList(disposition.acceptance),
          verification: canonicalList(disposition.verification), rollback: normalizeText(disposition.rollback) } }));
    } else {
      const content = [`PM-Review-Receipt: ${receiptIdValue}`, `PM-Root-Cause: ${rootCause}`,
        `PM-Blocker: ${normalizeText(disposition.reason)}`].join("\n");
      mutations.push({ kind: "annotation", purpose: "blocker", ticket_id: ticketId,
        key: `pmb-${sha(`${receiptIdValue}\0${rootCause}`).slice(0, 24)}`, content });
    }
  }
  for (const finding of input.findings) {
    if (!("disposition" in finding)) continue;
    let followUpProofSha: string | undefined;
    if (finding.disposition.kind === "follow_up") {
      if (!provider.readTicketProof) fail("pm_review_live_proof_invalid", "PM provider cannot reopen finding follow-up proof");
      const rawProof = await provider.readTicketProof(finding.disposition.reference_id);
      if (!rawProof) fail("pm_review_live_proof_invalid", "finding follow-up reference is missing from live readback");
      const proof = parsePmLiveTicketProof(rawProof);
      if (proof.ticket_id.toLowerCase() !== finding.disposition.reference_id.toLowerCase()
        || proof.parent_id.toLowerCase() !== input.phase4_proof.parent_id.toLowerCase()
        || proof.configured_parent_id.toLowerCase() !== input.phase4_proof.parent_id.toLowerCase()) {
        fail("pm_review_live_proof_invalid", "finding follow-up proof does not match its live reference");
      }
      followUpProofSha = liveProofCommitment(proof);
    }
    mutations.push({ kind: "annotation", purpose: `finding-${finding.id}`, ticket_id: ticketId,
      key: `pmd-${sha(`${receiptIdValue}\0${finding.id}`).slice(0, 24)}`,
      content: annotationForFinding(receiptIdValue, finding, followUpProofSha) });
  }
  return mutations.sort((a, b) => a.key.localeCompare(b.key));
}

export async function reviewPm(rawInput: ReviewPmInput, deps: ReviewPmDeps = {}): Promise<PmReviewReceipt> {
  const parsed = ReviewInputSchema.safeParse(rawInput);
  if (!parsed.success) fail("pm_invalid_review_request", "PM review request is invalid");
  const input = parsed.data;
  scanReviewInput(input);
  const resolved = await resolvePmGoal(input.cwd, input.goal, deps);
  if (!resolved) fail("pm_harness_missing", "PM review requires an initialized harness goal");
  await assertPmLoopActive(resolved.root, deps);
  await assertSafeReviewStore(resolved.root, resolved.goalId, input.claim_id, deps.executionStore);

  const prepare = await readPmPrepareReceipt(resolved.root, resolved.goalId, input.producer_slot, input.invocation_key, deps.executionStore);
  const handoff = await readPmHandoffReceipt(resolved.root, resolved.goalId, input.claim_id, deps.executionStore);
  const workerClaim = prepare && await readWorkerClaim(resolved.root, prepare.receipt_id, deps.executionStore);
  const binding = deps.binding ?? await verifyCoordinationBinding(input.cwd, input.goal, deps);
  if (!binding || binding.goal_id !== resolved.goalId
    || binding.parent_id.toLowerCase() !== input.phase4_proof.parent_id.toLowerCase()) {
    fail("pm_review_destination_mismatch", "PM review destination does not match the authenticated goal binding");
  }
  if (!prepare || prepare.receipt_id !== input.prepare_receipt_id || prepare.state !== "claimed" || !prepare.provider_annotation || !handoff
    || handoff.prepare_receipt_id !== prepare.receipt_id || handoff.claim.claim_id !== input.claim_id || !workerClaim
    || handoff.worker_claim_protected_state_sha256 !== workerClaim.protected_state_sha256
    || JSON.stringify(handoff.worker_origin) !== JSON.stringify(workerClaim.worker_origin)
    || JSON.stringify(handoff.worker_payload) !== JSON.stringify(workerClaim.worker_payload)
    || handoff.prepare_claim_commitment_sha256 !== pmPrepareClaimCommitment(prepare)
    || JSON.stringify(workerClaim.worker) !== JSON.stringify(handoff.worker)
    || JSON.stringify(workerClaim.claim) !== JSON.stringify(handoff.claim)) {
    fail("pm_review_chain_invalid", "PM review chain did not authenticate prepare, claim, and handoff");
  }
  const workerRecord = await reauthenticateWorkerActor(handoff, binding, deps, "pm_review_worker_origin_invalid");
  const reviewerRecord = await readActorOrigin(input.reviewer_origin, "reviewer", deps, "pm_review_origin_invalid");
  const reviewer = ReviewerIdentitySchema.parse({ subject: reviewerRecord.subject, run_id: reviewerRecord.run_id,
    session_id: reviewerRecord.session_id });
  const selectorReused = JSON.stringify(input.reviewer_origin) === JSON.stringify(handoff.worker_origin.selector);
  const identityReused = reviewerRecord.record_sha256 === workerRecord.record_sha256
    || canonicalIdentity(reviewer.subject) === canonicalIdentity(handoff.worker.subject)
    || canonicalIdentity(reviewer.run_id) === canonicalIdentity(handoff.worker.run_id)
    || canonicalIdentity(reviewer.session_id) === canonicalIdentity(handoff.worker.session_id);
  if (reviewerRecord.goal_id !== resolved.goalId
    || reviewerRecord.parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
    || reviewerRecord.ticket_id !== handoff.claim.ticket_id
    || reviewerRecord.prepare_receipt_id !== prepare.receipt_id
    || reviewerRecord.claim_id !== handoff.claim.claim_id || selectorReused || identityReused) {
    fail("pm_review_provenance_invalid", "signed reviewer record must bind this review and remain structurally independent");
  }
  const reviewerOrigin = actorBinding(reviewerRecord, input.reviewer_origin);

  const manifest = await authenticateReviewArtifacts(resolved.root, handoff, deps.executionStore);
  const provider = deps.provider ?? await defaultPmProvider(input.cwd, input.goal, deps);
  if (!provider.readTicketProof) fail("pm_review_live_proof_invalid", "PM provider cannot reopen live ticket proof");
  const ticketProofRaw = await provider.readTicketProof(handoff.claim.ticket_id);
  if (!ticketProofRaw) fail("pm_review_live_proof_invalid", "selected PM ticket is missing from live readback");
  const ticketProof = parsePmLiveTicketProof(ticketProofRaw);
  if (ticketProof.ticket_id.toLowerCase() !== handoff.claim.ticket_id.toLowerCase()
    || ticketProof.parent_id.toLowerCase() !== input.phase4_proof.parent_id.toLowerCase()
    || ticketProof.configured_parent_id.toLowerCase() !== input.phase4_proof.parent_id.toLowerCase()
    || !ticketProof.evidence_reference_ids.includes(handoff.claim.provider_annotation_id)) {
    fail("pm_review_live_proof_invalid", "live selected-ticket proof does not bind the authenticated PM claim");
  }
  const durableReview = await readReviewReceipt(resolved.root, resolved.goalId, input.claim_id, deps.executionStore);
  if (durableReview && !liveProofMonotonicallyCompatible(durableReview.ticket_proof, ticketProof)) {
    fail("pm_review_live_proof_invalid", "live selected-ticket proof is not a monotonic extension of the durable review receipt");
  }
  const signedTicketProof = durableReview?.ticket_proof ?? ticketProof;
  const closureLoader = deps.loadContinuationClosureVerdict ?? loadContinuationClosureVerdict;
  const phase4 = validateClosure(await closureLoader({
    root: resolved.root, proofId: input.phase4_proof.proof_id, parentId: input.phase4_proof.parent_id,
    runId: input.phase4_proof.run_id, sessionId: input.phase4_proof.session_id, surface: "ticket-completion",
  }), input.phase4_proof);
  const reviewPayload = pmReviewerActorPayload({
    goal_id: resolved.goalId,
    parent_id: binding.parent_id,
    ticket_id: handoff.claim.ticket_id,
    prepare_receipt_id: prepare.receipt_id,
    claim_id: handoff.claim.claim_id,
    handoff_receipt_id: handoff.receipt_id,
    worker_record_sha256: workerRecord.record_sha256,
    manifest,
    ticket_proof: signedTicketProof,
    phase4_proof: input.phase4_proof,
    phase4,
    verdict: input.verdict,
    findings: input.findings,
    ...(input.high_disposition ? { high_disposition: input.high_disposition } : {}),
  });
  if (reviewerRecord.payload_sha256 !== sha(JSON.stringify(reviewPayload))
    || JSON.stringify(reviewerRecord.payload) !== JSON.stringify(reviewPayload)) {
    fail("pm_review_origin_payload_invalid", "signed reviewer payload does not match the exact manifest, verdict, findings, Phase 4 proof, and live target");
  }

  const severe = input.findings.filter((finding) => finding.severity === "Critical" || finding.severity === "High");
  if (handoff.state === "incomplete" && !severe.some((finding) => finding.severity === "High" || finding.severity === "Critical")) {
    fail("pm_review_incomplete_requires_high", "incomplete PM handoff requires a High finding");
  }
  const roots = new Set(severe.map((finding) => finding.root_cause_key));
  if (roots.size > 1) fail("pm_review_correction_fanout", "Critical and High symptoms must converge on one canonical root cause");
  if (phase4.verdict === "FAIL" && input.high_disposition) fail("pm_review_correction_fanout", "Phase 4 FAIL must reuse its exact pair without another PM correction");
  if (phase4.verdict === "PASS" && severe.length > 0 && !input.high_disposition) fail("pm_review_disposition_missing", "Critical and High findings require one correction or blocker");
  if (severe.length === 0 && input.high_disposition) fail("pm_review_disposition_conflict", "high disposition requires a Critical or High finding");
  if (phase4.verdict === "PASS" && severe.length > 0 && input.high_disposition?.kind === "correction") {
    const required = input.high_disposition.required_capability;
    const workerCapability = handoff.worker.capability;
    const truthfulStrength = required.rank === workerCapability.rank ? "equal" : "stronger";
    if (required.id !== workerCapability.id || required.rank < workerCapability.rank
      || input.high_disposition.strength !== truthfulStrength) {
      fail("pm_review_capability_invalid", "correction capability must be same-class, equal-or-stronger, and truthfully labeled");
    }
  }
  const allAcceptancePassed = handoff.state === "handed_off" && handoff.outcome === "completed"
    && handoff.handoff.acceptance_checklist.length === prepare.brief.acceptance.length
    && new Set(handoff.handoff.acceptance_checklist.map((row) => row.criterion)).size === handoff.handoff.acceptance_checklist.length
    && prepare.brief.acceptance.every((criterion) => handoff.handoff.acceptance_checklist.some((row) => row.criterion === criterion && row.status === "pass" && row.evidence.length > 0));
  if (input.verdict === "PASS" && (!allAcceptancePassed || phase4.verdict !== "PASS" || severe.length > 0)) {
    fail("pm_review_pass_invalid", "PASS requires completed acceptance, Phase 4 PASS, and no unresolved Critical or High finding");
  }

  const receiptId = reviewReceiptId(resolved.goalId, input.claim_id);
  const mutationPlan = await pendingReviewMutations(provider, resolved.goalId, handoff.claim.ticket_id, receiptId, input, phase4);
  const canonicalInput = sha(JSON.stringify({
    goal_id: resolved.goalId, producer_slot: input.producer_slot, invocation_key: input.invocation_key,
    prepare_receipt_id: input.prepare_receipt_id, claim_id: input.claim_id, reviewer_origin: input.reviewer_origin,
    phase4_proof: input.phase4_proof, verdict: input.verdict,
    findings: input.findings, high_disposition: input.high_disposition,
  }));
  const leaseKey = `pmr-${sha(`${resolved.goalId}\0${input.claim_id}`).slice(0, 24)}`;
  if (deps.executionStore) await deps.executionStore.assertLease(leaseKey, "pm_review_storage_unsafe");
  else await assertSafeContinuationLeaseTree(resolved.root, leaseKey, "pm_review_storage_unsafe");
  const operation = async () => {
    let existing = await readReviewReceipt(resolved.root, resolved.goalId, input.claim_id, deps.executionStore);
    if (existing && existing.canonical_input_sha256 !== canonicalInput) fail("pm_review_conflict", "canonical PM review input differs for this claim");
    if (existing && !liveProofMonotonicallyCompatible(existing.ticket_proof, ticketProof)) {
      fail("pm_review_live_proof_invalid", "live selected-ticket proof is not a monotonic extension of the durable review receipt");
    }
    const baseFindings = input.findings.map((finding) => FindingReceiptSchema.parse({
      id: finding.id, severity: finding.severity, root_cause_key: finding.root_cause_key,
      summary: normalizeText(finding.summary), evidence: canonicalList(finding.evidence),
    }));
    const stagedCore = ReviewReceiptCoreSchema.parse({
      schema_version: 2, receipt_id: receiptId, goal_id: resolved.goalId, prepare_receipt_id: prepare.receipt_id,
      claim_id: input.claim_id, handoff_receipt_id: handoff.receipt_id, canonical_input_sha256: canonicalInput,
      state: "pending_disposition", reviewer, reviewer_origin: reviewerOrigin, review_payload: reviewPayload,
      worker: handoff.worker, worker_origin: handoff.worker_origin, worker_payload: handoff.worker_payload,
      ticket_proof: existing?.ticket_proof ?? ticketProof,
      ticket_proof_sha256: existing?.ticket_proof_sha256 ?? liveProofCommitment(ticketProof),
      authenticated_manifest: manifest, manifest_sha256: sha(JSON.stringify(manifest)), phase4_proof: input.phase4_proof, phase4,
      verdict: input.verdict, pending_mutations: mutationPlan, findings: baseFindings,
      ...(phase4.verdict === "FAIL" ? { high_disposition: { kind: "phase4_pair", failure_id: phase4.failure_id!, correction_reservation_id: phase4.correction_reservation_id! } } : {}),
    });
    if (!existing) {
      if (deps.faultAt === "before_write") fail("pm_fault_before_review_write", "injected pre-write failure");
      existing = await writeReviewReceipt(resolved.root, resolved.goalId, input.claim_id, stagedCore, deps.executionStore);
    }
    if (deps.faultAt === "after_write_before_disposition") fail("pm_fault_after_review_write", "injected post-write failure");

    let highDisposition: z.infer<typeof HighDispositionReceiptSchema> | undefined = stagedCore.high_disposition;
    if (phase4.verdict === "PASS" && severe.length > 0) {
      const disposition = input.high_disposition!;
      const rootCause = severe[0]!.root_cause_key;
      if (disposition.kind === "correction") {
        if (!provider.ensureCorrection) fail("pm_review_provider_invalid", "PM provider cannot create or reopen a canonical correction");
        const key = `pmc-${sha(`${resolved.goalId}\0${handoff.claim.ticket_id}\0${rootCause}`).slice(0, 24)}`;
        const request = CorrectionRequestSchema.parse({ root_cause_key: rootCause, strength: disposition.strength,
          required_capability: disposition.required_capability,
          title: normalizeText(disposition.title), acceptance: canonicalList(disposition.acceptance),
          verification: canonicalList(disposition.verification), rollback: normalizeText(disposition.rollback) });
        const correction = CorrectionReferenceSchema.parse(await provider.ensureCorrection(handoff.claim.ticket_id, key, request));
        if (correction.key !== key || correction.root_cause_key !== rootCause || correction.strength !== disposition.strength
          || JSON.stringify(correction.required_capability) !== JSON.stringify(disposition.required_capability)) {
          fail("pm_provider_readback_failed", "canonical PM correction did not survive exact readback");
        }
        highDisposition = { kind: "correction", ...correction };
      } else {
        const content = [
          `PM-Review-Receipt: ${receiptId}`,
          `PM-Root-Cause: ${rootCause}`, `PM-Blocker: ${normalizeText(disposition.reason)}`,
        ].join("\n");
        const key = `pmb-${sha(`${receiptId}\0${rootCause}`).slice(0, 24)}`;
        const annotation = AnnotationSchema.parse(await provider.annotate(handoff.claim.ticket_id, key, content));
        if (annotation.issue_id !== handoff.claim.ticket_id || annotation.key !== key || annotation.content !== content) {
          fail("pm_provider_readback_failed", "PM blocker disposition did not survive exact readback");
        }
        highDisposition = { kind: "blocker", reference_id: annotation.id, reason: normalizeText(disposition.reason), provider_annotation: annotation };
      }
    }

    const findings = [];
    for (const finding of input.findings) {
      if (!("disposition" in finding)) {
        findings.push(FindingReceiptSchema.parse({ id: finding.id, severity: finding.severity, root_cause_key: finding.root_cause_key,
          summary: normalizeText(finding.summary), evidence: canonicalList(finding.evidence) }));
        continue;
      }
      let followUpProofSha: string | undefined;
      if (finding.disposition.kind === "follow_up") {
        const rawProof = await provider.readTicketProof!(finding.disposition.reference_id);
        if (!rawProof) fail("pm_review_live_proof_invalid", "finding follow-up reference is missing from live readback");
        const proof = parsePmLiveTicketProof(rawProof);
        if (proof.ticket_id.toLowerCase() !== finding.disposition.reference_id.toLowerCase()
          || proof.parent_id.toLowerCase() !== input.phase4_proof.parent_id.toLowerCase()
          || proof.configured_parent_id.toLowerCase() !== input.phase4_proof.parent_id.toLowerCase()) {
          fail("pm_review_live_proof_invalid", "finding follow-up proof does not match its live reference");
        }
        followUpProofSha = liveProofCommitment(proof);
      }
      const content = annotationForFinding(receiptId, finding, followUpProofSha);
      const key = `pmd-${sha(`${receiptId}\0${finding.id}`).slice(0, 24)}`;
      const annotation = AnnotationSchema.parse(await provider.annotate(handoff.claim.ticket_id, key, content));
      if (annotation.issue_id !== handoff.claim.ticket_id || annotation.key !== key || annotation.content !== content) {
        fail("pm_provider_readback_failed", "PM finding disposition did not survive exact readback");
      }
      findings.push(FindingReceiptSchema.parse({
        id: finding.id, severity: finding.severity, root_cause_key: finding.root_cause_key,
        summary: normalizeText(finding.summary), evidence: canonicalList(finding.evidence),
        disposition: { ...finding.disposition, ...(followUpProofSha ? { follow_up_proof_sha256: followUpProofSha } : {}), provider_annotation: annotation },
      }));
    }
    if (deps.faultAt === "after_disposition_before_finalize") fail("pm_fault_after_review_disposition", "injected post-disposition failure");
    const finalCore = ReviewReceiptCoreSchema.parse({ ...stagedCore, state: "reviewed", findings, ...(highDisposition ? { high_disposition: highDisposition } : {}) });
    if (existing.state === "reviewed") {
      const { protected_state_sha256: _protected, ...existingCore } = existing;
      if (JSON.stringify(existingCore) !== JSON.stringify(finalCore)) fail("pm_review_conflict", "stored PM review differs from exact provider readback");
      return existing;
    }
    return writeReviewReceipt(resolved.root, resolved.goalId, input.claim_id, finalCore, deps.executionStore);
  };
  return deps.executionStore
    ? deps.executionStore.withLease(leaseKey, operation)
    : withCoordinationLease(resolved.root, leaseKey, operation, deps);
}

const SchedulerArtifactRequestSchema = z.object({
  path: z.string().min(1).max(4096),
  sha256: z.string().regex(SHA256),
}).strict();
const StatusInputSchema = z.object({
  cwd: z.string().min(1).max(4096),
  goal: z.string().regex(SAFE_REF).optional(),
  workspace_id: z.string().uuid(),
  parent_id: z.string().regex(SAFE_REF),
  producer_slot: z.string().regex(SAFE_REF),
  invocation_key: z.string().regex(SAFE_REF),
  claim_id: z.string().regex(SAFE_REF).optional(),
  evidence_requirement: z.enum(["manual", "natural"]),
  scheduler_artifact: SchedulerArtifactRequestSchema.optional(),
  scheduler_origin: PmSchedulerOriginSelectorSchema.optional(),
  record_gap: z.boolean().default(false),
}).strict().refine((value) => !(value.scheduler_artifact && value.scheduler_origin),
  "scheduler artifact and trusted origin are mutually exclusive");

export type StatusPmInput = z.input<typeof StatusInputSchema>;

const SchedulerArtifactCoreSchema = z.object({
  schema_version: z.literal(1),
  evidence_class: z.enum(["natural_scheduler", "synthetic_fixture", "manual"]),
  source: z.literal("external_scheduler"),
  goal_id: z.string().regex(SAFE_REF),
  workspace_id: z.string().uuid(),
  parent_id: z.string().regex(SAFE_REF),
  producer_slot: z.string().regex(SAFE_REF),
  invocation_key: z.string().regex(SAFE_REF),
  ticket_id: z.string().regex(SAFE_REF),
  review_receipt_id: z.string().regex(/^pmr-[0-9a-f]{32}$/),
  review_protected_state_sha256: z.string().regex(SHA256),
  scheduler_id: z.string().regex(SAFE_REF),
  run_id: z.string().regex(SAFE_REF),
  scheduled_at: z.string().datetime(),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime(),
  timezone: z.string().min(1).max(128),
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  prepare_local_time: z.literal("09:00"),
  review_local_time: z.literal("17:00"),
  trigger: z.enum(["scheduled", "manual", "synthetic"]),
  manual_trigger: z.boolean(),
  delivery: z.literal("local_no_delivery"),
}).strict();
const SchedulerArtifactSchema = SchedulerArtifactCoreSchema.extend({
  protected_state_sha256: z.string().regex(SHA256),
}).strict();
const GapReceiptCoreSchema = z.object({
  schema_version: z.literal(1),
  receipt_id: z.string().regex(/^pmg-[0-9a-f]{32}$/),
  goal_id: z.string().regex(SAFE_REF),
  producer_slot: z.string().regex(SAFE_REF),
  invocation_key: z.string().regex(SAFE_REF),
  ticket_id: z.string().regex(SAFE_REF),
  review_receipt_id: z.string().regex(/^pmr-[0-9a-f]{32}$/),
  evidence_requirement: z.literal("natural"),
  reason_code: z.literal("PM_NATURAL_EVIDENCE_MISSING"),
}).strict();
const GapReceiptSchema = GapReceiptCoreSchema.extend({ protected_state_sha256: z.string().regex(SHA256) }).strict();

const StatusStateSchema = z.enum([
  "incomplete", "blocked", "mutation_uncommitted", "manual_evidence",
  "missing_natural_evidence", "verified_natural_evidence",
]);
const Phase5GateSchema = z.object({
  phase: z.literal("P5-E"),
  verdict: z.enum(["PASS", "PARTIAL", "FAIL", "BLOCKED"]),
  reason_code: z.enum([
    "PM_REVIEW_BLOCKED", "PM_REVIEW_FAILED", "PM_REVIEW_PARTIAL",
    "PM_NATURAL_EVIDENCE_VERIFIED", "PM_NATURAL_EVIDENCE_MISSING",
  ]),
  evidence_reference: z.string().min(1),
}).strict();
const StatusReportSchema = z.object({
  schema_version: z.literal(1),
  state: StatusStateSchema,
  reason_code: z.string(),
  goal_id: z.string(),
  workspace_id: z.string().uuid(),
  parent_id: z.string(),
  ticket_id: z.string().optional(),
  receipt_chain: z.object({
    prepare_receipt_id: z.string().optional(), worker_claim_receipt_id: z.string().optional(),
    handoff_receipt_id: z.string().optional(), review_receipt_id: z.string().optional(),
  }).strict(),
  producer: z.object({
    slot: z.string(), invocation_key: z.string(), prepare_receipt_id: z.string().optional(),
    observed_provenance: z.array(z.object({ run_id: z.string(), session_id: z.string() }).strict()),
  }).strict(),
  worker: WorkerSchema.optional(),
  reviewer: ReviewerIdentitySchema.optional(),
  artifact_hashes: z.array(ArtifactEntrySchema),
  provider_references: z.object({
    prepare_annotation_id: z.string().optional(),
    live_evidence_reference_ids: z.array(z.string()),
    finding_annotation_ids: z.array(z.string()),
    correction_reference_ids: z.array(z.string()),
  }).strict(),
  phase4: ClosureVerdictSchema.optional(),
  phase4_proof: Phase4ProofSchema.optional(),
  verdict: z.enum(["PASS", "PARTIAL", "FAIL", "BLOCKED"]).optional(),
  findings: z.array(FindingReceiptSchema),
  high_disposition: HighDispositionReceiptSchema.optional(),
  evidence: z.object({
    classification: z.enum(["manual", "synthetic", "missing_natural", "verified_natural"]),
    scheduler_artifact_sha256: z.string().regex(SHA256).optional(),
    scheduler_id: z.string().optional(),
    scheduler_run_id: z.string().optional(),
    scheduler_origin_id: z.string().optional(),
    scheduler_record_id: z.string().optional(),
    gap_receipt: GapReceiptSchema.optional(),
  }).strict(),
  phase5_gate: Phase5GateSchema.optional(),
  recovery: z.object({
    reason_code: z.literal("PM_MUTATION_UNCOMMITTED"), owning_command: z.enum(["autonomy pm prepare", "autonomy pm review"]),
    producer_slot: z.string(), invocation_key: z.string(), exact_reference_ids: z.array(z.string()), instruction: z.string(),
  }).strict().optional(),
}).strict();

export type PmStatusReport = z.infer<typeof StatusReportSchema>;
export type TrustedPmSchedulerReadback = TrustedPmSchedulerOriginReadback;
export interface StatusPmDeps extends CoordinationDeps, PmExecutionDeps {
  binding?: CoordinationBinding;
  readActorOrigin?: (selector: PmActorOriginSelector) => Promise<TrustedPmActorOriginReadback | undefined>;
  allowManualLocalDouble?: boolean;
  provider?: PmProvider;
  loadContinuationClosureVerdict?: (input: ContinuationProofBinding) => Promise<CanonicalContinuationVerdict>;
  readTrustedSchedulerArtifact?: (
    request: PmSchedulerOriginSelector,
  ) => Promise<TrustedPmSchedulerReadback | undefined>;
}

async function readExpectedMutation(provider: PmProvider, mutation: z.infer<typeof PendingReviewMutationSchema>): Promise<string | undefined> {
  if (mutation.kind === "annotation") {
    if (!provider.readAnnotation) fail("pm_status_provider_invalid", "PM status provider cannot read exact annotations");
    const annotation = await provider.readAnnotation(mutation.ticket_id, mutation.key, mutation.content);
    if (!annotation) return undefined;
    if (annotation.issue_id !== mutation.ticket_id || annotation.key !== mutation.key || annotation.content !== mutation.content) {
      fail("pm_status_evidence_reference_invalid", "PM annotation failed exact readback");
    }
    return annotation.id;
  }
  if (!provider.readCorrection) fail("pm_status_provider_invalid", "PM status provider cannot read exact corrections");
  const correction = await provider.readCorrection(mutation.ticket_id, mutation.key, mutation.request);
  if (!correction) return undefined;
  if (correction.key !== mutation.key || correction.root_cause_key !== mutation.request.root_cause_key
    || correction.strength !== mutation.request.strength
    || JSON.stringify(correction.required_capability) !== JSON.stringify(mutation.request.required_capability)) {
    fail("pm_status_evidence_reference_invalid", "PM correction failed exact readback");
  }
  return correction.reference_id;
}

function gapReceiptCore(
  goalId: string,
  prepare: Pick<PmPrepareReceipt, "producer_slot" | "invocation_key">,
  ticketId: string,
  reviewReceiptIdValue: string,
) {
  const identity = {
    goal_id: goalId, producer_slot: prepare.producer_slot, invocation_key: prepare.invocation_key,
    ticket_id: ticketId, review_receipt_id: reviewReceiptIdValue,
    evidence_requirement: "natural" as const, reason_code: "PM_NATURAL_EVIDENCE_MISSING" as const,
  };
  return GapReceiptCoreSchema.parse({ schema_version: 1, receipt_id: `pmg-${sha(JSON.stringify(identity)).slice(0, 32)}`, ...identity });
}

export function pmGapReceiptPath(root: string, receiptIdValue: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "pm", "gaps", `${receiptIdValue}.json`);
}

async function assertSafeGapStore(root: string, receiptIdValue: string, store?: PmExecutionStore): Promise<void> {
  const pm = path.join(root, HARNESS_DIR_NAME, "autonomy", "pm");
  const gaps = path.join(pm, "gaps");
  await executionAssertPath(root, gaps, "directory", "pm_status_storage_unsafe", store);
  await executionAssertPath(root, pmGapReceiptPath(root, receiptIdValue), "file", "pm_status_storage_unsafe", store);
}

export async function readPmGapReceipt(root: string, receiptIdValue: string, store?: PmExecutionStore): Promise<z.infer<typeof GapReceiptSchema> | undefined> {
  await assertSafeGapStore(root, receiptIdValue, store);
  const raw = await executionReadJson<unknown>(pmGapReceiptPath(root, receiptIdValue), store);
  if (raw === undefined) return undefined;
  const parsed = GapReceiptSchema.safeParse(raw);
  if (!parsed.success) fail("pm_status_gap_invalid", "stored PM natural-evidence gap receipt is malformed");
  const { protected_state_sha256, ...core } = parsed.data;
  if (protected_state_sha256 !== sha(JSON.stringify(core))) fail("pm_status_gap_tampered", "stored PM natural-evidence gap receipt integrity failed");
  const canonical = gapReceiptCore(parsed.data.goal_id, parsed.data, parsed.data.ticket_id, parsed.data.review_receipt_id);
  if (parsed.data.receipt_id !== canonical.receipt_id) fail("pm_status_identity_invalid", "PM gap receipt identity is not canonical");
  return parsed.data;
}

async function recordPmGap(root: string, core: z.infer<typeof GapReceiptCoreSchema>, store?: PmExecutionStore): Promise<z.infer<typeof GapReceiptSchema>> {
  const existing = await readPmGapReceipt(root, core.receipt_id, store);
  const receipt = GapReceiptSchema.parse({ ...core, protected_state_sha256: sha(JSON.stringify(core)) });
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(receipt)) fail("pm_status_gap_conflict", "stored PM gap receipt conflicts with the canonical gap");
    return existing;
  }
  await executionWriteJson(pmGapReceiptPath(root, core.receipt_id), receipt, store);
  const reread = await readPmGapReceipt(root, core.receipt_id, store);
  if (!reread || JSON.stringify(reread) !== JSON.stringify(receipt)) fail("pm_status_gap_readback_failed", "PM gap receipt did not survive exact readback");
  return reread;
}

async function readSchedulerArtifact(
  request: z.infer<typeof SchedulerArtifactRequestSchema>,
): Promise<z.infer<typeof SchedulerArtifactSchema> | undefined> {
  const file = path.resolve(request.path);
  const before = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!before) return undefined;
  if (!before.isFile() || before.isSymbolicLink() || before.size > 64 * 1024) {
    fail("pm_status_scheduler_artifact_unsafe", "scheduler artifact must be one bounded regular file");
  }
  const real = await fs.realpath(file);
  if (real !== file) fail("pm_status_scheduler_artifact_unsafe", "scheduler artifact path must not traverse a symlink");
  const raw = await fs.readFile(file);
  const after = await fs.lstat(file);
  if (!sameArtifactIdentity(before, after) || sha(raw.toString("utf8")) !== request.sha256) {
    fail("pm_status_scheduler_artifact_tampered", "scheduler artifact changed or did not match its expected digest");
  }
  let value: unknown;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { return fail("pm_status_scheduler_artifact_invalid", "scheduler artifact is not canonical UTF-8 JSON"); }
  return parseSchedulerArtifact(value);
}

function parseSchedulerArtifact(value: unknown): z.infer<typeof SchedulerArtifactSchema> {
  const parsed = SchedulerArtifactSchema.safeParse(value);
  if (!parsed.success) return fail("pm_status_scheduler_artifact_invalid", "scheduler artifact is malformed");
  const { protected_state_sha256, ...core } = parsed.data;
  if (protected_state_sha256 !== sha(JSON.stringify(core))) {
    fail("pm_status_scheduler_artifact_tampered", "scheduler artifact integrity failed");
  }
  return parsed.data;
}

function schedulerLocalMinute(value: string, timezone: string): { date: string; time: string } {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23",
    });
  } catch {
    return fail("pm_status_scheduler_artifact_invalid", "natural scheduler timezone is invalid");
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(value))
    .filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

function emptyStatusBase(input: z.infer<typeof StatusInputSchema>, goalId: string): Omit<PmStatusReport, "state" | "reason_code"> {
  return {
    schema_version: 1, goal_id: goalId, workspace_id: input.workspace_id, parent_id: input.parent_id,
    receipt_chain: {},
    producer: { slot: input.producer_slot, invocation_key: input.invocation_key, observed_provenance: [] },
    artifact_hashes: [], provider_references: { live_evidence_reference_ids: [], finding_annotation_ids: [], correction_reference_ids: [] },
    findings: [], evidence: { classification: input.evidence_requirement === "natural" ? "missing_natural" : "manual" },
  };
}

function statusResult(base: Omit<PmStatusReport, "state" | "reason_code">, state: z.infer<typeof StatusStateSchema>, reasonCode: string): PmStatusReport {
  return StatusReportSchema.parse({ ...base, state, reason_code: reasonCode });
}

function reducePhase5Gate(review: PmReviewReceipt, evidence: PmStatusReport["evidence"]): z.infer<typeof Phase5GateSchema> {
  if (review.verdict === "BLOCKED" || review.high_disposition?.kind === "blocker") {
    return { phase: "P5-E", verdict: "BLOCKED", reason_code: "PM_REVIEW_BLOCKED", evidence_reference: review.receipt_id };
  }
  if (review.verdict === "FAIL") {
    return { phase: "P5-E", verdict: "FAIL", reason_code: "PM_REVIEW_FAILED", evidence_reference: review.receipt_id };
  }
  if (review.verdict === "PARTIAL") {
    return { phase: "P5-E", verdict: "PARTIAL", reason_code: "PM_REVIEW_PARTIAL", evidence_reference: review.receipt_id };
  }
  if (evidence.classification === "verified_natural") {
    return { phase: "P5-E", verdict: "PASS", reason_code: "PM_NATURAL_EVIDENCE_VERIFIED",
      evidence_reference: evidence.scheduler_artifact_sha256! };
  }
  return { phase: "P5-E", verdict: "PARTIAL", reason_code: "PM_NATURAL_EVIDENCE_MISSING",
    evidence_reference: evidence.gap_receipt?.receipt_id ?? review.receipt_id };
}

export async function statusPm(rawInput: StatusPmInput, deps: StatusPmDeps = {}): Promise<PmStatusReport> {
  const parsed = StatusInputSchema.safeParse(rawInput);
  if (!parsed.success) fail("pm_invalid_status_request", "PM status request is invalid");
  const input = parsed.data;
  const resolved = await resolvePmGoal(input.cwd, input.goal, deps);
  if (!resolved) fail("pm_harness_missing", "PM status requires an initialized harness goal");
  const goalState = await new HarnessStore(resolved.root).readStateV3();
  const goalBackend = goalState.goals[resolved.goalId]?.backend;
  let binding = deps.binding;
  if (goalBackend?.kind === "github") {
    if (String(goalBackend.parent_issue_number) !== input.parent_id
      || input.workspace_id !== `${goalBackend.owner}/${goalBackend.repo}`) {
      fail("pm_status_destination_mismatch", "PM status destination does not match the GitHub goal backend");
    }
    binding = binding ?? {
      schema_version: 1,
      goal_id: resolved.goalId,
      credential_mode: "profile",
      server_origin: "https://github.com",
      workspace_id: `${goalBackend.owner}/${goalBackend.repo}`,
      parent_id: String(goalBackend.parent_issue_number),
      parent_identifier: String(goalBackend.parent_issue_number),
      project_source: "parent",
      issue_prefix: "GH",
      verified_at: new Date().toISOString(),
    };
  } else {
    binding = binding ?? await verifyCoordinationBinding(input.cwd, input.goal, deps);
    if (!binding || binding.goal_id !== resolved.goalId || binding.workspace_id !== input.workspace_id
      || binding.parent_id.toLowerCase() !== input.parent_id.toLowerCase()) {
      fail("pm_status_destination_mismatch", "PM status destination does not match the authenticated goal binding");
    }
  }
  if (!binding) fail("pm_status_destination_mismatch", "PM status destination does not match the authenticated goal binding");
  let base = emptyStatusBase(input, resolved.goalId);
  const prepare = await readPmPrepareReceipt(resolved.root, resolved.goalId, input.producer_slot, input.invocation_key, deps.executionStore);
  if (!prepare) return statusResult(base, "incomplete", "PM_PREPARE_MISSING");
  if (prepare.receipt_id !== receiptId(resolved.goalId, input.producer_slot, input.invocation_key)) {
    fail("pm_status_identity_invalid", "PM prepare receipt identity is not canonical");
  }
  base = { ...base, receipt_chain: { prepare_receipt_id: prepare.receipt_id },
    producer: { slot: prepare.producer_slot, invocation_key: prepare.invocation_key,
      prepare_receipt_id: prepare.receipt_id, observed_provenance: prepare.observed_provenance } };
  if (prepare.observed_provenance.length === 0) fail("pm_status_provenance_invalid", "PM prepare provenance is missing");
  if (prepare.state === "blocked") return statusResult(base, "blocked", "PM_PREPARE_BLOCKED");
  if (prepare.state === "no_selection") return statusResult(base, "incomplete", prepare.decision.reason_code);
  if (!prepare.decision.selected_id) fail("pm_status_chain_invalid", "PM prepare selection is missing its ticket identity");
  base = { ...base, ticket_id: prepare.decision.selected_id };

  const provider = deps.provider ?? (
    goalBackend?.kind === "github"
      ? githubPmProvider(goalBackend, deps.ghRunner ?? spawnGh, deps.env ?? process.env)
      : multicaPmProvider(binding, deps.runner ?? spawnMultica, deps.env ?? process.env)
  );
  if (!provider.readTicketProof) fail("pm_status_provider_invalid", "PM status provider cannot read ticket proof");
  const liveRaw = await provider.readTicketProof(prepare.decision.selected_id);
  if (!liveRaw) fail("pm_status_live_proof_invalid", "selected PM ticket is missing from live readback");
  const live = parsePmLiveTicketProof(liveRaw);
  if (live.ticket_id.toLowerCase() !== prepare.decision.selected_id.toLowerCase()
    || live.parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
    || live.configured_parent_id.toLowerCase() !== binding.parent_id.toLowerCase()) {
    fail("pm_status_live_proof_invalid", "live PM ticket does not match the authenticated destination");
  }
  if (prepare.provider_annotation && !live.evidence_reference_ids.includes(prepare.provider_annotation.id)) {
    fail("pm_status_evidence_reference_invalid", "live PM ticket is missing the prepare evidence reference");
  }
  if (prepare.provider_annotation) {
    if (!provider.readAnnotation) fail("pm_status_provider_invalid", "PM status provider cannot read exact prepare annotations");
    const exactPrepare = await provider.readAnnotation(prepare.decision.selected_id, prepare.provider_annotation.key, annotationContent(prepare));
    if (!exactPrepare || JSON.stringify(exactPrepare) !== JSON.stringify(prepare.provider_annotation)) {
      fail("pm_status_evidence_reference_invalid", "prepare annotation failed exact readback");
    }
  }
  base = { ...base, provider_references: { ...base.provider_references,
    prepare_annotation_id: prepare.provider_annotation?.id, live_evidence_reference_ids: canonicalList(live.evidence_reference_ids) } };
  if (prepare.state === "prepared" && !prepare.provider_annotation) {
    const annotationKey = `pm-${sha(`${prepare.receipt_id}\0annotation`).slice(0, 24)}`;
    const remote = provider.readAnnotation
      ? await provider.readAnnotation(prepare.decision.selected_id, annotationKey, annotationContent(prepare))
      : undefined;
    const recovery = remote ? {
      reason_code: "PM_MUTATION_UNCOMMITTED" as const, owning_command: "autonomy pm prepare" as const,
      producer_slot: prepare.producer_slot, invocation_key: prepare.invocation_key,
      exact_reference_ids: [remote.id],
      instruction: "Rerun autonomy pm prepare with the original producer slot and invocation key; reconcile only from exact provider readback.",
    } : undefined;
    return statusResult({ ...base, ...(recovery ? { recovery } : {}) }, recovery ? "mutation_uncommitted" : "incomplete",
      recovery ? "PM_MUTATION_UNCOMMITTED" : "PM_PREPARE_NOT_FINALIZED");
  }
  if (!input.claim_id) return statusResult(base, "incomplete", "PM_HANDOFF_MISSING");

  const handoff = await readPmHandoffReceipt(resolved.root, resolved.goalId, input.claim_id, deps.executionStore);
  const workerClaim = await readWorkerClaim(resolved.root, prepare.receipt_id, deps.executionStore);
  if (!handoff) return statusResult(base, "incomplete", "PM_HANDOFF_MISSING");
  if (workerClaim && (workerClaim.claim_receipt_id !== `pmcr-${sha(JSON.stringify([resolved.goalId, prepare.receipt_id])).slice(0, 32)}`
    || handoff.claim.claim_id !== pmWorkerClaimId(resolved.goalId, prepare, handoff.worker)
    || handoff.receipt_id !== handoffReceiptId(resolved.goalId, input.claim_id))) {
    fail("pm_status_identity_invalid", "PM claim or handoff identity is not canonical");
  }
  if (!workerClaim || handoff.prepare_receipt_id !== prepare.receipt_id || handoff.claim.claim_id !== input.claim_id
    || handoff.producer_slot !== input.producer_slot || handoff.invocation_key !== input.invocation_key
    || handoff.claim.ticket_id !== prepare.decision.selected_id
    || handoff.claim.provider_annotation_id !== prepare.provider_annotation?.id
    || handoff.worker_claim_protected_state_sha256 !== workerClaim.protected_state_sha256
    || JSON.stringify(handoff.worker_origin) !== JSON.stringify(workerClaim.worker_origin)
    || JSON.stringify(handoff.worker_payload) !== JSON.stringify(workerClaim.worker_payload)
    || handoff.prepare_claim_commitment_sha256 !== pmPrepareClaimCommitment(prepare)
    || JSON.stringify(handoff.worker) !== JSON.stringify(workerClaim.worker)
    || JSON.stringify(handoff.claim) !== JSON.stringify(workerClaim.claim)) {
    fail("pm_status_chain_invalid", "PM prepare, worker claim, and handoff do not form one authenticated chain");
  }
  const artifacts = await authenticateReviewArtifacts(resolved.root, handoff, deps.executionStore);
  const workerRecord = await reauthenticateWorkerActor(handoff, binding, deps, "pm_status_worker_origin_invalid");
  base = { ...base, receipt_chain: { ...base.receipt_chain, worker_claim_receipt_id: workerClaim.claim_receipt_id,
    handoff_receipt_id: handoff.receipt_id }, worker: handoff.worker, artifact_hashes: artifacts };
  const review = await readPmReviewReceipt(resolved.root, resolved.goalId, input.claim_id, deps.executionStore);
  if (!review) return statusResult(base, "incomplete",
    handoff.state === "incomplete" ? "PM_WORKER_INCOMPLETE" : "PM_REVIEW_MISSING");
  if (review.receipt_id !== reviewReceiptId(resolved.goalId, input.claim_id)) {
    fail("pm_status_identity_invalid", "PM review receipt identity is not canonical");
  }
  if (review.prepare_receipt_id !== prepare.receipt_id || review.claim_id !== handoff.claim.claim_id
    || review.handoff_receipt_id !== handoff.receipt_id || JSON.stringify(review.worker) !== JSON.stringify(handoff.worker)
    || JSON.stringify(review.worker_origin) !== JSON.stringify(handoff.worker_origin)
    || JSON.stringify(review.worker_payload) !== JSON.stringify(handoff.worker_payload)
    || JSON.stringify(review.authenticated_manifest) !== JSON.stringify(artifacts)
    || review.manifest_sha256 !== sha(JSON.stringify(artifacts))
    || canonicalIdentity(review.reviewer.subject) === canonicalIdentity(handoff.worker.subject)
    || canonicalIdentity(review.reviewer.run_id) === canonicalIdentity(handoff.worker.run_id)
    || canonicalIdentity(review.reviewer.session_id) === canonicalIdentity(handoff.worker.session_id)
    || review.ticket_proof.ticket_id.toLowerCase() !== handoff.claim.ticket_id.toLowerCase()
    || review.ticket_proof.parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
    || review.ticket_proof.configured_parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
    || review.phase4_proof.parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
    || !liveProofMonotonicallyCompatible(review.ticket_proof, live)) {
    fail("pm_status_chain_invalid", "PM review does not authenticate the prepare, handoff, provenance, artifacts, and live proof");
  }
  const reviewerRecord = await readActorOrigin(review.reviewer_origin.selector, "reviewer", deps, "pm_status_reviewer_origin_invalid");
  const reviewerIdentity = ReviewerIdentitySchema.safeParse({ subject: reviewerRecord.subject,
    run_id: reviewerRecord.run_id, session_id: reviewerRecord.session_id });
  const actorReused = reviewerRecord.record_sha256 === workerRecord.record_sha256
    || JSON.stringify(review.reviewer_origin.selector) === JSON.stringify(handoff.worker_origin.selector);
  if (!reviewerIdentity.success || JSON.stringify(reviewerIdentity.data) !== JSON.stringify(review.reviewer)
    || JSON.stringify(actorBinding(reviewerRecord, review.reviewer_origin.selector)) !== JSON.stringify(review.reviewer_origin)
    || reviewerRecord.goal_id !== resolved.goalId
    || reviewerRecord.parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
    || reviewerRecord.ticket_id !== handoff.claim.ticket_id
    || reviewerRecord.prepare_receipt_id !== prepare.receipt_id
    || reviewerRecord.claim_id !== handoff.claim.claim_id
    || reviewerRecord.payload_sha256 !== sha(JSON.stringify(review.review_payload))
    || JSON.stringify(reviewerRecord.payload) !== JSON.stringify(review.review_payload)
    || review.review_payload.goal_id !== resolved.goalId
    || review.review_payload.parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
    || review.review_payload.ticket_id !== handoff.claim.ticket_id
    || review.review_payload.prepare_receipt_id !== prepare.receipt_id
    || review.review_payload.claim_id !== handoff.claim.claim_id
    || review.review_payload.handoff_receipt_id !== handoff.receipt_id
    || review.review_payload.worker_record_sha256 !== workerRecord.record_sha256
    || JSON.stringify(review.review_payload.manifest) !== JSON.stringify(artifacts)
    || JSON.stringify(review.review_payload.ticket_proof) !== JSON.stringify(review.ticket_proof)
    || JSON.stringify(review.review_payload.phase4_proof) !== JSON.stringify(review.phase4_proof)
    || JSON.stringify(review.review_payload.phase4) !== JSON.stringify(review.phase4)
    || review.review_payload.verdict !== review.verdict || actorReused) {
    fail("pm_status_chain_invalid", "PM reviewer signature no longer authenticates the exact durable review payload");
  }
  let authenticatedPhase4: CanonicalContinuationVerdict;
  try {
    const loader = deps.loadContinuationClosureVerdict ?? loadContinuationClosureVerdict;
    authenticatedPhase4 = validateClosure(await loader({
      root: resolved.root, proofId: review.phase4_proof.proof_id, parentId: review.phase4_proof.parent_id,
      runId: review.phase4_proof.run_id, sessionId: review.phase4_proof.session_id, surface: "ticket-completion",
    }), review.phase4_proof);
  } catch {
    return fail("pm_status_phase4_invalid", "PM status could not reauthenticate the Phase 4 continuation verdict");
  }
  if (JSON.stringify(authenticatedPhase4) !== JSON.stringify(review.phase4)) {
    fail("pm_status_phase4_invalid", "durable Phase 4 verdict differs from its authenticated proof");
  }
  const mutationReadbacks = new Map<string, string>();
  for (const mutation of review.pending_mutations) {
    const reference = await readExpectedMutation(provider, mutation);
    if (reference) mutationReadbacks.set(mutation.key, reference);
  }
  const requiredEvidence = new Set<string>([handoff.claim.provider_annotation_id]);
  const findingAnnotationIds: string[] = [];
  const correctionReferenceIds: string[] = [];
  for (const finding of review.findings) {
    if (finding.disposition?.provider_annotation) {
      const annotation = finding.disposition.provider_annotation;
      const expected = review.pending_mutations.find((mutation) => mutation.kind === "annotation" && mutation.key === annotation.key);
      if (!expected || mutationReadbacks.get(expected.key) !== annotation.id || annotation.issue_id !== handoff.claim.ticket_id) {
        fail("pm_status_evidence_reference_invalid", "finding annotation failed exact readback");
      }
      requiredEvidence.add(annotation.id); findingAnnotationIds.push(annotation.id);
    }
    if (finding.disposition?.kind === "follow_up" && finding.disposition.reference_id) {
      const followUpRaw = await provider.readTicketProof(finding.disposition.reference_id);
      if (!followUpRaw) fail("pm_status_evidence_reference_invalid", "finding follow-up reference is missing");
      const followUp = parsePmLiveTicketProof(followUpRaw);
      if (followUp.ticket_id.toLowerCase() !== finding.disposition.reference_id.toLowerCase()
        || followUp.parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
        || followUp.configured_parent_id.toLowerCase() !== binding.parent_id.toLowerCase()
        || finding.disposition.follow_up_proof_sha256 !== liveProofCommitment(followUp)) {
        fail("pm_status_evidence_reference_invalid", "finding follow-up reference failed exact proof authentication");
      }
    }
  }
  if (review.high_disposition?.kind === "blocker") {
    const blocker = review.high_disposition;
    const expected = review.pending_mutations.find((mutation) => mutation.kind === "annotation"
      && mutation.key === blocker.provider_annotation.key);
    if (blocker.provider_annotation.issue_id !== handoff.claim.ticket_id
      || blocker.reference_id !== blocker.provider_annotation.id
      || !expected || mutationReadbacks.get(expected.key) !== blocker.reference_id) {
      fail("pm_status_evidence_reference_invalid", "blocker reference is not its exact provider annotation");
    }
    requiredEvidence.add(blocker.reference_id);
    findingAnnotationIds.push(blocker.reference_id);
  }
  if (review.high_disposition?.kind === "correction") {
    const correction = review.high_disposition;
    const expected = review.pending_mutations.find((mutation) => mutation.kind === "correction" && mutation.key === correction.key);
    if (!expected || mutationReadbacks.get(expected.key) !== correction.reference_id) {
      fail("pm_status_evidence_reference_invalid", "PM correction reference failed exact readback");
    }
    correctionReferenceIds.push(correction.reference_id);
  }
  base = { ...base, receipt_chain: { ...base.receipt_chain, review_receipt_id: review.receipt_id },
    reviewer: review.reviewer, phase4_proof: review.phase4_proof, phase4: authenticatedPhase4, verdict: review.verdict,
    ...(review.high_disposition ? { high_disposition: review.high_disposition } : {}),
    findings: review.findings, provider_references: { ...base.provider_references,
      finding_annotation_ids: canonicalList(findingAnnotationIds), correction_reference_ids: canonicalList(correctionReferenceIds) } };
  if (review.state === "pending_disposition") {
    const exactReferences = [...mutationReadbacks.values()].sort();
    const recovery = exactReferences.length > 0 ? {
      reason_code: "PM_MUTATION_UNCOMMITTED" as const, owning_command: "autonomy pm review" as const,
      producer_slot: prepare.producer_slot, invocation_key: prepare.invocation_key,
      exact_reference_ids: exactReferences,
      instruction: "Rerun autonomy pm review with the original producer slot and invocation key; reconcile only from exact provider readback.",
    } : undefined;
    return statusResult({ ...base, ...(recovery ? { recovery } : {}) }, recovery ? "mutation_uncommitted" : "incomplete",
      recovery ? "PM_MUTATION_UNCOMMITTED" : "PM_REVIEW_NOT_FINALIZED");
  }
  for (const reference of requiredEvidence) {
    if (!live.evidence_reference_ids.includes(reference)) {
      fail("pm_status_evidence_reference_invalid", "a durable PM provider reference is absent from live readback");
    }
  }

  let scheduler: z.infer<typeof SchedulerArtifactSchema> | undefined;
  let schedulerDigest: string | undefined;
  let schedulerOriginId: string | undefined;
  let schedulerRecordId: string | undefined;
  let trustedSchedulerOrigin = false;
  if (input.scheduler_origin) {
    const trusted = deps.readTrustedSchedulerArtifact
      ? await deps.readTrustedSchedulerArtifact(input.scheduler_origin)
      : undefined;
    if (trusted !== undefined) {
      if (trusted.origin !== "scheduler_record" || !SHA256.test(trusted.record_sha256)
        || trusted.origin_id !== input.scheduler_origin.origin_id || trusted.record_id !== input.scheduler_origin.record_id) {
        fail("pm_status_scheduler_origin_mismatch", "trusted scheduler readback does not match the opaque origin selector");
      }
      scheduler = parseSchedulerArtifact(trusted.artifact);
      if (JSON.stringify(trusted.schedule) !== JSON.stringify({
        timezone: scheduler.timezone, local_date: scheduler.local_date,
        prepare_local_time: scheduler.prepare_local_time, review_local_time: scheduler.review_local_time,
      })) {
        fail("pm_status_scheduler_artifact_mismatch", "trusted scheduler provenance does not match the persisted record schedule");
      }
      trustedSchedulerOrigin = true;
      schedulerDigest = trusted.record_sha256;
      schedulerOriginId = trusted.origin_id;
      schedulerRecordId = trusted.record_id;
    }
  } else if (input.scheduler_artifact) {
    scheduler = await readSchedulerArtifact(input.scheduler_artifact);
    schedulerDigest = input.scheduler_artifact.sha256;
  }
  let evidence: PmStatusReport["evidence"] = { classification: "manual" };
  if (scheduler) {
    const natural = trustedSchedulerOrigin && scheduler.evidence_class === "natural_scheduler"
      && scheduler.trigger === "scheduled" && !scheduler.manual_trigger;
    if (scheduler.goal_id !== resolved.goalId || scheduler.workspace_id !== binding.workspace_id
      || scheduler.parent_id.toLowerCase() !== binding.parent_id.toLowerCase() || scheduler.producer_slot !== prepare.producer_slot
      || scheduler.invocation_key !== prepare.invocation_key || scheduler.ticket_id !== handoff.claim.ticket_id
      || scheduler.review_receipt_id !== review.receipt_id
      || scheduler.review_protected_state_sha256 !== review.protected_state_sha256) {
      fail("pm_status_scheduler_artifact_mismatch", "scheduler artifact does not bind the authenticated PM review chain");
    }
    const scheduledAt = Date.parse(scheduler.scheduled_at); const startedAt = Date.parse(scheduler.started_at); const completedAt = Date.parse(scheduler.completed_at);
    if (natural) {
      const scheduledLocal = schedulerLocalMinute(scheduler.scheduled_at, scheduler.timezone);
      const startedLocal = schedulerLocalMinute(scheduler.started_at, scheduler.timezone);
      const completedLocal = schedulerLocalMinute(scheduler.completed_at, scheduler.timezone);
      if (!Number.isFinite(scheduledAt) || !Number.isFinite(startedAt) || !Number.isFinite(completedAt)
        || !(scheduledAt <= startedAt && startedAt <= completedAt)
        || completedAt - scheduledAt > 24 * 60 * 60 * 1000 || completedAt > Date.now()
        || scheduledLocal.date !== scheduler.local_date || scheduledLocal.time !== scheduler.prepare_local_time
        || startedLocal.date !== scheduler.local_date
        || completedLocal.date !== scheduler.local_date || completedLocal.time !== scheduler.review_local_time) {
        fail("pm_status_scheduler_artifact_invalid", "natural scheduler record is outside its authenticated local 09:00-to-17:00 boundary");
      }
    }
    evidence = natural
      ? { classification: "verified_natural", scheduler_artifact_sha256: schedulerDigest,
        scheduler_id: scheduler.scheduler_id, scheduler_run_id: scheduler.run_id,
        scheduler_origin_id: schedulerOriginId, scheduler_record_id: schedulerRecordId }
      : { classification: "synthetic", scheduler_artifact_sha256: schedulerDigest,
        scheduler_id: scheduler.scheduler_id, scheduler_run_id: scheduler.run_id };
  } else if (input.evidence_requirement === "natural") evidence = { classification: "missing_natural" };

  let state: z.infer<typeof StatusStateSchema>; let reasonCode: string;
  if (review.verdict === "BLOCKED" || review.high_disposition?.kind === "blocker") {
    state = "blocked"; reasonCode = "PM_REVIEW_BLOCKED";
  } else if (evidence.classification === "verified_natural") {
    state = "verified_natural_evidence"; reasonCode = "PM_NATURAL_EVIDENCE_VERIFIED";
  } else if (input.evidence_requirement === "natural") {
    state = "missing_natural_evidence"; reasonCode = "PM_NATURAL_EVIDENCE_MISSING";
  } else {
    state = "manual_evidence"; reasonCode = "PM_MANUAL_EVIDENCE_ONLY";
  }
  if (input.record_gap) {
    if (state !== "missing_natural_evidence") fail("pm_status_gap_not_required", "a PM gap may be recorded only when natural evidence is missing");
    const gap = await recordPmGap(resolved.root, gapReceiptCore(resolved.goalId, prepare, handoff.claim.ticket_id, review.receipt_id), deps.executionStore);
    evidence = { ...evidence, gap_receipt: gap };
  }
  const phase5Gate = reducePhase5Gate(review, evidence);
  return statusResult({ ...base, evidence, phase5_gate: phase5Gate }, state, reasonCode);
}

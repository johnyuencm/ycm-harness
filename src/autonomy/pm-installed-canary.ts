import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { assertSafeContinuationStoragePath } from "../continuation/storage-safety.js";
import type { CanonicalContinuationVerdict } from "../continuation/shadow.js";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import {
  handoffPm, pmReviewerActorPayload, pmWorkerActorPayload, pmWorkerClaimId, pmWorkerRunRoot, preparePm, projectPmPrepare, readPmGapReceipt, readPmHandoffReceipt,
  readPmPrepareReceipt, readPmReviewReceipt, reviewPm, statusPm,
  type PmCandidate, type PmExecutionStore, type PmHandoffReceipt, type PmPrepareReceipt, type PmProvider,
  type PmReviewReceipt, type PmStatusReport,
} from "./pm.js";
import type { PmActorOriginSelector, TrustedPmActorOriginReadback } from "./pm-actor-origin.js";
import {
  persistPinnedLocalArtifacts,
  type PinnedPmExecution,
  type PinnedLocalArtifactStoreHooks,
} from "./pinned-local-artifact-store.js";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const WORKSPACE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const PARENT_ID = "p5e-local-parent";
const PRODUCER_SLOT = "p5e-manual-local";
const INVOCATION_KEY = "installed-no-delivery-v3";
const PREPARE_RUN_ID = "p5e-prepare-run";
const PREPARE_SESSION_ID = "p5e-prepare-session";
const CANDIDATE: PmCandidate = {
  id: "p5e-local-candidate", root_key: "p5e-local-root", priority: "high",
  updated_at: "2026-07-16T08:00:00.000Z", active: true, material: true, concrete_acceptance: true,
  dependencies_satisfied: true, safe_authority: true, clear: true,
};
const BRIEF = {
  objective: "Persist one installed manual PM evidence cycle.",
  non_goals: ["No Multica, scheduler, delivery, ticket lifecycle, Git, or external mutation."],
  acceptance: ["The installed manual acceptance passes."], evidence: ["Read back all ignored local PM receipts."],
  first_steps: ["Use the deterministic local-only provider double."], verification: ["Authenticate manual status and one natural-evidence gap."],
  capability_cost_rationale: "Use the smallest deterministic no-agent canary.",
  safety_rollback: "Stop invoking the canary and retain existing receipts for audit.",
  risks: ["Manual evidence cannot prove a natural scheduler run."],
  handoff_contract: "Return the authenticated receipt IDs and honest PARTIAL gate report.",
};
const WORKER = { subject: "p5e-local-worker", run_id: "p5e-worker-run", session_id: "p5e-worker-session",
  capability: { id: "deterministic-local-canary", rank: 0 } };
const REVIEWER = { subject: "p5e-local-reviewer", run_id: "p5e-reviewer-run", session_id: "p5e-reviewer-session" };
const WORKER_ORIGIN = { origin_id: "manual-local-double", record_id: "p5e-worker-v3" } as const;
const REVIEWER_ORIGIN = { origin_id: "manual-local-double", record_id: "p5e-reviewer-v3" } as const;
const ARTIFACTS = { prompt: "prompt.txt", output: "output.txt", exit_status: "exit-status.txt", meaningful_log: "meaningful.log" };
const ARTIFACT_CONTENT = new Map([
  [ARTIFACTS.prompt, "Run the installed deterministic local-only PM evidence canary.\n"],
  [ARTIFACTS.output, "Manual local PM canary completed; natural scheduler evidence remains absent.\n"],
  [ARTIFACTS.exit_status, "0\n"],
  [ARTIFACTS.meaningful_log, "prepare handoff review status gap: pass\n"],
]);
const EXPECTED_ARTIFACT_MANIFEST = ([
  ["prompt", ARTIFACTS.prompt],
  ["output", ARTIFACTS.output],
  ["exit_status", ARTIFACTS.exit_status],
  ["meaningful_log", ARTIFACTS.meaningful_log],
] as const).map(([kind, relative_path]) => {
  const content = ARTIFACT_CONTENT.get(relative_path)!;
  return { kind, relative_path, size_bytes: Buffer.byteLength(content), sha256: sha(content) };
});

const HANDOFF = {
  acceptance_checklist: [{ criterion: BRIEF.acceptance[0]!, status: "pass" as const, evidence: ["local receipt readback"] }],
  remaining_risks: ["Natural scheduler evidence is absent."], severity_self_assessment: "Low" as const, changed_files: [],
  evidence: ["local receipt readback"], commands: [{ command: "pm-installed-canary", result: "manual pass" }],
  follow_up: { ids: [], suggestions: ["Wait for a genuine trusted scheduler record."] },
};
const PHASE4_PROOF = { proof_id: sha("p5e-local-phase4-proof"), parent_id: PARENT_ID,
  run_id: "p5e-phase4-run", session_id: "p5e-phase4-session" };

function manualActorRecord(input: {
  selector: PmActorOriginSelector;
  role: "worker" | "reviewer";
  identity: typeof WORKER | typeof REVIEWER;
  goalId: string;
  ticketId: string;
  prepareReceiptId: string;
  claimId: string;
  payload: unknown;
}): TrustedPmActorOriginReadback {
  const payloadSha = sha(JSON.stringify(input.payload));
  const core = {
    schema_version: 1 as const, ...input.selector, key_id: "manual-local-double", assurance: "manual_local_double" as const,
    role: input.role, subject: input.identity.subject, run_id: input.identity.run_id, session_id: input.identity.session_id,
    ...("capability" in input.identity ? { capability: input.identity.capability } : {}),
    goal_id: input.goalId, parent_id: PARENT_ID, ticket_id: input.ticketId,
    prepare_receipt_id: input.prepareReceiptId, claim_id: input.claimId, payload: input.payload, payload_sha256: payloadSha,
  };
  return { ...core, record_sha256: sha(JSON.stringify(core)) };
}

function localAnnotation(issueId: string, key: string, content: string) {
  return { id: `local-${sha(`${key}\0${content}`).slice(0, 24)}`, issue_id: issueId, key, content };
}

const ReportCoreSchema = z.object({
  schema_version: z.literal(3), report_id: z.string().regex(/^p5e-[0-9a-f]{32}$/), goal_id: z.string().min(1),
  verdict: z.literal("PARTIAL"), reason_code: z.literal("PM_NATURAL_EVIDENCE_MISSING"),
  evidence_class: z.literal("manual_local_provider"), provider: z.literal("deterministic_local_double"),
  claim_id: z.string().min(1),
  receipt_ids: z.object({ prepare: z.string().regex(/^pm-[0-9a-f]{32}$/), handoff: z.string().regex(/^pmh-[0-9a-f]{32}$/),
    review: z.string().regex(/^pmr-[0-9a-f]{32}$/), gap: z.string().regex(/^pmg-[0-9a-f]{32}$/) }).strict(),
  evidence_ids: z.array(z.string().min(1)).length(4),
  safety: z.object({ provider_lifecycle_mutations: z.literal(0), schedule_mutations: z.literal(0), deliveries: z.literal(0) }).strict(),
}).strict();
const ReportIdentitySchema = ReportCoreSchema.omit({ report_id: true });
const ReportSchema = ReportCoreSchema.extend({ protected_state_sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export type PmInstalledCanaryReport = z.infer<typeof ReportSchema>;

export interface PmInstalledCanaryTrace {
  schema_version: 3;
  commands: {
    prepare: PmPrepareReceipt;
    handoff: PmHandoffReceipt;
    review: PmReviewReceipt;
    status: PmStatusReport;
  };
  report: PmInstalledCanaryReport;
}

export interface PmInstalledCanaryDeps {
  artifactStore?: PinnedLocalArtifactStoreHooks;
}

export function pmInstalledCanaryReportPath(root: string, reportId: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "pm", "gates", `${reportId}.json`);
}

async function readReport(root: string, reportId: string, execution?: PmExecutionStore): Promise<PmInstalledCanaryReport | undefined> {
  const file = pmInstalledCanaryReportPath(root, reportId);
  if (execution) await execution.assertPath(file, "file", "pm_canary_storage_unsafe");
  else await assertSafeContinuationStoragePath(root, file, "file", "pm_canary_storage_unsafe");
  const raw = execution ? await execution.readJson<unknown>(file) : await readJsonIfExists<unknown>(file);
  if (!raw) return undefined;
  if (typeof raw !== "object" || (raw as { schema_version?: unknown }).schema_version !== 3) return undefined;
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) throw new Error("pm_canary_report_invalid");
  const value = parsed.data;
  const { protected_state_sha256, ...core } = value;
  if (protected_state_sha256 !== sha(JSON.stringify(core))) throw new Error("pm_canary_report_tampered");
  const { report_id: _reportId, ...identity } = core;
  if (reportId !== `p5e-${sha(JSON.stringify(identity)).slice(0, 32)}` || core.report_id !== reportId) {
    throw new Error("pm_canary_report_identity_invalid");
  }
  return value;
}

async function storeReport(root: string, coreWithoutId: Omit<PmInstalledCanaryReport, "report_id" | "protected_state_sha256">, execution?: PmExecutionStore): Promise<PmInstalledCanaryReport> {
  const identity = ReportIdentitySchema.parse(coreWithoutId);
  const reportId = `p5e-${sha(JSON.stringify(identity)).slice(0, 32)}`;
  const core = ReportCoreSchema.parse({ ...identity, report_id: reportId });
  const report = ReportSchema.parse({ ...core, protected_state_sha256: sha(JSON.stringify(core)) });
  const existing = await readReport(root, reportId, execution);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(report)) throw new Error("pm_canary_report_conflict");
    return existing;
  }
  if (execution) await execution.writeJson(pmInstalledCanaryReportPath(root, reportId), report);
  else await writeJsonAtomic(pmInstalledCanaryReportPath(root, reportId), report);
  const reread = await readReport(root, reportId, execution);
  if (!reread || JSON.stringify(reread) !== JSON.stringify(report)) throw new Error("pm_canary_report_readback_failed");
  return reread;
}

async function existingReport(
  root: string,
  goalId: string,
  claimId: string,
  execution?: PinnedPmExecution,
): Promise<PmInstalledCanaryReport | undefined> {
  const directory = path.join(root, HARNESS_DIR_NAME, "autonomy", "pm", "gates");
  if (execution) await execution.assertPath(directory, "directory", "pm_canary_storage_unsafe");
  else await assertSafeContinuationStoragePath(root, directory, "directory", "pm_canary_storage_unsafe");
  const names = execution ? execution.listJson(directory)
    : await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const reports: PmInstalledCanaryReport[] = [];
  for (const name of names.filter((value) => /^p5e-[0-9a-f]{32}\.json$/.test(value)).sort()) {
    const report = await readReport(root, path.basename(name, ".json"), execution);
    if (report?.goal_id === goalId && report.provider === "deterministic_local_double" && report.claim_id === claimId) {
      reports.push(report);
    }
  }
  if (reports.length > 1) throw new Error("pm_canary_report_conflict");
  const report = reports[0];
  if (!report) return undefined;
  const [prepare, handoff, review, gap] = await Promise.all([
    readPmPrepareReceipt(root, goalId, PRODUCER_SLOT, INVOCATION_KEY, execution),
    readPmHandoffReceipt(root, goalId, report.claim_id, execution),
    readPmReviewReceipt(root, goalId, report.claim_id, execution),
    readPmGapReceipt(root, report.receipt_ids.gap, execution),
  ]);
  if (prepare?.receipt_id !== report.receipt_ids.prepare || handoff?.receipt_id !== report.receipt_ids.handoff
    || review?.receipt_id !== report.receipt_ids.review || gap?.receipt_id !== report.receipt_ids.gap) {
    throw new Error("pm_canary_receipt_readback_failed");
  }
  return report;
}

/** Run one deterministic installed/manual PM chain. This function has no external provider, scheduler, delivery, or lifecycle adapter. */
async function executePmInstalledManualCanary(
  explicitRoot: string,
  canaryDeps: PmInstalledCanaryDeps = {},
): Promise<PmInstalledCanaryTrace> {
  const root = await fs.realpath(path.resolve(explicitRoot));
  const state = await readJsonIfExists<{ active_goal_id?: string }>(path.join(root, HARNESS_DIR_NAME, "state.json"));
  if (!state?.active_goal_id) throw new Error("pm_canary_active_goal_missing");
  const projectionInput = {
    goal_id: state.active_goal_id,
    producer_slot: PRODUCER_SLOT,
    invocation_key: INVOCATION_KEY,
    brief: BRIEF,
    candidates: [CANDIDATE],
    observed_provenance: [{ run_id: PREPARE_RUN_ID, session_id: PREPARE_SESSION_ID }],
  };
  const preparedProjection = projectPmPrepare(projectionInput);
  if (!preparedProjection.annotation) throw new Error("pm_canary_projection_mismatch");
  const projectedAnnotation = localAnnotation(preparedProjection.annotation.candidate_id,
    preparedProjection.annotation.key, preparedProjection.annotation.content);
  const claimedProjection = projectPmPrepare({ ...projectionInput, provider_annotation: projectedAnnotation }).receipt;
  const projectedClaimId = pmWorkerClaimId(state.active_goal_id, claimedProjection, WORKER);
  const projectedRunRoot = pmWorkerRunRoot(root, state.active_goal_id, projectedClaimId);
  const storeSegments = path.relative(root, projectedRunRoot).split(path.sep);

  const annotations = new Map<string, { id: string; issue_id: string; key: string; content: string }>();
  const provider: PmProvider = {
    async listCandidates() {
      return [CANDIDATE];
    },
    async annotate(issueId, key, content) {
      const row = localAnnotation(issueId, key, content);
      const prior = annotations.get(key);
      if (prior && JSON.stringify(prior) !== JSON.stringify(row)) throw new Error("pm_canary_annotation_conflict");
      annotations.set(key, row);
      return row;
    },
    async readAnnotation(issueId, key, content) {
      const row = annotations.get(key);
      return row?.issue_id === issueId && row.content === content ? row : undefined;
    },
    async readTicketProof(ticketId) {
      return { ticket_id: ticketId, configured_parent_id: PARENT_ID, parent_id: PARENT_ID, status: "in_review",
        content_strings: ["Installed manual PM evidence canary", "The installed manual acceptance passes."],
        evidence_reference_ids: [...annotations.values()].filter((row) => row.issue_id === ticketId).map((row) => row.id).sort(),
        readback_at: "2026-07-16T17:00:00.000Z" };
    },
  };
  const proof: CanonicalContinuationVerdict = {
    verdict: "PASS", reasons: [], proof_id: sha("p5e-local-phase4-proof"), surface: "ticket-completion",
  };
  const binding = { schema_version: 1 as const, goal_id: state.active_goal_id, credential_mode: "profile" as const,
    profile: "local-only", server_origin: "http://localhost:3000", workspace_id: WORKSPACE_ID, parent_id: PARENT_ID,
    parent_identifier: "P5E-LOCAL", project_source: "parent" as const, issue_prefix: "P5E",
    verified_at: "2026-07-16T00:00:00.000Z" };
  const actorRecords = new Map<string, TrustedPmActorOriginReadback>();
  const recordKey = (selector: PmActorOriginSelector) => `${selector.origin_id}\0${selector.record_id}`;
  const registerActors = (handoff: PmHandoffReceipt, review?: PmReviewReceipt) => {
    actorRecords.set(recordKey(WORKER_ORIGIN), manualActorRecord({ selector: WORKER_ORIGIN, role: "worker", identity: WORKER,
      goalId: handoff.goal_id, ticketId: handoff.claim.ticket_id, prepareReceiptId: handoff.prepare_receipt_id,
      claimId: handoff.claim.claim_id, payload: handoff.worker_payload }));
    if (review) actorRecords.set(recordKey(REVIEWER_ORIGIN), manualActorRecord({ selector: REVIEWER_ORIGIN, role: "reviewer", identity: REVIEWER,
      goalId: handoff.goal_id, ticketId: handoff.claim.ticket_id, prepareReceiptId: handoff.prepare_receipt_id,
      claimId: handoff.claim.claim_id, payload: review.review_payload }));
  };
  const deps = { binding, provider, loadContinuationClosureVerdict: async () => proof,
    readActorOrigin: async (selector: PmActorOriginSelector) => actorRecords.get(recordKey(selector)),
    allowManualLocalDouble: true };
  const statusBase = { workspace_id: WORKSPACE_ID, parent_id: PARENT_ID,
    producer_slot: PRODUCER_SLOT, invocation_key: INVOCATION_KEY, claim_id: projectedClaimId };
  const commandTrace = async (
    execution: PinnedPmExecution,
    report: PmInstalledCanaryReport,
  ): Promise<PmInstalledCanaryTrace["commands"]> => {
    const transactionRoot = execution.resolved.root;
    const prepare = await readPmPrepareReceipt(transactionRoot, state.active_goal_id!, PRODUCER_SLOT, INVOCATION_KEY, execution);
    const handoff = await readPmHandoffReceipt(transactionRoot, state.active_goal_id!, report.claim_id, execution);
    const review = await readPmReviewReceipt(transactionRoot, state.active_goal_id!, report.claim_id, execution);
    if (!prepare?.provider_annotation || !handoff || !review) throw new Error("pm_canary_receipt_readback_failed");
    registerActors(handoff, review);
    annotations.set(prepare.provider_annotation.key, prepare.provider_annotation);
    const status = await statusPm({ cwd: transactionRoot, ...statusBase, evidence_requirement: "natural", record_gap: true },
      { ...deps, executionStore: execution });
    if (status.phase5_gate?.verdict !== "PARTIAL" || status.evidence.gap_receipt?.receipt_id !== report.receipt_ids.gap) {
      throw new Error("pm_canary_receipt_readback_failed");
    }
    return { prepare, handoff, review, status };
  };
  return persistPinnedLocalArtifacts(root, storeSegments,
    [...ARTIFACT_CONTENT].map(([name, content]) => ({ name, content })), async (execution) => {
      if (!execution) throw new Error("pm_canary_artifact_unsupported");
      const transactionRoot = execution.resolved.root;
      const afterPhase = async (phase: "prepare" | "handoff" | "review" | "status") => {
        try { await canaryDeps.artifactStore?.afterPmPhase?.(phase); }
        catch { throw new Error("pm_canary_artifact_unsafe"); }
      };
      const replay = await existingReport(transactionRoot, state.active_goal_id!, projectedClaimId, execution);
      if (replay) {
        if (replay.claim_id !== projectedClaimId) throw new Error("pm_canary_projection_mismatch");
        return { schema_version: 3 as const, commands: await commandTrace(execution, replay), report: replay };
      }
      const prepared = await preparePm({ cwd: transactionRoot, producer_slot: PRODUCER_SLOT, invocation_key: INVOCATION_KEY,
        run_id: PREPARE_RUN_ID, session_id: PREPARE_SESSION_ID, brief: BRIEF }, { provider, executionStore: execution });
      await afterPhase("prepare");
      if (JSON.stringify(prepared) !== JSON.stringify(claimedProjection)) throw new Error("pm_canary_projection_mismatch");
      const claim = { claim_id: pmWorkerClaimId(prepared.goal_id, prepared, WORKER), ticket_id: CANDIDATE.id,
        provider_annotation_id: prepared.provider_annotation!.id };
      const runRoot = pmWorkerRunRoot(transactionRoot, prepared.goal_id, claim.claim_id);
      if (claim.claim_id !== projectedClaimId) throw new Error("pm_canary_projection_mismatch");
      const workerPayload = pmWorkerActorPayload({ goal_id: prepared.goal_id, parent_id: PARENT_ID,
        ticket_id: claim.ticket_id, prepare_receipt_id: prepared.receipt_id, claim_id: claim.claim_id,
        producer_slot: PRODUCER_SLOT, invocation_key: INVOCATION_KEY, outcome: "completed",
        manifest: EXPECTED_ARTIFACT_MANIFEST, handoff: HANDOFF });
      const workerRecord = manualActorRecord({ selector: WORKER_ORIGIN, role: "worker", identity: WORKER,
        goalId: prepared.goal_id, ticketId: claim.ticket_id, prepareReceiptId: prepared.receipt_id,
        claimId: claim.claim_id, payload: workerPayload });
      actorRecords.set(recordKey(WORKER_ORIGIN), workerRecord);
      const handoff = await handoffPm({ cwd: transactionRoot, producer_slot: PRODUCER_SLOT, invocation_key: INVOCATION_KEY,
        prepare_receipt_id: prepared.receipt_id, claim, worker_origin: WORKER_ORIGIN,
        artifacts: ARTIFACTS, outcome: "completed", handoff: HANDOFF },
      { ...deps, expectedArtifactManifest: EXPECTED_ARTIFACT_MANIFEST, executionStore: execution });
      await afterPhase("handoff");
      const ticketProof = await provider.readTicketProof!(claim.ticket_id);
      if (!ticketProof) throw new Error("pm_canary_projection_mismatch");
      const reviewPayload = pmReviewerActorPayload({ goal_id: prepared.goal_id, parent_id: PARENT_ID,
        ticket_id: claim.ticket_id, prepare_receipt_id: prepared.receipt_id, claim_id: claim.claim_id,
        handoff_receipt_id: handoff.receipt_id, worker_record_sha256: workerRecord.record_sha256,
        manifest: handoff.manifest, ticket_proof: ticketProof, phase4_proof: PHASE4_PROOF, phase4: proof,
        verdict: "PASS", findings: [] });
      actorRecords.set(recordKey(REVIEWER_ORIGIN), manualActorRecord({ selector: REVIEWER_ORIGIN, role: "reviewer", identity: REVIEWER,
        goalId: prepared.goal_id, ticketId: claim.ticket_id, prepareReceiptId: prepared.receipt_id,
        claimId: claim.claim_id, payload: reviewPayload }));
      const review = await reviewPm({ cwd: transactionRoot, producer_slot: PRODUCER_SLOT, invocation_key: INVOCATION_KEY,
        prepare_receipt_id: prepared.receipt_id, claim_id: claim.claim_id,
        reviewer_origin: REVIEWER_ORIGIN, phase4_proof: PHASE4_PROOF,
        verdict: "PASS", findings: [] }, { ...deps, executionStore: execution });
      await afterPhase("review");
      const manual = await statusPm({ cwd: transactionRoot, ...statusBase, evidence_requirement: "manual", record_gap: false },
        { ...deps, executionStore: execution });
      const partial = await statusPm({ cwd: transactionRoot, ...statusBase, evidence_requirement: "natural", record_gap: true },
        { ...deps, executionStore: execution });
      await afterPhase("status");
      if (manual.evidence.classification !== "manual" || partial.phase5_gate?.verdict !== "PARTIAL" || !partial.evidence.gap_receipt) {
        throw new Error("pm_canary_evidence_invalid");
      }
      const receiptIds = { prepare: prepared.receipt_id, handoff: handoff.receipt_id, review: review.receipt_id,
        gap: partial.evidence.gap_receipt.receipt_id };
      const report = await storeReport(transactionRoot, { schema_version: 3, goal_id: prepared.goal_id, verdict: "PARTIAL",
        reason_code: "PM_NATURAL_EVIDENCE_MISSING", evidence_class: "manual_local_provider",
        provider: "deterministic_local_double", claim_id: claim.claim_id,
        receipt_ids: receiptIds, evidence_ids: Object.values(receiptIds).sort(),
        safety: { provider_lifecycle_mutations: 0, schedule_mutations: 0, deliveries: 0 } }, execution);
      return { schema_version: 3 as const, commands: { prepare: prepared, handoff, review, status: partial }, report };
    }, canaryDeps.artifactStore, { goalId: state.active_goal_id, claimId: projectedClaimId }, async (execution, result) => {
      const committed = await readReport(execution.resolved.root, result.report.report_id, execution);
      if (!committed || JSON.stringify(committed) !== JSON.stringify(result.report)) {
        throw new Error("pm_canary_report_readback_failed");
      }
      const authenticated = await existingReport(execution.resolved.root, state.active_goal_id!, projectedClaimId, execution);
      if (!authenticated || JSON.stringify(authenticated) !== JSON.stringify(committed)) {
        throw new Error("pm_canary_receipt_readback_failed");
      }
      return { schema_version: 3 as const, commands: await commandTrace(execution, authenticated), report: authenticated };
    });
}

/** Return the four successful shared-function results plus the durable manual/local PARTIAL report. */
export async function runPmInstalledManualCanaryTrace(
  explicitRoot: string,
  canaryDeps: PmInstalledCanaryDeps = {},
): Promise<PmInstalledCanaryTrace> {
  return executePmInstalledManualCanary(explicitRoot, canaryDeps);
}

/** Backward-compatible report-only API for callers that do not need operator parity evidence. */
export async function runPmInstalledManualCanary(
  explicitRoot: string,
  canaryDeps: PmInstalledCanaryDeps = {},
): Promise<PmInstalledCanaryReport> {
  return (await executePmInstalledManualCanary(explicitRoot, canaryDeps)).report;
}

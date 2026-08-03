import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import {
  apply,
  canonicalStrategicActionIdentity,
  STRATEGIC_ACTION_SELECTOR_OPERATIONS,
  withStrategicActionTestDependencies,
  type StrategicActionRequest,
  type StrategicActionResult,
  type StrategicActionSuccess,
} from "./strategic-action.js";
import {
  promote,
  canonicalKnowledgePromotionIdentity,
  withKnowledgePromotionTestDependencies,
  type KnowledgePromotionRequest,
  type KnowledgePromotionResult,
  type KnowledgePromotionSuccess,
} from "./knowledge-promotion.js";
import {
  review,
  withStrategicReviewTestDependencies,
  type StrategicReviewNormalSuccess,
  type StrategicReviewRequest,
  type StrategicReviewResult,
  type StrategicReviewSnapshotSuccess,
} from "./strategic-review.js";
import { sourcePluginRoot } from "./strategic-installed-parity.js";
import type { StrategicTicketCapability, StrategicTicketRead } from "../tickets/provider.js";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

const PROFILE_FIXTURES = [
  "pm-normal.json",
  "nightly-workspace-normal.json",
  "operations-normal.json",
  "optional-domain-normal.json",
] as const;

const ReportCoreSchema = z.object({
  schema_version: z.literal(1),
  report_id: z.string().regex(/^p6d-[0-9a-f]{32}$/),
  goal_id: z.string().min(1),
  verdict: z.literal("PARTIAL"),
  reason_code: z.literal("STRATEGIC_NATURAL_EVIDENCE_MISSING"),
  evidence_class: z.literal("manual_local_provider"),
  provider: z.literal("deterministic_local_double"),
  natural_schedule: z.literal(false),
  profiles: z.array(z.string().min(1)).length(4),
  bounded_snapshot: z.object({
    report_id: z.string().min(1),
    mutation_count: z.literal(0),
  }).strict(),
  loop: z.object({
    evaluate_report_id: z.string().min(1),
    ticket_receipt_id: z.string().min(1),
    ticket_id: z.string().min(1),
    pause_receipt_id: z.string().min(1),
    rollback_receipt_id: z.string().min(1),
    promotion_receipt_id: z.string().min(1),
    promotion_ticket_id: z.string().min(1),
  }).strict(),
  honest_stop: z.object({
    status: z.enum(["PARTIAL", "BLOCKED"]),
    reason: z.string().min(1),
  }).strict(),
  replay: z.object({
    ticket_receipt_id: z.string().min(1),
    promotion_receipt_id: z.string().min(1),
    duplicate_mutation: z.literal(false),
    duplicate_knowledge_event: z.literal(false),
  }).strict(),
  safety: z.object({
    provider_lifecycle_mutations: z.literal(0),
    schedule_mutations: z.literal(0),
    deliveries: z.literal(0),
    merge: z.literal(0),
    push: z.literal(0),
    commit: z.literal(0),
    history_mutation: z.literal(0),
  }).strict(),
}).strict();

const ReportIdentitySchema = ReportCoreSchema.omit({ report_id: true });
const ReportSchema = ReportCoreSchema.extend({
  protected_state_sha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

export type StrategicInstalledCanaryReport = z.infer<typeof ReportSchema>;

export interface StrategicInstalledCanaryTrace {
  schema_version: 1;
  commands: {
    profiles: Record<string, StrategicReviewNormalSuccess>;
    snapshot: StrategicReviewSnapshotSuccess;
    ticket: StrategicActionSuccess;
    pause: StrategicActionSuccess;
    rollback: StrategicActionSuccess;
    promote: KnowledgePromotionSuccess;
    honest_stop: StrategicActionResult | StrategicReviewResult;
    ticket_replay: StrategicActionSuccess;
    promote_replay: KnowledgePromotionSuccess;
  };
  report: StrategicInstalledCanaryReport;
}

export interface StrategicInstalledCanaryDeps {
  pluginRoot?: string;
  now?: () => string;
}

export function strategicInstalledCanaryReportPath(root: string, reportId: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "strategic", "gates", `${reportId}.json`);
}

async function readReport(root: string, reportId: string): Promise<StrategicInstalledCanaryReport | undefined> {
  const raw = await readJsonIfExists<unknown>(strategicInstalledCanaryReportPath(root, reportId));
  if (!raw || typeof raw !== "object" || (raw as { schema_version?: unknown }).schema_version !== 1) return undefined;
  const parsed = ReportSchema.safeParse(raw);
  if (!parsed.success) throw new Error("strategic_canary_report_invalid");
  const value = parsed.data;
  const { protected_state_sha256, ...core } = value;
  if (protected_state_sha256 !== sha(JSON.stringify(core))) throw new Error("strategic_canary_report_tampered");
  const { report_id: _reportId, ...identity } = core;
  if (reportId !== `p6d-${sha(JSON.stringify(identity)).slice(0, 32)}` || core.report_id !== reportId) {
    throw new Error("strategic_canary_report_identity_invalid");
  }
  return value;
}

async function storeReport(
  root: string,
  coreWithoutId: Omit<StrategicInstalledCanaryReport, "report_id" | "protected_state_sha256">,
): Promise<StrategicInstalledCanaryReport> {
  const identity = ReportIdentitySchema.parse(coreWithoutId);
  const reportId = `p6d-${sha(JSON.stringify(identity)).slice(0, 32)}`;
  const core = ReportCoreSchema.parse({ ...identity, report_id: reportId });
  const report = ReportSchema.parse({ ...core, protected_state_sha256: sha(JSON.stringify(core)) });
  const existing = await readReport(root, reportId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(report)) throw new Error("strategic_canary_report_conflict");
    return existing;
  }
  await writeJsonAtomic(strategicInstalledCanaryReportPath(root, reportId), report);
  const reread = await readReport(root, reportId);
  if (!reread || JSON.stringify(reread) !== JSON.stringify(report)) throw new Error("strategic_canary_report_readback_failed");
  return reread;
}

async function resolvePluginRoot(deps?: StrategicInstalledCanaryDeps): Promise<string> {
  if (deps?.pluginRoot) return deps.pluginRoot;
  const moduleFile = fileURLToPath(import.meta.url);
  let current = path.dirname(moduleFile);
  for (;;) {
    const marker = path.join(current, ".cursor-plugin", "plugin.json");
    try {
      const stat = await fs.lstat(marker);
      if (stat.isFile() && !stat.isSymbolicLink()) return current;
    } catch {
      // continue
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return sourcePluginRoot(import.meta.url);
}

async function loadFixture(pluginRoot: string, name: string): Promise<Record<string, any>> {
  return JSON.parse(await fs.readFile(path.join(pluginRoot, "fixtures", "strategic-review-canary", name), "utf8"));
}

async function createSignedInstallation(
  projectRoot: string,
  pluginRoot: string,
  requests: Record<string, any>[],
): Promise<string> {
  const installationRoot = path.join(projectRoot, HARNESS_DIR_NAME, "autonomy", "strategic", "canary-installation");
  const configRoot = path.join(installationRoot, "config");
  const recordRoot = path.join(installationRoot, "records");
  await fs.rm(installationRoot, { recursive: true, force: true });
  await fs.mkdir(configRoot, { recursive: true });
  await fs.mkdir(recordRoot, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const keyId = "strategic-canary-key";
  const originId = "installed-review-origin";
  const profiles = new Map<string, {
    profile: string;
    domain: string;
    proof: string;
    recurrence_threshold: number;
  }>();
  for (const request of requests) {
    profiles.set(request.profile, {
      profile: request.profile,
      domain: request.authority.domain,
      proof: request.authority.proof,
      recurrence_threshold: 2,
    });
    const recordId = request.evidence_origin.record_id;
    const recordBytes = Buffer.from(JSON.stringify({
      schema_version: 1,
      origin_id: originId,
      record_id: recordId,
      key_id: keyId,
      installation_id: request.authority.installation_id,
      profile: request.profile,
      domain: request.authority.domain,
      evidence: request.evidence,
    }), "utf8");
    await fs.writeFile(path.join(recordRoot, `${recordId}.json`), recordBytes);
    await fs.writeFile(
      path.join(recordRoot, `${recordId}.sig`),
      signBytes(null, recordBytes, privateKey).toString("base64"),
      "utf8",
    );
  }
  await fs.writeFile(path.join(configRoot, "strategic-review-origins.json"), JSON.stringify({
    schema_version: 1,
    origins: [{
      origin_id: originId,
      record_root: recordRoot,
      key_id: keyId,
      public_key_pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      profiles: [...profiles.values()],
    }],
  }), "utf8");
  await fs.cp(
    path.join(pluginRoot, "config", "strategic-review-profiles.json"),
    path.join(configRoot, "strategic-review-profiles.json"),
  );
  return installationRoot;
}

function withMultiActions(request: Record<string, any>, actions: string[]): Record<string, any> {
  const next = structuredClone(request);
  const laneItems = actions.map((action, index) => ({
    finding_id: "triage-root-cause",
    action,
    evidence: ["explicit-feedback"],
    disposition: "TRACKED",
    ticket_id: `P6D-${index + 10}`,
    independent_action: true,
  }));
  next.analysis.lanes.NOW = laneItems;
  next.continuation.response_text = `\`\`\`continuation-ledger\n${JSON.stringify({
    items: laneItems.map((item) => ({
      lane: "NOW",
      action: item.action,
      disposition: item.disposition,
      evidence: "explicit-feedback",
      expected_impact: "The strategic action remains durably dispositioned.",
      cost_class: "no_agent",
      evidence_horizon: "7d",
      ticket_id: item.ticket_id,
    })),
  })}\n\`\`\``;
  next.continuation.tickets = Object.fromEntries(laneItems.map((item) => [item.ticket_id, {
    ticket_id: item.ticket_id,
    configured_parent_id: next.continuation.parent_id,
    parent_id: next.continuation.parent_id,
    status: "todo",
    content_strings: [item.action],
    evidence_reference_ids: ["explicit-feedback"],
    readback_at: "2026-07-18T17:00:00.000Z",
  }]));
  return next;
}

function memoryTickets(): StrategicTicketCapability & {
  store: Map<string, StrategicTicketRead>;
} {
  const store = new Map<string, StrategicTicketRead>();
  return {
    store,
    async search(query) {
      return [...store.values()].filter((ticket) =>
        ticket.root_cause === query.root_cause && ticket.action_identities.includes(query.action_identity));
    },
    async read(id) {
      const ticket = store.get(id);
      return ticket ? structuredClone(ticket) : undefined;
    },
    async create(input) {
      const ticket: StrategicTicketRead = {
        kind: "ticket",
        ticket_id: `CANARY-${store.size + 1}`,
        title: input.title,
        root_cause: input.root_cause,
        action_identities: [input.action_identity],
        owner: null,
        priority: "medium",
        comments: [],
        provider_proof: {
          source: `fixture://ticket/CANARY-${store.size + 1}`,
          digest: sha(input.action_identity).padEnd(64, "0").slice(0, 64),
          read_at: "2026-07-21T17:05:00.000Z",
        },
      };
      store.set(ticket.ticket_id, ticket);
      return structuredClone(ticket);
    },
    async comment(id, content, actionIdentity) {
      const ticket = store.get(id);
      if (!ticket) throw new Error("ticket missing");
      ticket.comments.push({ id: `c-${ticket.comments.length + 1}`, content, action_identity: actionIdentity });
      if (!ticket.action_identities.includes(actionIdentity)) ticket.action_identities.push(actionIdentity);
      store.set(id, ticket);
      return structuredClone(ticket);
    },
    async setPriority(id, priority, actionIdentity) {
      const ticket = store.get(id);
      if (!ticket) throw new Error("ticket missing");
      ticket.priority = priority;
      if (actionIdentity && !ticket.action_identities.includes(actionIdentity)) {
        ticket.action_identities.push(actionIdentity);
      }
      store.set(id, ticket);
      return structuredClone(ticket);
    },
  };
}

async function evaluateProfile(
  cwd: string,
  installationRoot: string,
  request: Record<string, any>,
): Promise<StrategicReviewNormalSuccess> {
  const result = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => review({ cwd, ...request } as StrategicReviewRequest),
  );
  if (!result.ok || result.status !== "PASS") {
    throw new Error(`strategic_canary_profile_failed:${request.profile}:${JSON.stringify(result)}`);
  }
  return result as StrategicReviewNormalSuccess;
}

async function existingReport(root: string, goalId: string): Promise<StrategicInstalledCanaryReport | undefined> {
  const directory = path.join(root, HARNESS_DIR_NAME, "autonomy", "strategic", "gates");
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? [] : Promise.reject(error));
  const reports: StrategicInstalledCanaryReport[] = [];
  for (const name of names.filter((value) => /^p6d-[0-9a-f]{32}\.json$/.test(value)).sort()) {
    const report = await readReport(root, path.basename(name, ".json"));
    if (report?.goal_id === goalId && report.provider === "deterministic_local_double") reports.push(report);
  }
  if (reports.length > 1) throw new Error("strategic_canary_report_conflict");
  return reports[0];
}

export async function runStrategicInstalledManualCanaryTrace(
  root: string,
  deps: StrategicInstalledCanaryDeps = {},
): Promise<StrategicInstalledCanaryTrace> {
  const pluginRoot = await resolvePluginRoot(deps);
  const now = deps.now ?? (() => "2026-07-21T17:00:00.000Z");
  const profileRequests = [];
  for (const name of PROFILE_FIXTURES) {
    profileRequests.push(await loadFixture(pluginRoot, name));
  }
  const goalId = (profileRequests[0]?.goal_id as string | undefined) ?? "goal-phase-6-fixture";
  const existing = await existingReport(root, goalId);
  if (existing) {
    return {
      schema_version: 1,
      commands: {
        profiles: {},
        snapshot: {
          ok: true,
          status: "SNAPSHOT",
          report_id: existing.bounded_snapshot.report_id,
          report_sha256: "0".repeat(64),
          report_bytes: "{}",
          storage_reference: "idempotent-replay",
          report: {
            schema_version: 1,
            mode: "bounded_snapshot",
            profile: "pm-17:00",
            authority: {
              installation_id: "fixture-installation",
              profile: "pm-17:00",
              domain: "product-management",
              proof: "strategic-review/v1/pm-17:00/product-management",
            },
            evidence_class: "FACT",
            producer: { id: "idempotent", slot: "replay" },
            findings: [],
            references: [],
          },
          mutation_count: 0,
        } as unknown as StrategicReviewSnapshotSuccess,
        ticket: {
          ok: true, status: "APPLIED", receipt_id: existing.loop.ticket_receipt_id,
          receipt_sha256: "0".repeat(64), receipt_bytes: "{}", storage_reference: "idempotent-replay",
          receipt: {} as StrategicActionSuccess["receipt"], mutation_count: 0,
        },
        pause: {
          ok: true, status: "APPLIED", receipt_id: existing.loop.pause_receipt_id,
          receipt_sha256: "0".repeat(64), receipt_bytes: "{}", storage_reference: "idempotent-replay",
          receipt: {} as StrategicActionSuccess["receipt"], mutation_count: 0,
        },
        rollback: {
          ok: true, status: "ROLLED_BACK", receipt_id: existing.loop.rollback_receipt_id,
          receipt_sha256: "0".repeat(64), receipt_bytes: "{}", storage_reference: "idempotent-replay",
          receipt: {} as StrategicActionSuccess["receipt"], mutation_count: 0,
        },
        promote: {
          ok: true, status: "PROMOTED", receipt_id: existing.loop.promotion_receipt_id,
          receipt_sha256: "0".repeat(64), receipt_bytes: "{}", storage_reference: "idempotent-replay",
          receipt: {} as KnowledgePromotionSuccess["receipt"], mutation_count: 0,
        },
        honest_stop: {
          ok: false, status: existing.honest_stop.status, reason: existing.honest_stop.reason, mutation_count: 0,
        },
        ticket_replay: {
          ok: true, status: "APPLIED", receipt_id: existing.replay.ticket_receipt_id,
          receipt_sha256: "0".repeat(64), receipt_bytes: "{}", storage_reference: "idempotent-replay",
          receipt: {} as StrategicActionSuccess["receipt"], mutation_count: 0,
        },
        promote_replay: {
          ok: true, status: "PROMOTED", receipt_id: existing.replay.promotion_receipt_id,
          receipt_sha256: "0".repeat(64), receipt_bytes: "{}", storage_reference: "idempotent-replay",
          receipt: {} as KnowledgePromotionSuccess["receipt"], mutation_count: 0,
        },
      },
      report: existing,
    };
  }
  const snapshotRequest = await loadFixture(pluginRoot, "pm-snapshot.json");
  const loopBase = withMultiActions(await loadFixture(pluginRoot, "pm-normal.json"), [
    "Create or reuse the Phase 6 canary triage ticket",
    "Pause the installed PM loop until the unsafe state is corrected",
    "Restore the installed PM loop to its last authenticated safe state",
  ]);
  const installationRoot = await createSignedInstallation(root, pluginRoot, [
    ...profileRequests,
    snapshotRequest,
    loopBase,
  ]);

  const profiles: Record<string, StrategicReviewNormalSuccess> = {};
  for (const request of profileRequests) {
    profiles[request.profile] = await evaluateProfile(root, installationRoot, request);
  }

  const snapshot = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => review({ cwd: root, ...snapshotRequest } as StrategicReviewRequest),
  );
  if (!snapshot.ok || snapshot.status !== "SNAPSHOT" || snapshot.mutation_count !== 0) {
    throw new Error(`strategic_canary_snapshot_failed:${JSON.stringify(snapshot)}`);
  }

  const loopEvaluate = await evaluateProfile(root, installationRoot, loopBase);
  const [ticketLane, pauseLane, rollbackLane] = loopEvaluate.report.lanes.NOW;
  if (!ticketLane || !pauseLane || !rollbackLane) throw new Error("strategic_canary_lanes_missing");

  const tickets = memoryTickets();
  const safeState = {
    kind: "installed_loop" as const,
    loop_id: "pm-17-00-loop",
    profile: loopEvaluate.report.profile,
    paused: false,
    state_version: "state-v1",
    protected_state_digest: "3".repeat(64),
    read_at: now(),
  };
  let liveLoop = structuredClone(safeState);
  const { operation: _operation, ...authenticationRaw } = loopBase;
  const authentication = authenticationRaw as Omit<StrategicReviewRequest, "cwd" | "operation" | "report_id">;
  const authority = {
    installation_id: loopEvaluate.report.authority.installation_id,
    profile: loopEvaluate.report.profile,
    domain: loopEvaluate.report.authority.domain,
    capability_proof: `strategic-action/v1/${loopEvaluate.report.profile}/${loopEvaluate.report.authority.domain}`,
    capabilities: [...STRATEGIC_ACTION_SELECTOR_OPERATIONS],
  };
  const reportAuth = {
    report_id: loopEvaluate.report_id,
    report_sha256: loopEvaluate.report_sha256,
    report_bytes: loopEvaluate.report_bytes,
    authentication,
  };

  const ticketIdentity = canonicalStrategicActionIdentity(
    loopEvaluate.report.profile,
    ticketLane.finding_id,
    ticketLane.action,
  );
  const finding = loopEvaluate.report.findings.find(({ id }) => id === ticketLane.finding_id)!;
  let actionTicket: StrategicTicketRead | undefined;
  const ticketRequest: StrategicActionRequest = {
    cwd: root,
    operation: "apply",
    report: reportAuth,
    authority,
    action_identity: ticketIdentity,
    selector: {
      operation: "ticket_reuse_or_create",
      finding_id: ticketLane.finding_id,
      action: ticketLane.action,
      root_cause: finding.root_cause!,
      evidence_reference_ids: [...ticketLane.evidence],
      owner: null,
      ticket: {
        title: ticketLane.action,
        brief: finding.root_cause!,
        acceptance: [finding.postcondition!],
      },
    },
    expected_before: {
      kind: "ticket_search",
      root_cause: finding.root_cause!,
      action_identity: ticketIdentity,
      owner: null,
      matching_ticket_ids: [],
    },
  };

  const ticketDeps = {
    now,
    ticket: {
      async search() { return actionTicket ? [actionTicket] : []; },
      async read(id: string) {
        return actionTicket?.ticket_id === id ? structuredClone(actionTicket) : tickets.read(id);
      },
      async create(input: Parameters<StrategicTicketCapability["create"]>[0]) {
        actionTicket = await tickets.create(input);
        return structuredClone(actionTicket);
      },
      async comment(id: string, content: string, actionIdentity: string) {
        return tickets.comment(id, content, actionIdentity);
      },
      async setPriority(id: string, priority: "urgent" | "high" | "medium" | "low", actionIdentity?: string) {
        return tickets.setPriority(id, priority, actionIdentity);
      },
    },
    loop: {
      async read(loopId: string) {
        return loopId === liveLoop.loop_id ? structuredClone(liveLoop) : undefined;
      },
      async setPaused(loopId: string, paused: boolean) {
        if (loopId !== liveLoop.loop_id) throw new Error("loop missing");
        liveLoop = paused
          ? {
              ...liveLoop,
              paused: true,
              state_version: "state-v2",
              protected_state_digest: "4".repeat(64),
            }
          : structuredClone(safeState);
      },
    },
  };

  const ticket = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => withStrategicActionTestDependencies(ticketDeps, () => apply(ticketRequest)),
  );
  if (!ticket.ok || ticket.status !== "APPLIED") throw new Error(`strategic_canary_ticket_failed:${JSON.stringify(ticket)}`);

  const pauseIdentity = canonicalStrategicActionIdentity(
    loopEvaluate.report.profile,
    pauseLane.finding_id,
    pauseLane.action,
  );
  const pauseRequest: StrategicActionRequest = {
    cwd: root,
    operation: "apply",
    report: reportAuth,
    authority,
    action_identity: pauseIdentity,
    selector: {
      operation: "installed_loop_pause",
      finding_id: pauseLane.finding_id,
      action: pauseLane.action,
      evidence_reference_ids: [...pauseLane.evidence],
      loop_id: safeState.loop_id,
      reason: "Unsafe recurrent state requires a bounded pause.",
    },
    expected_before: structuredClone(safeState),
  };
  const pause = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => withStrategicActionTestDependencies(ticketDeps, () => apply(pauseRequest)),
  );
  if (!pause.ok || pause.status !== "APPLIED") throw new Error(`strategic_canary_pause_failed:${JSON.stringify(pause)}`);

  const rollbackIdentity = canonicalStrategicActionIdentity(
    loopEvaluate.report.profile,
    rollbackLane.finding_id,
    rollbackLane.action,
  );
  const rollbackRequest: StrategicActionRequest = {
    cwd: root,
    operation: "apply",
    report: reportAuth,
    authority,
    action_identity: rollbackIdentity,
    selector: {
      operation: "rollback",
      finding_id: rollbackLane.finding_id,
      action: rollbackLane.action,
      evidence_reference_ids: [...rollbackLane.evidence],
      target_receipt_id: pause.receipt_id,
    },
    expected_before: structuredClone(liveLoop),
  };
  const rollback = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => withStrategicActionTestDependencies(ticketDeps, () => apply(rollbackRequest)),
  );
  if (!rollback.ok || rollback.status !== "ROLLED_BACK") {
    throw new Error(`strategic_canary_rollback_failed:${JSON.stringify(rollback)}`);
  }

  const promotionTicket = await tickets.create({
    title: "Promote reusable Phase 6 canary lesson",
    brief: "Curate the verified reusable lesson from accepted action evidence into the knowledge base.",
    acceptance: ["Raw immutable", "Curated page linked", "Index/log updated"],
    root_cause: "Reusable lesson from accepted action is not yet curated.",
    action_identity: ticketIdentity,
    owner: null,
  });
  await tickets.comment(promotionTicket.ticket_id, `promotion-of:${ticket.receipt_id}`, ticketIdentity);

  const pageId = "phase-6-canary-triage-lesson";
  const rawBytes = "Verified reusable lesson: bind explicit feedback evidence to daily triage control before disposition.";
  const promotionRequest: KnowledgePromotionRequest = {
    cwd: root,
    operation: "promote",
    promotion_identity: canonicalKnowledgePromotionIdentity({
      ticket_id: promotionTicket.ticket_id,
      action_receipt_id: ticket.receipt_id,
      page_id: pageId,
      raw_body_sha256: sha(rawBytes),
    }),
    worker: {
      worker_id: "later-worker-promoter",
      authenticated_at: "2026-07-21T18:00:00.000Z",
      proof: `knowledge-promotion/v1/${loopBase.profile}/${loopBase.authority.domain}`,
    },
    ticket: {
      ticket_id: promotionTicket.ticket_id,
      linked_action_receipt_id: ticket.receipt_id,
      linked_action_identity: ticket.receipt.action_identity,
    },
    report: reportAuth,
    action: {
      receipt_id: ticket.receipt_id,
      receipt_sha256: ticket.receipt_sha256,
      receipt_bytes: ticket.receipt_bytes,
      action_identity: ticket.receipt.action_identity,
    },
    producer: {
      worker_id: loopBase.producer.id,
      finalized_at: ticket.receipt.timestamps.finalized_at,
    },
    raw: {
      bytes: rawBytes,
      provenance: {
        origin: "accepted-action-lesson",
        source_uri: `ticket://${promotionTicket.ticket_id}`,
        content_type: "article",
        type_metadata: { kind: "reusable_lesson" },
      },
      classification: "reusable_lesson",
    },
    lesson: {
      page_id: pageId,
      title: "Phase 6 canary triage lesson",
      type: "concept",
      tags: ["workflow", "triage", "learning"],
      body: "Bind explicit feedback evidence to the daily triage control before disposition. Supported by accepted action evidence.",
      confidence: "high",
      contradictions: [],
      related_page_ids: ["llm-knowledge-bases", "knowledge-ingestion"],
      search_query: "phase 6 canary triage",
      evidence_reference_ids: [...ticket.receipt.provenance.evidence_reference_ids],
    },
  };

  const promoteResult = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => withKnowledgePromotionTestDependencies({
      ticket: tickets,
      now: () => "2026-07-21T18:00:00.000Z",
    }, () => promote(promotionRequest)),
  );
  if (!promoteResult.ok || promoteResult.status !== "PROMOTED") {
    throw new Error(`strategic_canary_promote_failed:${JSON.stringify(promoteResult)}`);
  }

  const honestStopRequest: StrategicActionRequest = {
    ...structuredClone(ticketRequest),
    authority: {
      ...authority,
      capability_proof: "strategic-action/v1/pm-17:00/unauthorized-expansion",
    },
  };
  const honestStop = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => withStrategicActionTestDependencies(ticketDeps, () => apply(honestStopRequest)),
  );
  if (honestStop.ok || (honestStop.status !== "BLOCKED" && honestStop.status !== "PARTIAL")) {
    throw new Error(`strategic_canary_honest_stop_failed:${JSON.stringify(honestStop)}`);
  }

  const ticketReplay = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => withStrategicActionTestDependencies(ticketDeps, () => apply(structuredClone(ticketRequest))),
  );
  if (!ticketReplay.ok || ticketReplay.mutation_count !== 0 || ticketReplay.receipt_id !== ticket.receipt_id) {
    throw new Error(`strategic_canary_ticket_replay_failed:${JSON.stringify(ticketReplay)}`);
  }

  const promoteReplay = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => withKnowledgePromotionTestDependencies({
      ticket: tickets,
      now: () => "2026-07-21T18:00:00.000Z",
    }, () => promote(structuredClone(promotionRequest))),
  );
  if (!promoteReplay.ok || promoteReplay.mutation_count !== 0 || promoteReplay.receipt_id !== promoteResult.receipt_id) {
    throw new Error(`strategic_canary_promote_replay_failed:${JSON.stringify(promoteReplay)}`);
  }

  const report = await storeReport(root, {
    schema_version: 1,
    goal_id: loopBase.goal_id ?? "goal-phase-6-fixture",
    verdict: "PARTIAL",
    reason_code: "STRATEGIC_NATURAL_EVIDENCE_MISSING",
    evidence_class: "manual_local_provider",
    provider: "deterministic_local_double",
    natural_schedule: false,
    profiles: profileRequests.map((request) => request.profile as string),
    bounded_snapshot: {
      report_id: snapshot.report_id,
      mutation_count: 0,
    },
    loop: {
      evaluate_report_id: loopEvaluate.report_id,
      ticket_receipt_id: ticket.receipt_id,
      ticket_id: ticket.receipt.after.kind === "ticket" ? ticket.receipt.after.ticket_id : "missing",
      pause_receipt_id: pause.receipt_id,
      rollback_receipt_id: rollback.receipt_id,
      promotion_receipt_id: promoteResult.receipt_id,
      promotion_ticket_id: promotionTicket.ticket_id,
    },
    honest_stop: {
      status: honestStop.status === "PARTIAL" || honestStop.status === "BLOCKED" ? honestStop.status : "BLOCKED",
      reason: "ok" in honestStop && honestStop.ok === false ? honestStop.reason : "ACTION_NOT_AUTHORIZED",
    },
    replay: {
      ticket_receipt_id: ticketReplay.receipt_id,
      promotion_receipt_id: promoteReplay.receipt_id,
      duplicate_mutation: false,
      duplicate_knowledge_event: false,
    },
    safety: {
      provider_lifecycle_mutations: 0,
      schedule_mutations: 0,
      deliveries: 0,
      merge: 0,
      push: 0,
      commit: 0,
      history_mutation: 0,
    },
  });

  return {
    schema_version: 1,
    commands: {
      profiles,
      snapshot,
      ticket,
      pause,
      rollback,
      promote: promoteResult,
      honest_stop: honestStop,
      ticket_replay: ticketReplay,
      promote_replay: promoteReplay,
    },
    report,
  };
}

export async function runStrategicInstalledManualCanary(
  root: string,
  deps: StrategicInstalledCanaryDeps = {},
): Promise<StrategicInstalledCanaryReport> {
  const trace = await runStrategicInstalledManualCanaryTrace(root, deps);
  return trace.report;
}

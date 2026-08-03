import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type CoordinationDeps,
  type EnsureContinuationInput,
  type VerifiedContinuation,
  CoordinationError,
  ensureContinuation,
} from "../autonomy/coordination.js";
import {
  buildFollowUpRequest,
  type DeedHandlerDeps,
  parseExplicitFollowUps,
  persistStopFollowUps,
  recordVerifiedContinuations,
} from "../autonomy/deeds.js";
import type { StateT } from "../schema/state.js";

type RecordLike = Record<string, unknown>;
type HarnessState = StateT | RecordLike | undefined;

export interface StopHookOutput {
  decision: "block";
  reason: string;
  stopReason: string;
  systemMessage: string;
}

const TERMINAL_GOAL_STATUSES = new Set(["done", "abandoned", "cancelled", "complete"]);
const ACTIONABLE_TICKET_STATUSES = new Set(["todo", "pending", "active", "in_progress"]);
const REVIEW_TICKET_STATUSES = new Set(["in_review", "in-review"]);

function record(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordsOf(value: unknown): RecordLike[] { return Object.values(record(value) ?? {}).map(record).filter((item): item is RecordLike => !!item); }

function goalOf(state: HarnessState): RecordLike | undefined {
  const raw = record(state);
  const goals = record(raw?.goals);
  if (!goals) return undefined;
  const id = text(raw?.active_goal_id);
  const selected = id ? record(goals[id]) : undefined;
  if (selected) return selected;
  return recordsOf(goals).find((goal) => ["planning", "active", "verifying", "blocked", "draft"].includes(text(goal.status) ?? ""));
}

function activeGoal(state: HarnessState): RecordLike | undefined {
  const goal = goalOf(state);
  if (!goal) return undefined;
  const status = text(goal.status);
  return status && !TERMINAL_GOAL_STATUSES.has(status) ? goal : undefined;
}

function goalId(state: HarnessState, goal: RecordLike): string | undefined {
  const raw = record(state);
  return text(goal.id) ?? text(raw?.active_goal_id);
}

function ticketsForGoal(state: HarnessState, goal: RecordLike): RecordLike[] {
  const raw = record(state) ?? {};
  const id = goalId(state, goal);
  const tickets = record(raw.local_tickets) ?? record(raw.tickets) ?? record(raw.tasks) ?? {};
  const phases = record(raw.phases) ?? {};
  return recordsOf(tickets)
    .filter((ticket) => {
      if (id && text(ticket.goal_id) === id) return true;
      const phaseId = text(ticket.phase_id);
      return !!id && !!phaseId && text(record(phases[phaseId])?.goal_id) === id;
    })
    .sort((a, b) => (typeof a.order === "number" ? a.order : 999) - (typeof b.order === "number" ? b.order : 999));
}

function trackerUnavailable(state: HarnessState, goal: RecordLike): boolean {
  const raw = record(state) ?? {};
  const backend = record(goal.backend) ?? record(goal.ticket_backend) ?? record(raw.ticket_backend);
  const cache = record(raw.tracker_cache) ?? record(raw.ticket_cache);
  return backend?.available === false
    || backend?.outage === true
    || ((backend?.kind === "github" || backend?.kind === "multica") && !text(backend.last_verified_at))
    || cache?.available === false
    || cache?.outage === true
    || goal.tracker_unavailable === true;
}

function waitingForHumanOrExternal(goal: RecordLike): boolean {
  const values = [goal.wait_reason, goal.waiting_for, goal.wait_state, goal.pause_reason]
    .map(text)
    .filter((value): value is string => !!value)
    .join(" ")
    .toLowerCase();
  return /human|external|user|approval|manual|dependency/.test(values)
    || goal.waiting === true;
}

function ticketNeedsAttention(state: HarnessState, ticket: RecordLike): boolean {
  const status = text(ticket.status) ?? "todo";
  if (ACTIONABLE_TICKET_STATUSES.has(status) || REVIEW_TICKET_STATUSES.has(status)) return true;
  if (status !== "done") return false;
  // A completed code ticket without an evidence pointer is not trustworthy.
  if (ticket.code_changed !== true) return false;
  const raw = record(state) ?? {};
  const evidence = record(raw.evidence) ?? record(raw.evidence_pointers) ?? {};
  const id = text(ticket.id);
  return !recordsOf(evidence).some((item) => text(item.ticket_id) === id && item.outcome === "pass");
}

function firstAttentionTicket(state: HarnessState, goal: RecordLike): RecordLike | undefined {
  return ticketsForGoal(state, goal).find((ticket) => ticketNeedsAttention(state, ticket));
}

function normalizeStopReasonPart(value: string | undefined): string {
  return (value ?? "ticket").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "ticket";
}

/**
 * Stop is a safety net, not a workflow engine. Standard goals are advisory
 * (the host receives no block decision); only explicitly enforced high goals
 * can block, and only while actionable/unverified work remains.
 */
export function buildStopHookOutput(state: HarnessState): StopHookOutput | null {
  const goal = activeGoal(state);
  if (!goal) return null;
  if (text(goal.assurance) !== "high" || goal.stop_enforcement !== true) return null;
  if (text(goal.status) === "blocked" || waitingForHumanOrExternal(goal) || trackerUnavailable(state, goal)) return null;

  const ticket = firstAttentionTicket(state, goal);
  if (!ticket) return null;

  const title = text(goal.title) ?? "active goal";
  const label = text(ticket.title) ?? text(ticket.id) ?? "next ticket";
  const command = REVIEW_TICKET_STATUSES.has(text(ticket.status) ?? "")
    ? `ycm-harness verify verdict ${text(ticket.id) ?? "<ticket-id>"}`
    : `ycm-harness ticket start ${text(ticket.id) ?? "<ticket-id>"}`;
  const systemMessage = `High-assurance goal '${title}' still has unverified work: '${label}'. ${command} before stopping.`;
  return {
    decision: "block",
    reason: systemMessage,
    stopReason: `cursor_harness_${normalizeStopReasonPart(text(ticket.status))}`,
    systemMessage,
  };
}

const StopPayloadSchema = z.object({
  session_id: z.string().min(1).max(256),
  turn_id: z.string().min(1).max(256).optional(),
  cwd: z.string().min(1).max(4096),
  hook_event_name: z.literal("Stop"),
  model: z.string().min(1).max(256).optional(),
  stop_hook_active: z.boolean().optional(),
  last_assistant_message: z.string().max(64 * 1024),
}).passthrough();

export type StopPayload = z.infer<typeof StopPayloadSchema>;

export function validateStopPayload(rawPayload: unknown): StopPayload {
  const parsed = StopPayloadSchema.safeParse(rawPayload);
  if (!parsed.success) throw new Error("invalid_stop_payload");
  return parsed.data;
}

export interface StopDispatcherDeps extends DeedHandlerDeps {
  ensure?: (input: EnsureContinuationInput, deps?: CoordinationDeps) => Promise<VerifiedContinuation | undefined>;
  persist?: typeof persistStopFollowUps;
  record?: typeof recordVerifiedContinuations;
}

function followUpBlock(code: string): StopHookOutput {
  const safe = code.toLowerCase().replace(/[^a-z0-9_]+/g, "_").slice(0, 80) || "failed";
  const systemMessage = `Explicit follow-up persistence is incomplete (${safe}); resolve durable coordination before stopping.`;
  return { decision: "block", reason: systemMessage, stopReason: `cursor_harness_follow_up_${safe}`, systemMessage };
}

/** Persist explicit follow-ups, ensure verified children, then compose ordinary Stop behavior. */
export async function dispatchStopHook(
  rawPayload: unknown,
  state: StateT | RecordLike | undefined,
  deps: StopDispatcherDeps = {},
): Promise<StopHookOutput | null> {
  const payload = validateStopPayload(rawPayload);
  if (!state || !activeGoal(state)) return buildStopHookOutput(state);
  const items = parseExplicitFollowUps(payload.last_assistant_message);
  if (!items.length) return buildStopHookOutput(state);
  const turnId = payload.turn_id ?? `stop-${createHash("sha256").update(items.map((item) => item.toLowerCase()).join("\n"), "utf8").digest("hex")}`;
  try {
    await (deps.persist ?? persistStopFollowUps)({ cwd: payload.cwd, sessionId: payload.session_id, turnId, items }, deps);
    const verified: VerifiedContinuation[] = [];
    for (const item of items) {
      const result = await (deps.ensure ?? ensureContinuation)({ cwd: payload.cwd, metadataPolicy: "optional", request: buildFollowUpRequest(item) }, deps);
      if (!result) return followUpBlock("binding_missing");
      verified.push(result);
    }
    await (deps.record ?? recordVerifiedContinuations)({
      cwd: payload.cwd,
      sessionId: payload.session_id,
      turnId,
      references: verified.map((item) => item.identifier),
    }, deps);
  } catch (error) {
    return followUpBlock(error instanceof CoordinationError ? error.code : error instanceof Error ? error.message : "failed");
  }
  return buildStopHookOutput(state);
}

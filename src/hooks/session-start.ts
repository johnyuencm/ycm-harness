import type { StateT } from "../schema/state.js";
import type { UserHarnessStateT } from "../schema/user-state.js";

/**
 * The session hook is deliberately a resume card, not a workflow transcript.
 * Keep this shape tolerant of both the V2 migration bridge and State V3 so the
 * hook does not become coupled to the storage implementation.
 */
export interface SessionDigest {
  has_state: boolean;
  active: boolean;
  goal_title?: string;
  goal_status?: string;
  assurance?: string;
  active_ticket?: string;
  ticket_status?: string;
  pending_tickets: string[];
  blocker?: string;
  recent_decisions: string[];
  recent_wiki_refs: string[];
  tracker_status?: "live" | "stale" | "unavailable";
  next_action: string;
  next_command?: string;

  // V2 aliases kept for consumers that read the digest directly during 0.3.
  phase_kind?: string;
  phase_status?: string;
  task_title?: string;
  task_status?: string;
  pending_tasks: string[];
  recent_checkpoints: string[];
  artifact_kinds: string[];
}

export interface NudgeDigest { due: boolean; count: number; threshold: number; }

export interface SessionDigestInputs {
  /** Accepted for the 0.2 bridge; periodic wiki nudges are intentionally ignored. */
  userState?: UserHarnessStateT | undefined;
  nudge?: NudgeDigest;
}

type RecordLike = Record<string, unknown>;
type StateLike = RecordLike & { goals?: Record<string, RecordLike> };
type HarnessState = StateT | RecordLike | undefined;

const ACTIVE_GOAL_STATUSES = new Set(["draft", "planning", "active", "verifying", "blocked"]);
const TERMINAL_GOAL_STATUSES = new Set(["done", "abandoned", "cancelled", "complete"]);
const ACTIVE_TICKET_STATUSES = new Set(["active", "in_progress", "in-review", "in_review"]);
const OPEN_TICKET_STATUSES = new Set(["todo", "pending", "active", "in_progress", "in-review", "in_review", "blocked"]);

function asRecord(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function recordsOf(value: unknown): RecordLike[] { return Object.values(asRecord(value) ?? {}).map(asRecord).filter((item): item is RecordLike => !!item); }

function stateRecord(state: unknown): StateLike | undefined {
  return asRecord(state) as StateLike | undefined;
}

function activeGoalOf(state: StateLike): RecordLike | undefined {
  const goals = asRecord(state.goals);
  const id = text(state.active_goal_id);
  const selected = id && goals ? asRecord(goals[id]) : undefined;
  if (selected) return selected;
  // V3 keeps one active goal id. This fallback only helps malformed/hand-made
  // hook fixtures and never changes persisted state.
  return goals
    ? recordsOf(goals).find((candidate) => ACTIVE_GOAL_STATUSES.has(text(candidate.status) ?? ""))
    : undefined;
}

function goalId(state: StateLike, goal: RecordLike): string | undefined {
  return text(goal.id) ?? text(state.active_goal_id);
}

function isActiveGoal(goal: RecordLike | undefined): boolean {
  if (!goal) return false;
  const status = text(goal.status);
  return !!status && ACTIVE_GOAL_STATUSES.has(status) && !TERMINAL_GOAL_STATUSES.has(status);
}

function ticketsForGoal(state: StateLike, goal: RecordLike): RecordLike[] {
  const id = goalId(state, goal);
  const source = asRecord(state.local_tickets) ?? asRecord(state.tickets) ?? asRecord(state.tasks) ?? {};
  const phases = asRecord(state.phases) ?? {};
  return recordsOf(source)
    .filter((ticket) => {
      if (id && text(ticket.goal_id) === id) return true;
      // V2 tasks point at phases rather than goals.
      const phaseId = text(ticket.phase_id);
      return !!id && !!phaseId && text(asRecord(phases[phaseId])?.goal_id) === id;
    })
    .sort((a, b) => {
      const ao = typeof a.order === "number" ? a.order : Number.MAX_SAFE_INTEGER;
      const bo = typeof b.order === "number" ? b.order : Number.MAX_SAFE_INTEGER;
      return ao - bo || (text(a.created_at) ?? "").localeCompare(text(b.created_at) ?? "");
    });
}

function ticketLabel(ticket: RecordLike): string {
  return text(ticket.title) ?? text(ticket.brief) ?? text(ticket.id) ?? "(untitled ticket)";
}

function phaseOf(state: StateLike, goal: RecordLike): RecordLike | undefined {
  const phases = asRecord(state.phases) ?? {};
  const goalIdValue = goalId(state, goal);
  return recordsOf(phases)
    .filter((phase) => text(phase.goal_id) === goalIdValue)
    .sort((a, b) => (typeof a.order === "number" ? a.order : 999) - (typeof b.order === "number" ? b.order : 999))
    .find((phase) => text(phase.status) === "active")
    ?? recordsOf(phases).find((phase) => text(phase.goal_id) === goalIdValue);
}

function activeTicketOf(state: StateLike, goal: RecordLike, tickets: RecordLike[]): RecordLike | undefined {
  const requested = text(goal.active_ticket_id) ?? text(goal.active_ticket_ref) ?? text(state.active_ticket_id);
  if (requested) {
    const found = tickets.find((ticket) => text(ticket.id) === requested);
    if (found) return found;
  }
  return tickets.find((ticket) => ACTIVE_TICKET_STATUSES.has(text(ticket.status) ?? ""))
    ?? tickets.find((ticket) => OPEN_TICKET_STATUSES.has(text(ticket.status) ?? ""));
}

function blockerOf(state: StateLike, goal: RecordLike, ticket?: RecordLike): string | undefined {
  const direct = text(goal.blocker) ?? text(goal.blocked_reason) ?? text(ticket?.blocker) ?? text(ticket?.blocked_reason);
  if (direct) return direct;
  const checkpoints = asRecord(state.checkpoints) ?? {};
  const goalIdValue = goalId(state, goal);
  const checkpoint = recordsOf(checkpoints)
    .filter((item) => (!goalIdValue || text(item.goal_id) === goalIdValue) && text(item.kind) === "blocker")
    .sort((a, b) => (text(b.created_at) ?? "").localeCompare(text(a.created_at) ?? ""))[0];
  return text(checkpoint?.notes) ?? text(checkpoint?.title);
}

function trackerStatus(state: StateLike, goal: RecordLike): SessionDigest["tracker_status"] {
  const backend = asRecord(goal.ticket_backend) ?? asRecord(goal.backend) ?? asRecord(state.ticket_backend) ?? {};
  const cache = asRecord(state.tracker_cache) ?? asRecord(state.ticket_cache) ?? {};
  if (backend.available === false || backend.outage === true || cache.available === false || cache.outage === true) {
    return "unavailable";
  }
  if (backend.stale === true || cache.stale === true || backend.live === false || cache.live === false) {
    return "stale";
  }
  if (text(backend.last_verified_at) || text(backend.verified_at) || text(cache.last_verified_at) || text(cache.verified_at)) {
    return "live";
  }
  // Local tickets have no remote freshness requirement.
  const kind = text(backend.kind) ?? text(backend.provider);
  return kind && kind !== "local" ? "stale" : undefined;
}

function decisionsOf(state: StateLike, goal: RecordLike): string[] {
  const goalIdValue = goalId(state, goal);
  const checkpoints = asRecord(state.checkpoints) ?? {};
  const result: string[] = [];
  for (const checkpoint of recordsOf(checkpoints).sort((a, b) => (text(b.created_at) ?? "").localeCompare(text(a.created_at) ?? ""))) {
    if (goalIdValue && text(checkpoint.goal_id) && text(checkpoint.goal_id) !== goalIdValue) continue;
    const values = Array.isArray(checkpoint.decisions) ? checkpoint.decisions : [checkpoint.decision];
    for (const value of values) {
      const item = text(value);
      if (item && !result.includes(item)) result.push(item);
      if (result.length >= 2) return result;
    }
  }
  return result;
}

function wikiRefsOf(state: StateLike, goal: RecordLike): string[] {
  const result: string[] = [];
  const add = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(add);
    else {
      const item = text(value);
      if (item && !result.includes(item)) result.push(item);
    }
  };
  add(goal.wiki_page_ids);
  add(goal.knowledge_page_ids);
  const wiki = asRecord(state.project_wiki) ?? asRecord(state.wiki);
  if (wiki) add(Object.keys(asRecord(wiki.pages) ?? {}).slice(-2));
  return result.slice(0, 2);
}

function nextFor(goal: RecordLike, ticket: RecordLike | undefined, tickets: RecordLike[], blocker?: string): { message: string; command?: string } {
  const title = text(goal.title) ?? "active goal";
  const status = text(goal.status) ?? "active";
  if (status === "blocked" || blocker) return { message: blocker ? `Blocked: ${blocker}` : `Goal '${title}' is blocked.` };
  if (ticket) {
    const ticketStatus = text(ticket.status) ?? "todo";
    const ticketId = text(ticket.id) ?? "<ticket-id>";
    if (ticketStatus === "in_review" || ticketStatus === "in-review") {
      return { message: `Await fresh verification for '${ticketLabel(ticket)}'.`, command: `ycm-harness verify verdict ${ticketId}` };
    }
    if (ACTIVE_TICKET_STATUSES.has(ticketStatus)) {
      return { message: `Continue '${ticketLabel(ticket)}'.`, command: `ycm-harness ticket submit ${ticketId}` };
    }
    return { message: `Start '${ticketLabel(ticket)}'.`, command: `ycm-harness ticket start ${ticketId}` };
  }
  const open = tickets.find((item) => OPEN_TICKET_STATUSES.has(text(item.status) ?? ""));
  if (open) return { message: `Start '${ticketLabel(open)}'.`, command: `ycm-harness ticket start ${text(open.id) ?? "<ticket-id>"}` };
  return { message: `Verify and complete '${title}'.`, command: "ycm-harness goal verify " + (text(goal.id) ?? "<goal-id>") };
}

export function buildSessionDigest(state: unknown, _inputs: SessionDigestInputs = {}): SessionDigest {
  if (!state) {
    return {
      has_state: false,
      active: false,
      pending_tickets: [],
      pending_tasks: [],
      recent_decisions: [],
      recent_wiki_refs: [],
      recent_checkpoints: [],
      artifact_kinds: [],
      next_action: "No harness state.",
    };
  }
  const raw = stateRecord(state);
  if (!raw) {
    return { has_state: true, active: false, pending_tickets: [], pending_tasks: [], recent_decisions: [], recent_wiki_refs: [], recent_checkpoints: [], artifact_kinds: [], next_action: "No active goal." };
  }
  const goal = activeGoalOf(raw);
  if (!goal || !isActiveGoal(goal)) {
    return { has_state: true, active: false, pending_tickets: [], pending_tasks: [], recent_decisions: [], recent_wiki_refs: [], recent_checkpoints: [], artifact_kinds: [], next_action: "No active goal." };
  }
  const tickets = ticketsForGoal(raw, goal);
  const ticket = activeTicketOf(raw, goal, tickets);
  const blocker = blockerOf(raw, goal, ticket);
  const phase = phaseOf(raw, goal);
  const next = nextFor(goal, ticket, tickets, blocker);
  const pending = tickets.filter((item) => OPEN_TICKET_STATUSES.has(text(item.status) ?? ""))
    .slice(0, 3)
    .map((item) => `${ticketLabel(item)} [${text(item.status) ?? "todo"}]`);
  const checkpoints = recordsOf(raw.checkpoints)
    .filter((item) => !goalId(raw, goal) || !text(item.goal_id) || text(item.goal_id) === goalId(raw, goal))
    .sort((a, b) => (text(b.created_at) ?? "").localeCompare(text(a.created_at) ?? ""))
    .slice(0, 2)
    .map((item) => text(item.title) ?? text(item.kind) ?? "checkpoint");
  return {
    has_state: true,
    active: true,
    goal_title: text(goal.title),
    goal_status: text(goal.status),
    assurance: text(goal.assurance) ?? (goal.strict === true ? "high" : "standard"),
    active_ticket: ticket ? ticketLabel(ticket) : undefined,
    ticket_status: text(ticket?.status),
    pending_tickets: pending,
    blocker,
    recent_decisions: decisionsOf(raw, goal),
    recent_wiki_refs: wikiRefsOf(raw, goal),
    tracker_status: trackerStatus(raw, goal),
    next_action: next.message,
    next_command: next.command,
    phase_kind: text(phase?.kind),
    phase_status: text(phase?.status),
    task_title: ticket ? ticketLabel(ticket) : undefined,
    task_status: text(ticket?.status),
    pending_tasks: pending,
    recent_checkpoints: checkpoints,
    artifact_kinds: [],
  };
}

export function renderSessionContext(digest: SessionDigest, scoutContext?: string): string {
  const scout = scoutContext?.trim();
  if (!digest.active) return scout ?? "";
  const lines = ["# ycm-harness", `Goal: ${digest.goal_title ?? "(untitled)"} [${digest.goal_status ?? "active"}, ${digest.assurance ?? "standard"}]`];
  if (digest.active_ticket) lines.push(`Ticket: ${digest.active_ticket} [${digest.ticket_status ?? "todo"}]`);
  if (digest.pending_tickets.length > 1) lines.push(`Frontier: ${digest.pending_tickets.slice(0, 2).join("; ")}`);
  if (digest.blocker) lines.push(`Blocker: ${digest.blocker}`);
  if (digest.tracker_status && digest.tracker_status !== "live") lines.push(`Tracker: ${digest.tracker_status} cache (mutations may be unavailable)`);
  if (digest.recent_decisions.length) lines.push(`Decisions: ${digest.recent_decisions.join("; ")}`);
  if (digest.recent_wiki_refs.length) lines.push(`Wiki: ${digest.recent_wiki_refs.join(", ")}`);
  lines.push(`Next: ${digest.next_action}`);
  if (digest.next_command) lines.push(`Run: ${digest.next_command}`);
  const digestContext = lines.slice(0, 20).join("\n");
  return scout ? `${digestContext}\n${scout}` : digestContext;
}

export type CursorHookOutput = { additional_context?: string };

export function buildHookOutput(digest: SessionDigest, scoutContext?: string): CursorHookOutput {
  const context = renderSessionContext(digest, scoutContext);
  return context ? { additional_context: context } : {};
}

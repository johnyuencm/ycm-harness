import { createHash } from "node:crypto";
import { z } from "zod";
import { MutationProofSchema, type MutationProofRecord } from "../autonomy/mutation-proof.js";
import { SlugId } from "../schema/common.js";

export type ContinuationDisposition = "TRACKED" | "MUTATED" | "MONITORING ONLY";

export type NormalizedContinuationItem = {
  lane: string;
  action: string;
  disposition: string;
  evidence: string;
  expected_impact: string;
  cost_class: string;
  evidence_horizon: string;
  ticket_id?: string;
  mutation_action?: string;
  monitoring_owner?: string;
  monitoring_reference?: string;
  monitoring_reason?: string;
  monitoring_check?: string;
  monitoring_exit?: string;
};

export type ContinuationFinalizerResult = {
  status: "PASS" | "FAIL";
  reasons: string[];
  items: NormalizedContinuationItem[];
};

export const LiveTicketProofSchema = z.object({
  ticket_id: z.string().min(1),
  configured_parent_id: z.string().min(1),
  parent_id: z.string().min(1),
  status: z.enum(["todo", "in_progress", "in_review", "done", "blocked", "cancelled"]),
  content_strings: z.array(z.string()),
  evidence_reference_ids: z.array(z.string()),
  readback_at: z.string().datetime(),
}).strict();

export type LiveTicketProof = z.infer<typeof LiveTicketProofSchema>;
export type MutationProof = MutationProofRecord;

export interface ContinuationLiveProofContext {
  parentId: string;
  runId: string;
  sessionId: string;
}

export interface ContinuationLiveProofDeps {
  readTicket(ticketId: string): Promise<unknown>;
  readMutations(): Promise<unknown>;
}

const LEDGER = /```continuation-ledger[ \t]*\r?\n([\s\S]*?)\r?\n```/gi;
const REQUIRED_FIELDS = ["lane", "action", "disposition", "evidence", "expected_impact", "cost_class", "evidence_horizon"] as const;
const DISPOSITIONS = new Set<ContinuationDisposition>(["TRACKED", "MUTATED", "MONITORING ONLY"]);
const MONITORING_FIELDS = ["monitoring_owner", "monitoring_reference", "monitoring_reason", "monitoring_check", "monitoring_exit"] as const;
const MUTATION_ACTIONS = new Set(["raised", "commented", "advanced", "blocked", "completed"]);
const MULTICA_TICKET = /^[A-Z][A-Z0-9]*-[1-9][0-9]*$/;
const UUID_TICKET = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EMPTY_MARKER = /^(?:none(?: found)?|nothing|no action needed|no follow-up needed|empty)$/i;

type ProseContinuation = { lane: string; body: string };
type ContinuationIdentity = { lane: string; action: string; disposition: string; ticket?: string };

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeItem(item: Record<string, unknown>): NormalizedContinuationItem {
  const ticket = text(item.ticket_id);
  const mutationAction = text(item.mutation_action).toLocaleLowerCase("en-US");
  const monitoring = Object.fromEntries(MONITORING_FIELDS
    .map((field) => [field, text(item[field])])
    .filter((entry) => entry[1])) as Partial<Pick<NormalizedContinuationItem, typeof MONITORING_FIELDS[number]>>;
  return {
    lane: text(item.lane).toUpperCase(),
    action: text(item.action),
    disposition: text(item.disposition).toUpperCase(),
    evidence: text(item.evidence),
    expected_impact: text(item.expected_impact),
    cost_class: text(item.cost_class),
    evidence_horizon: text(item.evidence_horizon),
    ...(ticket ? { ticket_id: ticket } : {}),
    ...(mutationAction ? { mutation_action: mutationAction } : {}),
    ...monitoring,
  };
}

function normalizePresentation(value: string): string {
  return value
    .trim()
    .replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.;:—–-]+|[\s,.;:—–-]+$/g, "")
    .trim();
}

function canonicalLane(value: string): string | undefined {
  const lane = normalizePresentation(value).toUpperCase().replace(/[ -]+/g, "-");
  if (lane === "NOW" || lane === "NEXT" || lane === "LATER") return lane;
  if (/^FOLLOW-?UPS?$/.test(lane)) return "FOLLOW-UPS";
  if (/^ACTION-ITEMS?$/.test(lane)) return "ACTION-ITEMS";
  if (lane === "REMAINING-WORK") return lane;
  return undefined;
}

function proseContinuations(responseText: string): ProseContinuation[] {
  const prose = responseText.replace(LEDGER, "");
  const continuations: ProseContinuation[] = [];
  let lane: string | undefined;
  for (const line of prose.split(/\r?\n/)) {
    const heading = line.match(/^\s{0,3}#{1,6}\s+(.+?)\s*$/);
    if (heading) {
      lane = canonicalLane(heading[1]!);
      continue;
    }
    const inline = normalizePresentation(line).match(/^(NOW|NEXT|LATER|FOLLOW[ -]?UPS?|ACTION ITEMS?|REMAINING WORK)\s*:\s*(.+)$/i);
    if (inline) {
      const inlineLane = canonicalLane(inline[1]!);
      const body = normalizePresentation(inline[2]!);
      if (inlineLane && body && !EMPTY_MARKER.test(body)) continuations.push({ lane: inlineLane, body });
      lane = undefined;
      continue;
    }
    if (!lane) continue;
    const body = normalizePresentation(line);
    if (!body || body.startsWith("```") || EMPTY_MARKER.test(body)) continue;
    continuations.push({ lane, body });
  }
  return continuations;
}

function identityAction(value: string): string {
  return normalizePresentation(value).toLocaleLowerCase("en-US");
}

function proseIdentity(continuation: ProseContinuation): ContinuationIdentity | undefined {
  const ticketed = continuation.body.match(/^(.*?)(?:\s+[—–-]\s+|\s*:\s*|\s+)(TRACKED|MUTATED)\s+(\S+)$/i);
  if (ticketed) {
    return {
      lane: continuation.lane,
      action: identityAction(ticketed[1]!),
      disposition: ticketed[2]!.toUpperCase(),
      ticket: normalizePresentation(ticketed[3]!).toLocaleLowerCase("en-US"),
    };
  }
  const monitoring = continuation.body.match(/^(.*?)(?:\s+[—–-]\s+|\s*:\s*|\s+)(MONITORING ONLY)$/i);
  if (!monitoring) return undefined;
  return {
    lane: continuation.lane,
    action: identityAction(monitoring[1]!),
    disposition: "MONITORING ONLY",
  };
}

function ledgerIdentity(item: NormalizedContinuationItem): ContinuationIdentity {
  return {
    lane: canonicalLane(item.lane) ?? item.lane,
    action: identityAction(item.action),
    disposition: item.disposition,
    ...(item.ticket_id ? { ticket: item.ticket_id.toLocaleLowerCase("en-US") } : {}),
  };
}

function sameIdentity(left: ContinuationIdentity, right: ContinuationIdentity): boolean {
  return left.lane === right.lane
    && left.action === right.action
    && left.disposition === right.disposition
    && left.ticket === right.ticket;
}

function envelopeFailure(responseText: string, reason: string): ContinuationFinalizerResult {
  return {
    status: "FAIL",
    reasons: [
      reason,
      ...proseContinuations(responseText).map((continuation) =>
        `UNMAPPED_CONTINUATION:${continuation.lane}:${continuation.body.slice(0, 120)}`),
    ],
    items: [],
  };
}

export function finalizeContinuationLedger(responseText: string): ContinuationFinalizerResult {
  const matches = [...responseText.matchAll(LEDGER)];
  if (matches.length !== 1) {
    return envelopeFailure(responseText, matches.length === 0 ? "MISSING_LEDGER" : "MULTIPLE_LEDGERS");
  }
  try {
    const payload: unknown = JSON.parse(matches[0]![1]!);
    if (typeof payload !== "object" || payload === null || !Array.isArray((payload as { items?: unknown }).items)
      || !(payload as { items: unknown[] }).items.every((item) => typeof item === "object" && item !== null && !Array.isArray(item))) {
      return envelopeFailure(responseText, "INVALID_LEDGER_SCHEMA");
    }
    const rawItems = (payload as { items: Record<string, unknown>[] }).items;
    const reasons: string[] = [];
    const items = rawItems.map(normalizeItem);
    rawItems.forEach((item, index) => {
      for (const field of REQUIRED_FIELDS) {
        if (!text(item[field])) reasons.push(`MISSING_FIELD:${index}:${field}`);
      }
      if (!DISPOSITIONS.has(text(item.disposition).toUpperCase() as ContinuationDisposition)) {
        reasons.push(`INVALID_DISPOSITION:${index}`);
        return;
      }
      const disposition = text(item.disposition).toUpperCase() as ContinuationDisposition;
      if (disposition === "MONITORING ONLY") {
        for (const field of MONITORING_FIELDS) {
          if (!text(item[field])) reasons.push(`MISSING_FIELD:${index}:${field}`);
        }
      } else {
        const ticket = text(item.ticket_id);
        if (!(SlugId.safeParse(ticket).success || MULTICA_TICKET.test(ticket) || UUID_TICKET.test(ticket))) {
          reasons.push(`INVALID_TICKET_ID:${index}`);
        }
        if (disposition === "MUTATED") {
          const mutationAction = text(item.mutation_action).toLocaleLowerCase("en-US");
          if (!mutationAction) reasons.push(`MISSING_FIELD:${index}:mutation_action`);
          else if (!MUTATION_ACTIONS.has(mutationAction)) reasons.push(`INVALID_MUTATION_ACTION:${index}`);
        }
      }
    });
    const unmatchedItems = items.map(ledgerIdentity);
    for (const continuation of proseContinuations(responseText)) {
      const identity = proseIdentity(continuation);
      const matchIndex = identity ? unmatchedItems.findIndex((item) => sameIdentity(identity, item)) : -1;
      if (matchIndex === -1) {
        reasons.push(`UNMAPPED_CONTINUATION:${continuation.lane}:${continuation.body.slice(0, 120)}`);
      } else {
        unmatchedItems.splice(matchIndex, 1);
      }
    }
    return { status: reasons.length ? "FAIL" : "PASS", reasons, items };
  } catch {
    return envelopeFailure(responseText, "MALFORMED_LEDGER");
  }
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sameContent(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase("en-US") === right.trim().toLocaleLowerCase("en-US");
}

function mutationReason(item: NormalizedContinuationItem, context: ContinuationLiveProofContext, records: MutationProof[]): string | undefined {
  const ticketId = item.ticket_id!;
  if (!records.length) return `MUTATION_NOT_FOUND:${ticketId}`;
  const ticket = records.filter((record) => record.ticket_id === ticketId);
  if (!ticket.length) return `MUTATION_TICKET_MISMATCH:${ticketId}`;
  const run = ticket.filter((record) => record.run_sha256 === sha(context.runId));
  if (!run.length) return `MUTATION_RUN_MISMATCH:${ticketId}`;
  const session = run.filter((record) => record.session_sha256 === sha(context.sessionId));
  if (!session.length) return `MUTATION_SESSION_MISMATCH:${ticketId}`;
  const action = session.filter((record) => sameContent(record.action, item.mutation_action!));
  if (!action.length) return `MUTATION_ACTION_MISMATCH:${ticketId}`;
  if (!action.some((record) => record.outcome === "success")) return `MUTATION_FAILED:${ticketId}`;
  return undefined;
}

function ticketReason(item: NormalizedContinuationItem, context: ContinuationLiveProofContext, proof: LiveTicketProof | undefined): string | undefined {
  const ticketId = item.ticket_id!;
  if (!proof || proof.ticket_id !== ticketId) return `TICKET_NOT_FOUND:${ticketId}`;
  if (proof.configured_parent_id !== context.parentId || proof.parent_id !== context.parentId) return `WRONG_TICKET_PARENT:${ticketId}`;
  if (proof.status === "done" || proof.status === "cancelled") return `TICKET_CLOSED:${ticketId}`;
  if (!proof.content_strings.some((content) => sameContent(content, item.action))) return `TICKET_CONTENT_MISMATCH:${ticketId}`;
  if (!proof.evidence_reference_ids.includes(item.evidence)) return `EVIDENCE_NOT_FOUND:${ticketId}:${item.evidence}`;
  return undefined;
}

/** Add live proof without changing the synchronous structural parser seam. */
export async function finalizeContinuationLedgerLive(
  responseText: string,
  context: ContinuationLiveProofContext,
  deps: ContinuationLiveProofDeps,
): Promise<ContinuationFinalizerResult> {
  const structural = finalizeContinuationLedger(responseText);
  if (structural.status === "FAIL") return structural;
  const reasons: string[] = [];
  for (const item of structural.items) {
    if (item.disposition === "MONITORING ONLY") continue;
    const ticketId = item.ticket_id!;
    let proof: LiveTicketProof | undefined;
    try {
      const rawProof = await deps.readTicket(ticketId);
      if (rawProof !== undefined) {
        const parsed = LiveTicketProofSchema.safeParse(rawProof);
        if (!parsed.success) throw new Error("invalid_live_ticket_proof");
        proof = parsed.data;
      }
    } catch {
      reasons.push(`TRACKER_UNREADABLE:${ticketId}`);
      continue;
    }
    const liveReason = ticketReason(item, context, proof);
    if (liveReason) reasons.push(liveReason);
    if (item.disposition === "MUTATED") {
      try {
        const parsed = z.array(MutationProofSchema).safeParse(await deps.readMutations());
        if (!parsed.success) throw new Error("invalid_mutation_proof_array");
        const reason = mutationReason(item, context, parsed.data);
        if (reason) reasons.push(reason);
      } catch {
        reasons.push(`MUTATION_PROOF_UNREADABLE:${ticketId}`);
      }
    }
  }
  return { ...structural, status: reasons.length ? "FAIL" : "PASS", reasons };
}

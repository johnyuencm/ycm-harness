import { z } from "zod";
import { IsoDateTime, LongText, ShortText, SlugId } from "./common.js";
import { WikiState, emptyWikiState } from "./wiki.js";

/** The small, durable lifecycle used by the lean workflow. */
export const STATE_V3_VERSION = 3 as const;
export const GoalV3Status = z.enum([
  "planning",
  "active",
  "verifying",
  "blocked",
  "done",
  "abandoned",
]);
export type GoalV3StatusT = z.infer<typeof GoalV3Status>;

export const Assurance = z.enum(["standard", "high"]);
export type AssuranceT = z.infer<typeof Assurance>;

/** A goal is bound to one provider for its whole lifetime. */
export const TicketBackend = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local") }),
  z.object({
    kind: z.literal("github"),
    owner: ShortText,
    repo: ShortText,
    project_owner: ShortText,
    project_number: z.number().int().positive(),
    parent_issue_number: z.number().int().positive(),
    last_verified_at: IsoDateTime.optional(),
    cache_digest: ShortText.optional(),
    available: z.boolean().optional(),
    stale: z.boolean().optional(),
    outage: z.boolean().optional(),
  }),
  /** @deprecated Legacy Multica goals only — parseable, not creatable via CLI. */
  z.object({
    kind: z.literal("multica"),
    origin: ShortText,
    workspace_id: ShortText,
    parent_issue_id: ShortText,
    last_verified_at: IsoDateTime.optional(),
    cache_digest: ShortText.optional(),
    available: z.boolean().optional(),
    stale: z.boolean().optional(),
    outage: z.boolean().optional(),
  }),
]);
export type TicketBackendT = z.infer<typeof TicketBackend>;

/** Default GitHub tracker binding for this product repo. */
export const DEFAULT_GITHUB_TRACKER = {
  owner: "johnyuencm",
  repo: "ycm-harness",
  project_owner: "johnyuencm",
  project_number: 1,
} as const;

export const WorktreeStatusV3 = z.enum(["pending", "active", "merged", "abandoned"]);
export type WorktreeStatusV3T = z.infer<typeof WorktreeStatusV3>;

export const GoalV3 = z.object({
  id: SlugId,
  title: ShortText,
  description: LongText.optional(),
  status: GoalV3Status,
  assurance: Assurance.default("standard"),
  backend: TicketBackend.default(() => ({ kind: "local" as const })),
  active_ticket_id: SlugId.optional(),
  worktree_path: ShortText.optional(),
  branch: ShortText.optional(),
  base_sha: ShortText.optional(),
  worktree_status: WorktreeStatusV3.default("pending"),
  stop_enforcement: z.boolean().default(false),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type GoalV3T = z.infer<typeof GoalV3>;

export const TicketStatus = z.enum([
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
]);
export type TicketStatusT = z.infer<typeof TicketStatus>;

export const Ticket = z.object({
  id: SlugId,
  goal_id: SlugId,
  title: ShortText,
  brief: LongText.optional(),
  acceptance: z.array(ShortText).default(() => []),
  blocked_by: z.array(SlugId).default(() => []),
  status: TicketStatus,
  code_changed: z.boolean().default(false),
  order: z.number().int().nonnegative(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type TicketT = z.infer<typeof Ticket>;

export const CheckpointV3Kind = z.enum([
  "phase_transition",
  "task_complete",
  "blocker",
  "decision",
  "context_compaction",
  "manual",
]);
export type CheckpointV3KindT = z.infer<typeof CheckpointV3Kind>;

export const CheckpointV3 = z.object({
  id: SlugId,
  goal_id: SlugId,
  ticket_id: SlugId.optional(),
  kind: CheckpointV3Kind,
  title: ShortText,
  notes: LongText.optional(),
  decisions: z.array(ShortText).default(() => []),
  next_action: ShortText.optional(),
  created_at: IsoDateTime,
});
export type CheckpointV3T = z.infer<typeof CheckpointV3>;

export const EvidenceKind = z.enum(["verification", "commit", "other"]);
export type EvidenceKindT = z.infer<typeof EvidenceKind>;

/** A pointer to evidence; the bytes remain in the referenced file/comment. */
export const EvidencePointer = z.object({
  id: SlugId,
  goal_id: SlugId,
  ticket_id: SlugId.optional(),
  kind: EvidenceKind,
  submission_digest: ShortText.optional(),
  evidence_digest: ShortText.optional(),
  evidence_path: ShortText.optional(),
  remote_comment_id: ShortText.optional(),
  command: ShortText.optional(),
  outcome: z.enum(["pass", "fail", "not_applicable"]).optional(),
  provenance: z.record(ShortText).default(() => ({})),
  recorded_at: IsoDateTime,
});
export type EvidencePointerT = z.infer<typeof EvidencePointer>;

export const LegacyArchive = z.object({
  version: z.literal(2),
  state_path: ShortText,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  manifest_path: ShortText,
  archived_at: IsoDateTime,
});
export type LegacyArchiveT = z.infer<typeof LegacyArchive>;

export const TrackerCache = z.object({
  available: z.boolean().optional(),
  stale: z.boolean().optional(),
  outage: z.boolean().optional(),
  last_verified_at: IsoDateTime.optional(),
  digest: ShortText.optional(),
}).default(() => ({}));
export type TrackerCacheT = z.infer<typeof TrackerCache>;

/** Host session ids are not harness slugs (Cursor/Claude/Codex formats vary). */
export const HostSessionId = z.string().min(1).max(256);
export type HostSessionIdT = z.infer<typeof HostSessionId>;

/** Binds a host chat session to one goal for Stop / SessionStart scoping. */
export const SessionClaim = z.object({
  goal_id: SlugId,
  claimed_at: IsoDateTime,
  last_seen_at: IsoDateTime,
});
export type SessionClaimT = z.infer<typeof SessionClaim>;

export const StateV3 = z.object({
  version: z.literal(STATE_V3_VERSION),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  active_goal_id: SlugId.optional(),
  goals: z.record(GoalV3),
  local_tickets: z.record(Ticket),
  checkpoints: z.record(CheckpointV3),
  evidence: z.record(EvidencePointer),
  wiki: WikiState.default(() => emptyWikiState()),
  tracker_cache: TrackerCache.optional(),
  legacy_archive: LegacyArchive.optional(),
  session_claims: z.record(HostSessionId, SessionClaim).default(() => ({})),
});
export type StateV3T = z.infer<typeof StateV3>;

export function emptyStateV3(now: string): StateV3T {
  return {
    version: STATE_V3_VERSION,
    created_at: now,
    updated_at: now,
    goals: {},
    local_tickets: {},
    checkpoints: {},
    evidence: {},
    wiki: emptyWikiState(),
    tracker_cache: {},
    session_claims: {},
  };
}

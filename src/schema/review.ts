import { z } from "zod";
import { IsoDateTime, ShortText, SlugId, LongText } from "./common.js";

// Legacy split-reviewer values remain parseable for existing state only. New
// review sessions accept `combined_reviewer` through the CLI.
export const ReviewerKind = z.enum([
  "combined_reviewer",
  "tech_lead",
  "project_manager",
  "user_advocate",
]);
export type ReviewerKindT = z.infer<typeof ReviewerKind>;

export const Severity = z.enum(["high", "medium", "low"]);
export type SeverityT = z.infer<typeof Severity>;

export const Finding = z.object({
  id: SlugId,
  severity: Severity,
  title: ShortText,
  notes: LongText.optional(),
  reviewer: ReviewerKind,
  resolved: z.boolean().default(() => false),
  resolved_at: IsoDateTime.optional(),
  resolved_in_round: z.number().int().min(1).optional(),
});
export type FindingT = z.infer<typeof Finding>;

export const ReviewerSource = z.enum(["subagent", "orchestrator"]);
export type ReviewerSourceT = z.infer<typeof ReviewerSource>;

export const ReviewerVerdict = z.object({
  reviewer: ReviewerKind,
  score: z.number().min(0).max(100),
  recommendation: ShortText.optional(),
  finding_ids: z.array(SlugId).default(() => []),
  evidence_file: ShortText.optional(),
  evidence_artifact_id: SlugId.optional(),
  reviewer_source: ReviewerSource.optional(),
  subagent_kind: ShortText.optional(),
  recorded_at: IsoDateTime,
});
export type ReviewerVerdictT = z.infer<typeof ReviewerVerdict>;

export const FIX_LOOP_MAX_ROUNDS = 3;

export const FixLoopRound = z.object({
  number: z.number().int().min(1).max(FIX_LOOP_MAX_ROUNDS),
  rca: LongText,
  evidence: LongText,
  three_whys: LongText,
  plan: LongText,
  address_why: LongText,
  fix: LongText,
  recorded_at: IsoDateTime,
});
export type FixLoopRoundT = z.infer<typeof FixLoopRound>;

export const ReviewSessionStatus = z.enum([
  "open",
  "fix_loop",
  "blocked",
  "passed",
  "failed",
]);
export type ReviewSessionStatusT = z.infer<typeof ReviewSessionStatus>;

export const ReviewSession = z.object({
  id: SlugId,
  target_kind: z.enum(["task", "phase"]),
  target_id: SlugId,
  goal_id: SlugId,
  status: ReviewSessionStatus,
  verdicts: z.record(ReviewerVerdict).default(() => ({})),
  findings: z.record(Finding).default(() => ({})),
  rounds: z.array(FixLoopRound).default(() => []),
  followups_drained: z.boolean().default(() => false),
  opened_at: IsoDateTime,
  closed_at: IsoDateTime.optional(),
});
export type ReviewSessionT = z.infer<typeof ReviewSession>;

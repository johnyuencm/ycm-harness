import { z } from "zod";
import { IsoDateTime, LongText, ShortText, SlugId } from "./common.js";
import { ReviewerKind, Severity } from "./review.js";

export const ReviewEvidenceFinding = z.object({
  severity: Severity,
  title: ShortText,
  notes: LongText.optional(),
});
export type ReviewEvidenceFindingT = z.infer<typeof ReviewEvidenceFinding>;

export const ReviewEvidence = z.object({
  schema_version: z.literal(1),
  session_id: SlugId,
  reviewer: ReviewerKind,
  score: z.number().min(0).max(100),
  reviewer_source: z.enum(["subagent", "orchestrator"]),
  subagent_kind: ShortText,
  reviewed_at: IsoDateTime,
  recommendation: ShortText.optional(),
  checks_performed: z.array(ShortText).min(1),
  findings: z.array(ReviewEvidenceFinding).default(() => []),
  ack_zero_findings_reason: LongText.optional(),
  scope_summary: ShortText.optional(),
});
export type ReviewEvidenceT = z.infer<typeof ReviewEvidence>;

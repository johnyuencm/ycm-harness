import { z } from "zod";
import { IsoDateTime, LongText, ShortText, SlugId } from "./common.js";

export const RitualKind = z.enum([
  "grill-me",
  "writing-plans",
  "ralplan",
  "ultrawork",
  "ralph",
  "review-gate",
  "project-wiki-update",
  "user-wiki-dry-run",
  "explore-codebase",
  "explore-knowledge-base",
  "team-execution",
]);
export type RitualKindT = z.infer<typeof RitualKind>;

export const RitualStatus = z.enum(["complete", "blocked"]);
export type RitualStatusT = z.infer<typeof RitualStatus>;

export const RitualRecord = z.object({
  id: SlugId,
  goal_id: SlugId,
  phase_id: SlugId,
  kind: RitualKind,
  status: RitualStatus.default(() => "complete" as const),
  evidence_path: ShortText,
  summary: LongText,
  metadata: z.record(z.unknown()).default(() => ({})),
  created_at: IsoDateTime,
});
export type RitualRecordT = z.infer<typeof RitualRecord>;

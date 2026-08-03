import { z } from "zod";
import { IsoDateTime, LongText, ShortText, SlugId } from "./common.js";

export const ArtifactKind = z.enum([
  "user-story",
  "prd",
  "design",
  "implementation-plan",
  "test-plan",
  "progress",
  "explore-report",
  "explore-synthesis",
  "review-output",
  "execution-ledger",
]);
export type ArtifactKindT = z.infer<typeof ArtifactKind>;

export const Artifact = z.object({
  id: SlugId,
  goal_id: SlugId,
  phase_id: SlugId.optional(),
  kind: ArtifactKind,
  path: ShortText,
  summary: LongText.optional(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type ArtifactT = z.infer<typeof Artifact>;

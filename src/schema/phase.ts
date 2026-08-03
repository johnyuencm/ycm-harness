import { z } from "zod";
import { IsoDateTime, ShortText, SlugId, LongText } from "./common.js";

export const PhaseKind = z.enum([
  "explore",
  "discuss",
  "design",
  "plan",
  "execute",
  "validate",
  "finish",
]);
export type PhaseKindT = z.infer<typeof PhaseKind>;

export const PhaseStatus = z.enum([
  "pending",
  "active",
  "blocked",
  "complete",
  "skipped",
]);
export type PhaseStatusT = z.infer<typeof PhaseStatus>;

export const Phase = z.object({
  id: SlugId,
  goal_id: SlugId,
  kind: PhaseKind,
  title: ShortText,
  summary: LongText.optional(),
  status: PhaseStatus,
  order: z.number().int().nonnegative(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type PhaseT = z.infer<typeof Phase>;

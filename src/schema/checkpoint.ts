import { z } from "zod";
import { IsoDateTime, ShortText, SlugId, LongText } from "./common.js";

export const CheckpointKind = z.enum([
  "phase_transition",
  "task_complete",
  "blocker",
  "decision",
  "context_compaction",
  "manual",
]);
export type CheckpointKindT = z.infer<typeof CheckpointKind>;

export const Checkpoint = z.object({
  id: SlugId,
  goal_id: SlugId,
  phase_id: SlugId.optional(),
  task_id: SlugId.optional(),
  kind: CheckpointKind,
  title: ShortText,
  notes: LongText.optional(),
  decisions: z.array(ShortText).default(() => []),
  next_action: ShortText.optional(),
  created_at: IsoDateTime,
});
export type CheckpointT = z.infer<typeof Checkpoint>;

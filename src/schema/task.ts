import { z } from "zod";
import { IsoDateTime, ShortText, SlugId, LongText } from "./common.js";

export const TaskStatus = z.enum([
  "pending",
  "active",
  "blocked",
  "done",
  "cancelled",
]);
export type TaskStatusT = z.infer<typeof TaskStatus>;

export const SmokeRequirement = z.enum([
  "required",
  "not_applicable",
]);
export type SmokeRequirementT = z.infer<typeof SmokeRequirement>;

export const Task = z.object({
  id: SlugId,
  phase_id: SlugId,
  title: ShortText,
  brief: LongText.optional(),
  status: TaskStatus,
  smoke: SmokeRequirement.default("required"),
  code_changed: z.boolean().optional(),
  smoke_evidence_ids: z.array(SlugId).default(() => []),
  order: z.number().int().nonnegative(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type TaskT = z.infer<typeof Task>;

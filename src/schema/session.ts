import { z } from "zod";
import { IsoDateTime, ShortText, SlugId } from "./common.js";

export const Session = z.object({
  id: SlugId,
  started_at: IsoDateTime,
  last_seen_at: IsoDateTime,
  active_goal_id: SlugId.optional(),
  active_phase_id: SlugId.optional(),
  active_task_id: SlugId.optional(),
  notes: ShortText.optional(),
});
export type SessionT = z.infer<typeof Session>;

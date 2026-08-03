import { z } from "zod";
import { IsoDateTime, LongText, ShortText, SlugId } from "./common.js";

export const CommitRecord = z.object({
  id: SlugId,
  goal_id: SlugId,
  task_id: SlugId,
  sha: ShortText,
  summary: LongText,
  created_at: IsoDateTime,
});
export type CommitRecordT = z.infer<typeof CommitRecord>;

import { z } from "zod";
import { IsoDateTime, ShortText, SlugId, LongText } from "./common.js";

export const GoalStatus = z.enum(["draft", "active", "blocked", "done", "abandoned"]);
export type GoalStatusT = z.infer<typeof GoalStatus>;

export const WorktreeStatus = z.enum(["pending", "active", "merged", "abandoned"]);
export type WorktreeStatusT = z.infer<typeof WorktreeStatus>;

export const Goal = z.object({
  id: SlugId,
  title: ShortText,
  description: LongText.optional(),
  status: GoalStatus,
  worktree_path: ShortText.optional(),
  branch: ShortText.optional(),
  base_sha: ShortText.optional(),
  worktree_status: WorktreeStatus.default(() => "pending" as const),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
});
export type GoalT = z.infer<typeof Goal>;

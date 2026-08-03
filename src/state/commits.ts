import { promises as fs } from "node:fs";
import path from "node:path";
import type { CommitRecordT } from "../schema/commit.js";
import type { StateT } from "../schema/state.js";
import { goalDir } from "./paths.js";
import { appendJsonl } from "./io.js";

export function commitsFile(root: string, goalId: string): string {
  return path.join(goalDir(root, goalId), "commits.jsonl");
}

export function commitRecordsForGoal(state: StateT, goalId: string): CommitRecordT[] {
  return Object.values(state.commits ?? {}).filter((c) => c.goal_id === goalId);
}

export async function appendCommitToDisk(
  root: string,
  record: CommitRecordT,
): Promise<void> {
  await appendJsonl(commitsFile(root, record.goal_id), record);
}

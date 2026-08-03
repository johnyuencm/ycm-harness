import { z } from "zod";
import { Goal } from "./goal.js";
import { Phase } from "./phase.js";
import { Task } from "./task.js";
import { Checkpoint } from "./checkpoint.js";
import { SmokeEvidence } from "./smoke.js";
import { Session } from "./session.js";
import { WikiState, emptyWikiState } from "./wiki.js";
import { ReviewSession } from "./review.js";
import { RitualRecord } from "./ritual.js";
import { Artifact } from "./artifact.js";
import { CommitRecord } from "./commit.js";
import { IsoDateTime, SlugId } from "./common.js";

const SessionNudge = z.object({
  user_msgs_since_wiki_write: z.number().int().min(0).default(() => 0),
  last_wiki_write_at: IsoDateTime.optional(),
  last_user_msg_at: IsoDateTime.optional(),
});
export type SessionNudgeT = z.infer<typeof SessionNudge>;

function emptyNudge(): SessionNudgeT {
  return { user_msgs_since_wiki_write: 0 };
}

export const STATE_VERSION = 2 as const;

export const State = z.object({
  version: z.literal(STATE_VERSION),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  active_goal_id: SlugId.optional(),
  active_session_id: SlugId.optional(),
  goals: z.record(Goal),
  phases: z.record(Phase),
  tasks: z.record(Task),
  checkpoints: z.record(Checkpoint),
  smoke: z.record(SmokeEvidence),
  sessions: z.record(Session),
  wiki: WikiState.default(() => emptyWikiState()),
  reviews: z.record(ReviewSession).default(() => ({})),
  rituals: z.record(RitualRecord).default(() => ({})),
  artifacts: z.record(Artifact).default(() => ({})),
  commits: z.record(CommitRecord).default(() => ({})),
  session_nudge: SessionNudge.default(() => emptyNudge()),
});
export type StateT = z.infer<typeof State>;

export function emptyState(now: string): StateT {
  return {
    version: STATE_VERSION,
    created_at: now,
    updated_at: now,
    goals: {},
    phases: {},
    tasks: {},
    checkpoints: {},
    smoke: {},
    sessions: {},
    wiki: emptyWikiState(),
    reviews: {},
    rituals: {},
    artifacts: {},
    commits: {},
    session_nudge: emptyNudge(),
  };
}

export function migrateStateIfNeeded(raw: unknown): unknown {
  if (!raw || typeof raw !== "object") return raw;
  const obj = raw as Record<string, unknown>;
  const version = typeof obj.version === "number" ? obj.version : 0;
  if (version >= STATE_VERSION) return raw;

  const next: Record<string, unknown> = { ...obj };
  if (version < 2) {
    next.version = 2;
    if (!next.artifacts || typeof next.artifacts !== "object") {
      next.artifacts = {};
    }
    if (!next.commits || typeof next.commits !== "object") {
      next.commits = {};
    }
    if (next.goals && typeof next.goals === "object") {
      const goals = next.goals as Record<string, Record<string, unknown>>;
      for (const id of Object.keys(goals)) {
        const g = goals[id];
        if (g && typeof g === "object" && g.worktree_status === undefined) {
          g.worktree_status = "pending";
        }
      }
    }
  }
  return next;
}

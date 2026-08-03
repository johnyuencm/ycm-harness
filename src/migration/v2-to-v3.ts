import { State, migrateStateIfNeeded, type StateT } from "../schema/state.js";
import {
  StateV3,
  type StateV3T,
  type GoalV3StatusT,
  type TicketStatusT,
  type EvidencePointerT,
  emptyStateV3,
  type LegacyArchiveT,
} from "../schema/v3.js";
import type { PhaseT } from "../schema/phase.js";
import type { TaskT } from "../schema/task.js";
import type { SmokeEvidenceT } from "../schema/smoke.js";
import type { CommitRecordT } from "../schema/commit.js";
import type { CheckpointT } from "../schema/checkpoint.js";
import { nowIso } from "../state/ids.js";

export interface MigrateV2Options {
  /** Used by the on-disk migrator after it has staged the legacy archive. */
  archive?: LegacyArchiveT;
  now?: string;
}

function goalStatus(goal: StateT["goals"][string], phases: PhaseT[]): GoalV3StatusT {
  if (goal.status === "draft") return "planning";
  if (goal.status === "blocked") return "blocked";
  if (goal.status === "done") return "done";
  if (goal.status === "abandoned") return "abandoned";

  const ordered = [...phases].sort((a, b) => a.order - b.order);
  const active = ordered.find((phase) => phase.status === "active");
  if (active) {
    if (active.kind === "validate" || active.kind === "finish") return "verifying";
    if (active.kind !== "execute") return "planning";
    return "active";
  }
  const latest = [...ordered].reverse().find((phase) => phase.status !== "pending");
  if (latest && (latest.kind === "validate" || latest.kind === "finish")) return "verifying";
  return "active";
}

function ticketStatus(status: TaskT["status"]): TicketStatusT {
  switch (status) {
    case "pending": return "todo";
    case "active": return "in_progress";
    case "blocked": return "blocked";
    case "done": return "done";
    case "cancelled": return "cancelled";
  }
}

function addVerificationEvidence(
  target: Record<string, EvidencePointerT>,
  smoke: SmokeEvidenceT,
  goalId: string | undefined,
): void {
  if (!goalId) return;
  const id = `smoke_${smoke.id}`;
  target[id] = {
    id,
    goal_id: goalId,
    ticket_id: smoke.task_id,
    kind: "verification",
    evidence_digest: smoke.log_sha256,
    evidence_path: smoke.log_file,
    command: smoke.command,
    outcome: smoke.outcome,
    provenance: {
      recording_mode: smoke.recording_mode,
      recorded_at: smoke.recorded_at,
    },
    recorded_at: smoke.executed_at ?? smoke.recorded_at,
  };
}

function addCommitEvidence(
  target: Record<string, EvidencePointerT>,
  commit: CommitRecordT,
  goalId: string | undefined,
): void {
  if (!goalId) return;
  const id = `commit_${commit.id}`;
  target[id] = {
    id,
    goal_id: goalId,
    ticket_id: commit.task_id,
    kind: "commit",
    evidence_digest: commit.sha,
    provenance: { summary: commit.summary.slice(0, 500) },
    recorded_at: commit.created_at,
  };
}

/**
 * Convert a validated V2 state to the lean V3 representation.
 * Legacy phases/reviews/rituals/artifacts/commits are deliberately not copied
 * into active state; the caller archives the original bytes before applying it.
 */
export function migrateV2ToV3(raw: unknown, options: MigrateV2Options = {}): StateV3T {
  const parsed = State.parse(migrateStateIfNeeded(raw));
  if (parsed.version !== 2) {
    throw new Error(`Expected V2 state, received version ${String((parsed as { version?: unknown }).version)}`);
  }

  const now = options.now ?? nowIso();
  const next = emptyStateV3(now);
  next.created_at = parsed.created_at;
  next.updated_at = now;
  const phasesByGoal = new Map<string, PhaseT[]>();
  for (const phase of Object.values(parsed.phases)) {
    const list = phasesByGoal.get(phase.goal_id) ?? [];
    list.push(phase);
    phasesByGoal.set(phase.goal_id, list);
  }

  for (const goal of Object.values(parsed.goals)) {
    const mappedStatus = goalStatus(goal, phasesByGoal.get(goal.id) ?? []);
    next.goals[goal.id] = {
      id: goal.id,
      title: goal.title,
      description: goal.description,
      status: mappedStatus,
      assurance: "standard",
      backend: { kind: "local" },
      worktree_path: goal.worktree_path,
      branch: goal.branch,
      base_sha: goal.base_sha,
      worktree_status: goal.worktree_status,
      stop_enforcement: false,
      created_at: goal.created_at,
      updated_at: goal.updated_at,
    };
  }

  const phaseGoal = new Map(Object.values(parsed.phases).map((phase) => [phase.id, phase.goal_id]));
  const taskGoal = new Map<string, string>();
  const taskEntries = Object.values(parsed.tasks)
    .map((task) => ({ task, phase: parsed.phases[task.phase_id] }))
    .filter((entry): entry is { task: TaskT; phase: PhaseT } => !!entry.phase)
    .sort((a, b) => a.phase.order - b.phase.order || a.task.order - b.task.order || a.task.id.localeCompare(b.task.id));
  for (const [order, entry] of taskEntries.entries()) {
    const { task, phase } = entry;
    taskGoal.set(task.id, phase.goal_id);
    next.local_tickets[task.id] = {
      id: task.id,
      goal_id: phase.goal_id,
      title: task.title,
      brief: task.brief,
      acceptance: [],
      blocked_by: [],
      status: ticketStatus(task.status),
      code_changed: task.code_changed ?? false,
      order,
      created_at: task.created_at,
      updated_at: task.updated_at,
    };
  }

  for (const checkpoint of Object.values(parsed.checkpoints) as CheckpointT[]) {
    next.checkpoints[checkpoint.id] = {
      id: checkpoint.id,
      goal_id: checkpoint.goal_id,
      ticket_id: checkpoint.task_id && next.local_tickets[checkpoint.task_id] ? checkpoint.task_id : undefined,
      kind: checkpoint.kind,
      title: checkpoint.title,
      notes: checkpoint.notes,
      decisions: checkpoint.decisions,
      next_action: checkpoint.next_action,
      created_at: checkpoint.created_at,
    };
  }

  for (const smoke of Object.values(parsed.smoke)) addVerificationEvidence(next.evidence, smoke, taskGoal.get(smoke.task_id ?? "") ?? phaseGoal.get(smoke.phase_id ?? ""));
  for (const commit of Object.values(parsed.commits)) addCommitEvidence(next.evidence, commit, taskGoal.get(commit.task_id));

  next.active_goal_id = parsed.active_goal_id;
  const activeSession = parsed.active_session_id ? parsed.sessions[parsed.active_session_id] : undefined;
  const activeTicketId = activeSession?.active_task_id && next.local_tickets[activeSession.active_task_id]
    ? activeSession.active_task_id
    : Object.values(next.local_tickets).find((ticket) => ticket.goal_id === parsed.active_goal_id && ticket.status === "in_progress")?.id;
  const activeGoal = parsed.active_goal_id ? next.goals[parsed.active_goal_id] : undefined;
  if (activeTicketId && activeGoal) {
    next.goals[activeGoal.id] = { ...activeGoal, active_ticket_id: activeTicketId };
  }
  next.wiki = parsed.wiki;
  if (options.archive) next.legacy_archive = options.archive;
  return StateV3.parse(next);
}

export { StateV3 };
export type { StateV3T };

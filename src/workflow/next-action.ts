import type { StateT } from "../schema/state.js";
import type { GoalT } from "../schema/goal.js";
import type { PhaseT, PhaseKindT } from "../schema/phase.js";
import type { TaskT } from "../schema/task.js";
import { FIRST_PHASE, PHASE_ORDER } from "./transitions.js";

export interface NextActionContext {
  goal?: GoalT;
  phase?: PhaseT;
  task?: TaskT;
  message: string;
  command?: string;
}

export function activeGoal(state: StateT): GoalT | undefined {
  if (!state.active_goal_id) return undefined;
  return state.goals[state.active_goal_id];
}

export function phasesForGoal(state: StateT, goalId: string): PhaseT[] {
  return Object.values(state.phases)
    .filter((p) => p.goal_id === goalId)
    .sort((a, b) => a.order - b.order);
}

export function tasksForPhase(state: StateT, phaseId: string): TaskT[] {
  return Object.values(state.tasks)
    .filter((t) => t.phase_id === phaseId)
    .sort((a, b) => a.order - b.order);
}

export function activePhase(state: StateT, goal?: GoalT): PhaseT | undefined {
  if (!goal) return undefined;
  const phases = phasesForGoal(state, goal.id);
  return phases.find((p) => p.status === "active") ?? phases.find((p) => p.status === "pending");
}

export function activeTask(state: StateT, phase?: PhaseT): TaskT | undefined {
  if (!phase) return undefined;
  const tasks = tasksForPhase(state, phase.id);
  return tasks.find((t) => t.status === "active") ?? tasks.find((t) => t.status === "pending");
}

export function nextPhaseKind(current?: PhaseKindT): PhaseKindT | undefined {
  if (!current) return FIRST_PHASE;
  const idx = PHASE_ORDER.indexOf(current);
  if (idx === -1 || idx === PHASE_ORDER.length - 1) return undefined;
  return PHASE_ORDER[idx + 1];
}

export function computeNextAction(state: StateT): NextActionContext {
  const goal = activeGoal(state);
  if (!goal) {
    return {
      message: "No active goal. Create one to begin.",
      command: "ycm-harness goal create \"<title>\"",
    };
  }
  const phase = activePhase(state, goal);
  const openReview = Object.values(state.reviews ?? {}).find(
    (r) => r.goal_id === goal.id && (r.status === "open" || r.status === "fix_loop"),
  );
  if (openReview) {
    return {
      goal,
      phase,
      message: `Open review session ${openReview.id} (status=${openReview.status}). Inspect status and either record verdicts, run a fix-loop round, or close.`,
      command: `ycm-harness review status ${openReview.id} --json`,
    };
  }
  if (!phase) {
    const goalPhases = phasesForGoal(state, goal.id);
    const finishDone = goalPhases.some((p) => p.kind === "finish" && p.status === "complete");
    if (finishDone) {
      return {
        goal,
        message: `Goal '${goal.title}' is complete (all phases through finish). Create a new goal for additional scope.`,
        command: 'ycm-harness goal create "<title>"',
      };
    }
    if (goal.worktree_status !== "active") {
      return {
        goal,
        message: `Goal '${goal.title}' has no worktree yet. Initialize one for goal-scoped isolation.`,
        command: "ycm-harness goal worktree init",
      };
    }
    if (goalPhases.length === 0) {
      return {
        goal,
        message: `Goal '${goal.title}' has no phases. Start the ${FIRST_PHASE} phase.`,
        command: `ycm-harness phase start ${FIRST_PHASE}`,
      };
    }
    return {
      goal,
      message: `Goal '${goal.title}' has no active phase. Resume or start the next incomplete phase from phase list.`,
      command: "ycm-harness phase list",
    };
  }
  const task = activeTask(state, phase);
  if (phase.status === "blocked") {
    return {
      goal,
      phase,
      task,
      message: `Phase '${phase.kind}' is blocked. Resolve the blocker, then re-activate.`,
      command: `ycm-harness checkpoint blocker "<describe blocker>"`,
    };
  }
  if (phase.kind === "execute" && task) {
    if (task.status === "active") {
      return {
        goal,
        phase,
        task,
        message: `Continue task '${task.title}'. Record smoke evidence before completing if behavior changes.`,
      command: `ycm-harness smoke --task ${task.id}`,
      };
    }
    if (task.status === "pending") {
      return {
        goal,
        phase,
        task,
        message: `Activate the next task: '${task.title}'.`,
        command: `ycm-harness task start ${task.id}`,
      };
    }
  }
  if (phase.kind === "execute" && !task) {
    const queued = Object.values(state.tasks)
      .filter((t) => t.status === "pending" || t.status === "blocked")
      .filter((t) => {
        const tp = state.phases[t.phase_id];
        return tp && tp.goal_id === goal.id && tp.id !== phase.id;
      })
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    const head = queued[0];
    if (head) {
      return {
        goal,
        phase,
        task: head,
        message: `Activate the next task drafted in plan: '${head.title}'.`,
        command: `ycm-harness task start ${head.id}`,
      };
    }
    return {
      goal,
      phase,
      message: "No tasks in execute phase. Create the first task from the plan.",
      command: "ycm-harness task create \"<title>\"",
    };
  }
  if (phase.kind === "validate") {
    return {
      goal,
      phase,
      task,
      message:
        "Validate phase outcomes against goal/plan, then record an end-to-end smoke check.",
      command: `ycm-harness smoke --phase ${phase.id}`,
    };
  }
  if (phase.kind === "finish") {
    return {
      goal,
      phase,
      message: "Capture a final checkpoint and close the goal.",
      command: `ycm-harness checkpoint manual "Goal '${goal.title}' finished"`,
    };
  }
  return {
    goal,
    phase,
    task,
    message: `Continue phase '${phase.kind}'. Capture decisions as checkpoints; advance when ready.`,
    command: `ycm-harness checkpoint decision "<decision>"`,
  };
}

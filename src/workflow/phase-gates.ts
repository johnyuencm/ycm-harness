import type { ArtifactKindT, ArtifactT } from "../schema/artifact.js";
import type { CheckpointT } from "../schema/checkpoint.js";
import type { PhaseT } from "../schema/phase.js";
import type { RitualKindT, RitualRecordT } from "../schema/ritual.js";
import type { SmokeEvidenceT } from "../schema/smoke.js";
import { smokeHasExecutionProof } from "../enforcement/smoke-verify.js";
import { strictGatesEnabled } from "../enforcement/strict-mode.js";
import type { StateT } from "../schema/state.js";
import type { TaskT } from "../schema/task.js";
import { decideGate } from "../review/policy.js";
import { commitRecordsForGoal } from "../state/commits.js";

export interface PhaseGateDecision {
  allowed: boolean;
  missing: string[];
}

function ritualsForPhase(state: StateT, phaseId: string): RitualRecordT[] {
  return Object.values(state.rituals).filter((r) => r.phase_id === phaseId);
}

function completeRitualsForPhase(state: StateT, phaseId: string): RitualRecordT[] {
  return ritualsForPhase(state, phaseId).filter((r) => r.status === "complete");
}

function hasRitual(state: StateT, phaseId: string, kind: RitualKindT): boolean {
  return completeRitualsForPhase(state, phaseId).some((r) => r.kind === kind);
}

function phaseCheckpoints(state: StateT, phaseId: string): CheckpointT[] {
  return Object.values(state.checkpoints).filter((c) => c.phase_id === phaseId);
}

function phaseTasks(state: StateT, phaseId: string): TaskT[] {
  return Object.values(state.tasks).filter((t) => t.phase_id === phaseId);
}

function phaseSmoke(state: StateT, phaseId: string): SmokeEvidenceT[] {
  return Object.values(state.smoke).filter((s) => s.phase_id === phaseId);
}

function goalArtifactsOfKind(state: StateT, goalId: string, kind: ArtifactKindT): ArtifactT[] {
  return Object.values(state.artifacts).filter(
    (a) => a.goal_id === goalId && a.kind === kind,
  );
}

function metaBool(value: unknown): boolean | undefined {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "string") {
    if (value.toLowerCase() === "true") return true;
    if (value.toLowerCase() === "false") return false;
  }
  return undefined;
}

function writingPlanRitual(state: StateT, phaseId: string): RitualRecordT | undefined {
  return completeRitualsForPhase(state, phaseId)
    .filter((r) => r.kind === "writing-plans")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

function passedReviewForPhase(state: StateT, phaseId: string): boolean {
  return Object.values(state.reviews).some((session) => {
    if (session.target_kind !== "phase" || session.target_id !== phaseId) return false;
    const gate = decideGate(session, state);
    return session.status === "passed" && gate.status === "passed";
  });
}

export function evaluatePhaseExitGate(state: StateT, phase: PhaseT): PhaseGateDecision {
  const missing: string[] = [];

  if (phase.kind === "explore") {
    const synthesis = goalArtifactsOfKind(state, phase.goal_id, "explore-synthesis");
    if (synthesis.length < 1) {
      missing.push(
        "register at least one explore-synthesis artifact (ycm-harness artifact register --kind explore-synthesis --path <file>)",
      );
    }
    const reports = goalArtifactsOfKind(state, phase.goal_id, "explore-report");
    if (reports.length < 2) {
      missing.push(
        `register at least 2 explore-report artifacts (have ${reports.length}); fan out to subagents for codebase + risks`,
      );
    }
    if (!hasRitual(state, phase.id, "explore-codebase")) {
      missing.push("record a complete explore-codebase ritual for the explore phase");
    }
    if (!hasRitual(state, phase.id, "explore-knowledge-base")) {
      missing.push(
        "record a complete explore-knowledge-base ritual for the explore phase (project wiki + user wiki scan)",
      );
    }
  }

  if (phase.kind === "discuss") {
    if (!hasRitual(state, phase.id, "grill-me")) {
      missing.push("record a complete grill-me ritual for the discuss phase");
    }
    if (!phaseCheckpoints(state, phase.id).some((c) => c.kind === "decision")) {
      missing.push("record at least one decision checkpoint in the discuss phase");
    }
    if (goalArtifactsOfKind(state, phase.goal_id, "user-story").length < 1) {
      missing.push(
        "register a user-story artifact (ycm-harness artifact register --kind user-story --path <file>)",
      );
    }
    if (goalArtifactsOfKind(state, phase.goal_id, "prd").length < 1) {
      missing.push("register a prd artifact (ycm-harness artifact register --kind prd --path <file>)");
    }
  }

  if (phase.kind === "design") {
    if (goalArtifactsOfKind(state, phase.goal_id, "design").length < 1) {
      missing.push(
        "register a design artifact (ycm-harness artifact register --kind design --path <file>)",
      );
    }
  }

  if (phase.kind === "plan") {
    const wp = writingPlanRitual(state, phase.id);
    if (!wp) {
      missing.push("record a complete writing-plans ritual for the plan phase");
    } else {
      const required = metaBool(wp.metadata.ralplan_required);
      if (required === undefined) {
        missing.push("record writing-plans metadata ralplan_required=true|false");
      } else if (required && !hasRitual(state, phase.id, "ralplan")) {
        missing.push("record a complete ralplan ritual because ralplan_required=true");
      }
    }
    if (goalArtifactsOfKind(state, phase.goal_id, "implementation-plan").length < 1) {
      missing.push(
        "register an implementation-plan artifact (ycm-harness artifact register --kind implementation-plan --path <file>)",
      );
    }
    if (goalArtifactsOfKind(state, phase.goal_id, "test-plan").length < 1) {
      missing.push(
        "register a test-plan artifact (ycm-harness artifact register --kind test-plan --path <file>)",
      );
    }
    if (phaseTasks(state, phase.id).length === 0) {
      missing.push("create at least one ordered task in the plan phase");
    }
  }

  if (phase.kind === "execute") {
    if (!hasRitual(state, phase.id, "ultrawork")) {
      missing.push("record a complete ultrawork ritual for the execute phase");
    }
    if (!hasRitual(state, phase.id, "ralph")) {
      missing.push("record a complete ralph ritual for the execute phase");
    }
    for (const task of phaseTasks(state, phase.id)) {
      if (task.status !== "done" && task.status !== "blocked" && task.status !== "cancelled") {
        missing.push(`finish or block task ${task.id}`);
      }
      if (task.status === "done" && task.smoke === "required" && task.smoke_evidence_ids.length === 0) {
        missing.push(`record smoke evidence for runnable task ${task.id}`);
      }
      if (task.status === "done" && task.smoke === "required" && strictGatesEnabled()) {
        const smokes = task.smoke_evidence_ids
          .map((id) => state.smoke[id])
          .filter((s): s is SmokeEvidenceT => Boolean(s));
        const passSmokes = smokes.filter((s) => s.outcome === "pass");
        if (passSmokes.length === 0) {
          missing.push(
            `task ${task.id} requires passing smoke via 'ycm-harness smoke run --task ${task.id} --command <cmd>'`,
          );
        } else if (!passSmokes.some((s) => smokeHasExecutionProof(s))) {
          missing.push(
            `task ${task.id} pass smoke must be executed (smoke run), not manually recorded`,
          );
        }
      }
      const needsCommit =
        task.status === "done" &&
        (task.code_changed === true ||
          (task.code_changed === undefined && task.smoke === "required"));
      if (needsCommit) {
        const commits = commitRecordsForGoal(state, phase.goal_id);
        if (!commits.some((c) => c.task_id === task.id)) {
          missing.push(
            `record a commit for task ${task.id} (ycm-harness commit record --task ${task.id} --sha <sha> --summary "...")`,
          );
        }
      }
    }
  }

  if (phase.kind === "validate") {
    const phaseSmokes = phaseSmoke(state, phase.id);
    const hasPassingPhaseSmoke = phaseSmokes.some((s) => s.outcome === "pass");
    if (!hasPassingPhaseSmoke) {
      missing.push(
        "record passing phase smoke via 'ycm-harness smoke run --phase <id> --command <cmd>'",
      );
    } else if (strictGatesEnabled() && !phaseSmokes.some((s) => s.outcome === "pass" && smokeHasExecutionProof(s))) {
      missing.push("validate phase pass smoke must be executed (smoke run), not manually recorded");
    }
    const reviewOutputs = goalArtifactsOfKind(state, phase.goal_id, "review-output");
    if (strictGatesEnabled() && reviewOutputs.length < 1) {
      missing.push(
        `register 1 review-output artifact from the combined independent reviewer (have ${reviewOutputs.length})`,
      );
    }
    if (!hasRitual(state, phase.id, "review-gate")) {
      missing.push("record a complete review-gate ritual for the validate phase");
    }
    if (!passedReviewForPhase(state, phase.id)) {
      missing.push("close a passed review session targeting the validate phase");
    }
  }

  if (phase.kind === "finish") {
    if (goalArtifactsOfKind(state, phase.goal_id, "progress").length < 1) {
      missing.push(
        "register a progress artifact (ycm-harness artifact register --kind progress --path <file>)",
      );
    }
    if (!hasRitual(state, phase.id, "project-wiki-update")) {
      missing.push("record a complete project-wiki-update ritual for the finish phase");
    }
    if (!phaseCheckpoints(state, phase.id).some((c) => c.kind === "manual")) {
      missing.push("record a final manual checkpoint in the finish phase");
    }
  }

  return { allowed: missing.length === 0, missing };
}

export function formatPhaseGateFailure(phase: PhaseT, missing: string[]): string {
  return [
    `Cannot leave '${phase.kind}' phase; strict SOP gate is not satisfied.`,
    ...missing.map((m) => `- ${m}`),
  ].join("\n");
}

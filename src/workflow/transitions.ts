import type { PhaseKindT, PhaseStatusT } from "../schema/phase.js";

export const PHASE_ORDER: PhaseKindT[] = [
  "explore",
  "discuss",
  "design",
  "plan",
  "execute",
  "validate",
  "finish",
];

export const FIRST_PHASE: PhaseKindT = PHASE_ORDER[0] as PhaseKindT;

export interface TransitionRequest {
  current?: PhaseKindT | undefined;
  target: PhaseKindT;
}

export interface TransitionDecision {
  allowed: boolean;
  reason?: string;
}

export function evaluatePhaseTransition(req: TransitionRequest): TransitionDecision {
  const { current, target } = req;
  if (current === target) {
    return { allowed: true };
  }
  if (!current) {
    if (target === FIRST_PHASE) return { allowed: true };
    return {
      allowed: false,
      reason: `First phase must be '${FIRST_PHASE}'. Got '${target}'. Run 'phase start ${FIRST_PHASE}' first.`,
    };
  }
  const fromIdx = PHASE_ORDER.indexOf(current);
  const toIdx = PHASE_ORDER.indexOf(target);
  if (fromIdx === -1 || toIdx === -1) {
    return { allowed: false, reason: `Unknown phase: ${current} -> ${target}` };
  }
  if (toIdx === fromIdx + 1) {
    return { allowed: true };
  }
  if (toIdx < fromIdx) {
    return {
      allowed: true,
      reason: "Rolling back to an earlier phase. Recent decisions may be revisited.",
    };
  }
  return {
    allowed: false,
    reason: `Cannot skip from '${current}' directly to '${target}'. Move one phase at a time.`,
  };
}

export function isTerminalPhaseStatus(status: PhaseStatusT): boolean {
  return status === "complete" || status === "skipped";
}

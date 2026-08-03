import type { ReviewSessionT, SeverityT } from "../schema/review.js";
import { FIX_LOOP_MAX_ROUNDS } from "../schema/review.js";
import { checkSessionProvenance } from "../enforcement/review-provenance.js";
import { strictGatesEnabled } from "../enforcement/strict-mode.js";
import type { StateT } from "../schema/state.js";

export const MIN_SCORE = 82.3;
export const MAX_FIX_LOOP_ROUNDS = FIX_LOOP_MAX_ROUNDS;

export interface ReviewAggregate {
  min_score: number | null;
  reviewer_count: number;
  by_severity: Record<SeverityT, number>;
  unresolved_by_severity: Record<SeverityT, number>;
  meets_score: boolean;
  meets_severity_gate: boolean;
  // Open findings that hard-block the gate. Only `high` blocks; `medium` is
  // orchestrator-discretion and `low` is deferred, both draining to followups.
  open_blocking: number;
}

export function aggregateReview(session: ReviewSessionT): ReviewAggregate {
  // Legacy split-role verdicts remain parseable for old state, but they are not
  // inputs to the new combined-reviewer gate.
  const combined = session.verdicts.combined_reviewer;
  const verdicts = combined ? [combined] : [];
  const minScore = verdicts.length === 0 ? null : Math.min(...verdicts.map((v) => v.score));
  const bySeverity: Record<SeverityT, number> = { high: 0, medium: 0, low: 0 };
  const unresolved: Record<SeverityT, number> = { high: 0, medium: 0, low: 0 };
  for (const f of Object.values(session.findings)) {
    bySeverity[f.severity]++;
    if (!f.resolved) unresolved[f.severity]++;
  }
  const meetsScore = minScore !== null && minScore >= MIN_SCORE;
  const openBlocking = unresolved.high;
  const meetsGate = openBlocking === 0;
  return {
    min_score: minScore,
    reviewer_count: verdicts.length,
    by_severity: bySeverity,
    unresolved_by_severity: unresolved,
    meets_score: meetsScore,
    meets_severity_gate: meetsGate,
    open_blocking: openBlocking,
  };
}

export interface GateDecision {
  status: "pending" | "needs_fix_loop" | "blocked" | "passed";
  reason: string;
}

export function decideGate(session: ReviewSessionT, state?: StateT): GateDecision {
  if (!session.verdicts.combined_reviewer) {
    return {
      status: "pending",
      reason: "Need a verdict from the combined independent reviewer before gating.",
    };
  }
  if (strictGatesEnabled() && state) {
    const prov = checkSessionProvenance(session, state);
    if (!prov.ok) {
      return {
        status: "needs_fix_loop",
        reason: `Review provenance failed: ${prov.violations[0] ?? "unknown"}`,
      };
    }
  }
  const agg = aggregateReview(session);
  if (agg.meets_score && agg.meets_severity_gate) {
    return {
      status: "passed",
      reason: `min_score met threshold and 0 open high findings.`,
    };
  }
  if (session.rounds.length >= MAX_FIX_LOOP_ROUNDS) {
    return {
      status: "blocked",
      reason: `Reached max ${MAX_FIX_LOOP_ROUNDS} fix-loop rounds with score below threshold or open high=${agg.open_blocking}. Delegate to human review.`,
    };
  }
  const scoreState = agg.meets_score ? "score met threshold" : "score below threshold";
  return {
    status: "needs_fix_loop",
    reason: `${scoreState}; open high=${agg.open_blocking}; round ${session.rounds.length + 1}/${MAX_FIX_LOOP_ROUNDS} required.`,
  };
}

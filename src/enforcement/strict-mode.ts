/**
 * Strict gates are on by default. Set YCM_HARNESS_STRICT_GATES=0 to relax
 * enforcement (tests only — never disable in production harness runs).
 */
export function strictGatesEnabled(): boolean {
  const raw = process.env.YCM_HARNESS_STRICT_GATES;
  if (raw === undefined || raw === "") return true;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

export function allowOrchestratorReview(): boolean {
  const raw = process.env.YCM_HARNESS_ALLOW_ORCHESTRATOR_REVIEW;
  if (raw === undefined || raw === "") return false;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/** Minimum seconds between review open and first verdict (anti instant-pass). */
export function reviewMinDeliberationSeconds(): number {
  const raw = process.env.YCM_HARNESS_REVIEW_MIN_SECONDS;
  if (raw === undefined || raw === "") return strictGatesEnabled() ? 5 : 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

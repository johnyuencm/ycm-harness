import fs from "node:fs/promises";
import path from "node:path";
import type { ReviewEvidenceT } from "../schema/review-evidence.js";
import { ReviewEvidence } from "../schema/review-evidence.js";
import type { ReviewSessionT } from "../schema/review.js";
import type { StateT } from "../schema/state.js";
import {
  allowOrchestratorReview,
  reviewMinDeliberationSeconds,
  strictGatesEnabled,
} from "./strict-mode.js";

export interface ProvenanceCheck {
  ok: boolean;
  violations: string[];
}

export async function loadReviewEvidence(absPath: string): Promise<ReviewEvidenceT> {
  const raw = await fs.readFile(absPath, "utf8");
  const parsed = JSON.parse(raw) as unknown;
  return ReviewEvidence.parse(parsed);
}

export function validateReviewEvidence(
  evidence: ReviewEvidenceT,
  opts: {
    sessionId: string;
    reviewer: string;
    allowOrchestrator?: boolean;
  },
): ProvenanceCheck {
  const violations: string[] = [];
  if (evidence.session_id !== opts.sessionId) {
    violations.push(`evidence session_id '${evidence.session_id}' != '${opts.sessionId}'`);
  }
  if (evidence.reviewer !== opts.reviewer) {
    violations.push(`evidence reviewer '${evidence.reviewer}' != '${opts.reviewer}'`);
  }
  if (evidence.checks_performed.length < 1) {
    violations.push("evidence checks_performed must list at least one check");
  }
  const allowOrch = opts.allowOrchestrator ?? allowOrchestratorReview();
  if (evidence.reviewer_source === "orchestrator" && !allowOrch) {
    violations.push(
      "orchestrator self-review blocked; dispatch one fresh combined reviewer and record reviewer_source=subagent",
    );
  }
  if (evidence.reviewer_source === "subagent") {
    if (!evidence.subagent_kind || evidence.subagent_kind.toLowerCase() === "orchestrator") {
      violations.push("subagent reviews require a distinct subagent_kind");
    }
  }
  if (evidence.findings.length === 0) {
    const reason = evidence.ack_zero_findings_reason?.trim() ?? "";
    if (reason.length < 20) {
      violations.push(
        "zero findings requires ack_zero_findings_reason (min 20 chars) explaining what was checked",
      );
    }
  }
  return { ok: violations.length === 0, violations };
}

export function checkSessionProvenance(
  session: ReviewSessionT,
  state: StateT,
): ProvenanceCheck {
  if (!strictGatesEnabled()) {
    return { ok: true, violations: [] };
  }
  const violations: string[] = [];
  const combined = session.verdicts.combined_reviewer;
  for (const [role, verdict] of combined ? [["combined_reviewer", combined] as const] : []) {
    if (!verdict.evidence_file) {
      violations.push(`${role}: missing evidence_file (use review verdict --evidence-file)`);
      continue;
    }
    if (!verdict.subagent_kind) {
      violations.push(`${role}: missing subagent_kind on verdict`);
    }
    if (verdict.reviewer_source === "orchestrator" && !allowOrchestratorReview()) {
      violations.push(`${role}: orchestrator-sourced verdict not permitted`);
    }
    if (verdict.evidence_artifact_id) {
      const art = state.artifacts[verdict.evidence_artifact_id];
      if (!art) {
        violations.push(`${role}: evidence artifact ${verdict.evidence_artifact_id} not registered`);
      } else if (art.kind !== "review-output") {
        violations.push(`${role}: evidence artifact must be kind review-output`);
      }
    } else {
      violations.push(
        `${role}: register evidence as review-output artifact before recording verdict`,
      );
    }
  }
  const minSec = reviewMinDeliberationSeconds();
  if (minSec > 0 && combined) {
    const firstAt = Date.parse(combined.recorded_at);
    const openedAt = Date.parse(session.opened_at);
    if (Number.isFinite(firstAt) && Number.isFinite(openedAt)) {
      const elapsed = (firstAt - openedAt) / 1000;
      if (elapsed < minSec) {
        violations.push(
          `review completed in ${elapsed.toFixed(1)}s (min ${minSec}s) — likely paperwork pass`,
        );
      }
    }
  }
  return { ok: violations.length === 0, violations };
}

function normPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export async function resolveEvidencePath(projectRoot: string, relOrAbs: string): Promise<string> {
  const abs = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(projectRoot, relOrAbs);
  await fs.access(abs);
  return abs;
}

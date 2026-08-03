import type { StateT } from "../schema/state.js";
import type { PhaseT } from "../schema/phase.js";
import type { TaskT } from "../schema/task.js";
import type { SmokeEvidenceT } from "../schema/smoke.js";
import { verifySmokeBatch, verifySmokeIntegrityBatch } from "./smoke-verify.js";
import { checkSessionProvenance } from "./review-provenance.js";
import { decideGate } from "../review/policy.js";
import { execGit, isGitRepo } from "../git/worktree.js";

function phaseTasks(state: StateT, phaseId: string): TaskT[] {
  return Object.values(state.tasks).filter((t) => t.phase_id === phaseId);
}

function phaseSmoke(state: StateT, phaseId: string): SmokeEvidenceT[] {
  return Object.values(state.smoke).filter((s) => s.phase_id === phaseId);
}

function taskSmoke(state: StateT, task: TaskT): SmokeEvidenceT[] {
  return task.smoke_evidence_ids
    .map((id) => state.smoke[id])
    .filter((s): s is SmokeEvidenceT => Boolean(s));
}

export async function verifyPhaseGatesAsync(
  state: StateT,
  phase: PhaseT,
  projectRoot: string,
): Promise<string[]> {
  const failures: string[] = [];

  if (phase.kind === "execute") {
    for (const task of phaseTasks(state, phase.id)) {
      if (task.status !== "done" || task.smoke !== "required") continue;
      const smokes = taskSmoke(state, task);
      const passing = smokes.filter((s) => s.outcome === "pass");
      if (passing.length === 0) continue;
      const results = await verifySmokeIntegrityBatch(passing, projectRoot);
      for (const r of results.filter((x) => !x.ok)) {
        failures.push(`task ${task.id} smoke ${r.smoke_id}: ${r.reason}`);
      }
    }
    if (await isGitRepo(projectRoot)) {
      const recorded: Array<{ taskId: string; sha: string }> = [];
      for (const task of phaseTasks(state, phase.id)) {
        if (task.status !== "done" || !task.code_changed) continue;
        const commits = Object.values(state.commits ?? {}).filter((c) => c.task_id === task.id);
        recorded.push(...commits.map((c) => ({ taskId: task.id, sha: c.sha })));
      }
      const unique = [
        ...new Set(recorded.map((c) => c.sha).filter((sha) => !/[\r\n]/.test(sha))),
      ];
      if (unique.length > 0) {
        const git = await execGit(
          ["cat-file", "--batch-check=%(objectname) %(objecttype)"],
          projectRoot,
          `${unique.join("\n")}\n`,
        );
        const lines = git.stdout.trimEnd().split(/\r?\n/);
        const isCommit = new Map(
          unique.map((sha, index) => [
            sha,
            git.code === 0 && lines[index]?.endsWith(" commit"),
          ]),
        );
        for (const c of recorded) {
          if (/[\r\n]/.test(c.sha) || !isCommit.get(c.sha)) {
            failures.push(`task ${c.taskId} commit ${c.sha.slice(0, 8)} not found in git`);
          }
        }
      }
    }
  }

  if (phase.kind === "validate") {
    const phaseSmokes = phaseSmoke(state, phase.id).filter((s) => s.outcome === "pass");
    const smokeResults = await verifySmokeBatch(phaseSmokes, projectRoot);
    for (const r of smokeResults.filter((x) => !x.ok)) {
      failures.push(`validate phase smoke ${r.smoke_id}: ${r.reason}`);
    }
    for (const session of Object.values(state.reviews)) {
      if (session.target_kind !== "phase" || session.target_id !== phase.id) continue;
      const gate = decideGate(session, state);
      const prov = checkSessionProvenance(session, state);
      if (!prov.ok) {
        failures.push(...prov.violations.map((v) => `review ${session.id}: ${v}`));
      }
      if (session.status === "passed" && gate.status !== "passed") {
        failures.push(`review ${session.id}: closed passed but gate is ${gate.status}`);
      }
    }
  }

  return failures;
}

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { runShellCommand, writeCommandLog, type CommandRunResult } from "../enforcement/exec-command.js";
import { type EvidencePointerT, type StateV3T, type TicketT } from "../schema/v3.js";
import { nowIso, shortId } from "../state/ids.js";

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const execFileAsync = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
  try {
    const result = await execFileAsync("git", args, { cwd: root, windowsHide: true, encoding: "utf8" });
    return String(result.stdout).trim();
  } catch {
    throw new Error(`git ${args[0] ?? "command"} failed.`);
  }
}

/** The immutable input to a ticket submission. A dirty tree is never accepted. */
export async function submissionDigest(root: string, ticket: TicketT): Promise<string> {
  const acceptance = sha(JSON.stringify(ticket.acceptance));
  if (!ticket.code_changed) return sha(JSON.stringify({ ticket_id: ticket.id, acceptance, commit: "none", tree: "none", dirty: "none" }));
  const dirty = await git(root, ["status", "--porcelain"]);
  if (dirty) throw new Error("Code-changing ticket submissions require a clean worktree.");
  const commit = await git(root, ["rev-parse", "HEAD"]);
  const tree = await git(root, ["rev-parse", "HEAD^{tree}"]);
  return sha(JSON.stringify({ ticket_id: ticket.id, acceptance, commit, tree, dirty: sha(dirty) }));
}

export function validateKnowledge(state: StateV3T, knowledge: string[]): string[] {
  const values = [...new Set(knowledge.map((value) => value.trim()).filter(Boolean))];
  if (values.length === 0 || values.every((value) => value.toLowerCase() === "none")) return ["none"];
  if (values.some((value) => value.toLowerCase() === "none")) throw new Error("Knowledge must be none or project-wiki page IDs, not both.");
  for (const id of values) if (!state.wiki.pages[id]) throw new Error(`Unknown project-wiki page: ${id}`);
  return values;
}

export interface VerificationInput {
  root: string;
  ticket: TicketT;
  command: string;
  implementerRun: string;
  verifierRun: string;
  knowledge: string[];
  evidenceFile?: string;
}

export function evidenceRoot(projectRoot: string, goal: { worktree_path?: string }): string {
  return goal.worktree_path ? path.resolve(projectRoot, goal.worktree_path) : projectRoot;
}

export async function executeVerification(input: VerificationInput): Promise<{
  pointer: EvidencePointerT;
  result: CommandRunResult;
}> {
  if (!input.implementerRun.trim() || !input.verifierRun.trim() || input.implementerRun === input.verifierRun) {
    throw new Error("Verification requires distinct implementer and verifier run IDs.");
  }
  const result = await runShellCommand(input.command, input.root);
  const id = `evidence-${shortId().slice(0, 8)}`;
  const log = await writeCommandLog(path.join(input.root, ".ycm-harness"), id, result);
  const pointer: EvidencePointerT = {
    id,
    goal_id: input.ticket.goal_id,
    ticket_id: input.ticket.id,
    kind: "verification",
    evidence_digest: result.sha256,
    evidence_path: path.relative(input.root, log),
    command: input.command,
    outcome: result.exitCode === 0 ? "pass" : "fail",
    provenance: {
      implementer_run: input.implementerRun,
      verifier_run: input.verifierRun,
      knowledge: input.knowledge.join(","),
      submitted_at: nowIso(),
    },
    recorded_at: nowIso(),
  };
  if (input.evidenceFile) pointer.evidence_path = path.relative(input.root, input.evidenceFile);
  return { pointer, result };
}

export function completionEvidence(state: StateV3T, ticket: TicketT): EvidencePointerT | undefined {
  const submitted = Object.values(state.evidence)
    .filter((evidence) => evidence.ticket_id === ticket.id && evidence.submission_digest)
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
  if (!submitted?.submission_digest) return undefined;
  return Object.values(state.evidence)
    .filter((evidence) =>
      evidence.ticket_id === ticket.id
      && evidence.outcome === "pass"
      && evidence.submission_digest === submitted.submission_digest
      && !!evidence.provenance.implementer_run
      && !!evidence.provenance.verifier_run
      && evidence.provenance.implementer_run !== evidence.provenance.verifier_run,
    )
    .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
}

export async function freshCompletionEvidence(root: string, state: StateV3T, ticket: TicketT): Promise<EvidencePointerT | undefined> {
  const evidence = completionEvidence(state, ticket);
  if (!evidence?.submission_digest) return undefined;
  return await submissionDigest(root, ticket) === evidence.submission_digest ? evidence : undefined;
}



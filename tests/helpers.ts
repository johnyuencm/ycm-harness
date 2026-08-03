import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";

// Tests use real strict gates but skip artificial review timing delays.
process.env.YCM_HARNESS_REVIEW_MIN_SECONDS ??= "0";

export async function tempProject(prefix = "ch-"): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  return root;
}

export async function evidenceFile(root: string, name: string): Promise<string> {
  const file = path.join(root, `${name}.md`);
  await fs.writeFile(file, `${name} evidence`, "utf8");
  return file;
}

export interface CliRunArgs {
  program: Command;
  args: string[];
}

/**
 * Satisfy the V5 explore-phase exit gate inside a test:
 * - register two explore-report artifacts and one explore-synthesis artifact
 * - record explore-codebase and explore-knowledge-base rituals
 * Requires the program to already be sitting on an active goal with `phase start explore` invoked by the caller.
 */
export async function satisfyDiscussGate(
  root: string,
  runProgram: (args: string[]) => Promise<void>,
): Promise<void> {
  const us = await evidenceFile(root, "user-story");
  const prd = await evidenceFile(root, "prd");
  await runProgram(["artifact", "register", "--kind", "user-story", "--path", us, "--summary", "user story"]);
  await runProgram(["artifact", "register", "--kind", "prd", "--path", prd, "--summary", "prd"]);
  await runProgram([
    "ritual",
    "record",
    "--kind",
    "grill-me",
    "--evidence-file",
    await evidenceFile(root, "grill-me"),
    "--summary",
    "discuss complete",
  ]);
  await runProgram(["checkpoint", "decision", "Discuss resolved", "-d", "Resolved"]);
}

export async function satisfyDesignGate(
  root: string,
  runProgram: (args: string[]) => Promise<void>,
): Promise<void> {
  const design = await evidenceFile(root, "design");
  await runProgram(["artifact", "register", "--kind", "design", "--path", design, "--summary", "design"]);
}

export async function satisfyPlanGate(
  root: string,
  runProgram: (args: string[]) => Promise<void>,
): Promise<void> {
  const impl = await evidenceFile(root, "implementation-plan");
  const test = await evidenceFile(root, "test-plan");
  await runProgram([
    "artifact",
    "register",
    "--kind",
    "implementation-plan",
    "--path",
    impl,
    "--summary",
    "plan",
  ]);
  await runProgram(["artifact", "register", "--kind", "test-plan", "--path", test, "--summary", "tests"]);
  await runProgram([
    "ritual",
    "record",
    "--kind",
    "writing-plans",
    "--evidence-file",
    await evidenceFile(root, "writing-plans"),
    "--summary",
    "plan",
    "--meta",
    "ralplan_required=false",
  ]);
}

export async function satisfyExploreGate(
  root: string,
  runProgram: (args: string[]) => Promise<void>,
): Promise<void> {
  const synth = await evidenceFile(root, "explore-synthesis");
  const reportA = await evidenceFile(root, "explore-report-a");
  const reportB = await evidenceFile(root, "explore-report-b");
  const kb = await evidenceFile(root, "explore-knowledge-base");
  await runProgram(["artifact", "register", "--kind", "explore-report", "--path", reportA, "--summary", "scope a"]);
  await runProgram(["artifact", "register", "--kind", "explore-report", "--path", reportB, "--summary", "scope b"]);
  await runProgram(["artifact", "register", "--kind", "explore-synthesis", "--path", synth, "--summary", "synthesis"]);
  await runProgram(["ritual", "record", "--kind", "explore-codebase", "--evidence-file", synth, "--summary", "codebase complete"]);
  await runProgram(["ritual", "record", "--kind", "explore-knowledge-base", "--evidence-file", kb, "--summary", "kb complete"]);
}

export async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/** Cross-platform no-op command that exits 0 for smoke run tests. */
export function trivialSmokeCommand(): string {
  return process.platform === "win32" ? "cmd /c echo smoke-ok" : "echo smoke-ok";
}

/** Linux-only: O_DIRECTORY/O_NOFOLLOW + /proc/self/fd pinned reads. */
export const isLinuxDescriptorFs = process.platform === "linux";

/** Skip when descriptor-relative pinning is unavailable (non-Linux). Returns true if skipped. */
export function skipUnlessLinux(
  t: { skip: (message?: string) => void },
  detail = "requires Linux descriptor-relative filesystem support",
): boolean {
  if (isLinuxDescriptorFs) return false;
  t.skip(detail);
  return true;
}

export async function runSmokePass(
  root: string,
  runProgram: (args: string[]) => Promise<void>,
  opts: { task?: string; phase?: string; command?: string },
): Promise<void> {
  const args = ["smoke", "run", "-c", opts.command ?? trivialSmokeCommand()];
  if (opts.task) args.push("--task", opts.task);
  if (opts.phase) args.push("--phase", opts.phase);
  await runProgram(args);
}

export async function writeReviewEvidence(
  root: string,
  sessionId: string,
  reviewer: "combined_reviewer",
  subagentKind: string,
  score: number,
  findings: Array<{ severity: "high" | "medium" | "low"; title: string; notes?: string }> = [],
): Promise<string> {
  const file = path.join(root, `review-${reviewer}.json`);
  const body = {
    schema_version: 1,
    session_id: sessionId,
    reviewer,
    score,
    reviewer_source: "subagent",
    subagent_kind: subagentKind,
    reviewed_at: new Date().toISOString(),
    recommendation: "ok",
    checks_performed: ["inspected diff", "ran smoke"],
    findings,
    ack_zero_findings_reason:
      findings.length === 0
        ? "Reviewed diff and re-ran smoke; no high/medium issues found in scope."
        : undefined,
    scope_summary: sessionId,
  };
  await fs.writeFile(file, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  return file;
}

export async function submitReviewVerdict(
  root: string,
  runProgram: (args: string[]) => Promise<void>,
  sessionId: string,
  reviewer: "combined_reviewer",
  subagentKind: string,
  score: number,
  findings: Array<{ severity: "high" | "medium" | "low"; title: string; notes?: string }> = [],
): Promise<void> {
  const evidence = await writeReviewEvidence(root, sessionId, reviewer, subagentKind, score, findings);
  await runProgram([
    "artifact",
    "register",
    "--kind",
    "review-output",
    "--path",
    evidence,
    "--summary",
    `${reviewer} review`,
  ]);
  await runProgram([
    "review",
    "verdict",
    "--session",
    sessionId,
    "--reviewer",
    reviewer,
    "--evidence-file",
    evidence,
  ]);
}

export async function passReviewSession(
  root: string,
  runProgram: (args: string[]) => Promise<void>,
  sessionId: string,
): Promise<void> {
  await submitReviewVerdict(root, runProgram, sessionId, "combined_reviewer", "combined_reviewer", 92);
  await runProgram(["review", "close", sessionId]);
}

/** Serialize HOME mutation — parallel tests racing process.env.YCM_HARNESS_HOME flake installs. */
let withTempUserHomeLock: Promise<void> = Promise.resolve();

export async function withTempUserHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const previous = withTempUserHomeLock;
  withTempUserHomeLock = previous.then(() => gate);
  await previous;
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "ch-userhome-"));
  const prev = process.env.YCM_HARNESS_HOME;
  process.env.YCM_HARNESS_HOME = home;
  try {
    return await fn(home);
  } finally {
    if (prev === undefined) delete process.env.YCM_HARNESS_HOME;
    else process.env.YCM_HARNESS_HOME = prev;
    await cleanup(home);
    release();
  }
}

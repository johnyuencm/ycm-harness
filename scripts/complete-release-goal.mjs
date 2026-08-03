#!/usr/bin/env node
/**
 * Drive one harness goal through explore → finish (for V6/V7/V8 release verification).
 * Usage: node scripts/complete-release-goal.mjs "Ship V6 design phase" v6
 */
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

const title = process.argv[2];
const tag = process.argv[3] ?? "release";
if (!title) {
  console.error("Usage: node scripts/complete-release-goal.mjs \"<goal title>\" <tag>");
  process.exit(1);
}

const root = process.cwd();
const cli = path.join(root, "dist", "cli", "index.js");
const evidenceDir = path.join(root, ".ycm-harness", "evidence", tag);
await fs.mkdir(evidenceDir, { recursive: true });

async function evidence(name) {
  const file = path.join(evidenceDir, `${name}.md`);
  await fs.writeFile(file, `${name} evidence for ${title}\n`, "utf8");
  return file;
}

function run(...args) {
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (r.status !== 0) {
    throw new Error(
      `ycm-harness ${args.join(" ")}\n${r.stderr || r.stdout || `exit ${r.status}`}`,
    );
  }
  return (r.stdout || "").trim();
}

async function satisfyExplore() {
  const synth = await evidence("explore-synthesis");
  const a = await evidence("explore-report-a");
  const b = await evidence("explore-report-b");
  const kb = await evidence("explore-kb");
  run("artifact", "register", "--kind", "explore-report", "--path", a, "--summary", "scope a");
  run("artifact", "register", "--kind", "explore-report", "--path", b, "--summary", "scope b");
  run("artifact", "register", "--kind", "explore-synthesis", "--path", synth, "--summary", "synthesis");
  run("ritual", "record", "--kind", "explore-codebase", "--evidence-file", synth, "--summary", "codebase");
  run("ritual", "record", "--kind", "explore-knowledge-base", "--evidence-file", kb, "--summary", "kb");
}

async function satisfyDiscuss() {
  run("artifact", "register", "--kind", "user-story", "--path", await evidence("user-story"), "--summary", "story");
  run("artifact", "register", "--kind", "prd", "--path", await evidence("prd"), "--summary", "prd");
  run("ritual", "record", "--kind", "grill-me", "--evidence-file", await evidence("grill-me"), "--summary", "discuss");
  run("checkpoint", "decision", `${tag} discuss resolved`, "-d", "Resolved");
}

async function satisfyDesign() {
  run("artifact", "register", "--kind", "design", "--path", await evidence("design"), "--summary", "design");
}

async function satisfyPlan() {
  run("artifact", "register", "--kind", "implementation-plan", "--path", await evidence("impl-plan"), "--summary", "plan");
  run("artifact", "register", "--kind", "test-plan", "--path", await evidence("test-plan"), "--summary", "tests");
  run(
    "ritual",
    "record",
    "--kind",
    "writing-plans",
    "--evidence-file",
    await evidence("writing-plans"),
    "--summary",
    "plan",
    "--meta",
    "ralplan_required=false",
  );
}

async function satisfyExecute(taskId, { teamExecution = false } = {}) {
  run("ritual", "record", "--kind", "ultrawork", "--evidence-file", await evidence("ultrawork"), "--summary", "uw");
  run("ritual", "record", "--kind", "ralph", "--evidence-file", await evidence("ralph"), "--summary", "ralph");
  if (teamExecution) {
    run(
      "ritual",
      "record",
      "--kind",
      "team-execution",
      "--evidence-file",
      await evidence("team-execution"),
      "--summary",
      "lanes",
      "--meta",
      "lanes=3",
    );
  }
  run("task", "start", taskId);
  run(
    "smoke",
    "--task",
    taskId,
    "--outcome",
    "pass",
    "--command",
    "npm test",
    "--expected",
    "pass",
    "--actual",
    "pass",
    "--exit",
    "0",
  );
  run("task", "done", taskId);
  run("commit", "record", "--task", taskId, "--sha", "0000000000000000", "--summary", `${tag} ship`);
}

async function satisfyValidate(phaseId) {
  run(
    "smoke",
    "--phase",
    phaseId,
    "--outcome",
    "pass",
    "--command",
    "npm test",
    "--expected",
    "pass",
    "--actual",
    "pass",
    "--exit",
    "0",
  );
  let sessionId;
  const nextRaw = run("next", "--json");
  const next = JSON.parse(nextRaw);
  const existing = next.command?.match(/review status (rev_[^\s]+)/);
  if (existing) {
    sessionId = existing[1];
  } else {
    const opened = run("review", "start", "--target", "phase", "--id", phaseId);
    const line = opened.split("\n").find((l) => l.trim().startsWith("Review session opened: "));
    sessionId = line?.replace(/^Review session opened:\s*/i, "").trim();
  }
  if (!sessionId?.startsWith("rev_")) throw new Error(`no review session: ${nextRaw}`);
  run("review", "verdict", "--session", sessionId, "--reviewer", "combined_reviewer", "--score", "95");
  run("review", "close", sessionId);
  run("ritual", "record", "--kind", "review-gate", "--evidence-file", await evidence("review-gate"), "--summary", "review");
}

async function satisfyFinish() {
  run("artifact", "register", "--kind", "progress", "--path", await evidence("progress"), "--summary", "done");
  run("ritual", "record", "--kind", "project-wiki-update", "--evidence-file", await evidence("wiki"), "--summary", "wiki");
  run("checkpoint", "manual", `${tag} goal closed`);
}

function parseTaskId(listOut) {
  const m = listOut.match(/\(task_[^)]+\)/);
  if (!m) throw new Error(`no task in: ${listOut}`);
  return m[0].slice(1, -1);
}

function phaseIdFromNext() {
  const raw = run("next", "--json");
  const j = JSON.parse(raw);
  if (!j.phase_id) throw new Error(`no phase_id in next: ${raw}`);
  return j.phase_id;
}

console.log(`Creating goal: ${title}`);
run("goal", "create", title);
try {
  run("goal", "worktree", "init");
} catch (e) {
  console.warn("worktree init:", e.message?.split("\n")[0] ?? e);
}

run("phase", "start", "explore");
await satisfyExplore();
run("phase", "start", "discuss");
await satisfyDiscuss();
run("phase", "start", "design");
await satisfyDesign();
run("phase", "start", "plan");
run("task", "create", `${tag} verification task`, "--smoke", "required");
await satisfyPlan();
const taskId = parseTaskId(run("task", "list"));
run("phase", "start", "execute");
await satisfyExecute(taskId, { teamExecution: tag.startsWith("v7") });
run("phase", "start", "validate");
const validatePhaseId = phaseIdFromNext();
await satisfyValidate(validatePhaseId);
run("phase", "start", "finish");
await satisfyFinish();
run("phase", "complete");
try {
  run("goal", "worktree", "finish");
} catch {
  /* optional if worktree missing */
}
console.log(run("goal", "status", "--json"));

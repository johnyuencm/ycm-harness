import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  tempProject,
  cleanup,
  withTempUserHome,
  satisfyExploreGate,
  satisfyDiscussGate,
  satisfyDesignGate,
  satisfyPlanGate,
  submitReviewVerdict,
  writeReviewEvidence,
  passReviewSession,
} from "./helpers.js";
import { createContext } from "../src/cli/context.js";
import type { CliOutput } from "../src/cli/output.js";
import { registerInit } from "../src/cli/commands/init.js";
import { registerGoal } from "../src/cli/commands/goal.js";
import { registerPhase } from "../src/cli/commands/phase.js";
import { registerTask } from "../src/cli/commands/task.js";
import { registerHook } from "../src/cli/commands/hook.js";
import { registerCheckpoint } from "../src/cli/commands/checkpoint.js";
import { registerSmoke } from "../src/cli/commands/smoke.js";
import { registerWiki } from "../src/cli/commands/wiki.js";
import { registerUserWiki } from "../src/cli/commands/user-wiki.js";
import { registerReview } from "../src/cli/commands/review.js";
import { registerSession } from "../src/cli/commands/session.js";
import { registerCaveman } from "../src/cli/commands/caveman.js";
import { registerRitual } from "../src/cli/commands/ritual.js";
import { registerArtifact } from "../src/cli/commands/artifact.js";

import { redact, BUILTIN_RULES, compileAllowList } from "../src/wiki/redact.js";
import {
  ReviewSession,
  Finding,
  ReviewerVerdict,
  FixLoopRound,
} from "../src/schema/review.js";
import { aggregateReview, decideGate, MIN_SCORE, MAX_FIX_LOOP_ROUNDS } from "../src/review/policy.js";
import { computeNudge, NUDGE_THRESHOLD, tickUserMessage, resetOnWikiWrite } from "../src/session/nudge.js";
import { caveman } from "../src/caveman/compress.js";
import {
  UserHarnessState,
  emptyUserState,
} from "../src/schema/user-state.js";

interface CapturedOutput extends CliOutput {
  stdout: string[];
  stderr: string[];
  jsons: unknown[];
}

function captureOutput(): CapturedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const jsons: unknown[] = [];
  return {
    out(text) {
      stdout.push(text);
    },
    err(text) {
      stderr.push(text);
    },
    json(value) {
      jsons.push(value);
      stdout.push(JSON.stringify(value));
    },
    stdout,
    stderr,
    jsons,
  };
}

function buildProgram(cwd: string, out: CliOutput): Command {
  const ctx = createContext(cwd);
  const program = new Command();
  program.name("ycm-harness").exitOverride();
  registerInit(program, ctx, out);
  registerGoal(program, ctx, out);
  registerPhase(program, ctx, out);
  registerTask(program, ctx, out);
  registerHook(program, ctx, out);
  registerCheckpoint(program, ctx, out);
  registerSmoke(program, ctx, out);
  registerWiki(program, ctx, out);
  registerUserWiki(program, ctx, out);
  registerReview(program, ctx, out);
  registerSession(program, ctx, out);
  registerCaveman(program, ctx, out);
  registerRitual(program, ctx, out);
  registerArtifact(program, ctx, out);
  return program;
}

async function advanceToDiscuss(root: string, out: CapturedOutput): Promise<void> {
  await run(root, out, ["phase", "start", "explore"]);
  await satisfyExploreGate(root, async (args) => run(root, out, args));
  await run(root, out, ["phase", "start", "discuss"]);
}

async function run(cwd: string, out: CapturedOutput, args: string[]): Promise<void> {
  const program = buildProgram(cwd, out);
  await program.parseAsync(args, { from: "user" });
}

async function evidence(root: string, name: string): Promise<string> {
  const file = path.join(root, `${name}.md`);
  await fs.writeFile(file, `${name} evidence`, "utf8");
  return file;
}

async function recordRitual(
  root: string,
  out: CapturedOutput,
  kind: string,
  meta: string[] = [],
): Promise<void> {
  const args = [
    "ritual",
    "record",
    "--kind",
    kind,
    "--evidence-file",
    await evidence(root, `ritual-${kind}`),
    "--summary",
    `${kind} complete`,
  ];
  for (const m of meta) args.push("--meta", m);
  await run(root, out, args);
}

async function satisfyDiscuss(root: string, out: CapturedOutput): Promise<void> {
  await satisfyDiscussGate(root, async (args) => run(root, out, args));
}

async function satisfyPlan(root: string, out: CapturedOutput): Promise<void> {
  await satisfyPlanGate(root, async (args) => run(root, out, args));
}

async function extractTaskId(lines: string[]): Promise<string> {
  for (const line of lines) {
    const m = line.match(/\((task_[^)]+)\)/);
    if (m) return m[1];
  }
  throw new Error(`couldn't extract task id from ${lines.join("|")}`);
}

async function startExecuteWithTask(
  root: string,
  out: CapturedOutput,
  title = "Subject",
): Promise<string> {
  await advanceToDiscuss(root, out);
  await satisfyDiscuss(root, out);
  await run(root, out, ["phase", "start", "design"]);
  await satisfyDesignGate(root, async (args) => run(root, out, args));
  await run(root, out, ["phase", "start", "plan"]);
  await run(root, out, ["task", "create", title]);
  await satisfyPlan(root, out);
  await run(root, out, ["phase", "start", "execute"]);
  out.stdout.length = 0;
  await run(root, out, ["task", "list"]);
  const taskId = await extractTaskId(out.stdout);
  await run(root, out, ["task", "start", taskId]);
  return taskId;
}


test("UserHarnessState parses with defaults and round-trips", () => {
  const empty = emptyUserState(new Date().toISOString());
  const parsed = UserHarnessState.parse(empty);
  assert.equal(parsed.wiki.initialized, false);
  assert.equal(Object.keys(parsed.wiki.pages).length, 0);
});

test("redact strips builtin secrets and respects allowlist", () => {
  const openAiFixture = "sk-" + "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
  const githubFixture = "ghp_" + "abcdefghijklmnopqrstuvwxyz0123456789";
  const input = `Email me at john@example.com on 192.168.1.10. Key ${openAiFixture}. GitHub ${githubFixture}. Allowed: shared@example.com.`;
  const allow = compileAllowList(["shared@example\\.com"]);
  const r = redact(input, { allow });
  assert.match(r.redacted, /<redacted:email>/);
  assert.match(r.redacted, /<redacted:ip>/);
  assert.match(r.redacted, /<redacted:openai-key>/);
  assert.match(r.redacted, /<redacted:github-token>/);
  assert.match(r.redacted, /shared@example\.com/);
  const ruleIds = new Set(r.findings.map((f) => f.rule_id));
  assert.ok(ruleIds.has("email"));
  assert.ok(ruleIds.has("ipv4"));
  assert.ok(ruleIds.has("openai-key"));
  assert.ok(ruleIds.has("github-token"));
  assert.ok(!r.findings.some((f) => f.match.includes("shared@example.com")));
});

test("BUILTIN_RULES include private-key block detection", () => {
  const ruleIds = new Set(BUILTIN_RULES.map((r) => r.id));
  for (const id of [
    "email",
    "ipv4",
    "absolute-home-unix",
    "absolute-home-win",
    "openai-key",
    "anthropic-key",
    "github-token",
    "stripe-key",
    "aws-access-key",
    "private-key-block",
  ]) {
    assert.ok(ruleIds.has(id), `expected rule '${id}' in BUILTIN_RULES`);
  }
});

test("Review schemas validate verdicts, findings, and rounds", () => {
  const at = new Date().toISOString();
  const finding = Finding.parse({
    id: "find_x",
    severity: "high",
    title: "Bad thing",
    reviewer: "combined_reviewer",
  });
  assert.equal(finding.resolved, false);
  const verdict = ReviewerVerdict.parse({
    reviewer: "combined_reviewer",
    score: 88,
    finding_ids: ["find_x"],
    recorded_at: at,
  });
  assert.equal(verdict.score, 88);
  assert.equal(ReviewerVerdict.parse({ reviewer: "tech_lead", score: 80, recorded_at: at }).reviewer, "tech_lead");
  const round = FixLoopRound.parse({
    number: 1,
    rca: "x",
    evidence: "y",
    three_whys: "z",
    plan: "a",
    address_why: "b",
    fix: "c",
    recorded_at: at,
  });
  assert.equal(round.number, 1);
  const session = ReviewSession.parse({
    id: "rev_s",
    target_kind: "task",
    target_id: "task_y",
    goal_id: "goal_z",
    status: "open",
    opened_at: at,
  });
  assert.equal(session.status, "open");
  assert.equal(Object.keys(session.findings).length, 0);
});

test("aggregateReview/decideGate enforce score and severity gates", () => {
  const at = new Date().toISOString();
  const baseSession = ReviewSession.parse({
    id: "rev_a",
    target_kind: "task",
    target_id: "t_a",
    goal_id: "g_a",
    status: "open",
    opened_at: at,
  });
  const passing = {
    ...baseSession,
    verdicts: {
      combined_reviewer: ReviewerVerdict.parse({ reviewer: "combined_reviewer", score: 90, recorded_at: at }),
    },
  };
  assert.equal(decideGate(passing).status, "passed");
  assert.equal(aggregateReview(passing).meets_score, true);

  const failing = {
    ...passing,
    verdicts: {
      ...passing.verdicts,
      combined_reviewer: ReviewerVerdict.parse({ reviewer: "combined_reviewer", score: 70, recorded_at: at }),
    },
    findings: {
      f1: Finding.parse({ id: "f1", severity: "high", title: "x", reviewer: "combined_reviewer" }),
    },
  };
  assert.equal(decideGate(failing).status, "needs_fix_loop");

  const blocked = {
    ...failing,
    rounds: [
      FixLoopRound.parse({ number: 1, rca: "x", evidence: "y", three_whys: "z", plan: "p", address_why: "a", fix: "c", recorded_at: at }),
      FixLoopRound.parse({ number: 2, rca: "x", evidence: "y", three_whys: "z", plan: "p", address_why: "a", fix: "c", recorded_at: at }),
      FixLoopRound.parse({ number: 3, rca: "x", evidence: "y", three_whys: "z", plan: "p", address_why: "a", fix: "c", recorded_at: at }),
    ],
  };
  assert.equal(decideGate(blocked).status, "blocked");

  const legacyOnly = {
    ...baseSession,
    verdicts: {
      tech_lead: ReviewerVerdict.parse({ reviewer: "tech_lead", score: 90, recorded_at: at }),
    },
  };
  assert.equal(decideGate(legacyOnly).status, "pending");

  const migrated = {
    ...passing,
    verdicts: {
      tech_lead: ReviewerVerdict.parse({ reviewer: "tech_lead", score: 1, recorded_at: at }),
      ...passing.verdicts,
    },
  };
  assert.equal(aggregateReview(migrated).reviewer_count, 1);
  assert.equal(aggregateReview(migrated).min_score, 90);
  assert.equal(decideGate(migrated).status, "passed");

  assert.equal(MIN_SCORE, 82.3);
  assert.equal(MAX_FIX_LOOP_ROUNDS, 3);
});

test("session nudge counter increments on user_message and resets on wiki write", () => {
  let st = { user_msgs_since_wiki_write: 0 };
  const at = new Date().toISOString();
  for (let i = 0; i < NUDGE_THRESHOLD - 1; i++) {
    st = tickUserMessage(st, at);
  }
  assert.equal(computeNudge(st.user_msgs_since_wiki_write).due, false);
  st = tickUserMessage(st, at);
  assert.equal(computeNudge(st.user_msgs_since_wiki_write).due, true);
  st = resetOnWikiWrite(st, at);
  assert.equal(st.user_msgs_since_wiki_write, 0);
  assert.equal(computeNudge(st.user_msgs_since_wiki_write).due, false);
});

test("caveman compress preserves code/URL and strips fluff", () => {
  const input = "Sure! I would just basically really run `npm test` before pushing to https://github.com/example.\n\n```\nconsole.log('keep me');\n```\n\nOf course you might want to consider this approach. Use extensive logging in order to debug.";
  const out = caveman(input, { level: "full" });
  assert.match(out, /`npm test`/);
  assert.match(out, /https:\/\/github\.com\/example/);
  assert.match(out, /console\.log\('keep me'\);/);
  assert.doesNotMatch(out, /Sure!/);
  assert.doesNotMatch(out, /\bjust\b/);
  assert.doesNotMatch(out, /\bbasically\b/);
  assert.doesNotMatch(out, /Of course/);
  assert.doesNotMatch(out, /you might want to consider/i);
  assert.match(out, /\bbig\b/);
});

test("caveman lite keeps articles", () => {
  const input = "I would just basically run the tests in order to verify the change.";
  const out = caveman(input, { level: "lite" });
  assert.match(out, /\bthe\b/);
  assert.doesNotMatch(out, /\bjust\b/);
  assert.doesNotMatch(out, /\bbasically\b/);
  assert.doesNotMatch(out, /\bin order to\b/);
});

test("user-wiki golden path: init, redacted promote, page-show, lint", async () => {
  await withTempUserHome(async () => {
    const root = await tempProject();
    try {
      const out = captureOutput();
      const sourceFile = path.join(root, "doc.md");
      await fs.writeFile(sourceFile, "doc body", "utf8");

      await run(root, out, ["init"]);
      await run(root, out, ["goal", "create", "user wiki test"]);
      await advanceToDiscuss(root, out);
      await run(root, out, ["wiki", "init"]);
      await run(root, out, [
        "wiki",
        "source",
        "add",
        sourceFile,
        "--id",
        "src_one",
        "--title",
        "S",
      ]);
      const bodyFile = path.join(root, "page.md");
      await fs.writeFile(
        bodyFile,
        "Page body. Email: leak@example.com. Token: " + "ghp_" + "a".repeat(36) + ".",
        "utf8",
      );
      await run(root, out, [
        "wiki",
        "page",
        "upsert",
        "--id",
        "leaky",
        "--title",
        "Leaky",
        "--source",
        "src_one",
        "--body-file",
        bodyFile,
      ]);

      await run(root, out, ["user-wiki", "init"]);
      await run(root, out, ["wiki", "promote", "leaky", "--confirm"]);

      out.stdout.length = 0;
      await run(root, out, ["user-wiki", "page-show", "leaky"]);
      const userBody = out.stdout.join("\n");
      assert.match(userBody, /<redacted:email>/);
      assert.match(userBody, /<redacted:github-token>/);
      assert.doesNotMatch(userBody, /leak@example\.com/);
      assert.doesNotMatch(userBody, /ghp_a{36}/);

      out.jsons.length = 0;
      await run(root, out, ["user-wiki", "lint", "--json"]);
      const lint = out.jsons.at(-1) as { findings: string[]; count: number };
      assert.ok(lint.count >= 0);
    } finally {
      await cleanup(root);
    }
  });
});

test("review CLI golden path: open -> verdicts -> needs_fix_loop -> fix-loop record/resolve -> close passed with low drained", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "review test"]);
    const taskId = await startExecuteWithTask(root, out);

    out.stdout.length = 0;
    await run(root, out, ["review", "start", "--target", "task", "--id", taskId]);
    const sessionId = out.stdout.find((l) => l.startsWith("Review session opened: "))?.slice("Review session opened: ".length).trim();
    assert.ok(sessionId, `expected review session id, got ${out.stdout.join("|")}`);

    await submitReviewVerdict(root, async (a) => run(root, out, a), sessionId, "combined_reviewer", "combined_reviewer", 70, [
      { severity: "high", title: "Big issue", notes: "rationale" },
      { severity: "medium", title: "Mid issue" },
      { severity: "low", title: "Small UX nit" },
    ]);

    out.jsons.length = 0;
    await run(root, out, ["review", "status", sessionId, "--json"]);
    let status = out.jsons.at(-1) as { gate: string; min_score: number };
    assert.equal(status.gate, "needs_fix_loop");

    await run(root, out, ["review", "fix-loop", "start", sessionId]);
    await run(root, out, [
      "review",
      "fix-loop",
      "record",
      "--session",
      sessionId,
      "--round",
      "1",
      "--rca",
      "rca",
      "--evidence",
      "ev",
      "--three-whys",
      "w",
      "--plan",
      "p",
      "--address-why",
      "a",
      "--fix",
      "f",
    ]);

    const stateRaw = await fs.readFile(path.join(root, ".ycm-harness", "state.json"), "utf8");
    const state = JSON.parse(stateRaw);
    const findings = state.reviews[sessionId].findings as Record<string, { id: string; severity: string }>;
    const high = Object.values(findings).find((f) => f.severity === "high");
    const medium = Object.values(findings).find((f) => f.severity === "medium");
    assert.ok(high && medium, "expected high and medium findings on session");

    await run(root, out, [
      "review",
      "fix-loop",
      "resolve",
      "--session",
      sessionId,
      "--finding",
      high.id,
      "--round",
      "1",
    ]);
    await run(root, out, [
      "review",
      "fix-loop",
      "resolve",
      "--session",
      sessionId,
      "--finding",
      medium.id,
      "--round",
      "1",
    ]);

    await submitReviewVerdict(root, async (a) => run(root, out, a), sessionId, "combined_reviewer", "combined_reviewer", 89, [
      { severity: "low", title: "Small UX nit" },
    ]);

    out.jsons.length = 0;
    await run(root, out, ["review", "status", sessionId, "--json"]);
    status = out.jsons.at(-1) as { gate: string; min_score: number };
    assert.equal(status.gate, "passed");

    await run(root, out, ["review", "close", sessionId]);

    const followups = await fs
      .readFile(path.join(root, ".ycm-harness", "followups.md"), "utf8")
      .catch(() => "");
    assert.match(followups, /Small UX nit/);
  } finally {
    await cleanup(root);
  }
});

test("review close refuses while gate is needs_fix_loop", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "close-refuse test"]);
    const taskId = await startExecuteWithTask(root, out);
    out.stdout.length = 0;
    await run(root, out, ["review", "start", "--target", "task", "--id", taskId]);
    const sessionId = (out.stdout.find((l) => l.startsWith("Review session opened: ")) ?? "").slice("Review session opened: ".length).trim();
    await submitReviewVerdict(root, async (a) => run(root, out, a), sessionId, "combined_reviewer", "combined_reviewer", 60, [
      { severity: "high", title: "x" },
    ]);
    await assert.rejects(run(root, out, ["review", "close", sessionId]), /needs fix_loop/);
  } finally {
    await cleanup(root);
  }
});

test("session tick + nudge cycle through CLI", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    out.jsons.length = 0;
    await run(root, out, ["session", "nudge", "--json"]);
    let nudge = out.jsons.at(-1) as { due: boolean; count: number; threshold: number };
    assert.equal(nudge.due, false);
    assert.equal(nudge.count, 0);
    assert.equal(nudge.threshold, NUDGE_THRESHOLD);
    for (let i = 0; i < NUDGE_THRESHOLD; i++) {
      await run(root, out, ["session", "tick", "--kind", "user_message"]);
    }
    out.jsons.length = 0;
    await run(root, out, ["session", "nudge", "--json"]);
    nudge = out.jsons.at(-1) as { due: boolean; count: number; threshold: number };
    assert.equal(nudge.due, true);
    assert.equal(nudge.count, NUDGE_THRESHOLD);
    await run(root, out, ["session", "tick", "--kind", "wiki_write"]);
    out.jsons.length = 0;
    await run(root, out, ["session", "nudge", "--json"]);
    nudge = out.jsons.at(-1) as { due: boolean; count: number; threshold: number };
    assert.equal(nudge.due, false);
    assert.equal(nudge.count, 0);
  } finally {
    await cleanup(root);
  }
});

test("decideGate boundary at MIN_SCORE: 82.3 passes, 82.29 needs_fix_loop", () => {
  const at = new Date().toISOString();
  const base = ReviewSession.parse({
    id: "rev_b",
    target_kind: "task",
    target_id: "t_b",
    goal_id: "g_b",
    status: "open",
    opened_at: at,
  });
  const atBoundary = {
    ...base,
    verdicts: {
      combined_reviewer: ReviewerVerdict.parse({ reviewer: "combined_reviewer", score: MIN_SCORE, recorded_at: at }),
    },
  };
  assert.equal(decideGate(atBoundary).status, "passed");
  const justBelow = {
    ...atBoundary,
    verdicts: {
      ...atBoundary.verdicts,
      combined_reviewer: ReviewerVerdict.parse({ reviewer: "combined_reviewer", score: MIN_SCORE - 0.01, recorded_at: at }),
    },
  };
  assert.equal(decideGate(justBelow).status, "needs_fix_loop");
});

test("decideGate blocks when scores pass but a high finding is open", () => {
  const at = new Date().toISOString();
  const session = {
    ...ReviewSession.parse({
      id: "rev_h",
      target_kind: "task",
      target_id: "t_h",
      goal_id: "g_h",
      status: "open",
      opened_at: at,
    }),
    verdicts: {
      combined_reviewer: ReviewerVerdict.parse({ reviewer: "combined_reviewer", score: 95, recorded_at: at }),
    },
    findings: {
      f1: Finding.parse({ id: "f1", severity: "high", title: "open high", reviewer: "combined_reviewer" }),
    },
  };
  const gate = decideGate(session);
  assert.equal(gate.status, "needs_fix_loop");
  assert.doesNotMatch(gate.reason, /\b82\.3\b/);
});

test("decideGate passes with open medium/low findings when scores clear (medium is discretionary, low deferred)", () => {
  const at = new Date().toISOString();
  const session = {
    ...ReviewSession.parse({
      id: "rev_m",
      target_kind: "task",
      target_id: "t_m",
      goal_id: "g_m",
      status: "open",
      opened_at: at,
    }),
    verdicts: {
      combined_reviewer: ReviewerVerdict.parse({ reviewer: "combined_reviewer", score: 90, recorded_at: at }),
    },
    findings: {
      f1: Finding.parse({ id: "f1", severity: "medium", title: "open medium", reviewer: "combined_reviewer" }),
      f2: Finding.parse({ id: "f2", severity: "low", title: "open low", reviewer: "combined_reviewer" }),
    },
  };
  assert.equal(decideGate(session).status, "passed");
});

test("decideGate reasons never leak the literal threshold", () => {
  const at = new Date().toISOString();
  for (const score of [40, 70, MIN_SCORE - 0.01, MIN_SCORE, 100]) {
    const s = {
      ...ReviewSession.parse({
        id: "rev_l",
        target_kind: "task",
        target_id: "t_l",
        goal_id: "g_l",
        status: "open",
        opened_at: at,
      }),
      verdicts: {
        combined_reviewer: ReviewerVerdict.parse({ reviewer: "combined_reviewer", score, recorded_at: at }),
      },
    };
    const gate = decideGate(s);
    assert.doesNotMatch(gate.reason, /\b82\.3\b/);
    assert.doesNotMatch(gate.reason, /MIN_SCORE/);
  }
});

test("review prompt renders without leaking the score threshold", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "prompt test"]);
    const taskId = await startExecuteWithTask(root, out);
    out.stdout.length = 0;
    await run(root, out, ["review", "start", "--target", "task", "--id", taskId]);
    const sessionId = (out.stdout.find((l) => l.startsWith("Review session opened: ")) ?? "").slice("Review session opened: ".length).trim();
    out.stdout.length = 0;
    await run(root, out, ["review", "prompt", "--reviewer", "combined_reviewer", "--session", sessionId]);
    const blob = out.stdout.join("\n");
    assert.match(blob, /combined reviewer/i);
    assert.match(blob, new RegExp(sessionId));
    assert.doesNotMatch(blob, /\b82\.3\b/);
    assert.doesNotMatch(blob, /MIN_SCORE/);
    assert.doesNotMatch(blob, /threshold/i);
  } finally {
    await cleanup(root);
  }
});

test("fix-loop record enforces ordering and rejects duplicates", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "fl-order"]);
    const taskId = await startExecuteWithTask(root, out);
    out.stdout.length = 0;
    await run(root, out, ["review", "start", "--target", "task", "--id", taskId]);
    const sessionId = (out.stdout.find((l) => l.startsWith("Review session opened: ")) ?? "").slice("Review session opened: ".length).trim();
    await submitReviewVerdict(root, async (a) => run(root, out, a), sessionId, "combined_reviewer", "combined_reviewer", 70, [
      { severity: "high", title: "x" },
    ]);
    await run(root, out, ["review", "fix-loop", "start", sessionId]);
    await assert.rejects(
      run(root, out, [
        "review",
        "fix-loop",
        "record",
        "--session",
        sessionId,
        "--round",
        "2",
        "--rca",
        "x",
        "--evidence",
        "x",
        "--three-whys",
        "x",
        "--plan",
        "x",
        "--address-why",
        "x",
        "--fix",
        "x",
      ]),
      /Rounds must be recorded in order/,
    );
    await run(root, out, [
      "review",
      "fix-loop",
      "record",
      "--session",
      sessionId,
      "--round",
      "1",
      "--rca",
      "x",
      "--evidence",
      "x",
      "--three-whys",
      "x",
      "--plan",
      "x",
      "--address-why",
      "x",
      "--fix",
      "x",
    ]);
    await assert.rejects(
      run(root, out, [
        "review",
        "fix-loop",
        "record",
        "--session",
        sessionId,
        "--round",
        "1",
        "--rca",
        "x",
        "--evidence",
        "x",
        "--three-whys",
        "x",
        "--plan",
        "x",
        "--address-why",
        "x",
        "--fix",
        "x",
      ]),
      /already recorded/,
    );
  } finally {
    await cleanup(root);
  }
});

test("fix-loop start refuses non-open / non-fix_loop status", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "fl-guard"]);
    const taskId = await startExecuteWithTask(root, out);
    out.stdout.length = 0;
    await run(root, out, ["review", "start", "--target", "task", "--id", taskId]);
    const sessionId = (out.stdout.find((l) => l.startsWith("Review session opened: ")) ?? "").slice("Review session opened: ".length).trim();
    await passReviewSession(root, async (a) => run(root, out, a), sessionId);
    await assert.rejects(
      run(root, out, ["review", "fix-loop", "start", sessionId]),
      /Cannot start fix loop/,
    );
  } finally {
    await cleanup(root);
  }
});

test("wiki promote --dry-run does NOT write to user wiki", async () => {
  await withTempUserHome(async (home) => {
    const root = await tempProject();
    try {
      const out = captureOutput();
      await run(root, out, ["init"]);
      await run(root, out, ["goal", "create", "promote-dry"]);
      await advanceToDiscuss(root, out);
      await run(root, out, ["wiki", "init"]);
      const sourceFile = path.join(root, "doc.md");
      await fs.writeFile(sourceFile, "src", "utf8");
      await run(root, out, ["wiki", "source", "add", sourceFile, "--id", "src_x", "--title", "S"]);
      const bodyFile = path.join(root, "page.md");
      await fs.writeFile(bodyFile, "Body with leak@example.com.", "utf8");
      await run(root, out, [
        "wiki",
        "page",
        "upsert",
        "--id",
        "p1",
        "--title",
        "P",
        "--source",
        "src_x",
        "--body-file",
        bodyFile,
      ]);
      await run(root, out, ["user-wiki", "init"]);
      await run(root, out, ["wiki", "promote", "p1", "--dry-run"]);
      const expectedPath = path.join(home, ".ycm-harness", "wiki", "pages", "p1.md");
      await assert.rejects(fs.access(expectedPath), /ENOENT/);
      await run(root, out, ["wiki", "promote", "p1", "--confirm"]);
      await fs.access(expectedPath);
    } finally {
      await cleanup(root);
    }
  });
});

test("caveman compress preserves URL embedded in inline code and inline code embedded in fence", () => {
  const tricky = "Read `see https://example.com for details` then\n```js\nconst u = 'https://api.example.com';\n// `keep` me\n```\nDone.";
  const out = caveman(tricky, { level: "full" });
  assert.match(out, /`see https:\/\/example\.com for details`/);
  assert.match(out, /const u = 'https:\/\/api\.example\.com';/);
  assert.match(out, /`keep` me/);
  assert.equal((out.match(/```/g) ?? []).length, 2);
});

test("review verdict re-record with new findings replaces unresolved priors; empty findings preserve them", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "reverdict"]);
    const taskId = await startExecuteWithTask(root, out);
    out.stdout.length = 0;
    await run(root, out, ["review", "start", "--target", "task", "--id", taskId]);
    const sessionId = (out.stdout.find((l) => l.startsWith("Review session opened: ")) ?? "").slice("Review session opened: ".length).trim();

    await submitReviewVerdict(root, async (a) => run(root, out, a), sessionId, "combined_reviewer", "combined_reviewer", 70, [
      { severity: "high", title: "Original finding" },
    ]);
    await submitReviewVerdict(root, async (a) => run(root, out, a), sessionId, "combined_reviewer", "combined_reviewer", 95);
    let stateRaw = await fs.readFile(path.join(root, ".ycm-harness", "state.json"), "utf8");
    let state = JSON.parse(stateRaw);
    let findings = Object.values(state.reviews[sessionId].findings) as Array<{ title: string }>;
    assert.equal(findings.length, 1, "empty findings on re-verdict must preserve prior unresolved findings");
    assert.equal(findings[0].title, "Original finding");

    await submitReviewVerdict(root, async (a) => run(root, out, a), sessionId, "combined_reviewer", "combined_reviewer", 80, [
      { severity: "medium", title: "Replacement finding" },
    ]);
    stateRaw = await fs.readFile(path.join(root, ".ycm-harness", "state.json"), "utf8");
    state = JSON.parse(stateRaw);
    findings = Object.values(state.reviews[sessionId].findings) as Array<{ title: string }>;
    assert.equal(findings.length, 1, "supplying new findings must replace prior unresolved findings, not accumulate");
    assert.equal(findings[0].title, "Replacement finding");
  } finally {
    await cleanup(root);
  }
});

test("redactor catches Google API keys, Slack tokens, JWT, DB URLs, Bearer, SSH key", () => {
  const blob = [
    "Google: " + "AIza" + "SyA-" + "a".repeat(32),
    "Slack: " + "xoxb-" + "1234567890-" + "a".repeat(24),
    "JWT: " + "eyJhbGciOiJIUzI1NiJ9." + "eyJzdWIiOiJ4eHh4eHh4In0." + "s5gncARMP_signature_chunk_aaaa",
    "DB: postgres://user:secret@db.internal:5432/app",
    "Bearer: Bearer abcdefghijklmnopqrstuvwxyz0123456789",
    "SSH: ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAAAAAAAAAAAAAAAAAAAAAAAAAAAA me@host",
  ].join("\n");
  const r = redact(blob);
  assert.match(r.redacted, /<redacted:google-api-key>/);
  assert.match(r.redacted, /<redacted:slack-token>/);
  assert.match(r.redacted, /<redacted:jwt>/);
  assert.match(r.redacted, /<redacted:db-url>/);
  assert.match(r.redacted, /<redacted:bearer-token>/);
  assert.match(r.redacted, /<redacted:ssh-public-key>/);
  for (const id of ["google-api-key", "slack-token", "jwt", "db-url-with-creds", "bearer-token", "ssh-public-key"]) {
    assert.ok(r.findings.some((f) => f.rule_id === id), `expected '${id}' finding`);
  }
});

test("WikiState defaults are factory-bound (independent objects per parse)", () => {
  const a = UserHarnessState.parse({
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  const b = UserHarnessState.parse({
    version: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  a.wiki.pages["x"] = {
    id: "x",
    title: "X",
    source_ids: [],
    tags: [],
    body_path: "pages/x.md",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
  assert.equal(Object.keys(b.wiki.pages).length, 0, "different parses must not share the default record reference");
});

test("hook session-start surfaces nudge and user-wiki blocks", async () => {
  await withTempUserHome(async () => {
    const root = await tempProject();
    try {
      const out = captureOutput();
      await run(root, out, ["init"]);
      await run(root, out, ["goal", "create", "digest test"]);
      await advanceToDiscuss(root, out);
      await run(root, out, ["wiki", "init"]);
      await run(root, out, ["user-wiki", "init"]);
      for (let i = 0; i < NUDGE_THRESHOLD + 1; i++) {
        await run(root, out, ["session", "tick", "--kind", "user_message"]);
      }
      out.stdout.length = 0;
      await run(root, out, ["hook", "session-start"]);
      const blob = out.stdout.join("\n");
      assert.match(blob, /User wiki: pages=0 sources=0/);
      assert.match(blob, /WIKI UPDATE DUE/);
    } finally {
      await cleanup(root);
    }
  });
});

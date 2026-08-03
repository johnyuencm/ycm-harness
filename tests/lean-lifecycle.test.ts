import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { runCli } from "../src/cli/index.js";
import { HarnessStore } from "../src/state/store.js";
import { emptyStateV3, type TicketT } from "../src/schema/v3.js";
import { freshCompletionEvidence, submissionDigest } from "../src/tickets/evidence.js";
import { cleanup, tempProject, trivialSmokeCommand } from "./helpers.js";

const now = "2026-07-15T00:00:00.000Z";

test("fresh evidence binds acceptance and distinct verifier provenance", async () => {
  const root = await tempProject("ch-evidence-");
  try {
    const state = emptyStateV3(now);
    const ticket: TicketT = {
      id: "ticket",
      goal_id: "goal",
      title: "Contract",
      acceptance: ["old"],
      blocked_by: [],
      status: "in_review",
      code_changed: false,
      order: 0,
      created_at: now,
      updated_at: now,
    };
    const digest = await submissionDigest(root, ticket);
    state.evidence.submission = { id: "submission", goal_id: "goal", ticket_id: "ticket", kind: "other", submission_digest: digest, provenance: {}, recorded_at: now };
    state.evidence.verification = { id: "verification", goal_id: "goal", ticket_id: "ticket", kind: "verification", submission_digest: digest, outcome: "pass", provenance: { implementer_run: "impl", verifier_run: "review" }, recorded_at: now };
    assert.ok(await freshCompletionEvidence(root, state, ticket));

    assert.equal(await freshCompletionEvidence(root, state, { ...ticket, acceptance: ["changed"] }), undefined);
    state.evidence.verification.provenance.verifier_run = "impl";
    assert.equal(await freshCompletionEvidence(root, state, ticket), undefined);
  } finally {
    await cleanup(root);
  }
});

test("code submission digest uses shell-free Git tree resolution", async () => {
  const root = await tempProject("ch-git-digest-");
  try {
    for (const args of [["init", "-q"], ["config", "user.email", "test@example.invalid"], ["config", "user.name", "Test"]]) {
      assert.equal(spawnSync("git", args, { cwd: root }).status, 0);
    }
    await fs.writeFile(path.join(root, "file.txt"), "content\n", "utf8");
    assert.equal(spawnSync("git", ["add", "file.txt"], { cwd: root }).status, 0);
    assert.equal(spawnSync("git", ["commit", "-q", "-m", "test"], { cwd: root }).status, 0);
    const ticket: TicketT = { id: "ticket", goal_id: "goal", title: "Code", acceptance: ["works"], blocked_by: [], status: "in_review", code_changed: true, order: 0, created_at: now, updated_at: now };
    assert.match(await submissionDigest(root, ticket), /^[a-f0-9]{64}$/);
  } finally {
    await cleanup(root);
  }
});

test("goal completion rejects done code tickets without fresh evidence", async () => {
  const root = await tempProject("ch-goal-gate-");
  try {
    const state = emptyStateV3(now);
    state.active_goal_id = "goal";
    state.goals.goal = { id: "goal", title: "Goal", status: "active", assurance: "standard", backend: { kind: "local" }, worktree_status: "pending", stop_enforcement: false, created_at: now, updated_at: now };
    state.local_tickets.ticket = { id: "ticket", goal_id: "goal", title: "Code", acceptance: [], blocked_by: [], status: "done", code_changed: true, order: 0, created_at: now, updated_at: now };
    const store = new HarnessStore(root);
    await store.writeStateV3(state);

    assert.equal(await runCli(["--cwd", root, "goal", "complete", "goal"]), 1);
    assert.equal((await store.readStateV3()).goals.goal?.status, "active");
  } finally {
    await cleanup(root);
  }
});

test("wiki durable rejects traversal before writing outside the wiki", async () => {
  const root = await tempProject("ch-wiki-safe-");
  try {
    const readme = path.join(root, "README.md");
    await fs.writeFile(readme, "safe\\n", "utf8");
    await new HarnessStore(root).writeStateV3(emptyStateV3(now));

    assert.equal(await runCli(["--cwd", root, "wiki", "durable", "--id", "../../../README", "--title", "Bad", "--trigger", "decision", "--body", "hacked"]), 1);
    assert.equal(await fs.readFile(readme, "utf8"), "safe\\n");
  } finally {
    await cleanup(root);
  }
});

test("high-assurance verification executes in the recorded worktree", async () => {
  const root = await tempProject("ch-worktree-evidence-");
  try {
    const worktree = path.join(root, "work");
    await fs.mkdir(worktree);
    const state = emptyStateV3(now);
    state.active_goal_id = "goal";
    state.goals.goal = { id: "goal", title: "Goal", status: "active", assurance: "high", backend: { kind: "local" }, worktree_path: "work", worktree_status: "active", stop_enforcement: false, created_at: now, updated_at: now };
    const ticket: TicketT = { id: "ticket", goal_id: "goal", title: "Verify", acceptance: [], blocked_by: [], status: "in_review", code_changed: false, order: 0, created_at: now, updated_at: now };
    state.local_tickets.ticket = ticket;
    state.evidence.submission = { id: "submission", goal_id: "goal", ticket_id: "ticket", kind: "other", submission_digest: await submissionDigest(worktree, ticket), provenance: {}, recorded_at: now };
    await new HarnessStore(root).writeStateV3(state);

    assert.equal(await runCli(["--cwd", root, "verify", "run", "--ticket", "ticket", "--command", trivialSmokeCommand(), "--implementer-run", "impl", "--verifier-run", "review"]), 0);
    assert.ok((await fs.readdir(path.join(worktree, ".ycm-harness"))).length > 0);
  } finally {
    await cleanup(root);
  }
});

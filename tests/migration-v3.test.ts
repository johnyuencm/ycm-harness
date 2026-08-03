import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { emptyState } from "../src/schema/state.js";
import { migrateOnDisk, migrationPaths, type MigrationFault } from "../src/migration/disk.js";
import { tempProject, cleanup } from "./helpers.js";

function fixture() {
  const now = "2026-01-01T00:00:00.000Z";
  const state = emptyState(now);
  state.goals["lean-goal"] = {
    id: "lean-goal",
    title: "Lean goal",
    description: "migration fixture",
    status: "active",
    worktree_status: "active",
    created_at: now,
    updated_at: now,
  };
  state.phases["execute"] = {
    id: "execute",
    goal_id: "lean-goal",
    kind: "execute",
    title: "Execute",
    status: "active",
    order: 4,
    created_at: now,
    updated_at: now,
  };
  state.active_goal_id = "lean-goal";
  state.active_session_id = "session_1";
  state.sessions["session_1"] = {
    id: "session_1",
    started_at: now,
    last_seen_at: now,
    active_goal_id: "lean-goal",
    active_phase_id: "execute",
    active_task_id: "ship",
  };
  state.tasks["ship"] = {
    id: "ship",
    phase_id: "execute",
    title: "Ship",
    brief: "small tracer bullet",
    status: "active",
    smoke: "required",
    code_changed: true,
    smoke_evidence_ids: ["smoke_1"],
    order: 0,
    created_at: now,
    updated_at: now,
  };
  state.checkpoints["cp_1"] = {
    id: "cp_1",
    goal_id: "lean-goal",
    phase_id: "execute",
    task_id: "ship",
    kind: "decision",
    title: "Keep it lean",
    decisions: ["No phase gate"],
    created_at: now,
  };
  state.smoke["smoke_1"] = {
    id: "smoke_1",
    task_id: "ship",
    phase_id: "execute",
    outcome: "pass",
    recording_mode: "executed",
    command: "npm test",
    exit_code: 0,
    log_sha256: "a".repeat(64),
    executed_at: now,
    artifact_paths: [],
    recorded_at: now,
  };
  state.commits["commit_1"] = {
    id: "commit_1",
    goal_id: "lean-goal",
    task_id: "ship",
    sha: "b".repeat(40),
    summary: "fixture commit",
    created_at: now,
  };
  return state;
}

async function writeFixture(root: string): Promise<Buffer> {
  const paths = migrationPaths(root);
  await fs.mkdir(path.dirname(paths.statePath), { recursive: true });
  const bytes = Buffer.from(JSON.stringify(fixture(), null, 2) + "\n", "utf8");
  await fs.writeFile(paths.statePath, bytes);
  return bytes;
}

test("migration dry-run is read-only and maps V2 to V3", async () => {
  const root = await tempProject("ch-migrate-");
  try {
    const original = await writeFixture(root);
    const result = await migrateOnDisk(root, { dryRun: true, now: "2026-01-02T00:00:00.000Z" });
    assert.equal(result.applied, false);
    assert.equal(result.already_migrated, false);
    assert.equal(result.state?.version, 3);
    assert.equal(result.state?.goals["lean-goal"]?.status, "active");
    assert.equal(result.state?.local_tickets["ship"]?.status, "in_progress");
    assert.equal(result.state?.goals["lean-goal"]?.active_ticket_id, "ship");
    assert.equal(result.state?.checkpoints["cp_1"]?.ticket_id, "ship");
    assert.equal(Object.keys(result.state?.evidence ?? {}).length, 2);
    assert.deepEqual(await fs.readFile(migrationPaths(root).statePath), original);
    await assert.rejects(() => fs.access(migrationPaths(root).archiveDir));
  } finally {
    await cleanup(root);
  }
});

test("migration maps planning and verifying phase states into goal lifecycle", async () => {
  const root = await tempProject("ch-migrate-status-");
  try {
    const state = fixture();
    state.goals["lean-goal"]!.status = "active";
    state.phases["execute"]!.kind = "validate";
    state.phases["execute"]!.status = "active";
    const paths = migrationPaths(root);
    await fs.mkdir(path.dirname(paths.statePath), { recursive: true });
    await fs.writeFile(paths.statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
    const result = await migrateOnDisk(root, { dryRun: true });
    assert.equal(result.state?.goals["lean-goal"]?.status, "verifying");
    state.goals["lean-goal"]!.status = "draft";
    await fs.writeFile(paths.statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
    const planning = await migrateOnDisk(root, { dryRun: true });
    assert.equal(planning.state?.goals["lean-goal"]?.status, "planning");
  } finally {
    await cleanup(root);
  }
});

test("migration applies exact archive, V3 state, and is idempotent", async () => {
  const root = await tempProject("ch-migrate-");
  try {
    const original = await writeFixture(root);
    const first = await migrateOnDisk(root, { now: "2026-01-02T00:00:00.000Z" });
    assert.equal(first.applied, true);
    const paths = migrationPaths(root);
    assert.deepEqual(await fs.readFile(paths.archiveStatePath), original);
    const state = JSON.parse(await fs.readFile(paths.statePath, "utf8")) as { version: number; legacy_archive?: { sha256: string } };
    assert.equal(state.version, 3);
    assert.equal(state.legacy_archive?.sha256.length, 64);
    const archive = await fs.readFile(paths.archiveStatePath);
    const second = await migrateOnDisk(root, { now: "2026-01-03T00:00:00.000Z" });
    assert.equal(second.already_migrated, true);
    assert.deepEqual(await fs.readFile(paths.archiveStatePath), archive);
    await assert.rejects(() => fs.access(paths.tempDir));
  } finally {
    await cleanup(root);
  }
});

for (const fault of ["archive-write", "state-write", "archive-rename", "state-rename"] as MigrationFault[]) {
  test(`migration ${fault} failure preserves V2 state and archive`, async () => {
    const root = await tempProject("ch-migrate-fault-");
    try {
      const original = await writeFixture(root);
      await assert.rejects(() => migrateOnDisk(root, { faultAt: fault }));
      const paths = migrationPaths(root);
      assert.deepEqual(await fs.readFile(paths.statePath), original);
      await assert.rejects(() => fs.access(paths.archiveDir));
      await assert.rejects(() => fs.access(paths.tempDir));
    } finally {
      await cleanup(root);
    }
  });
}

test("migration cleans a stale crash remnant before retry", async () => {
  const root = await tempProject("ch-migrate-crash-");
  try {
    await writeFixture(root);
    const paths = migrationPaths(root);
    await fs.mkdir(paths.tempDir, { recursive: true });
    await fs.writeFile(path.join(paths.tempDir, "partial"), "partial", "utf8");
    const result = await migrateOnDisk(root);
    assert.equal(result.applied, true);
    await assert.rejects(() => fs.access(path.join(paths.tempDir, "partial")));
  } finally {
    await cleanup(root);
  }
});

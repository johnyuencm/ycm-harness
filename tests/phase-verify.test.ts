import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tempProject, cleanup } from "./helpers.js";
import { emptyState } from "../src/schema/state.js";
import { runShellCommand, writeCommandLog } from "../src/enforcement/exec-command.js";
import { verifyPhaseGatesAsync } from "../src/enforcement/phase-verify.js";

test("execute phase verifies historical smoke integrity without re-running commands", async () => {
  const root = await tempProject("ch-phase-integrity-");
  try {
    const now = new Date().toISOString();
    const marker = path.join(root, "marker.txt");
    const command = `echo x >> marker.txt`;
    const run = await runShellCommand(command, root);
    const log = await writeCommandLog(path.join(root, ".ycm-harness"), "smoke_one", run);
    const state = emptyState(now);
    const phase = {
      id: "phase_execute",
      goal_id: "goal_one",
      kind: "execute" as const,
      title: "Execute",
      status: "active" as const,
      order: 0,
      created_at: now,
      updated_at: now,
    };
    state.phases[phase.id] = phase;
    state.tasks.task_one = {
      id: "task_one",
      phase_id: phase.id,
      title: "One",
      status: "done",
      smoke: "required",
      smoke_evidence_ids: ["smoke_one"],
      order: 0,
      created_at: now,
      updated_at: now,
    };
    state.smoke.smoke_one = {
      id: "smoke_one",
      task_id: "task_one",
      outcome: "pass",
      recording_mode: "executed",
      command,
      exit_code: 0,
      log_file: path.relative(root, log),
      log_sha256: run.sha256,
      executed_at: now,
      artifact_paths: [],
      recorded_at: now,
    };

    assert.deepEqual(await verifyPhaseGatesAsync(state, phase, root), []);
    assert.equal((await fs.readFile(marker, "utf8")).match(/x/g)?.length, 1);

    const originalLog = await fs.readFile(log, "utf8");
    await fs.writeFile(log, `unhashed prefix\n${originalLog}`);
    assert.match((await verifyPhaseGatesAsync(state, phase, root))[0], /sha256/);

    await fs.writeFile(log, originalLog);
    await fs.appendFile(log, "tampered");
    assert.match((await verifyPhaseGatesAsync(state, phase, root))[0], /tampered/);

    await fs.rm(log);
    assert.match((await verifyPhaseGatesAsync(state, phase, root))[0], /log missing/);
  } finally {
    await cleanup(root);
  }
});




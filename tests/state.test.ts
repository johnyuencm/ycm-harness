import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { HarnessStore } from "../src/state/store.js";
import { tempProject, cleanup } from "./helpers.js";

test("HarnessStore.init creates state.json and events.jsonl, then refuses to re-init", async () => {
  const root = await tempProject();
  try {
    const store = new HarnessStore(root);
    const state = await store.init();
    assert.equal(state.version, 2);

    const stateFile = await fs.readFile(store.paths.stateFile, "utf8");
    assert.ok(stateFile.includes("\"version\": 2"));

    const events = await fs.readFile(store.paths.eventsFile, "utf8");
    assert.match(events, /"kind":"init"/);

    await assert.rejects(() => store.init(), /already initialized/);

    await store.init({ force: true });
    const state2 = await store.readState();
    assert.equal(state2.version, 2);
  } finally {
    await cleanup(root);
  }
});

test("HarnessStore.update writes back validated state and persists across reads", async () => {
  const root = await tempProject();
  try {
    const store = new HarnessStore(root);
    await store.init();
    await store.update((s) => {
      s.goals["goal_a"] = {
        id: "goal_a",
        title: "A",
        status: "active",
        created_at: s.created_at,
        updated_at: s.created_at,
      };
      s.active_goal_id = "goal_a";
      return s;
    });
    const fresh = new HarnessStore(root);
    const reread = await fresh.readState();
    assert.equal(reread.active_goal_id, "goal_a");
    assert.equal(reread.goals["goal_a"]?.title, "A");
  } finally {
    await cleanup(root);
  }
});

test("HarnessStore writes are atomic: no .tmp file remains", async () => {
  const root = await tempProject();
  try {
    const store = new HarnessStore(root);
    await store.init();
    const dir = path.dirname(store.paths.stateFile);
    const entries = await fs.readdir(dir);
    assert.ok(entries.every((e) => !e.endsWith(".tmp")));
  } finally {
    await cleanup(root);
  }
});

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { buildFollowUpRequest, handlePostToolUse, normalizePostToolUsePayload, parseExplicitFollowUps, recordVerifiedContinuations } from "../src/autonomy/deeds.js";
import { dispatchStopHook } from "../src/hooks/stop.js";
import { HarnessStore } from "../src/state/store.js";
import { emptyState } from "../src/schema/state.js";
import { cleanup, tempProject } from "./helpers.js";

const noGit = async (): Promise<undefined> => undefined;

async function harness(): Promise<string> {
  const root = await tempProject("ch-deeds-");
  const store = new HarnessStore(root);
  await store.init();
  await store.update((state) => {
    state.goals.goal_deeds = { id: "goal_deeds", title: "Deeds", status: "active", worktree_status: "active", created_at: state.created_at, updated_at: state.created_at };
    state.active_goal_id = "goal_deeds";
    return state;
  });
  return root;
}

function activeState() {
  const state = emptyState("2026-07-15T01:02:03.000Z");
  state.goals.goal = { id: "goal", title: "Active", status: "active", worktree_status: "active", created_at: state.created_at, updated_at: state.created_at };
  state.active_goal_id = "goal";
  return state;
}

function payload(root: string, toolUseId: string, command = "npm test") {
  return {
    session_id: "session-safe",
    turn_id: "turn-safe",
    cwd: root,
    hook_event_name: "PostToolUse" as const,
    model: "gpt-test",
    tool_name: "shell_command",
    tool_input: { command },
    tool_response: { exit_code: 0, output: "PRIVATE-TEXT" },
    tool_use_id: toolUseId,
  };
}

test("concurrent meaningful events publish a complete union pointer before return", async () => {
  const root = await harness();
  try {
    const [a, b] = await Promise.all([
      handlePostToolUse(payload(root, "tool-a"), { gitProbe: noGit, now: () => "2026-07-15T01:02:03.000Z" }),
      handlePostToolUse(payload(root, "tool-b", "npm run build"), { gitProbe: noGit, now: () => "2026-07-15T01:02:03.000Z" }),
    ]);
    assert.equal(a.status, "written");
    assert.equal(b.status, "written");
    assert.equal(a.pointer, b.pointer);
    const pointer = await fs.readFile(a.pointer!, "utf8");
    assert.equal((pointer.match(/^- [0-9a-f]{16} verification/gm) ?? []).length, 2);
    assert.doesNotMatch(pointer, /PRIVATE-TEXT|npm test|session-safe|turn-safe|tool-a|tool-b/);
  } finally {
    await cleanup(root);
  }
});

test("exact replay is no-op, changed replay quarantines, and failures/read-only/noise persist nothing", async () => {
  const root = await harness();
  try {
    const options = { gitProbe: noGit, now: () => "2026-07-15T01:02:03.000Z" };
    const first = await handlePostToolUse(payload(root, "tool-a"), options);
    assert.equal((await handlePostToolUse(payload(root, "tool-a"), options)).status, "replayed");
    assert.equal((await handlePostToolUse(payload(root, "tool-a", "npm run build"), options)).status, "quarantined");
    const before = await fs.readFile(first.pointer!, "utf8");
    assert.equal((await handlePostToolUse(payload(root, "read", "git status"), options)).status, "ignored");
    assert.equal((await handlePostToolUse(payload(root, "echo-test", "echo test"), options)).status, "ignored");
    assert.equal((await handlePostToolUse(payload(root, "echo-diff", "echo git diff --check"), options)).status, "ignored");
    assert.equal((await handlePostToolUse({ ...payload(root, "failed"), tool_response: { exit_code: 1 } }, options)).status, "ignored");
    assert.equal((await handlePostToolUse({ ...payload(root, "generic"), tool_name: "unknown_tool" }, options)).status, "ignored");
    assert.equal(await fs.readFile(first.pointer!, "utf8"), before);
    assert.equal((await handlePostToolUse(payload(root, "diff-check", "git diff --check"), options)).status, "written");
    const all = (await fs.readdir(path.join(root, ".ycm-harness", "autonomy"), { recursive: true })).join("\n");
    assert.doesNotMatch(all, /npm test|PRIVATE-TEXT|session-safe|turn-safe|tool-a/);
    const quarantine = all.match(/quarantine/g) ?? [];
    assert.ok(quarantine.length > 0);
  } finally {
    await cleanup(root);
  }
});
test("death after event write is repaired by exact replay", async () => {
  const root = await harness();
  try {
    const input = payload(root, "crash");
    await assert.rejects(() => handlePostToolUse(input, { gitProbe: noGit, now: () => "2026-07-15T01:02:03.000Z", afterEventWrite: async () => { throw new Error("death"); } }), /death/);
    const replay = await handlePostToolUse(input, { gitProbe: noGit, now: () => "2026-07-15T01:02:03.000Z" });
    assert.equal(replay.status, "replayed");
    assert.match(await fs.readFile(replay.pointer!, "utf8"), /verification/);
  } finally {
    await cleanup(root);
  }
});

test("native Codex Bash payloads normalize and classify without a model field", async () => {
  const root = await harness();
  try {
    const normalized = normalizePostToolUsePayload({
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      tool_response: { exit_code: 0, stdout: "ok" },
      tool_use_id: "tool-codex",
      session_id: "session-codex",
      turn_id: "turn-codex",
      cwd: root,
    });
    assert.ok(normalized);
    assert.equal(normalized?.tool_name, "shell_command");
    assert.equal(normalized?.model, "unknown");
    assert.equal((await handlePostToolUse(normalized!, { gitProbe: noGit, now: () => "2026-07-15T01:02:03.000Z" })).status, "written");
  } finally {
    await cleanup(root);
  }
});

test("malformed PostToolUse payloads are ignored instead of throwing", async () => {
  const root = await harness();
  try {
    assert.equal((await handlePostToolUse({}, { gitProbe: noGit })).status, "ignored");
    assert.equal((await handlePostToolUse({ hook_event_name: "PostToolUse" }, { gitProbe: noGit })).status, "ignored");
  } finally {
    await cleanup(root);
  }
});

test("untrusted success and unsafe verified references cannot persist", async () => {
  const root = await harness();
  try {
    assert.equal((await handlePostToolUse({ ...payload(root, "generic-success"), tool_response: { output: "looks fine" } }, { gitProbe: noGit })).status, "ignored");
    await assert.rejects(() => recordVerifiedContinuations({ cwd: root, sessionId: "s", turnId: "t", references: ["../../raw-secret"] }, { gitProbe: noGit }), /invalid_continuation_reference/);
  } finally {
    await cleanup(root);
  }
});

test("approved headings parse bullets/tails only, normalize/dedupe, and cap twelve", () => {
  for (const heading of ["FOLLOW-UPS", "next STEPS", "Action items", "Open items", "TODO", "To Do", "Remaining work"]) {
    assert.deepEqual(parseExplicitFollowUps(`${heading}: Ship it`), ["Ship it"]);
  }
  assert.deepEqual(parseExplicitFollowUps("## Next steps\n\n-  Fix   tests.\n* fix tests\n- none\n## Other\n- ignored"), ["Fix tests"]);
  for (const heading of ["Follow-up", "Things to consider", "Potential Follow-ups", "Follow ups", "Other"]) {
    assert.deepEqual(parseExplicitFollowUps(`${heading}:\n- ignored`), []);
  }
  assert.deepEqual(parseExplicitFollowUps("Casual prose says Next steps later"), []);
  const many = `Follow-ups\n${Array.from({ length: 15 }, (_, index) => `- Item ${index}`).join("\n")}`;
  assert.equal(parseExplicitFollowUps(many).length, 12);
});

test("follow-up request is complete and Stop precedence blocks failures before ordinary output", async () => {
  const request = buildFollowUpRequest("Verify release");
  for (const field of ["title", "source_class", "source", "problem", "impact_scope", "owner_control", "acceptance", "verification", "dependencies", "safety_blockers", "cost_class", "evidence_horizon", "rollback", "status", "priority"]) assert.ok(field in request);
  const stop = { session_id: "s", turn_id: "t", cwd: "C:/safe", hook_event_name: "Stop", model: "gpt-test", stop_hook_active: false, last_assistant_message: "Follow-ups:\n- Verify release" } as const;
  const state = activeState();
  const noFollowUp = await dispatchStopHook({ ...stop, last_assistant_message: "ordinary prose" }, state);
  assert.equal(noFollowUp, null);
  const blocked = await dispatchStopHook(stop, state, {
    persist: async () => undefined,
    ensure: async () => undefined,
    record: async () => undefined,
  });
  assert.equal(blocked?.stopReason, "cursor_harness_follow_up_binding_missing");
});

test("successful Stop ensures complete requests, enriches verified refs, and repeated turns converge", async () => {
  const requests: unknown[] = [];
  const refs: string[][] = [];
  const stop = { session_id: "s", turn_id: "t", cwd: "C:/safe", hook_event_name: "Stop", model: "gpt-test", stop_hook_active: true, last_assistant_message: "## Action items\n- Verify release" } as const;
  const deps = {
    persist: async () => "pointer",
    ensure: async (input: unknown) => { requests.push(input); return { state: "verified" as const, key: "ch-123", id: "11111111-1111-4111-8111-111111111111", identifier: "AUT-12", contract_sha256: "a".repeat(64), warnings: [] }; },
    record: async (input: { references: string[] }) => { refs.push(input.references); return "pointer"; },
  };
  const state = activeState();
  assert.equal(await dispatchStopHook(stop, state, deps as never), null);
  assert.equal(await dispatchStopHook({ ...stop, turn_id: "t2" }, state, deps as never), null);
  assert.deepEqual(requests[0], requests[1]);
  assert.deepEqual(refs, [["AUT-12"], ["AUT-12"]]);
});
test("Stop accepts no turn/model, ignores passthrough, and scopes raising to an active harness goal", async () => {
  let ensures = 0;
  let derivedTurn = "";
  const payload = { session_id: "s", cwd: "C:/safe", hook_event_name: "Stop", last_assistant_message: "Open items: Verify release", future_field: true };
  assert.equal(await dispatchStopHook(payload, undefined, { ensure: async () => { ensures++; return undefined; } }), null);
  assert.equal(ensures, 0);
  const result = await dispatchStopHook(payload, activeState(), {
    persist: async (input) => { derivedTurn = input.turnId; return "pointer"; },
    ensure: async () => { ensures++; return { state: "verified", key: "ch-123", id: "11111111-1111-4111-8111-111111111111", identifier: "AUT-12", contract_sha256: "a".repeat(64), warnings: [] }; },
    record: async () => "pointer",
  });
  assert.equal(result, null);
  assert.match(derivedTurn, /^stop-[0-9a-f]{64}$/);
  assert.equal(ensures, 1);
});
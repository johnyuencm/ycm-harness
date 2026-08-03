import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  EXPECTED_SLOTS,
  WATCHDOG_TIMEZONE,
  createMemoryGapIssueAdapter,
  createMemoryReceiptStore,
  createMemoryRuntimeProbe,
  disableWatchdog,
  enableWatchdog,
  expectedDueSlots,
  tickMissedSlotWatchdog,
  watchdogStatus,
  type FailureClass,
  type GapIssue,
  type SlotReceipt,
} from "../src/autonomy/missed-slot-watchdog.js";
import { cleanup, tempProject } from "./helpers.js";

/** Fixed instant: 2026-07-21 18:30 Asia/Hong_Kong (UTC+8) => 10:30Z. */
const AFTER_17 = "2026-07-21T10:30:00.000Z";
/** Fixed instant: 2026-07-21 08:00 Asia/Hong_Kong => before 09:00. */
const BEFORE_09 = "2026-07-21T00:00:00.000Z";
/** Fixed instant: 2026-07-22 00:15 Asia/Hong_Kong => after prior day 23:00. */
const AFTER_MIDNIGHT = "2026-07-21T16:15:00.000Z";

function receipt(
  slot: SlotReceipt["slot"],
  localDate: string,
  overrides: Partial<SlotReceipt> = {},
): SlotReceipt {
  return {
    schema_version: 1,
    slot,
    local_date: localDate,
    receipt_id: `rcpt-${localDate}-${slot.replace(":", "")}`,
    observed_at: `${localDate}T${slot}:00+08:00`,
    status: "ok",
    ...overrides,
  };
}

test("expected slots are exactly 09:00/17:00/23:00 Asia/Hong_Kong and due set grows with clock", () => {
  assert.equal(WATCHDOG_TIMEZONE, "Asia/Hong_Kong");
  assert.deepEqual([...EXPECTED_SLOTS], ["09:00", "17:00", "23:00"]);
  assert.deepEqual(
    expectedDueSlots(new Date(BEFORE_09)).map((item) => `${item.local_date}:${item.slot}`),
    ["2026-07-20:09:00", "2026-07-20:17:00", "2026-07-20:23:00"],
  );
  assert.deepEqual(
    expectedDueSlots(new Date(AFTER_17)).map((item) => `${item.local_date}:${item.slot}`),
    [
      "2026-07-20:09:00",
      "2026-07-20:17:00",
      "2026-07-20:23:00",
      "2026-07-21:09:00",
      "2026-07-21:17:00",
    ],
  );
  assert.deepEqual(
    expectedDueSlots(new Date(AFTER_MIDNIGHT)).map((item) => `${item.local_date}:${item.slot}`),
    [
      "2026-07-21:09:00",
      "2026-07-21:17:00",
      "2026-07-21:23:00",
    ],
  );
});

test("missing due slot creates exactly one live gap issue without LLM or credential mutation", async () => {
  const root = await tempProject("ch-watchdog-miss-");
  try {
    const receipts = createMemoryReceiptStore([
      receipt("09:00", "2026-07-20"),
      receipt("17:00", "2026-07-20"),
      receipt("23:00", "2026-07-20"),
      receipt("09:00", "2026-07-21"),
      // 17:00 2026-07-21 missing
    ]);
    const gaps = createMemoryGapIssueAdapter();
    const runtime = createMemoryRuntimeProbe({ app_available: true, scheduler_reachable: true });
    const mutations: string[] = [];
    const result = await tickMissedSlotWatchdog({
      root,
      now: () => AFTER_17,
      receipts,
      gaps,
      runtime,
      onForbidden: (kind) => mutations.push(kind),
    });
    assert.equal(result.outcome, "gap_open");
    assert.equal(result.missed.length, 1);
    assert.deepEqual(result.missed[0], {
      local_date: "2026-07-21",
      slot: "17:00",
      failure_class: "app_runtime_lifecycle" satisfies FailureClass,
    });
    const live = await gaps.findLive();
    assert.ok(live);
    assert.equal(live.status, "open");
    assert.equal(live.issue_id, result.gap_issue_id);
    assert.equal((await gaps.list()).length, 1);
    assert.deepEqual(mutations, []);
    assert.equal(result.llm_invoked, false);
    assert.equal(result.credentials_mutated, false);
    assert.equal(result.repo_mutated, false);
  } finally {
    await cleanup(root);
  }
});

test("overlapping ticks for one missing slot are idempotent and keep one live issue", async () => {
  const root = await tempProject("ch-watchdog-idem-");
  try {
    const receipts = createMemoryReceiptStore([
      receipt("09:00", "2026-07-20"),
      receipt("17:00", "2026-07-20"),
      receipt("23:00", "2026-07-20"),
      receipt("09:00", "2026-07-21"),
    ]);
    const gaps = createMemoryGapIssueAdapter();
    const runtime = createMemoryRuntimeProbe({ app_available: false, scheduler_reachable: false });
    const deps = {
      root,
      now: () => AFTER_17,
      receipts,
      gaps,
      runtime,
    };
    const [first, second] = await Promise.all([
      tickMissedSlotWatchdog(deps),
      tickMissedSlotWatchdog(deps),
    ]);
    assert.equal(first.gap_issue_id, second.gap_issue_id);
    assert.equal((await gaps.list()).filter((issue: GapIssue) => issue.status === "open").length, 1);
    assert.equal((await gaps.list()).length, 1);
    assert.equal(first.missed[0]?.failure_class, "app_runtime_lifecycle");
    const third = await tickMissedSlotWatchdog(deps);
    assert.equal(third.gap_issue_id, first.gap_issue_id);
    assert.equal(third.outcome, "gap_updated");
  } finally {
    await cleanup(root);
  }
});

test("app/runtime lifecycle failures are distinguished from agent/output failures", async () => {
  const rootDown = await tempProject("ch-watchdog-class-down-");
  const rootAgent = await tempProject("ch-watchdog-class-agent-");
  try {
    const runtimeDown = createMemoryRuntimeProbe({ app_available: false, scheduler_reachable: false });
    const runtimeUp = createMemoryRuntimeProbe({ app_available: true, scheduler_reachable: true });
    const empty = createMemoryReceiptStore([]);
    const agentFailed = createMemoryReceiptStore([
      receipt("09:00", "2026-07-20"),
      receipt("17:00", "2026-07-20"),
      receipt("23:00", "2026-07-20"),
      receipt("09:00", "2026-07-21"),
      receipt("17:00", "2026-07-21", {
        status: "failed",
        failure_class: "agent_output",
        receipt_id: "rcpt-agent-fail",
      }),
    ]);

    const down = await tickMissedSlotWatchdog({
      root: rootDown,
      now: () => AFTER_17,
      receipts: empty,
      gaps: createMemoryGapIssueAdapter(),
      runtime: runtimeDown,
    });
    assert.ok(down.missed.length > 0);
    assert.ok(down.missed.every((item) => item.failure_class === "app_runtime_lifecycle"));

    const agent = await tickMissedSlotWatchdog({
      root: rootAgent,
      now: () => AFTER_17,
      receipts: agentFailed,
      gaps: createMemoryGapIssueAdapter(),
      runtime: runtimeUp,
    });
    const seventeen = agent.missed.find((item) => item.slot === "17:00" && item.local_date === "2026-07-21");
    assert.equal(seventeen?.failure_class, "agent_output");
    assert.ok(agent.missed.every((item) =>
      item.slot === "17:00" && item.local_date === "2026-07-21"
        ? item.failure_class === "agent_output"
        : item.failure_class === "app_runtime_lifecycle" || item.failure_class === "agent_output"));
  } finally {
    await cleanup(rootDown);
    await cleanup(rootAgent);
  }
});

test("gap resolves only after recovered receipt readback", async () => {
  const root = await tempProject("ch-watchdog-recover-");
  try {
    const store = createMemoryReceiptStore([
      receipt("09:00", "2026-07-20"),
      receipt("17:00", "2026-07-20"),
      receipt("23:00", "2026-07-20"),
      receipt("09:00", "2026-07-21"),
    ]);
    const gaps = createMemoryGapIssueAdapter();
    const runtime = createMemoryRuntimeProbe({ app_available: true, scheduler_reachable: true });
    const open = await tickMissedSlotWatchdog({
      root, now: () => AFTER_17, receipts: store, gaps, runtime,
    });
    assert.equal(open.outcome, "gap_open");
    assert.equal((await gaps.findLive())?.status, "open");

    // Presence in the list alone is not enough: readback must succeed.
    store.inject(receipt("17:00", "2026-07-21", { receipt_id: "rcpt-recovered" }));
    store.breakReadback("rcpt-recovered");
    const stillOpen = await tickMissedSlotWatchdog({
      root, now: () => AFTER_17, receipts: store, gaps, runtime,
    });
    assert.notEqual(stillOpen.outcome, "gap_resolved");
    assert.equal((await gaps.findLive())?.status, "open");

    store.fixReadback("rcpt-recovered");
    const resolved = await tickMissedSlotWatchdog({
      root, now: () => AFTER_17, receipts: store, gaps, runtime,
    });
    assert.equal(resolved.outcome, "gap_resolved");
    assert.equal(resolved.gap_issue_id, open.gap_issue_id);
    assert.equal(await gaps.findLive(), undefined);
    assert.equal((await gaps.list()).find((issue) => issue.issue_id === open.gap_issue_id)?.status, "resolved");
  } finally {
    await cleanup(root);
  }
});

test("watchdog can be independently disabled without deleting prior evidence", async () => {
  const root = await tempProject("ch-watchdog-disable-");
  try {
    const store = createMemoryReceiptStore([
      receipt("09:00", "2026-07-20"),
      receipt("17:00", "2026-07-20"),
      receipt("23:00", "2026-07-20"),
      receipt("09:00", "2026-07-21"),
    ]);
    const gaps = createMemoryGapIssueAdapter();
    const runtime = createMemoryRuntimeProbe({ app_available: true, scheduler_reachable: true });
    const open = await tickMissedSlotWatchdog({
      root, now: () => AFTER_17, receipts: store, gaps, runtime,
    });
    assert.equal(open.outcome, "gap_open");
    const evidenceBefore = await fs.readdir(path.join(root, ".ycm-harness", "autonomy", "missed-slot-watchdog"));

    await disableWatchdog(root);
    const status = await watchdogStatus(root);
    assert.equal(status.enabled, false);
    assert.equal(status.live_gap_issue_id, open.gap_issue_id);

    const skipped = await tickMissedSlotWatchdog({
      root, now: () => AFTER_17, receipts: store, gaps, runtime,
    });
    assert.equal(skipped.outcome, "disabled");
    assert.equal((await gaps.findLive())?.status, "open");

    const evidenceAfter = await fs.readdir(path.join(root, ".ycm-harness", "autonomy", "missed-slot-watchdog"));
    assert.deepEqual(evidenceAfter.sort(), evidenceBefore.sort());
    assert.ok(evidenceAfter.includes("state.json"));
    assert.ok(evidenceAfter.includes("ticks.jsonl") || evidenceAfter.some((name) => name.startsWith("tick-")));

    await enableWatchdog(root);
    assert.equal((await watchdogStatus(root)).enabled, true);
  } finally {
    await cleanup(root);
  }
});

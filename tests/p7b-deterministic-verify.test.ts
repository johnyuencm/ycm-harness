import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CANARY_IDS,
  createMemoryCorrectionIssueAdapter,
  createPassingCanaryContext,
  runP7bDeterministicVerify,
  type CheckOutcome,
} from "../src/autonomy/p7b-deterministic-verify.js";

test("failing canary returns PARTIAL, opens one live correction issue, and never invents PASS", async () => {
  const corrections = createMemoryCorrectionIssueAdapter();
  const canaries = createPassingCanaryContext();
  canaries.repoDirty = async () => true;
  canaries.cleanStateEvidenceValid = async () => true;
  const result = await runP7bDeterministicVerify({
    commands: [{ id: "typecheck", run: async () => ({ exit_code: 0 }) }],
    canaries,
    corrections,
    now: () => "2026-07-21T15:00:00.000Z",
  });

  assert.equal(result.verdict, "PARTIAL");
  assert.equal(result.synthetic_pass, false);
  assert.ok(result.correction_issue_id);
  const live = await corrections.findLive();
  assert.ok(live);
  assert.equal(live.status, "open");
  assert.equal(live.issue_id, result.correction_issue_id);
  assert.ok(live.failed_checks.includes("dirty_repo"));
  assert.ok(result.checks.some((c: CheckOutcome) => c.id === "dirty_repo" && c.ok === false));
  assert.ok(result.checks.every((c: CheckOutcome) => typeof c.exit_code === "number"));
});

test("overlapping failures reuse one live correction issue", async () => {
  const corrections = createMemoryCorrectionIssueAdapter();
  const canaries = createPassingCanaryContext();
  canaries.trackerAvailable = async () => false;
  canaries.pendingContinuationPersisted = async () => false;
  const first = await runP7bDeterministicVerify({
    commands: [],
    canaries,
    corrections,
    now: () => "2026-07-21T15:01:00.000Z",
  });
  const second = await runP7bDeterministicVerify({
    commands: [],
    canaries,
    corrections,
    now: () => "2026-07-21T15:02:00.000Z",
  });
  assert.equal(first.verdict, "PARTIAL");
  assert.equal(second.verdict, "PARTIAL");
  assert.equal(first.correction_issue_id, second.correction_issue_id);
  assert.equal((await corrections.list()).length, 1);
});

test("all commands and canaries passing returns PASS with recorded exit codes", async () => {
  const corrections = createMemoryCorrectionIssueAdapter();
  const result = await runP7bDeterministicVerify({
    commands: [
      { id: "typecheck", run: async () => ({ exit_code: 0 }) },
      { id: "build", run: async () => ({ exit_code: 0 }) },
      { id: "targeted_tests", run: async () => ({ exit_code: 0 }) },
    ],
    canaries: createPassingCanaryContext(),
    corrections,
    now: () => "2026-07-21T15:03:00.000Z",
  });
  assert.equal(result.verdict, "PASS");
  assert.equal(result.synthetic_pass, false);
  assert.equal(result.correction_issue_id, undefined);
  assert.equal(await corrections.findLive(), undefined);
  for (const id of CANARY_IDS) {
    assert.ok(result.checks.some((c) => c.id === id && c.ok), `missing passing canary ${id}`);
  }
  assert.ok(result.checks.some((c) => c.id === "typecheck" && c.exit_code === 0 && c.ok));
});

test("dry-run never claims synthetic PASS", async () => {
  const corrections = createMemoryCorrectionIssueAdapter();
  const result = await runP7bDeterministicVerify({
    dryRun: true,
    commands: [{ id: "typecheck", run: async () => ({ exit_code: 0 }) }],
    canaries: createPassingCanaryContext(),
    corrections,
    now: () => "2026-07-21T15:04:00.000Z",
  });
  assert.notEqual(result.verdict, "PASS");
  assert.equal(result.verdict, "PARTIAL");
  assert.equal(result.synthetic_pass, false);
  assert.equal(result.reason_code, "DRY_RUN");
});

test("command failure also yields PARTIAL with correction issue", async () => {
  const corrections = createMemoryCorrectionIssueAdapter();
  const result = await runP7bDeterministicVerify({
    commands: [{ id: "typecheck", run: async () => ({ exit_code: 2 }) }],
    canaries: createPassingCanaryContext(),
    corrections,
    now: () => "2026-07-21T15:05:00.000Z",
  });
  assert.equal(result.verdict, "PARTIAL");
  assert.ok(result.correction_issue_id);
  assert.ok(result.checks.some((c) => c.id === "typecheck" && c.ok === false && c.exit_code === 2));
});

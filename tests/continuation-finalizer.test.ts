import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { finalizeContinuationLedger, finalizeContinuationLedgerLive } from "../src/continuation/finalizer.js";

function ledger(items: unknown[]): string {
  return `\`\`\`continuation-ledger\n${JSON.stringify({ items })}\n\`\`\``;
}

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    lane: "NEXT",
    action: "Inspect the artifact",
    disposition: "TRACKED",
    ticket_id: "task_demo",
    evidence: "artifact reference",
    expected_impact: "Proves the finalizer contract",
    cost_class: "low",
    evidence_horizon: "next natural run",
    ...overrides,
  };
}

test("an explicit empty continuation ledger passes", () => {
  assert.deepEqual(finalizeContinuationLedger("```continuation-ledger\n{\"items\": []}\n```"), {
    status: "PASS",
    reasons: [],
    items: [],
  });
});

test("ledger envelope failures have stable reasons", () => {
  const two = "```continuation-ledger\n{\"items\": []}\n```\n```continuation-ledger\n{\"items\": []}\n```";
  assert.deepEqual(finalizeContinuationLedger("ordinary prose").reasons, ["MISSING_LEDGER"]);
  assert.deepEqual(finalizeContinuationLedger("```continuation-ledger\nnot json\n```").reasons, ["MALFORMED_LEDGER"]);
  assert.deepEqual(finalizeContinuationLedger(two).reasons, ["MULTIPLE_LEDGERS"]);
  assert.deepEqual(finalizeContinuationLedger("```continuation-ledger\n[]\n```").reasons, ["INVALID_LEDGER_SCHEMA"]);
  assert.deepEqual(finalizeContinuationLedger("```continuation-ledger\n{\"items\":[null]}\n```").reasons, ["INVALID_LEDGER_SCHEMA"]);
  assert.deepEqual(finalizeContinuationLedger("```json\n{\"items\":[]}\n```").reasons, ["MISSING_LEDGER"]);
  assert.deepEqual(finalizeContinuationLedger("### NEXT\nInspect the artifact").reasons, [
    "MISSING_LEDGER",
    "UNMAPPED_CONTINUATION:NEXT:Inspect the artifact",
  ]);
});

test("required item fields and dispositions fail in stable contract order", () => {
  const result = finalizeContinuationLedger(ledger([{
    lane: "NEXT",
    action: "Inspect the artifact",
    disposition: "DEFERRED",
    evidence: "",
    expected_impact: 42,
    cost_class: "low",
  }]));
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.reasons, [
    "MISSING_FIELD:0:evidence",
    "MISSING_FIELD:0:expected_impact",
    "MISSING_FIELD:0:evidence_horizon",
    "INVALID_DISPOSITION:0",
  ]);
});

test("ticket and monitoring conditional schemas accept only supported structural forms", () => {
  for (const ticket_id of ["task_demo", "task.demo", "task..demo", "task.", "AUT-34", "11111111-1111-4111-8111-111111111111"]) {
    const result = finalizeContinuationLedger(ledger([item({ ticket_id })]));
    assert.deepEqual(result.reasons, [], ticket_id);
    assert.equal(result.items[0]?.ticket_id, ticket_id);
  }
  assert.equal(finalizeContinuationLedger(ledger([item({ disposition: "MUTATED", mutation_action: "advanced" })])).status, "PASS");
  for (const ticket_id of ["", "AUT 34", "../ticket", "ticket:1", "!bad", "a".repeat(121)]) {
    assert.deepEqual(finalizeContinuationLedger(ledger([item({ ticket_id })])).reasons, ["INVALID_TICKET_ID:0"], ticket_id);
  }
  assert.deepEqual(finalizeContinuationLedger(ledger([item({
    disposition: "MONITORING ONLY",
    ticket_id: undefined,
  })])).reasons, [
    "MISSING_FIELD:0:monitoring_owner",
    "MISSING_FIELD:0:monitoring_reference",
    "MISSING_FIELD:0:monitoring_reason",
    "MISSING_FIELD:0:monitoring_check",
    "MISSING_FIELD:0:monitoring_exit",
  ]);
  assert.equal(finalizeContinuationLedger(ledger([item({
    disposition: "MONITORING ONLY",
    ticket_id: undefined,
    monitoring_owner: "release watcher",
    monitoring_reference: "upstream-42",
    monitoring_reason: "External state has no owner-controlled mutation",
    monitoring_check: "Read upstream release status",
    monitoring_exit: "Release 42 is published",
  })])).status, "PASS");
});

test("only concrete content in designated continuation lanes requires mapping", () => {
  const empty = ledger([]);
  assert.deepEqual(finalizeContinuationLedger(`### NEXT\n- Inspect the artifact\n\n${empty}`).reasons, [
    "UNMAPPED_CONTINUATION:NEXT:Inspect the artifact",
  ]);
  assert.deepEqual(finalizeContinuationLedger(`## Remaining work\nInspect the artifact\n\n${empty}`).reasons, [
    "UNMAPPED_CONTINUATION:REMAINING-WORK:Inspect the artifact",
  ]);
  for (const [heading, lane] of [["NOW", "NOW"], ["LATER", "LATER"], ["Follow-ups", "FOLLOW-UPS"], ["Action items", "ACTION-ITEMS"]]) {
    assert.deepEqual(finalizeContinuationLedger(`### ${heading}\nInspect the artifact\n\n${empty}`).reasons, [
      `UNMAPPED_CONTINUATION:${lane}:Inspect the artifact`,
    ]);
  }
  for (const marker of ["none", "none found", "nothing", "no action needed", "no follow-up needed", "empty"]) {
    assert.equal(finalizeContinuationLedger(`### NEXT\n  - **${marker}.**\n\n${empty}`).status, "PASS", marker);
  }
  assert.equal(finalizeContinuationLedger(`## Discussion\nWe could inspect the artifact later.\n\n${empty}`).status, "PASS");
});

test("prose maps by normalized lane, action, disposition, and ticket identity", () => {
  const tracked = item({ ticket_id: "AUT-34" });
  const decorated = `   1. **NEXT:** **Inspect the artifact** — **TRACKED** \`AUT-34\`.`;
  const result = finalizeContinuationLedger(`${decorated}\n\n${ledger([tracked])}`);
  assert.equal(result.status, "PASS");
  assert.deepEqual(result.items, [{
    lane: "NEXT",
    action: "Inspect the artifact",
    disposition: "TRACKED",
    ticket_id: "AUT-34",
    evidence: "artifact reference",
    expected_impact: "Proves the finalizer contract",
    cost_class: "low",
    evidence_horizon: "next natural run",
  }]);

  for (const prose of [
    "### NEXT\n- Inspect a different artifact — TRACKED AUT-34",
    "### LATER\n- Inspect the artifact — TRACKED AUT-34",
    "### NEXT\n- Inspect the artifact — MUTATED AUT-34",
    "### NEXT\n- Inspect the artifact — TRACKED AUT-35",
  ]) {
    const failed = finalizeContinuationLedger(`${prose}\n\n${ledger([tracked])}`);
    assert.equal(failed.status, "FAIL", prose);
    assert.match(failed.reasons.at(-1) ?? "", /^UNMAPPED_CONTINUATION:/);
  }

  const monitoring = item({
    lane: "LATER",
    action: "Observe dependency state",
    disposition: "MONITORING ONLY",
    ticket_id: undefined,
    monitoring_owner: "release watcher",
    monitoring_reference: "upstream-42",
    monitoring_reason: "No owner-controlled mutation exists",
    monitoring_check: "Read upstream release status",
    monitoring_exit: "Release 42 is published",
  });
  assert.equal(finalizeContinuationLedger(`### LATER\n  * Observe dependency state — *MONITORING ONLY*.\n\n${ledger([monitoring])}`).status, "PASS");
});

test("prose and ledger identities reconcile as multisets", () => {
  const tracked = item({ ticket_id: "AUT-34" });
  const prose = "### NEXT\n- Inspect the artifact — TRACKED AUT-34\n- Inspect the artifact — TRACKED AUT-34";
  assert.deepEqual(finalizeContinuationLedger(`${prose}\n\n${ledger([tracked])}`).reasons, [
    "UNMAPPED_CONTINUATION:NEXT:Inspect the artifact — TRACKED AUT-34",
  ]);
  assert.equal(finalizeContinuationLedger(`${prose}\n\n${ledger([tracked, tracked])}`).status, "PASS");
  assert.deepEqual(finalizeContinuationLedger(`${prose}\n\n${ledger([
    tracked,
    item({ action: "Inspect a different artifact", ticket_id: "AUT-34" }),
  ])}`).reasons, ["UNMAPPED_CONTINUATION:NEXT:Inspect the artifact — TRACKED AUT-34"]);
});

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

function liveTicket(overrides: Record<string, unknown> = {}) {
  return {
    ticket_id: "AUT-34",
    configured_parent_id: "AUT-5",
    parent_id: "AUT-5",
    status: "in_progress" as const,
    content_strings: ["Inspect the artifact"],
    evidence_reference_ids: ["comment-7"],
    readback_at: "2026-07-15T04:05:06.000Z",
    ...overrides,
  };
}

function mutationProof(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1 as const,
    proof_id: "a".repeat(64),
    ticket_id: "AUT-34",
    action: "advanced" as const,
    outcome: "success" as const,
    run_sha256: sha("run-7"),
    session_sha256: sha("session-7"),
    recorded_at: "2026-07-15T04:05:06.000Z",
    ...overrides,
  };
}

test("TRACKED resolves exact live ticket, parent, active content, and evidence", async () => {
  const response = ledger([item({ ticket_id: "AUT-34", evidence: "comment-7" })]);
  const context = { parentId: "AUT-5", runId: "run-7", sessionId: "session-7" };
  const verified = await finalizeContinuationLedgerLive(response, context, {
    readTicket: async () => liveTicket(),
    readMutations: async () => [],
  });
  assert.equal(verified.status, "PASS");

  for (const [proof, reason] of [
    [undefined, "TICKET_NOT_FOUND:AUT-34"],
    [liveTicket({ parent_id: "AUT-6" }), "WRONG_TICKET_PARENT:AUT-34"],
    [liveTicket({ status: "done" }), "TICKET_CLOSED:AUT-34"],
    [liveTicket({ content_strings: ["Different work"] }), "TICKET_CONTENT_MISMATCH:AUT-34"],
    [liveTicket({ evidence_reference_ids: ["comment-8"] }), "EVIDENCE_NOT_FOUND:AUT-34:comment-7"],
  ] as const) {
    const result = await finalizeContinuationLedgerLive(response, context, {
      readTicket: async () => proof,
      readMutations: async () => [],
    });
    assert.deepEqual(result.reasons, [reason]);
  }

  const unreadable = await finalizeContinuationLedgerLive(response, context, {
    readTicket: async () => { throw new Error("connection refused"); },
    readMutations: async () => [],
  });
  assert.deepEqual(unreadable.reasons, ["TRACKER_UNREADABLE:AUT-34"]);
  for (const malformed of [
    liveTicket({ content_strings: [7] }),
    liveTicket({ unexpected: true }),
  ]) {
    const result = await finalizeContinuationLedgerLive(response, context, {
      readTicket: async () => malformed as never,
      readMutations: async () => [],
    });
    assert.deepEqual(result.reasons, ["TRACKER_UNREADABLE:AUT-34"]);
  }
});

test("MUTATED requires one successful same-run same-session same-ticket allowed action", async () => {
  const response = ledger([item({ disposition: "MUTATED", mutation_action: "advanced", ticket_id: "AUT-34" })]);
  const context = { parentId: "AUT-5", runId: "run-7", sessionId: "session-7" };
  const proof = mutationProof();
  let ticketReads = 0;
  const run = (records: Array<Record<string, unknown>>) => finalizeContinuationLedgerLive(response, context, {
    readTicket: async () => { ticketReads += 1; return liveTicket({ evidence_reference_ids: ["artifact reference"] }); },
    readMutations: async () => records,
  });
  assert.equal((await run([proof])).status, "PASS");
  assert.equal(ticketReads, 1);
  for (const [records, reason] of [
    [[], "MUTATION_NOT_FOUND:AUT-34"],
    [[{ ...proof, outcome: "failed" }], "MUTATION_FAILED:AUT-34"],
    [[{ ...proof, ticket_id: "AUT-35" }], "MUTATION_TICKET_MISMATCH:AUT-34"],
    [[{ ...proof, run_sha256: sha("run-8") }], "MUTATION_RUN_MISMATCH:AUT-34"],
    [[{ ...proof, session_sha256: sha("session-8") }], "MUTATION_SESSION_MISMATCH:AUT-34"],
    [[{ ...proof, action: "commented" }], "MUTATION_ACTION_MISMATCH:AUT-34"],
  ] as const) {
    assert.deepEqual((await run(records as Array<Record<string, unknown>>)).reasons, [reason]);
  }
  const mixed = await run([
    mutationProof({ run_sha256: sha("run-8") }),
    mutationProof({ outcome: "failed" }),
  ]);
  assert.deepEqual(mixed.reasons, ["MUTATION_FAILED:AUT-34"]);
  const malformed = await finalizeContinuationLedgerLive(response, context, {
    readTicket: async () => liveTicket({ evidence_reference_ids: ["artifact reference"] }),
    readMutations: async () => [{ ...proof, unexpected: true }] as never,
  });
  assert.deepEqual(malformed.reasons, ["MUTATION_PROOF_UNREADABLE:AUT-34"]);
  for (const action of ["raised", "commented", "advanced", "blocked", "completed"]) {
    const allowed = ledger([item({ disposition: "MUTATED", mutation_action: action, ticket_id: "AUT-34" })]);
    const result = await finalizeContinuationLedgerLive(allowed, context, {
      readTicket: async () => liveTicket({ evidence_reference_ids: ["artifact reference"] }),
      readMutations: async () => [{ ...proof, action }],
    });
    assert.equal(result.status, "PASS", action);
  }
  const invalid = ledger([item({ disposition: "MUTATED", mutation_action: "edited", ticket_id: "AUT-34" })]);
  assert.deepEqual(finalizeContinuationLedger(invalid).reasons, ["INVALID_MUTATION_ACTION:0"]);
  assert.deepEqual(finalizeContinuationLedger(ledger([item({ disposition: "MUTATED", mutation_action: undefined })])).reasons, [
    "MISSING_FIELD:0:mutation_action",
  ]);

  for (const [ticket, reason] of [
    [liveTicket({ evidence_reference_ids: ["artifact reference"], parent_id: "AUT-6" }), "WRONG_TICKET_PARENT:AUT-34"],
    [liveTicket({ evidence_reference_ids: [] }), "EVIDENCE_NOT_FOUND:AUT-34:artifact reference"],
  ] as const) {
    const result = await finalizeContinuationLedgerLive(response, context, {
      readTicket: async () => ticket,
      readMutations: async () => [proof],
    });
    assert.deepEqual(result.reasons, [reason]);
  }
});

test("MONITORING ONLY requires explicit ownership and exit fields without live reads", async () => {
  const monitoring = item({
    disposition: "MONITORING ONLY",
    ticket_id: undefined,
    monitoring_owner: "release watcher",
    monitoring_reference: "upstream-42",
    monitoring_reason: "Upstream release is externally controlled",
    monitoring_check: "Read upstream release status",
    monitoring_exit: "Release 42 is published",
  });
  assert.equal(finalizeContinuationLedger(ledger([monitoring])).status, "PASS");
  let reads = 0;
  const result = await finalizeContinuationLedgerLive(ledger([monitoring]), {
    parentId: "AUT-5", runId: "run-7", sessionId: "session-7",
  }, {
    readTicket: async () => { reads += 1; return liveTicket(); },
    readMutations: async () => { reads += 1; return []; },
  });
  assert.equal(result.status, "PASS");
  assert.equal(reads, 0);

  for (const field of ["monitoring_owner", "monitoring_reference", "monitoring_reason", "monitoring_check", "monitoring_exit"]) {
    const missing = { ...monitoring, [field]: undefined };
    assert.deepEqual(finalizeContinuationLedger(ledger([missing])).reasons, [`MISSING_FIELD:0:${field}`]);
  }
});

import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { readMutationProofs, recordMutationProof } from "../src/autonomy/mutation-proof.js";
import { finalizeContinuationLedgerLive } from "../src/continuation/finalizer.js";
import { cleanup, tempProject } from "./helpers.js";

test("mutation proof write is atomic, leased, idempotent, and hashes run provenance", async () => {
  const root = await tempProject("ch-mutation-proof-");
  try {
    const input = {
      root,
      runId: "private-run-id",
      sessionId: "private-session-id",
      ticketId: "AUT-34",
      action: "advanced" as const,
    };
    const fixed = { now: () => "2026-07-15T04:05:06.000Z" };
    const [first, replay] = await Promise.all([
      recordMutationProof(input, fixed),
      recordMutationProof(input, fixed),
    ]);
    assert.deepEqual([first.status, replay.status].sort(), ["replayed", "written"]);
    const records = await readMutationProofs(root);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.ticket_id, "AUT-34");
    assert.equal(records[0]?.action, "advanced");
    assert.equal(records[0]?.outcome, "success");
    assert.match(records[0]?.run_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.match(records[0]?.session_sha256 ?? "", /^[0-9a-f]{64}$/);
    const stored = await fs.readFile(path.join(root, ".ycm-harness", "autonomy", "mutation-proofs", `${records[0]!.proof_id}.json`), "utf8");
    assert.doesNotMatch(stored, /private-run-id|private-session-id/);
    assert.deepEqual((await fs.readdir(path.join(root, ".ycm-harness", "autonomy", "mutation-proofs"))).filter((name) => name.endsWith(".tmp")), []);
  } finally {
    await cleanup(root);
  }
});

test("mutation proof writer accepts five canonical actions and retains failed attempts", async () => {
  const root = await tempProject("ch-mutation-actions-");
  try {
    for (const action of ["raised", "commented", "advanced", "blocked", "completed"] as const) {
      await recordMutationProof({ root, runId: "run", sessionId: "session", ticketId: `ticket-${action}`, action });
    }
    assert.equal((await readMutationProofs(root)).length, 5);
    const failed = await recordMutationProof({
      root, runId: "run", sessionId: "session", ticketId: "ticket-failed", action: "advanced", outcome: "failed",
    });
    assert.equal(failed.proof.outcome, "failed");
    assert.equal((await readMutationProofs(root)).filter((record) => record.outcome === "failed").length, 1);
    const response = `\`\`\`continuation-ledger\n${JSON.stringify({ items: [{
      lane: "NEXT",
      action: "Inspect the artifact",
      disposition: "MUTATED",
      mutation_action: "advanced",
      ticket_id: "ticket-failed",
      evidence: "evidence-failed",
      expected_impact: "Records the failed attempt",
      cost_class: "low",
      evidence_horizon: "this run",
    }] })}\n\`\`\``;
    const finalized = await finalizeContinuationLedgerLive(response, { parentId: "goal", runId: "run", sessionId: "session" }, {
      readTicket: async () => ({
        ticket_id: "ticket-failed", configured_parent_id: "goal", parent_id: "goal", status: "in_progress",
        content_strings: ["Inspect the artifact"], evidence_reference_ids: ["evidence-failed"], readback_at: new Date().toISOString(),
      }),
      readMutations: () => readMutationProofs(root),
    });
    assert.deepEqual(finalized.reasons, ["MUTATION_FAILED:ticket-failed"]);
    await assert.rejects(() => recordMutationProof({
      root, runId: "run", sessionId: "session", ticketId: "ticket-invalid", action: "edited" as never,
    }), /invalid_mutation_proof/);
  } finally {
    await cleanup(root);
  }
});

test("mutation proof read and replay reject content-address and filename corruption", async () => {
  const contentRoot = await tempProject("ch-mutation-corrupt-");
  const filenameRoot = await tempProject("ch-mutation-filename-");
  try {
    const input = { root: contentRoot, runId: "run", sessionId: "session", ticketId: "AUT-34", action: "advanced" as const };
    const written = await recordMutationProof(input);
    const contentFile = path.join(contentRoot, ".ycm-harness", "autonomy", "mutation-proofs", `${written.proof.proof_id}.json`);
    const stored = JSON.parse(await fs.readFile(contentFile, "utf8")) as Record<string, unknown>;
    await fs.writeFile(contentFile, JSON.stringify({ ...stored, ticket_id: "AUT-35" }, null, 2) + "\n", "utf8");
    await assert.rejects(() => readMutationProofs(contentRoot), /invalid_stored_mutation_proof/);
    await assert.rejects(() => recordMutationProof(input), /invalid_stored_mutation_proof/);

    const other = await recordMutationProof({ ...input, root: filenameRoot });
    const dir = path.join(filenameRoot, ".ycm-harness", "autonomy", "mutation-proofs");
    await fs.rename(path.join(dir, `${other.proof.proof_id}.json`), path.join(dir, `${"b".repeat(64)}.json`));
    await assert.rejects(() => readMutationProofs(filenameRoot), /invalid_stored_mutation_proof/);
  } finally {
    await cleanup(contentRoot);
    await cleanup(filenameRoot);
  }
});

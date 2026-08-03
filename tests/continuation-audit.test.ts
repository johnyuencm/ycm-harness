import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  finalizeContinuationLedgerLiveAudited,
  readContinuationAudits,
  rebuildContinuationAuditProjection,
  type ContinuationAuditFaultPoint,
} from "../src/continuation/audit.js";
import { cleanup, tempProject } from "./helpers.js";

const RESPONSE = `\`\`\`continuation-ledger\n${JSON.stringify({ items: [] })}\n\`\`\``;
const NOW = "2026-07-16T01:02:03.000Z";

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function legacyV1Record(response: string) {
  const content = {
    schema_version: 1 as const,
    response_sha256: sha(response),
    items: [],
    evidence_reference_ids: [],
    verdict: "PASS" as const,
    reasons: [],
    surface: "scheduled-finalizer",
    mode: "shadow",
    parent_sha256: sha("AUT-5"),
    run_sha256: sha("legacy-run"),
    session_sha256: sha("legacy-session"),
  };
  const contentSha = sha(JSON.stringify(content));
  const authenticated = {
    ...content,
    audit_id: contentSha,
    content_sha256: contentSha,
    recorded_at: NOW,
  };
  return { ...authenticated, record_sha256: sha(JSON.stringify(authenticated)) };
}

async function treeSnapshot(root: string, relative = ""): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const directory = path.join(root, relative);
  for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) Object.assign(snapshot, await treeSnapshot(root, child));
    else if (entry.isSymbolicLink()) snapshot[child] = `link:${await fs.readlink(path.join(root, child))}`;
    else snapshot[child] = `file:${await fs.readFile(path.join(root, child), "utf8")}`;
  }
  return snapshot;
}

function context(root: string, overrides: Record<string, string> = {}) {
  return {
    root,
    parentId: "AUT-5",
    runId: "private-run",
    sessionId: "private-session",
    surface: "scheduled-finalizer",
    mode: "shadow",
    ...overrides,
  };
}

const live = {
  readTicket: async () => undefined,
  readMutations: async () => [],
};

test("audit retains normalized verdict data and only hashed response and provenance", async () => {
  const root = await tempProject("ch-continuation-audit-schema-");
  const response = `\`\`\`continuation-ledger\n${JSON.stringify({ items: [{
    lane: " next ",
    action: "Inspect the artifact",
    disposition: "tracked",
    ticket_id: "AUT-34",
    evidence: "comment-7",
    expected_impact: "Confirms the result",
    cost_class: "low",
    evidence_horizon: "this run",
  }] })}\n\`\`\``;
  try {
    const result = await finalizeContinuationLedgerLiveAudited(response, context(root), {
      now: () => NOW,
      readTicket: async () => ({
        ticket_id: "AUT-34",
        configured_parent_id: "AUT-5",
        parent_id: "AUT-5",
        status: "in_progress",
        content_strings: ["Inspect the artifact"],
        evidence_reference_ids: ["comment-7"],
        readback_at: NOW,
      }),
      readMutations: async () => [],
    });
    assert.equal(result.status, "PASS");
    const [record] = await readContinuationAudits(root);
    assert.equal(record?.response_sha256, sha(response));
    assert.equal(record?.audit_id, record?.content_sha256);
    assert.match(record?.record_sha256 ?? "", /^[0-9a-f]{64}$/);
    assert.equal(record?.run_sha256, sha("private-run"));
    assert.equal(record?.session_sha256, sha("private-session"));
    assert.equal(record?.parent_sha256, sha("AUT-5"));
    assert.equal(record?.verdict, "PASS");
    assert.deepEqual(record?.reasons, []);
    assert.equal(record?.policy.verdict, "PASS");
    assert.equal(record?.policy.trace.stages[0]?.stage, "no_agent");
    assert.equal(record?.policy.trace.stages[0]?.outcome, "sufficient");
    assert.deepEqual(record?.policy.trace.model_invocations, []);
    assert.deepEqual(record?.evidence_reference_ids, ["comment-7"]);
    assert.deepEqual(record?.items, [{
      lane: "NEXT",
      action: "Inspect the artifact",
      disposition: "TRACKED",
      ticket_id: "AUT-34",
      evidence: "comment-7",
      expected_impact: "Confirms the result",
      cost_class: "low",
      evidence_horizon: "this run",
    }]);
    const stored = await fs.readFile(path.join(root, ".ycm-harness", "autonomy", "continuation-audits", "records", `${record!.record_sha256}.json`), "utf8");
    assert.doesNotMatch(stored, /continuation-ledger|private-run|private-session/);
  } finally {
    await cleanup(root);
  }
});

function faultAt(point: ContinuationAuditFaultPoint) {
  return async (actual: ContinuationAuditFaultPoint): Promise<void> => {
    if (actual === point) throw new Error(`crash:${point}`);
  };
}

test("identical concurrent audits converge and distinct provenance persists", async () => {
  const root = await tempProject("ch-continuation-audit-concurrent-");
  try {
    const deps = { ...live, now: () => NOW };
    const [first, second] = await Promise.all([
      finalizeContinuationLedgerLiveAudited(RESPONSE, context(root), deps),
      finalizeContinuationLedgerLiveAudited(RESPONSE, context(root), deps),
    ]);
    assert.equal(first.status, "PASS");
    assert.equal(second.status, "PASS");
    assert.equal((await readContinuationAudits(root)).length, 1);

    await Promise.all([
      finalizeContinuationLedgerLiveAudited(RESPONSE, context(root, { runId: "run-a" }), deps),
      finalizeContinuationLedgerLiveAudited(RESPONSE, context(root, { runId: "run-b" }), deps),
    ]);
    const records = await readContinuationAudits(root);
    assert.equal(records.length, 3);
    assert.equal(new Set(records.map((record) => record.run_sha256)).size, 3);
    const stored = await fs.readFile(path.join(root, ".ycm-harness", "autonomy", "continuation-audits", "index.json"), "utf8");
    assert.doesNotMatch(stored, /private-run|private-session|continuation-ledger/);
  } finally {
    await cleanup(root);
  }
});

test("legacy v1 records retain their original digests while replay emits strict v2", async () => {
  const root = await tempProject("ch-continuation-audit-legacy-v1-");
  const record = legacyV1Record(RESPONSE);
  const recordsDir = path.join(root, ".ycm-harness", "autonomy", "continuation-audits", "records");
  const file = path.join(recordsDir, `${record.record_sha256}.json`);
  try {
    await fs.mkdir(recordsDir, { recursive: true });
    await fs.writeFile(file, JSON.stringify(record, null, 2) + "\n", "utf8");
    const [legacy] = await readContinuationAudits(root);
    assert.equal(record.content_sha256, "87559d7b87f5d625dfd297e53fca521471680de0f396e36a4620138554d906bb");
    assert.equal(record.record_sha256, "0ee582512b808eaec50d682e0d8b7f1d9adab8540f0c2b3a87f1e225a91ba0ad");
    assert.equal(legacy?.schema_version, 1);
    assert.equal("policy" in legacy!, false);
    assert.equal((await rebuildContinuationAuditProjection(root)).records.length, 1);

    const replay = await finalizeContinuationLedgerLiveAudited(RESPONSE, context(root, {
      runId: "legacy-run",
      sessionId: "legacy-session",
    }), { ...live, now: () => NOW });
    assert.equal(replay.status, "PASS");
    const records = await readContinuationAudits(root);
    assert.deepEqual(records.map((candidate) => candidate.schema_version).sort(), [1, 2]);
    assert.equal("policy" in records.find((candidate) => candidate.schema_version === 2)!, true);

    await fs.writeFile(file, JSON.stringify({ ...record, verdict: "FAIL" }, null, 2) + "\n", "utf8");
    await assert.rejects(() => readContinuationAudits(root), /invalid_stored_continuation_audit/);
  } finally {
    await cleanup(root);
  }
});

test("authoritative records replay and reject content or filename corruption", async () => {
  const contentRoot = await tempProject("ch-continuation-audit-content-");
  const filenameRoot = await tempProject("ch-continuation-audit-filename-");
  const timestampRoot = await tempProject("ch-continuation-audit-timestamp-");
  try {
    await finalizeContinuationLedgerLiveAudited(RESPONSE, context(contentRoot), { ...live, now: () => NOW });
    const [record] = await readContinuationAudits(contentRoot);
    const contentFile = path.join(contentRoot, ".ycm-harness", "autonomy", "continuation-audits", "records", `${record!.record_sha256}.json`);
    await fs.writeFile(contentFile, JSON.stringify({ ...record, verdict: "FAIL" }, null, 2) + "\n", "utf8");
    await assert.rejects(() => readContinuationAudits(contentRoot), /invalid_stored_continuation_audit/);
    const failedReplay = await finalizeContinuationLedgerLiveAudited(RESPONSE, context(contentRoot), { ...live, now: () => NOW });
    assert.equal(failedReplay.status, "FAIL");
    assert.deepEqual(failedReplay.reasons, ["AUDIT_PERSISTENCE_FAILED"]);

    await finalizeContinuationLedgerLiveAudited(RESPONSE, context(filenameRoot), { ...live, now: () => NOW });
    const [other] = await readContinuationAudits(filenameRoot);
    const dir = path.join(filenameRoot, ".ycm-harness", "autonomy", "continuation-audits", "records");
    await fs.rename(path.join(dir, `${other!.record_sha256}.json`), path.join(dir, `${"b".repeat(64)}.json`));
    await assert.rejects(() => readContinuationAudits(filenameRoot), /invalid_stored_continuation_audit/);

    await finalizeContinuationLedgerLiveAudited(RESPONSE, context(timestampRoot), { ...live, now: () => NOW });
    const [timestamped] = await readContinuationAudits(timestampRoot);
    const timestampFile = path.join(timestampRoot, ".ycm-harness", "autonomy", "continuation-audits", "records", `${timestamped!.record_sha256}.json`);
    await fs.writeFile(timestampFile, JSON.stringify({ ...timestamped, recorded_at: "2026-07-16T01:02:04.000Z" }, null, 2) + "\n", "utf8");
    await assert.rejects(() => readContinuationAudits(timestampRoot), /invalid_stored_continuation_audit/);
  } finally {
    await cleanup(contentRoot);
    await cleanup(filenameRoot);
    await cleanup(timestampRoot);
  }
});

test("crashes preserve authoritative ordering and replay repairs projection", async () => {
  for (const point of ["before_record_write", "after_record_write", "before_projection_rebuild", "after_index_projection_write", "after_projection_rebuild"] as const) {
    const root = await tempProject(`ch-continuation-audit-${point}-`);
    try {
      const failed = await finalizeContinuationLedgerLiveAudited(RESPONSE, context(root), {
        ...live,
        now: () => NOW,
        auditFault: faultAt(point),
      });
      assert.equal(failed.status, "FAIL", point);
      assert.deepEqual(failed.reasons, ["AUDIT_PERSISTENCE_FAILED"], point);
      const expectedRecords = point === "before_record_write" ? 0 : 1;
      assert.equal((await readContinuationAudits(root)).length, expectedRecords, point);

      const replay = await finalizeContinuationLedgerLiveAudited(RESPONSE, context(root), { ...live, now: () => NOW });
      assert.equal(replay.status, "PASS", point);
      const records = await readContinuationAudits(root);
      assert.equal(records.length, 1, point);
      const projected = JSON.parse(await fs.readFile(path.join(root, ".ycm-harness", "autonomy", "continuation-audits", "index.json"), "utf8")) as { records: unknown[] };
      assert.equal(projected.records.length, 1, point);
      const jsonl = (await fs.readFile(path.join(root, ".ycm-harness", "autonomy", "continuation-audits", "index.jsonl"), "utf8")).trim().split("\n");
      assert.equal(jsonl.length, 1, point);
    } finally {
      await cleanup(root);
    }
  }
});

test("projection is rebuilt from validated records and audit failure preserves validation data", async () => {
  const root = await tempProject("ch-continuation-audit-projection-");
  try {
    await finalizeContinuationLedgerLiveAudited(RESPONSE, context(root), { ...live, now: () => NOW });
    const index = path.join(root, ".ycm-harness", "autonomy", "continuation-audits", "index.json");
    const jsonl = path.join(root, ".ycm-harness", "autonomy", "continuation-audits", "index.jsonl");
    await fs.writeFile(index, "{\"records\":[]}", "utf8");
    await fs.writeFile(jsonl, "{\"lost\":true}\n{\"duplicate\":true}\n", "utf8");
    const rebuilt = await rebuildContinuationAuditProjection(root);
    assert.equal(rebuilt.records.length, 1);
    const lines = (await fs.readFile(jsonl, "utf8")).trim().split("\n").map((line) => JSON.parse(line) as { record_sha256: string });
    assert.deepEqual(lines.map((record) => record.record_sha256), rebuilt.records.map((record) => record.record_sha256));

    const invalid = "ordinary prose";
    const failed = await finalizeContinuationLedgerLiveAudited(invalid, context(root, { runId: "other-run" }), {
      ...live,
      auditFault: faultAt("before_record_write"),
    });
    assert.equal(failed.status, "FAIL");
    assert.deepEqual(failed.reasons, ["MISSING_LEDGER", "AUDIT_PERSISTENCE_FAILED"]);
    assert.deepEqual(failed.items, []);
  } finally {
    await cleanup(root);
  }
});

test("symlinked audit records fail closed without writing outside the root", async (t) => {
  const root = await tempProject("ch-continuation-audit-symlink-");
  const outside = await tempProject("ch-continuation-audit-outside-");
  try {
    const audit = path.join(root, ".ycm-harness", "autonomy", "continuation-audits");
    await fs.mkdir(audit, { recursive: true });
    await fs.writeFile(path.join(outside, "sentinel"), "outside", "utf8");
    try {
      await fs.symlink(outside, path.join(audit, "records"), process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks unavailable");
      throw error;
    }
    const result = await finalizeContinuationLedgerLiveAudited(RESPONSE, context(root), { ...live, now: () => NOW });
    assert.equal(result.status, "FAIL");
    assert.deepEqual(result.reasons, ["AUDIT_PERSISTENCE_FAILED"]);
    await assert.rejects(() => readContinuationAudits(root), /unsafe_continuation_audit_path/);
    assert.deepEqual(await fs.readdir(outside), ["sentinel"]);
    assert.equal(await fs.readFile(path.join(outside, "sentinel"), "utf8"), "outside");
  } finally {
    await cleanup(root);
    await cleanup(outside);
  }
});

test("pre-lease guard rejects harness and lock symlinks before external writes", async (t) => {
  for (const kind of ["harness", "locks", "lease"] as const) {
    const root = await tempProject(`ch-continuation-audit-prelease-${kind}-`);
    const outside = await tempProject(`ch-continuation-audit-prelease-outside-${kind}-`);
    try {
      await fs.writeFile(path.join(outside, "sentinel"), kind, "utf8");
      const harness = path.join(root, ".ycm-harness");
      const autonomy = path.join(harness, "autonomy");
      const locks = path.join(autonomy, "locks");
      const target = kind === "harness" ? harness : kind === "locks" ? locks : path.join(locks, "continuation-audits.lock");
      if (kind === "locks") await fs.mkdir(autonomy, { recursive: true });
      if (kind === "lease") await fs.mkdir(locks, { recursive: true });
      try {
        await fs.symlink(outside, target, process.platform === "win32" ? "junction" : "dir");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EPERM") return t.skip("symlinks unavailable");
        throw error;
      }
      const before = await treeSnapshot(outside);
      const result = await finalizeContinuationLedgerLiveAudited(RESPONSE, context(root), { ...live, now: () => NOW });
      assert.equal(result.status, "FAIL", kind);
      assert.deepEqual(result.reasons, ["AUDIT_PERSISTENCE_FAILED"], kind);
      await assert.rejects(() => rebuildContinuationAuditProjection(root), /unsafe_continuation_audit_path/, kind);
      assert.deepEqual(await treeSnapshot(outside), before, kind);
    } finally {
      await cleanup(root);
      await cleanup(outside);
    }
  }
});

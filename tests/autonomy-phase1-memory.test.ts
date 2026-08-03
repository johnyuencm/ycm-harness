import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { filterMemoryCandidates } from "../plugin/scripts/filter-memory-candidates.mjs";

const exec = promisify(execFile);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const script = path.join(repo, "plugin", "scripts", "filter-memory-candidates.mjs");
const fixture = path.join(repo, "tests", "fixtures", "autonomy-memory-candidates.json");

test("stable authorized preferences pass and unsafe candidates expose reasons only", async () => {
  const candidates = JSON.parse(await fs.readFile(fixture, "utf8"));
  const result = filterMemoryCandidates(candidates);
  assert.deepEqual(result.accepted.map((item) => item.id), ["phase-focus", "durable-followups"]);
  assert.deepEqual(new Set(result.denied.map((item) => item.reason)), new Set([
    "secret", "private_identifier", "ticket_or_commit", "transient_progress",
    "source_path", "procedure", "not_authorized",
  ]));
  assert.equal(JSON.stringify(result).includes("RAW_SECRET_SENTINEL_P1"), false);
});

test("conflicts fail closed in both orders and duplicates do not project twice", () => {
  const a = { id: "a", key: "preference.same", kind: "preference", authorized: true, text: "Large work uses seven focused implementation phases." };
  const b = { id: "b", key: "preference.same", kind: "preference", authorized: true, text: "Large work uses one combined implementation phase." };
  for (const values of [[a, b], [b, a]]) {
    const result = filterMemoryCandidates(values);
    assert.equal(result.accepted.length, 0);
    assert.deepEqual(result.denied.map((item) => item.reason).sort(), ["conflict", "conflict"]);
  }
  const duplicate = filterMemoryCandidates([a, { ...a, id: "a-copy" }]);
  assert.equal(duplicate.accepted.length, 1);
  assert.deepEqual(duplicate.denied, [{ id: "a-copy", reason: "duplicate" }]);
});

test("CLI is dry-run only and leaks no denied value to output or temporary files", async () => {
  const outputDir = await fs.mkdtemp(path.join(os.tmpdir(), "ch-p1-memory-output-"));
  try {
    const { stdout, stderr } = await exec(process.execPath, [script, fixture], { cwd: outputDir });
    assert.equal(stderr, "");
    assert.match(stdout, /phase-focus/);
    assert.equal(`${stdout}\n${stderr}`.includes("RAW_SECRET_SENTINEL_P1"), false);
    assert.deepEqual(await fs.readdir(outputDir), []);
  } finally {
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});


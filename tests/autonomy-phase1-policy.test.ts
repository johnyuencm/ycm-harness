import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repo, "plugin", "skills", "autonomous-harness");

test("Phase 1 policy skill has valid routing, reference, and canary", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: autonomous-harness\r?\ndescription: >-/);
  assert.match(skill, /PORTABLE_TARGET_CANARY_V1/);
  assert.match(skill, /references\/operating-policy\.md/);
  assert.equal(await fs.stat(path.join(skillRoot, "references", "operating-policy.md")).then((s) => s.isFile()), true);
});

test("Phase 1 policy requires durable live-read continuations and bounded cost", async () => {
  const all = await Promise.all([
    fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8"),
    fs.readFile(path.join(skillRoot, "references", "operating-policy.md"), "utf8"),
  ]).then((parts) => parts.join("\n"));

  for (const rule of [
    /every mutation or deferred continuation/i,
    /immediately live-read/i,
    /bounded read-only inspection may be ticket-exempt/i,
    /least expensive adequate tier/i,
    /per-run LLM judge/i,
    /one bounded correction path/i,
    /snapshot affected state and define rollback/i,
    /guidance must not be reported as enforcement/i,
  ]) assert.match(all, rule);
});

test("Phase 1 policy explicitly rejects premature later-phase assurance", async () => {
  const policy = await fs.readFile(path.join(skillRoot, "references", "operating-policy.md"), "utf8");
  assert.match(policy, /does not implement deed telemetry/i);
  for (const prohibitedClaim of [
    /deed telemetry is enforced/i,
    /startup scout is installed/i,
    /continuation ledger is active/i,
    /review schedules are enabled/i,
    /watchdog is running/i,
    /natural cycles have passed/i,
  ]) assert.doesNotMatch(policy, prohibitedClaim);
});


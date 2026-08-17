import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginSkills = path.join(repo, "plugin", "skills");

test("ycm-harness-work-lite ships with procedure and forbid list", async () => {
  const skill = await fs.readFile(
    path.join(pluginSkills, "ycm-harness-work-lite", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\r?\nname: ycm-harness-work-lite\r?\n/);
  assert.match(skill, /Forbidden/);
  assert.match(skill, /tech_lead/);
  assert.match(skill, /review panel/);
  assert.match(skill, /uiux/);
  assert.match(skill, /finish-architecture\.md/);
  assert.match(skill, /improve-codebase-architecture/);
  assert.match(skill, /Done bar/);
  assert.doesNotMatch(skill, /phase start validate/);
  assert.doesNotMatch(skill, /ycm-harness ritual record/);
  assert.doesNotMatch(skill, /smoke run --/);
  assert.match(skill, /wiki durable/);
  assert.doesNotMatch(skill, /wiki page upsert/);
});

test("ycm-harness-work-lite finish-architecture triggers external mattpocock skill", async () => {
  const doc = await fs.readFile(
    path.join(pluginSkills, "ycm-harness-work-lite", "finish-architecture.md"),
    "utf8",
  );
  assert.match(doc, /improve-codebase-architecture/);
  assert.match(doc, /Top recommendation/);
  assert.match(doc, /not bundled/);
  assert.match(doc, /Attach the skill/);
});

test("plan-and-advance hard-wires handoff to ycm-harness-work-lite", async () => {
  const skill = await fs.readFile(
    path.join(pluginSkills, "plan-and-advance", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /\/ycm-harness-work-lite/);
  assert.match(
    skill,
    /\*\*`ycm-harness-work-lite`\*\* \(`\/ycm-harness-work-lite`\)/,
  );
  assert.match(
    skill,
    /Handing off to full `\/ycm-harness-work` from this skill/,
  );
  // Must not still instruct a default full-work handoff after Plan.
  assert.doesNotMatch(
    skill,
    /hand off to \*\*`\/ycm-harness-work`\*\* to implement/,
  );
  assert.doesNotMatch(
    skill,
    /Immediately hand off to \*\*`\/ycm-harness-work`\*\*/,
  );
});

test("harness rule documents lite carve-out", async () => {
  const rule = await fs.readFile(
    path.join(repo, "plugin", "rules", "ycm-harness.mdc"),
    "utf8",
  );
  assert.match(rule, /Lite carve-out/);
  assert.match(rule, /ycm-harness-work-lite/);
});

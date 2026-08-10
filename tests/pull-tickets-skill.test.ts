import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginSkills = path.join(repo, "plugin", "skills");

test("pull-tickets ships with frontier pull, prioritize, and lite handoff", async () => {
  const skill = await fs.readFile(
    path.join(pluginSkills, "pull-tickets", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /^---\r?\nname: pull-tickets\r?\n/);
  assert.match(skill, /ycm-harness-work-lite/);
  assert.match(skill, /dry-run/);
  assert.match(skill, /issue_dependencies_summary/);
  assert.doesNotMatch(skill, /ycm-harness goal worktree/i);
});

test("pull-tickets is installed via HARNESS_SKILL_DIRS", async () => {
  const kit = await fs.readFile(
    path.join(repo, "src", "cli", "install-kit.ts"),
    "utf8",
  );
  assert.match(kit, /"pull-tickets"/);
});

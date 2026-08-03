import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repo, "plugin", "skills", "hard-problem-solving");

test("hard-problem-solving ships in plugin/skills with Codex interface", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: hard-problem-solving\r?\n/);
  assert.match(skill, /RCA → Evidence → 3 Whys → Solution Plan/);
  assert.match(skill, /Dominant mechanism/);
  assert.match(skill, /Decision Note Template/);
  const openaiYaml = await fs.readFile(
    path.join(skillRoot, "agents", "openai.yaml"),
    "utf8",
  );
  assert.match(openaiYaml, /display_name: "Hard Problem Solving"/);
  assert.match(openaiYaml, /\$hard-problem-solving/);
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginSkills = path.join(repo, "plugin", "skills");
const commanderSystem = path.join(repo, "plugin", "commander-system");

const EXTRA_SKILLS = [
  "commander",
  "merge-branches-to-master",
  "create-skill",
  "migrate-multica-to-github-projects",
] as const;

test("extra plugin skills ship with SKILL.md and Codex openai.yaml", async () => {
  for (const name of EXTRA_SKILLS) {
    const skill = await fs.readFile(
      path.join(pluginSkills, name, "SKILL.md"),
      "utf8",
    );
    assert.match(skill, new RegExp(`^---\\r?\\nname: ${name}\\r?\\n`));
    const yaml = await fs.readFile(
      path.join(pluginSkills, name, "agents", "openai.yaml"),
      "utf8",
    );
    assert.match(yaml, /display_name:/);
  }
});

test("commander-system templates use {{HOME}} and include inventories", async () => {
  const entrySkill = await fs.readFile(
    path.join(commanderSystem, "entry", "cursor-commander-SKILL.md"),
    "utf8",
  );
  assert.match(entrySkill, /\{\{HOME\}\}\\\.agents\\system\\/);
  assert.match(entrySkill, /11-INVENTORY-/);

  for (const f of [
    "00-DIAGNOSIS.md",
    "10-DISPATCH.md",
    "11-INVENTORY-cursor.md",
    "11-INVENTORY-claude.md",
    "11-INVENTORY-codex.md",
    "20-JUDGMENT.md",
    "30-TEMPLATES.md",
    "40-MAINTENANCE.md",
    "50-LETTER.md",
    "LESSONS.md",
  ]) {
    await fs.stat(path.join(commanderSystem, "system", f));
  }

  await fs.stat(path.join(repo, "plugin", "scripts", "install-commander.mjs"));
});

test("plugin commander skill points at ~/.agents/system", async () => {
  const skill = await fs.readFile(
    path.join(pluginSkills, "commander", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /~\/\.agents\/system\//);
  assert.doesNotMatch(skill, /\{\{HOME\}\}/);
});

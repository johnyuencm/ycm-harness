import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillRoot = path.join(repo, "plugin", "skills", "llm-wiki");

test("llm-wiki ships in plugin/skills with Codex interface", async () => {
  const skill = await fs.readFile(path.join(skillRoot, "SKILL.md"), "utf8");
  assert.match(skill, /^---\r?\nname: llm-wiki\r?\n/);
  assert.match(skill, /persistent wiki/);
  assert.match(skill, /wiki durable/);
  assert.match(skill, /File durable answers back into the wiki/);
  const openaiYaml = await fs.readFile(
    path.join(skillRoot, "agents", "openai.yaml"),
    "utf8",
  );
  assert.match(openaiYaml, /display_name: "LLM Wiki"/);
  assert.match(openaiYaml, /\$llm-wiki/);
});

test("llm-wiki is installed via HARNESS_SKILL_DIRS", async () => {
  const kit = await fs.readFile(
    path.join(repo, "src", "cli", "install-kit.ts"),
    "utf8",
  );
  assert.match(kit, /"llm-wiki"/);
});

test("ycm-harness-work wiki.md references llm-wiki skill when shipped", async () => {
  const wikiPath = path.join(
    repo,
    "plugin",
    "skills",
    "ycm-harness-work",
    "wiki.md",
  );
  try {
    const wiki = await fs.readFile(wikiPath, "utf8");
    assert.match(wiki, /\$llm-wiki/);
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return;
    }
    throw err;
  }
});

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const agentsDir = path.join(repo, "plugin", "agents");

const EXPECTED_AGENTS = [
  "implementer.md",
  "tech_lead.md",
  "spec_reviewer.md",
  "user_advocate.md",
  "project_manager.md",
  "explore-architecture.md",
  "explore-risks.md",
] as const;

function frontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match, "agent file must have YAML frontmatter");
  const fields: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return fields;
}

test("plugin ships specialist harness agents with Cursor frontmatter", async () => {
  const names = (await fs.readdir(agentsDir)).filter((n) => n.endsWith(".md")).sort();
  assert.deepEqual(names, [...EXPECTED_AGENTS].sort());
  assert.ok(!names.includes("combined_reviewer.md"));

  for (const file of EXPECTED_AGENTS) {
    const content = await fs.readFile(path.join(agentsDir, file), "utf8");
    const meta = frontmatter(content);
    assert.ok(meta.name, `${file} missing name`);
    assert.ok(meta.description, `${file} missing description`);
    assert.doesNotMatch(content, /cursor-harness review verdict/);
    assert.doesNotMatch(content, /--score <N>/);
  }

  const implementer = await fs.readFile(
    path.join(agentsDir, "implementer.md"),
    "utf8",
  );
  assert.match(implementer, /review panel/);
  assert.match(implementer, /mattpocock-skills@mattpocock/);

  const pluginJson = JSON.parse(
    await fs.readFile(
      path.join(repo, "plugin", ".cursor-plugin", "plugin.json"),
      "utf8",
    ),
  );
  assert.equal(pluginJson.agents, "./agents");
});

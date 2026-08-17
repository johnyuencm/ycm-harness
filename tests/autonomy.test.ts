import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = fileURLToPath(import.meta.url);
const root = path.resolve(path.dirname(here), "..");

const workSkill = path.join(
  root,
  "plugin",
  "skills",
  "ycm-harness-work",
  "SKILL.md",
);
const workSkillDir = path.dirname(workSkill);
const designSkill = path.join(
  root,
  "plugin",
  "skills",
  "ycm-harness-design",
  "SKILL.md",
);
const projectRule = path.join(root, "plugin", "rules", "ycm-harness.mdc");
const templateRule = path.join(root, "templates", "cursor-rule.mdc");
const codexPlugin = path.join(root, "plugin", ".cursor-plugin", "plugin.json");
const installCommand = path.join(root, "src", "cli", "commands", "install.ts");
const SPLIT_CONTEXT_FILES = [
  "autonomy.md",
  "discuss-grill-me.md",
  "execute-agents.md",
  "orchestrator-checklist.md",
  "ralph-loop.md",
];

const REQUIRED_SKILL_PHRASES = [
  "ycm-harness-design",
  "ticket submit",
  "verify run",
  "tech_lead",
  "Independent review",
  "wiki durable",
  "goal worktree init",
  "ycm-harness review",
  "when sibling files exist",
  "review-fix-loop.md",
  "orchestrator-checklist.md",
];

const REQUIRED_DESIGN_SKILL_PHRASES = [
  "name: ycm-harness-design",
  "ycm-harness-work",
  "checkpoint decision",
  "observable acceptance criteria",
  "ycm-harness status",
];

const REQUIRED_RULE_PHRASES = [
  "Autonomy contract",
  "Do not leave work to the user",
  "next --json",
  "tech_lead",
  "ticket submit",
  "verify run",
  "Lite carve-out",
  "ycm-harness-design",
  "ycm-harness-work",
  "goal worktree init",
  "GitHub",
  "wiki durable",
  "ycm-harness review",
  "strongest available model",
];

const REQUIRED_CONTEXT_PHRASES: Record<string, string[]> = {
  "autonomy.md": [
    "Do not leave work to the user",
    "ycm-harness next --json",
    "Propose, Then Confirm",
    "goal worktree init",
    "ticket submit",
  ],
  "commands.md": [
    "ticket submit",
    "verify run",
    "goal worktree",
    "Deprecated exit-2",
  ],
  "explore.md": [
    "explore-synthesis",
    "explore-codebase",
    "explore-knowledge-base",
    "Fan-out",
  ],
  "wiki.md": ["$llm-wiki", "wiki durable", "redaction", "session tick"],
  "review-fix-loop.md": [
    "tech_lead",
    "spec_reviewer",
    "user_advocate",
    "uiux",
    "project_manager",
    "author",
    "Review dispatch SOP",
    "$hard-problem-solving",
    "dominant mechanism",
  ],
  "discuss-grill-me.md": ["AskQuestion", "Plan", "ready", "grill-with-docs"],
  "execute-agents.md": ["tdd", "T5"],
  "cursor-modes.md": ["Shift+Tab", "multitask"],
  "caveman.md": ["Caveman compression", "User-facing messages stay normal"],
  "github-tickets.md": [
    "gh issue create",
    "parent issue",
    "child issue",
    "Project",
    "follow-up",
    "Fixes #",
  ],
  "orchestrator-checklist.md": [
    "Orchestrator fulfillment checklist",
    "verify run",
    "ticket submit",
    "anti-gaming",
    "improve-codebase-architecture",
  ],
  "finish-architecture.md": [
    "improve-codebase-architecture",
    "Top recommendation",
  ],
};

async function readIfPresent(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, "utf8");
  } catch (err) {
    if (err && typeof err === "object" && "code" in err && err.code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

test("skill file stays focused on workflow steps and links context files", async () => {
  const content = await fs.readFile(workSkill, "utf8");
  for (const phrase of REQUIRED_SKILL_PHRASES) {
    assert.ok(content.includes(phrase), `work skill missing phrase: ${phrase}`);
  }
  assert.match(content, /name: ycm-harness-work/);
  assert.ok(
    content.length < 8000,
    "SKILL.md should stay compact; detailed context belongs in sibling files",
  );
  assert.doesNotMatch(content, /## Autonomy contract/);
  assert.doesNotMatch(content, /## Core commands/);
  assert.doesNotMatch(content, /ycm-harness review start/);
  assert.doesNotMatch(content, /phase start/);
  assert.doesNotMatch(content, /ritual record/);
});

test("plugin skills and rules do not prescribe the cursor-harness CLI", async () => {
  const roots = [
    path.join(root, "plugin", "skills"),
    path.join(root, "plugin", "rules"),
    path.join(root, "plugin", ".cursor-plugin"),
    path.join(root, "plugin", ".claude-plugin"),
  ];
  async function walk(dir: string): Promise<string[]> {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) files.push(...(await walk(full)));
      else if (/\.(md|mdc|json)$/.test(entry.name)) files.push(full);
    }
    return files;
  }
  for (const start of roots) {
    for (const file of await walk(start)) {
      const content = await fs.readFile(file, "utf8");
      assert.doesNotMatch(
        content,
        /cursor-harness/,
        `${path.relative(root, file)} still names cursor-harness`,
      );
    }
  }
});

test("finish.md uses live 0.3 close-out commands", async () => {
  const content = await readIfPresent(path.join(workSkillDir, "finish.md"));
  if (content === null) return;
  assert.match(content, /wiki durable/);
  assert.match(content, /goal complete/);
  assert.doesNotMatch(content, /progress` artifact/);
  assert.doesNotMatch(content, /project-wiki-update/);
});

test("design skill drives grill-me into to-spec and to-tickets planning", async () => {
  const content = await fs.readFile(designSkill, "utf8");
  for (const phrase of REQUIRED_DESIGN_SKILL_PHRASES) {
    assert.ok(
      content.includes(phrase),
      `design skill missing phrase: ${phrase}`,
    );
  }
  assert.ok(content.length < 8000, "design skill should stay compact");
});

test("skill context files contain on-demand details", async () => {
  for (const [file, phrases] of Object.entries(REQUIRED_CONTEXT_PHRASES)) {
    const content = await readIfPresent(path.join(workSkillDir, file));
    if (content === null) continue;
    for (const phrase of phrases) {
      assert.ok(content.includes(phrase), `${file} missing phrase: ${phrase}`);
    }
  }
});

test("GitHub guidance mirrors goal as parent + ticket children + follow-ups", async () => {
  const files = [
    path.join(workSkillDir, "github-tickets.md"),
    path.join(workSkillDir, "anti-stop.md"),
    path.join(workSkillDir, "full-run.md"),
    path.join(workSkillDir, "commands.md"),
    projectRule,
    templateRule,
  ];
  const parts = [];
  for (const file of files) {
    const content = await readIfPresent(file);
    if (content !== null) parts.push(content);
  }
  const combined = parts.join("\n");
  assert.match(combined, /one parent (?:issue|GitHub issue)/i);
  assert.match(combined, /one child (?:issue )?per ticket/i);
  assert.match(combined, /follow-up/i);
  assert.match(combined, /gh auth status/i);
  assert.match(combined, /Project harness|project number `?1`?/i);
  assert.doesNotMatch(combined, /\bmultica issue\b/i);
});

test("project rule embeds the autonomy contract", async () => {
  const content = await fs.readFile(projectRule, "utf8");
  for (const phrase of REQUIRED_RULE_PHRASES) {
    assert.ok(content.includes(phrase), `rule missing phrase: ${phrase}`);
  }
});

test("template rule matches the project rule byte-for-byte", async () => {
  const a = await fs.readFile(projectRule, "utf8");
  const b = await fs.readFile(templateRule, "utf8");
  assert.equal(
    a,
    b,
    "templates/cursor-rule.mdc must mirror plugin/rules/ycm-harness.mdc",
  );
});

test("Cursor/Codex plugin manifests and work skill route through split harness skills", async () => {
  const manifest = JSON.parse(await fs.readFile(codexPlugin, "utf8")) as {
    skills?: string;
    hooks?: string;
  };
  assert.equal(manifest.skills, "./skills/");
  assert.match(manifest.hooks ?? "", /hooks-cursor/);
  const work = await fs.readFile(workSkill, "utf8");
  assert.match(work, /ycm-harness-design/);
  assert.match(work, /name: ycm-harness-work/);
});

test("install help routes through split harness skills", async () => {
  const content = await fs.readFile(installCommand, "utf8");
  assert.match(content, /user-level design\/work skills and plugin/);
  assert.match(content, /ycm-harness-design/);
  assert.match(content, /ycm-harness-work/);
  assert.doesNotMatch(content, /\/ycm-harness' works immediately/);
});

test("shipped context docs use split skill activation names", async () => {
  for (const file of SPLIT_CONTEXT_FILES) {
    const content = await readIfPresent(path.join(workSkillDir, file));
    if (content === null) continue;
    assert.doesNotMatch(
      content,
      /\/ycm-harness\b/,
      `${file} still mentions old slash activation`,
    );
  }
});

test("execute-agents puts spec completeness on the specialist panel", async () => {
  const content = await readIfPresent(
    path.join(workSkillDir, "execute-agents.md"),
  );
  if (content === null) return;
  assert.match(content, /spec_reviewer/);
  assert.match(content, /review panel/);
});

test("install-kit prunes leftover cursor-harness agent dirs", async () => {
  const kit = await fs.readFile(
    path.join(root, "src", "cli", "install-kit.ts"),
    "utf8",
  );
  assert.match(kit, /LEGACY_AGENT_DIRS/);
  assert.match(kit, /pruneLegacyAgentDirs/);
  assert.match(kit, /staleLegacyAgentItems/);
  assert.match(kit, /export async function repairLegacyAgentDirs/);
  const doctor = await fs.readFile(
    path.join(root, "src", "cli", "commands", "doctor.ts"),
    "utf8",
  );
  assert.match(doctor, /repairLegacyAgentDirs/);
});

test("commander-dispatch defaults implementer and reviewer to strongest HIGH", async () => {
  const content = await readIfPresent(
    path.join(workSkillDir, "commander-dispatch.md"),
  );
  if (content === null) return;
  assert.match(content, /strongest available model/);
  assert.doesNotMatch(content, /MID \(default\)/);
  assert.match(content, /HIGH \(default for implementer \+ review panel\)/);
});

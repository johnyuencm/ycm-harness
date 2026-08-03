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
  "Context files:",
  "autonomy.md",
  "commands.md",
  "review-fix-loop.md",
  "github-tickets.md",
  "Step 1: Work Bootstrap",
  "Step 2: Execute With Ralph",
  "Step 3: Validate",
  "Step 4: Finish",
  "artifacts.md",
  "execute-agents.md",
  "cursor-modes.md",
  "ralph-loop.md",
  "orchestrator-checklist.md",
  "ultrawork",
  "ralph",
  "review-gate",
  "project-wiki-update",
  "goal worktree init",
  "doctor --repair",
  "Step 0: Self-heal",
  "tdd",
  "finish-architecture.md",
  "improve-codebase-architecture",
  "mattpocock-skills@mattpocock",
];

const REQUIRED_DESIGN_SKILL_PHRASES = [
  "name: ycm-harness-design",
  "grill-with-docs",
  "AskQuestion",
  "Plan mode",
  "to-spec",
  "to-tickets",
  "wayfinder",
  "mattpocock-skills@mattpocock",
  "ycm-harness-work",
];

const REQUIRED_RULE_PHRASES = [
  "Autonomy contract",
  "Do not leave work to the user",
  "next --json",
  "V5 strict SOP",
  "ritual record",
  "grill-me",
  "writing-plans",
  "ultrawork",
  "ralph",
  "ralph-loop.md",
  "AskQuestion",
  "Plan mode",
  "Multitask",
  "cursor-modes.md",
  "ask user to switch",
  "ycm-harness-design",
  "ycm-harness-work",
  "explore-codebase",
  "goal worktree init",
  "GitHub",
  "orchestrator-checklist.md",
  "child issue",
  "follow-up",
];

const REQUIRED_CONTEXT_PHRASES: Record<string, string[]> = {
  "autonomy.md": [
    "Do not leave work to the user",
    "ycm-harness next --json",
    "Propose, Then Confirm",
    "goal worktree init",
    "phase start explore",
  ],
  "commands.md": [
    "ycm-harness ritual record",
    "ralplan",
    "ycm-harness smoke --task",
    "artifact register",
    "goal worktree",
    "explore-codebase",
  ],
  "explore.md": [
    "explore-synthesis",
    "explore-codebase",
    "explore-knowledge-base",
    "Fan-out",
  ],
  "wiki.md": ["$llm-wiki", "user-wiki", "redaction", "session tick"],
  "review-fix-loop.md": [
    "combined_reviewer",
    "Technical correctness",
    "Specification completeness",
    "Security",
    "User/operator value",
    "author",
    "Fix Loop SOP",
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
    "smoke run",
    "review verdict --evidence-file",
    "blocking_gates",
    "anti-gaming",
    "improve-codebase-architecture",
  ],
  "finish-architecture.md": [
    "improve-codebase-architecture",
    "Top recommendation",
  ],
};

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
    const content = await fs.readFile(path.join(workSkillDir, file), "utf8");
    for (const phrase of phrases) {
      assert.ok(content.includes(phrase), `${file} missing phrase: ${phrase}`);
    }
  }
});

test("GitHub guidance mirrors goal as parent + phase children + follow-ups", async () => {
  const files = [
    path.join(workSkillDir, "github-tickets.md"),
    path.join(workSkillDir, "anti-stop.md"),
    path.join(workSkillDir, "full-run.md"),
    path.join(workSkillDir, "commands.md"),
    projectRule,
    templateRule,
  ];
  const combined = (await Promise.all(files.map((file) => fs.readFile(file, "utf8")))).join("\n");
  assert.match(combined, /one parent (?:issue|GitHub issue)/i);
  assert.match(combined, /one child (?:issue )?per phase/i);
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
    const content = await fs.readFile(path.join(workSkillDir, file), "utf8");
    assert.doesNotMatch(
      content,
      /\/ycm-harness\b/,
      `${file} still mentions old slash activation`,
    );
  }
});

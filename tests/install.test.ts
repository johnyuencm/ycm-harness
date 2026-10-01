import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { tempProject, cleanup } from "./helpers.js";
import { createContext } from "../src/cli/context.js";
import { consoleOutput } from "../src/cli/output.js";
import { registerInstall } from "../src/cli/commands/install.js";
import { codexMarketplaceBlock, upsertTomlSection, wslPathToWindows } from "../src/cli/install-kit.js";

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

async function runInstall(
  cwd: string,
  args: string[],
  homeOverride: string,
): Promise<string[]> {
  const originalHome = process.env.USERPROFILE ?? process.env.HOME;
  if (process.platform === "win32") process.env.USERPROFILE = homeOverride;
  process.env.HOME = homeOverride;

  const stdout: string[] = [];
  const ctx = createContext(cwd);
  const out = {
    ...consoleOutput(),
    out(text: string) {
      stdout.push(text);
    },
    err() {},
    json() {},
  };
  const program = new Command();
  program.exitOverride();
  registerInstall(program, ctx, out);

  try {
    await program.parseAsync(["install", ...args], { from: "user" });
  } finally {
    if (process.platform === "win32") {
      if (originalHome === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = originalHome;
    }
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
  }

  return stdout;
}

test("install --project copies the rule and skill into <cwd>/.cursor/", async () => {
  const project = await tempProject();
  const home = await tempProject();
  try {
    await runInstall(project, ["--project"], home);
    const workSkill = path.join(
      project,
      ".cursor",
      "skills",
      "ycm-harness",
      "SKILL.md",
    );
    const designSkill = path.join(
      project,
      ".cursor",
      "skills",
      "ycm-harness-design",
      "SKILL.md",
    );
    const liteSkill = path.join(
      project,
      ".cursor",
      "skills",
      "ycm-harness-work-lite",
      "SKILL.md",
    );
    const autonomy = path.join(
      project,
      ".cursor",
      "skills",
      "ycm-harness",
      "autonomy.md",
    );
    const rule = path.join(project, ".cursor", "rules", "ycm-harness.mdc");
    const workSkillContent = await fs.readFile(workSkill, "utf8");
    const designSkillContent = await fs.readFile(designSkill, "utf8");
    const liteSkillContent = await fs.readFile(liteSkill, "utf8");
    const ruleContent = await fs.readFile(rule, "utf8");
    assert.match(workSkillContent, /name: ycm-harness-work/);
    assert.match(designSkillContent, /name: ycm-harness-design/);
    assert.match(designSkillContent, /mattpocock-skills@mattpocock/);
    assert.match(liteSkillContent, /name: ycm-harness-work-lite/);
    assert.match(ruleContent, /Lite carve-out/);
    assert.match(designSkillContent, /to-spec/);
    assert.match(designSkillContent, /to-tickets/);
    const autonomyContent = await readIfPresent(autonomy);
    if (autonomyContent !== null) {
      assert.match(autonomyContent, /Do not leave work to the user/);
    }
    assert.match(ruleContent, /ycm-harness 0\.3/);
    const exploreSkill = path.join(
      project,
      ".cursor",
      "skills",
      "ycm-harness",
      "explore.md",
    );
    const implementerAgent = path.join(
      project,
      ".cursor",
      "agents",
      "ycm-harness",
      "implementer.md",
    );
    const techLead = path.join(
      project,
      ".cursor",
      "agents",
      "ycm-harness",
      "tech_lead.md",
    );
    const exploreContent = await readIfPresent(exploreSkill);
    if (exploreContent !== null) {
      assert.match(exploreContent, /Fan-out/);
    }
    assert.match(await fs.readFile(implementerAgent, "utf8"), /implementer/);
    assert.match(
      await fs.readFile(implementerAgent, "utf8"),
      /mattpocock-skills@mattpocock/,
    );
    assert.match(await fs.readFile(techLead, "utf8"), /tech lead/);
    for (const agent of [
      "user_advocate.md",
      "project_manager.md",
      "explore-architecture.md",
      "explore-risks.md",
    ]) {
      const agentPath = path.join(
        project,
        ".cursor",
        "agents",
        "ycm-harness",
        agent,
      );
      assert.ok(
        await fs
          .stat(agentPath)
          .then(() => true)
          .catch(() => false),
        `expected agent: ${agentPath}`,
      );
    }
    assert.equal(
      await fs
        .stat(
          path.join(
            project,
            ".cursor",
            "agents",
            "ycm-harness",
            "combined_reviewer.md",
          ),
        )
        .then(() => true)
        .catch(() => false),
      false,
      "retired combined_reviewer.md must not be installed",
    );
    for (const retired of ["spec_reviewer.md", "uiux.md"]) {
      assert.equal(
        await fs
          .stat(
            path.join(project, ".cursor", "agents", "ycm-harness", retired),
          )
          .then(() => true)
          .catch(() => false),
        false,
        `retired ${retired} must not be installed`,
      );
    }
    for (const external of [
      "grill-me",
      "grill-with-docs",
      "grilling",
      "domain-modeling",
      "tdd",
      "improve-codebase-architecture",
      "codebase-design",
      "to-spec",
      "to-tickets",
      "wayfinder",
      "caveman",
      "caveman-commit",
      "caveman-compress",
      "caveman-help",
      "caveman-review",
      "caveman-stats",
      "cavecrew",
    ]) {
      const externalSkill = path.join(
        project,
        ".cursor",
        "skills",
        external,
        "SKILL.md",
      );
      assert.equal(
        await fs
          .stat(externalSkill)
          .then(() => true)
          .catch(() => false),
        false,
        `external skill must NOT be copied by harness: ${externalSkill}`,
      );
    }
    for (const owned of [
      "ycm-harness",
      "ycm-harness-design",
      "plan-and-advance",
      "pull-tickets",
      "run-technical-design-discussion",
      "llm-wiki",
      "merge-branches-to-master",
      "create-skill",
      "integrating-google-adsense",
    ]) {
      const ownedSkill = path.join(
        project,
        ".cursor",
        "skills",
        owned,
        "SKILL.md",
      );
      assert.ok(
        await fs
          .stat(ownedSkill)
          .then(() => true)
          .catch(() => false),
        `expected harness-owned skill: ${ownedSkill}`,
      );
    }
  } finally {
    await cleanup(project);
    await cleanup(home);
  }
});

test("install --user copies the skill into the user home", async () => {
  const project = await tempProject();
  const home = await tempProject();
  try {
    await runInstall(project, ["--user"], home);
    const workSkill = path.join(
      home,
      ".cursor",
      "skills",
      "ycm-harness",
      "SKILL.md",
    );
    const designSkill = path.join(
      home,
      ".cursor",
      "skills",
      "ycm-harness-design",
      "SKILL.md",
    );
    const liteSkill = path.join(
      home,
      ".cursor",
      "skills",
      "ycm-harness-work-lite",
      "SKILL.md",
    );
    const commands = path.join(
      home,
      ".cursor",
      "skills",
      "ycm-harness",
      "commands.md",
    );
    const pluginManifest = path.join(
      home,
      ".cursor",
      "plugins",
      "ycm-harness",
      ".cursor-plugin",
      "plugin.json",
    );
    const workContent = await fs.readFile(workSkill, "utf8");
    assert.match(workContent, /name: ycm-harness-work/);
    assert.match(
      await fs.readFile(designSkill, "utf8"),
      /name: ycm-harness-design/,
    );
    assert.match(
      await fs.readFile(liteSkill, "utf8"),
      /name: ycm-harness-work-lite/,
    );
    const commandsContent = await readIfPresent(commands);
    if (commandsContent !== null) {
      assert.match(commandsContent, /ycm-harness ticket submit/);
    }
    assert.match(
      await fs.readFile(pluginManifest, "utf8"),
      /"name": "ycm-harness"/,
    );
    for (const external of [
      "grill-me",
      "grill-with-docs",
      "grilling",
      "domain-modeling",
      "tdd",
      "improve-codebase-architecture",
      "codebase-design",
      "to-spec",
      "to-tickets",
      "wayfinder",
      "caveman",
      "cavecrew",
    ]) {
      const externalSkill = path.join(
        home,
        ".cursor",
        "skills",
        external,
        "SKILL.md",
      );
      assert.equal(
        await fs
          .stat(externalSkill)
          .then(() => true)
          .catch(() => false),
        false,
        `external skill must NOT be copied by harness: ${externalSkill}`,
      );
    }
  } finally {
    await cleanup(project);
    await cleanup(home);
  }
});

test("install default scope installs both user skill and project skill+rule", async () => {
  const project = await tempProject();
  const home = await tempProject();
  try {
    await runInstall(project, [], home);
    const userWorkSkill = path.join(
      home,
      ".cursor",
      "skills",
      "ycm-harness",
      "SKILL.md",
    );
    const userDesignSkill = path.join(
      home,
      ".cursor",
      "skills",
      "ycm-harness-design",
      "SKILL.md",
    );
    const projectWorkSkill = path.join(
      project,
      ".cursor",
      "skills",
      "ycm-harness",
      "SKILL.md",
    );
    const projectDesignSkill = path.join(
      project,
      ".cursor",
      "skills",
      "ycm-harness-design",
      "SKILL.md",
    );
    const projectRule = path.join(
      project,
      ".cursor",
      "rules",
      "ycm-harness.mdc",
    );
    for (const f of [
      userWorkSkill,
      userDesignSkill,
      projectWorkSkill,
      projectDesignSkill,
      projectRule,
    ]) {
      assert.ok(
        await fs
          .stat(f)
          .then(() => true)
          .catch(() => false),
        `expected file: ${f}`,
      );
    }
  } finally {
    await cleanup(project);
    await cleanup(home);
  }
});

test("install refuses to overwrite without --force", async () => {
  const project = await tempProject();
  const home = await tempProject();
  try {
    await runInstall(project, ["--project"], home);
    const rule = path.join(project, ".cursor", "rules", "ycm-harness.mdc");
    await fs.writeFile(rule, "user-edited", "utf8");
    await runInstall(project, ["--project"], home);
    const after = await fs.readFile(rule, "utf8");
    assert.equal(after, "user-edited");
    await runInstall(project, ["--project", "--force"], home);
    const overwritten = await fs.readFile(rule, "utf8");
    assert.match(overwritten, /ycm-harness 0\.3/);
  } finally {
    await cleanup(project);
    await cleanup(home);
  }
});

test("install --project --force prunes leftover nested skill files", async () => {
  const project = await tempProject();
  const home = await tempProject();
  try {
    await runInstall(project, ["--project"], home);
    const leftover = path.join(
      project,
      ".cursor",
      "skills",
      "llm-wiki",
      "llm-wiki",
      "SKILL.md",
    );
    await fs.mkdir(path.dirname(leftover), { recursive: true });
    await fs.writeFile(leftover, "# stale nested cursor-harness wiki\n", "utf8");
    await runInstall(project, ["--project", "--force"], home);
    assert.equal(
      await fs
        .stat(leftover)
        .then(() => true)
        .catch(() => false),
      false,
      "force install must prune leftover nested llm-wiki/llm-wiki",
    );
    assert.ok(
      await fs
        .stat(path.join(project, ".cursor", "skills", "llm-wiki", "SKILL.md"))
        .then(() => true)
        .catch(() => false),
    );
  } finally {
    await cleanup(project);
    await cleanup(home);
  }
});

test("install --project --force prunes retired combined_reviewer agent", async () => {
  const project = await tempProject();
  const home = await tempProject();
  try {
    await runInstall(project, ["--project"], home);
    const leftoverNames = [
      "combined_reviewer.md",
      "spec_reviewer.md",
      "uiux.md",
    ];
    for (const name of leftoverNames) {
      await fs.writeFile(
        path.join(project, ".cursor", "agents", "ycm-harness", name),
        "# retired leftover\n",
        "utf8",
      );
    }
    await runInstall(project, ["--project", "--force"], home);
    for (const name of leftoverNames) {
      assert.equal(
        await fs
          .stat(path.join(project, ".cursor", "agents", "ycm-harness", name))
          .then(() => true)
          .catch(() => false),
        false,
        `force install must prune retired ${name}`,
      );
    }
    assert.ok(
      await fs
        .stat(
          path.join(project, ".cursor", "agents", "ycm-harness", "tech_lead.md"),
        )
        .then(() => true)
        .catch(() => false),
    );
  } finally {
    await cleanup(project);
    await cleanup(home);
  }
});

test("codex marketplace block uses the Windows source path under WSL for sync and audit alike", () => {
  const saved = process.env.WSL_DISTRO_NAME;
  process.env.WSL_DISTRO_NAME = "Ubuntu";
  try {
    const block = codexMarketplaceBlock(
      "/mnt/c/Users/x/.codex/marketplaces/ycm-harness",
      "/mnt/c/Users/x/.codex/config.toml",
    );
    assert.match(block, /source = 'C:\\Users\\x\\\.codex\\marketplaces\\ycm-harness'/);
    assert.doesNotMatch(block, /\/mnt\//);
    const linuxHome = codexMarketplaceBlock(
      "/home/x/.codex/marketplaces/ycm-harness",
      "/home/x/.codex/config.toml",
    );
    assert.match(linuxHome, /\/home\/x\/\.codex\/marketplaces\/ycm-harness/);
  } finally {
    if (saved === undefined) delete process.env.WSL_DISTRO_NAME;
    else process.env.WSL_DISTRO_NAME = saved;
  }
});

test("wslPathToWindows maps /mnt drives to Windows paths", () => {
  assert.equal(
    wslPathToWindows("/mnt/c/Users/user/.codex/marketplaces/ycm-harness"),
    "C:\\Users\\user\\.codex\\marketplaces\\ycm-harness",
  );
  assert.equal(wslPathToWindows("/mnt/d/projects/ycm"), "D:\\projects\\ycm");
  assert.equal(wslPathToWindows("/mnt/c"), "C:\\");
  assert.equal(wslPathToWindows("/home/user/.codex/x"), undefined);
  assert.equal(wslPathToWindows("C:\\Users\\user"), undefined);
});
test("upsertTomlSection replaces a section whose header has a trailing comment", () => {
  const raw = '[marketplaces.ycm-harness] # mine\nsource = "old"\n\n[other]\nx = 1\n';
  const out = upsertTomlSection(raw, "marketplaces.ycm-harness", '[marketplaces.ycm-harness]\nsource = "new"\n');
  assert.equal(out.match(/^\[marketplaces\.ycm-harness\]/gm)?.length, 1);
  assert.match(out, /source = "new"/);
  assert.doesNotMatch(out, /source = "old"/);
  assert.match(out, /\[other\]\nx = 1\n/);
});

test("upsertTomlSection keeps foreign text byte-for-byte and is idempotent", () => {
  const foreign = [
    "[marketplaces.other]",
    'source_type = "git"',
    'source = "https://example.com/x"',
    "",
    '[plugins."other@other"]',
    "enabled = true",
    "",
    "[model]",
    'name = "user-choice"',
    "",
  ].join("\n");
  const block = "[marketplaces.ycm-harness-local]\nsource_type = \"local\"\nsource = '/x'\n";
  const once = upsertTomlSection(foreign, "marketplaces.ycm-harness-local", block);
  // The foreign text is a contiguous prefix, unchanged byte-for-byte.
  assert.equal(once.slice(0, foreign.length), foreign);
  // Re-upserting the same section does not duplicate or reorder it.
  const twice = upsertTomlSection(once, "marketplaces.ycm-harness-local", block);
  assert.equal(twice, once);
  assert.equal((twice.match(/\[marketplaces\.ycm-harness-local\]/g) ?? []).length, 1);
  // A file with no trailing newline still gets a separated block.
  const noNewline = upsertTomlSection('[model]\nname = "x"', "marketplaces.ycm-harness-local", block);
  assert.equal(noNewline, '[model]\nname = "x"\n\n' + block);
});

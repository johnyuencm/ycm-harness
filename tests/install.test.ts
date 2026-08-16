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
    const combinedReviewer = path.join(
      project,
      ".cursor",
      "agents",
      "ycm-harness",
      "combined_reviewer.md",
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
    assert.match(
      await fs.readFile(combinedReviewer, "utf8"),
      /combined reviewer/,
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

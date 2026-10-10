import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pluginSkills = path.join(repo, "plugin", "skills");
const commanderSystem = path.join(repo, "plugin", "commander-system");

const EXTRA_SKILLS = [
  "commander",
  "merge-branches-to-master",
  "review-past-commits",
  "create-skill",
  "migrate-multica-to-github-projects",
  "integrating-google-adsense",
  "explainer",
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

test("commander-system ships inventories and plugin pointer entry files", async () => {
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

  const pointer = await fs.readFile(
    path.join(commanderSystem, "entry", "plugin-pointer.md"),
    "utf8",
  );
  assert.match(pointer, /ycm-harness plugin/);
  // Remote agents only see the remote: reviews and reports must be committed.
  assert.match(pointer, /commit and push every review, report and architecture output/);
  assert.match(pointer, /docs\/reviews\//);
  assert.doesNotMatch(pointer, /\{\{HOME\}\}/);

  const dispatch = await fs.readFile(
    path.join(commanderSystem, "system", "10-DISPATCH.md"),
    "utf8",
  );
  assert.match(dispatch, /11-INVENTORY-cursor\.md/);
  assert.match(dispatch, /same folder as this file/);
  assert.doesNotMatch(dispatch, /\{\{HOME\}\}/);

  await fs.stat(path.join(repo, "plugin", "scripts", "install-commander.mjs"));
});

test("plugin commander skill points at in-plugin commander-system", async () => {
  const skill = await fs.readFile(
    path.join(pluginSkills, "commander", "SKILL.md"),
    "utf8",
  );
  assert.match(skill, /commander-system\/system\//);
  assert.match(skill, /\*\*only\*\* golden source/);
  assert.doesNotMatch(skill, /\{\{HOME\}\}/);
  assert.doesNotMatch(skill, /npm run commander:install/);
});

test("commander stays plugin-native and is not copied to user skill dirs", async () => {
  const kit = await fs.readFile(
    path.join(repo, "src", "cli", "install-kit.ts"),
    "utf8",
  );
  assert.match(kit, /PLUGIN_NATIVE_SKILL_DIRS = \["commander"\] as const/);
  assert.match(kit, /prunePluginNativeSkillDirs/);
  const dirs = kit.match(/const HARNESS_SKILL_DIRS = \[([\s\S]*?)\] as const/);
  assert.ok(dirs);
  assert.doesNotMatch(dirs[1], /"commander"/);
});

test("install-commander migrates pointers and does not copy protocol", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ycm-commander-"));
  try {
    await fs.mkdir(path.join(tmp, ".codex"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".claude"), { recursive: true });
    await fs.mkdir(path.join(tmp, ".agents", "system"), { recursive: true });
    await fs.writeFile(path.join(tmp, ".codex", "AGENTS.md"), "existing agents\n");
    await fs.writeFile(
      path.join(tmp, ".claude", "CLAUDE.md"),
      "You are the COMMANDER of this session\nread 10-DISPATCH.md under .agents\n",
    );
    await fs.writeFile(
      path.join(tmp, ".agents", "system", "10-DISPATCH.md"),
      "stale local protocol\n",
    );
    await fs.writeFile(
      path.join(tmp, ".agents", "system", "LESSONS.md"),
      "keep me\n",
    );
    await fs.mkdir(path.join(tmp, ".cursor", "skills", "commander"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(tmp, ".cursor", "skills", "commander", "SKILL.md"),
      "duplicate user skill\n",
    );

    const result = spawnSync(
      process.execPath,
      [path.join(repo, "plugin", "scripts", "install-commander.mjs")],
      {
        env: { ...process.env, YCM_HARNESS_HOME: tmp },
        encoding: "utf8",
      },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const agents = await fs.readFile(path.join(tmp, ".codex", "AGENTS.md"), "utf8");
    assert.match(agents, /ycm-harness plugin/);
    assert.match(agents, /existing agents/);
    const claude = await fs.readFile(path.join(tmp, ".claude", "CLAUDE.md"), "utf8");
    assert.match(claude, /ycm-harness plugin/);
    assert.doesNotMatch(claude, /You are the COMMANDER of this session/);

    await assert.rejects(
      fs.stat(path.join(tmp, ".agents", "system", "10-DISPATCH.md")),
    );
    const lessons = await fs.readFile(
      path.join(tmp, ".agents", "system", "LESSONS.md"),
      "utf8",
    );
    assert.equal(lessons, "keep me\n");
    await assert.rejects(
      fs.stat(path.join(tmp, ".cursor", "skills", "commander", "SKILL.md")),
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});


test("all active commander routers resolve protocol inside the plugin", async () => {
  const files = [
    'plugin/skills/commander/SKILL.md',
    'plugin/skills/commander/agents/openai.yaml',
    'plugin/commander-system/entry/claude-CLAUDE.md',
    'plugin/commander-system/entry/codex-agents-block.md',
    'plugin/commander-system/entry/cursor-commander-SKILL.md',
    'plugin/commander-system/entry/cursor-user-rule.txt',
    'plugin/commander-system/entry/plugin-pointer.md',
    'plugin/commander-system/system/00-DIAGNOSIS.md',
    'plugin/commander-system/system/10-DISPATCH.md',
    'plugin/commander-system/system/40-MAINTENANCE.md',
    'plugin/scripts/install-commander.mjs',
    'README.md',
  ];
  // Present only where the distribution ships them.
  const optional = ['plugin/rules/commander.mdc', 'plugin/commands/commander.md'];
  for (const file of [...files, ...optional]) {
    let content: string;
    try {
      content = await fs.readFile(path.join(repo, file), 'utf8');
    } catch (err) {
      if (optional.includes(file) && (err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    // ~/.agents/system may only appear as the LESSONS.md journal or in a "do not use / retired" note.
    for (const m of content.matchAll(/\.agents[\\/]system(?:[\\/](\S*))?/g)) {
      if (m[1]?.startsWith('LESSONS.md')) continue;
      const before = content.slice(Math.max(0, m.index - 60), m.index);
      assert.match(before, /\b(?:not|never|retire[sd]?)\b/i, `${file}: routes protocol to ~/.agents/system: ...${before}${m[0]}`);
    }
    if (file.endsWith('install-commander.mjs')) continue;
    assert.match(content, /commander-system\/system|plugin.*commander|commander.*plugin|same folder as this file/i, file);
  }
  // Protocol is read in place from the plugin, so no installer renders {{HOME}} any more.
  for (const name of await fs.readdir(path.join(commanderSystem, 'system'))) {
    if (!name.endsWith('.md') || name === 'LESSONS.md') continue;
    const content = await fs.readFile(path.join(commanderSystem, 'system', name), 'utf8');
    assert.doesNotMatch(content, /\{\{HOME\}\}/, name);
  }
  const skill = await fs.readFile(path.join(pluginSkills, 'commander', 'SKILL.md'), 'utf8');
  for (const guide of ['10-DISPATCH', '20-JUDGMENT', '30-TEMPLATES', '40-MAINTENANCE']) {
    const relative = `../../commander-system/system/${guide}.md`;
    assert.ok(skill.includes(relative), relative);
    await fs.stat(path.resolve(pluginSkills, 'commander', relative));
  }
});

test("fresh commander install writes plugin pointers and only a machine journal", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'ycm-commander-fresh-'));
  try {
    await fs.mkdir(path.join(tmp, '.codex'));
    const env: NodeJS.ProcessEnv = { ...process.env, HOME: tmp, USERPROFILE: tmp };
    delete env.YCM_HARNESS_HOME;
    for (let n = 0; n < 2; n++) {
      const result = spawnSync(process.execPath, [path.join(repo, 'plugin', 'scripts', 'install-commander.mjs')], { env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr || result.stdout);
      for (const entry of ['.claude/CLAUDE.md', '.codex/AGENTS.md']) {
        const content = await fs.readFile(path.join(tmp, entry), 'utf8');
        assert.match(content, /ycm-harness plugin/);
        assert.match(content, /commander-system\/system/);
        assert.doesNotMatch(content, /\.agents[\\/]system[\\/]10-DISPATCH/);
      }
      const files = (await fs.readdir(path.join(tmp, '.agents', 'system'))).filter(f => f.endsWith('.md'));
      assert.deepEqual(files, ['LESSONS.md']);
      await assert.rejects(fs.stat(path.join(tmp, '.cursor', 'skills', 'commander', 'SKILL.md')));
    }
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

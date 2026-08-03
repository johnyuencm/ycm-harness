import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { createContext } from "../src/cli/context.js";
import { registerSync } from "../src/cli/commands/sync.js";
import { registerPlugin } from "../src/cli/commands/plugin.js";
import { packageRoot } from "../src/cli/install-kit.js";
import { cleanup, tempProject, withTempUserHome } from "./helpers.js";

async function runSync(
  cwd: string,
  args: string[],
): Promise<{ stdout: string[]; jsons: unknown[] }> {
  const stdout: string[] = [];
  const jsons: unknown[] = [];
  const program = new Command();
  program.exitOverride();
  registerSync(program, createContext(cwd), {
    out(text: string) {
      stdout.push(text);
    },
    err(text: string) {
      stdout.push(text);
    },
    json(value: unknown) {
      jsons.push(value);
    },
  });
  await program.parseAsync(["sync", ...args], { from: "user" });
  return { stdout, jsons };
}

async function runPlugin(
  cwd: string,
  args: string[],
): Promise<{ stdout: string[]; jsons: unknown[] }> {
  const stdout: string[] = [];
  const jsons: unknown[] = [];
  const program = new Command();
  program.exitOverride();
  registerPlugin(program, createContext(cwd), {
    out(text: string) {
      stdout.push(text);
    },
    err(text: string) {
      stdout.push(text);
    },
    json(value: unknown) {
      jsons.push(value);
    },
  });
  await program.parseAsync(["plugin", ...args], { from: "user" });
  return { stdout, jsons };
}

async function writeCodexShim(root: string): Promise<string> {
  const isWin = process.platform === "win32";
  const shim = path.join(root, isWin ? "codex-shim.cmd" : "codex-shim");
  await fs.writeFile(
    shim,
    isWin ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    "utf8",
  );
  if (!isWin) await fs.chmod(shim, 0o755);
  return shim;
}

test("sync defaults to detected Cursor and Codex clients", async () => {
  await withTempUserHome(async (home) => {
    const cwd = await tempProject("ch-sync-");
    const priorCodexPath = process.env.CODEX_CLI_PATH;
    try {
      await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
      await fs.mkdir(path.join(home, ".codex"), { recursive: true });
      process.env.CODEX_CLI_PATH = await writeCodexShim(cwd);
      await runSync(cwd, []);
      await runSync(cwd, ["--codex"]);

      const cursorPlugin = path.join(
        home,
        ".cursor",
        "plugins",
        "ycm-harness",
        ".cursor-plugin",
        "plugin.json",
      );
      const codexConfig = path.join(home, ".codex", "config.toml");

      assert.ok(
        await fs
          .stat(cursorPlugin)
          .then(() => true)
          .catch(() => false),
        `expected cursor plugin at ${cursorPlugin}`,
      );
      const configText = await fs.readFile(codexConfig, "utf8");
      assert.match(configText, /\[marketplaces\.ycm-harness\]/);
      assert.match(configText, /source_type = "git"/);
      assert.match(
        configText,
        /source = 'git@github\.com:johnyuencm\/ycm-harness\.git'/,
      );
      assert.match(configText, /\[plugins\."ycm-harness@ycm-harness"\]/);
      assert.equal(
        (configText.match(/source = 'git@github\.com:johnyuencm\/ycm-harness\.git'/g) ?? [])
          .length,
        1,
      );
    } finally {
      if (priorCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = priorCodexPath;
      await cleanup(cwd);
    }
  });
});

test("sync --cursor updates only Cursor assets", async () => {
  await withTempUserHome(async (home) => {
    const cwd = await tempProject("ch-sync-cursor-");
    try {
      await fs.mkdir(path.join(home, ".cursor"), { recursive: true });
      await runSync(cwd, ["--cursor"]);

      const cursorPlugin = path.join(
        home,
        ".cursor",
        "plugins",
        "ycm-harness",
        ".cursor-plugin",
        "plugin.json",
      );
      const codexPlugin = path.join(
        home,
        ".codex",
        "marketplaces",
        "ycm-harness",
        "plugins",
        "ycm-harness",
        ".cursor-plugin",
        "plugin.json",
      );

      assert.ok(
        await fs
          .stat(cursorPlugin)
          .then(() => true)
          .catch(() => false),
      );
      assert.equal(
        await fs
          .stat(codexPlugin)
          .then(() => true)
          .catch(() => false),
        false,
      );
    } finally {
      await cleanup(cwd);
    }
  });
});

test("sync --codex updates Codex assets", async () => {
  await withTempUserHome(async (home) => {
    const cwd = await tempProject("ch-sync-source-");
    try {
      await fs.mkdir(path.join(home, ".codex"), { recursive: true });
      const { jsons } = await runSync(cwd, ["--codex", "--json"]);
      const payload = jsons.at(-1) as {
        targets?: { codex?: boolean; cursor?: boolean };
      };
      assert.equal(payload.targets?.codex, true);
      assert.equal(payload.targets?.cursor, false);
    } finally {
      await cleanup(cwd);
    }
  });
});

async function writeOpenCodeShim(root: string): Promise<string> {
  const isWin = process.platform === "win32";
  const shim = path.join(root, isWin ? "opencode-shim.cmd" : "opencode-shim");
  await fs.writeFile(
    shim,
    isWin ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n",
    "utf8",
  );
  if (!isWin) await fs.chmod(shim, 0o755);
  return shim;
}

test("sync --opencode updates skills and config", async () => {
  await withTempUserHome(async (home) => {
    const cwd = await tempProject("ch-sync-opencode-");
    const priorOpenCodePath = process.env.OPENCODE_CLI_PATH;
    try {
      await fs.mkdir(path.join(home, ".config", "opencode"), {
        recursive: true,
      });
      process.env.OPENCODE_CLI_PATH = await writeOpenCodeShim(cwd);

      const { jsons } = await runSync(cwd, ["--opencode", "--json"]);
      const payload = jsons.at(-1) as { targets?: { opencode?: boolean } };
      assert.equal(payload.targets?.opencode, true);

      const skill = path.join(
        home,
        ".config",
        "opencode",
        "skills",
        "ycm-harness",
        "SKILL.md",
      );
      const designSkill = path.join(
        home,
        ".config",
        "opencode",
        "skills",
        "ycm-harness-design",
        "SKILL.md",
      );
      const liteSkill = path.join(
        home,
        ".config",
        "opencode",
        "skills",
        "ycm-harness-work-lite",
        "SKILL.md",
      );
      const config = path.join(home, ".config", "opencode", "opencode.json");

      assert.ok(
        await fs
          .stat(skill)
          .then(() => true)
          .catch(() => false),
      );
      assert.match(
        await fs.readFile(skill, "utf8"),
        /name: ycm-harness-work/,
      );
      assert.ok(
        await fs
          .stat(designSkill)
          .then(() => true)
          .catch(() => false),
      );
      assert.match(
        await fs.readFile(designSkill, "utf8"),
        /name: ycm-harness-design/,
      );
      assert.ok(
        await fs
          .stat(liteSkill)
          .then(() => true)
          .catch(() => false),
      );
      assert.match(
        await fs.readFile(liteSkill, "utf8"),
        /name: ycm-harness-work-lite/,
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
      ]) {
        const externalSkill = path.join(
          home,
          ".config",
          "opencode",
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
      const githubSrc = path.join(
        packageRoot(),
        "plugin",
        "skills",
        "using-github-issues",
        "SKILL.md",
      );
      const github = path.join(
        home,
        ".config",
        "opencode",
        "skills",
        "using-github-issues",
        "SKILL.md",
      );
      if (
        await fs
          .stat(githubSrc)
          .then(() => true)
          .catch(() => false)
      ) {
        assert.ok(
          await fs
            .stat(github)
            .then(() => true)
            .catch(() => false),
        );
      }
      assert.match(await fs.readFile(config, "utf8"), /ycm-harness@/);
    } finally {
      if (priorOpenCodePath === undefined) delete process.env.OPENCODE_CLI_PATH;
      else process.env.OPENCODE_CLI_PATH = priorOpenCodePath;
      await cleanup(cwd);
    }
  });
});

test("sync --codex refreshes Codex cache through official remove/add commands", async () => {
  await withTempUserHome(async (home) => {
    const cwd = await tempProject("ch-plugin-update-");
    const priorCodexPath = process.env.CODEX_CLI_PATH;
    try {
      await fs.mkdir(path.join(home, ".codex"), { recursive: true });
      process.env.CODEX_CLI_PATH = await writeCodexShim(cwd);

      const { stdout, jsons } = await runSync(cwd, ["--codex", "--json"]);
      const payload = jsons.at(-1) as {
        reports?: string[];
        targets?: { codex?: boolean };
      };
      assert.equal(payload.targets?.codex, true);
      const reports = payload.reports ?? stdout;
      assert.ok(
        reports.some((line) => line.includes("codex plugin remove: removed")),
      );
      assert.ok(
        reports.some((line) =>
          line.includes("codex plugin add: installed/enabled"),
        ),
      );
    } finally {
      if (priorCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = priorCodexPath;
      await cleanup(cwd);
    }
  });
});

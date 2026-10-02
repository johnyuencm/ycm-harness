import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
      const codexConfig = path.join(home, ".codex", "config.toml");
      const codexMarketplace = path.join(
        home,
        ".codex",
        "marketplaces",
        "ycm-harness",
        ".agents",
        "plugins",
        "marketplace.json",
      );

      assert.ok(
        await fs
          .stat(cursorPlugin)
          .then(() => true)
          .catch(() => false),
        `expected cursor plugin at ${cursorPlugin}`,
      );
      assert.ok(
        await fs
          .stat(codexPlugin)
          .then(() => true)
          .catch(() => false),
        `expected codex plugin at ${codexPlugin}`,
      );
      assert.match(
        await fs.readFile(codexConfig, "utf8"),
        /\[marketplaces\.ycm-harness-local\]/,
      );
      assert.match(
        await fs.readFile(codexConfig, "utf8"),
        /\[plugins\."ycm-harness@ycm-harness-local"\]/,
      );
      assert.match(
        await fs.readFile(codexMarketplace, "utf8"),
        /"\.\/plugins\/ycm-harness"/,
      );
      assert.match(await fs.readFile(codexPlugin, "utf8"), /"name": "ycm-harness"/);
      const configText = await fs.readFile(codexConfig, "utf8");
      // Separator-agnostic: the written path is POSIX on Linux/macOS and
      // backslash-separated on Windows.
      assert.equal(
        (configText.match(/source = '.*marketplaces[\\/]ycm-harness'/g) ?? [])
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

test("sync --codex preserves foreign config.toml sections byte-for-byte", async () => {
  // Regression for the reported WSL rewrite incident: ensureCodexConfig must
  // splice only its two owned sections and leave every foreign line intact.
  await withTempUserHome(async (home) => {
    const cwd = await tempProject("ch-sync-codex-foreign-");
    const priorCodexPath = process.env.CODEX_CLI_PATH;
    try {
      await fs.mkdir(path.join(home, ".codex"), { recursive: true });
      const codexConfig = path.join(home, ".codex", "config.toml");
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
      await fs.writeFile(codexConfig, foreign, "utf8");
      process.env.CODEX_CLI_PATH = await writeCodexShim(cwd);
      await runSync(cwd, ["--codex"]);

      const written = await fs.readFile(codexConfig, "utf8");
      const harnessStart = written.indexOf("[marketplaces.ycm-harness-local]");
      assert.ok(harnessStart > 0, "harness marketplace section must be present");
      // Byte-for-byte: everything outside the harness-owned sections is the
      // original foreign text plus the single separating newline.
      assert.equal(written.slice(0, harnessStart), `${foreign}\n`);
      assert.match(written, /\[marketplaces\.ycm-harness-local\]/);
      assert.match(written, /\[plugins\."ycm-harness@ycm-harness-local"\]/);
    } finally {
      if (priorCodexPath === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = priorCodexPath;
      await cleanup(cwd);
    }
  });
});

// WSL + Windows Codex home, through the real sync writer and doctor audit. A
// private tmpfs over /mnt in a user+mount namespace stands in for /mnt/<drive>,
// so the real /mnt is never written. Skips where unprivileged namespaces are
// unavailable (macOS, Windows, locked-down Linux); the codexMarketplaceBlock
// helper test in install.test.ts still covers the mapping there.
test("sync --codex under WSL writes the Windows source that doctor audits as ok", (t) => {
  const repoRoot = packageRoot();
  const probe = spawnSync("unshare", ["-rm", "true"]);
  if (process.platform !== "linux" || probe.status !== 0 || repoRoot.startsWith("/mnt/")) {
    t.skip("needs Linux user+mount namespaces and a repo outside /mnt");
    return;
  }
  const home = "/mnt/z/home";
  const child = `
    import { promises as fs } from "node:fs";
    const kit = await import(${JSON.stringify(path.join(repoRoot, "src", "cli", "install-kit.ts"))});
    const config = "${home}/.codex/config.toml";
    await fs.writeFile(config, '[model]\\nname = "x"\\n\\n[marketplaces.ycm-harness-local] # mine\\nsource = "old"\\n\\n[other]\\nx = 1\\n');
    await kit.runClientSync({ codex: true, force: true });
    const first = await fs.readFile(config, "utf8");
    await kit.runClientSync({ codex: true, force: true });
    const second = await fs.readFile(config, "utf8");
    const { audit } = await kit.auditInstall("/mnt/z");
    process.stdout.write(JSON.stringify({ first, second, status: audit.codex_marketplace.status }));
  `;
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    YCM_HARNESS_HOME: home,
    WSL_DISTRO_NAME: "Ubuntu",
    CODEX_CLI_PATH: path.join(repoRoot, "missing-codex-cli-for-test"),
  };
  const run = spawnSync(
    "unshare",
    [
      "-rm", "sh", "-c",
      'mount -t tmpfs ycm-scratch /mnt && mkdir -p "$1/.codex" && exec "$0" --import tsx/esm --input-type=module -e "$2"',
      process.execPath, home, child,
    ],
    { cwd: repoRoot, env, encoding: "utf8" },
  );
  assert.equal(run.status, 0, run.stderr);
  const { first, second, status } = JSON.parse(run.stdout) as {
    first: string;
    second: string;
    status: string;
  };
  assert.match(first, /^source = 'Z:\\home\\\.codex\\marketplaces\\ycm-harness'$/m);
  assert.doesNotMatch(first, /\/mnt\//);
  assert.doesNotMatch(first, /source = "old"/);
  assert.equal(first.match(/^\[marketplaces\.ycm-harness-local\]/gm)?.length, 1);
  assert.match(first, /^\[model\]\nname = "x"\n\n\[marketplaces\.ycm-harness-local\]\n/);
  assert.match(first, /\n\n\[other\]\nx = 1\n\n\[plugins\."ycm-harness@ycm-harness-local"\]\nenabled = true\n$/);
  assert.equal(second, first, "a second sync must not rewrite the config");
  assert.equal(status, "ok", "doctor must audit the same source that sync wrote");
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
      const localPlugin = path.join(
        home,
        ".cursor",
        "plugins",
        "local",
        "ycm-harness",
        ".cursor-plugin",
        "plugin.json",
      );
      assert.ok(
        await fs
          .stat(localPlugin)
          .then(() => true)
          .catch(() => false),
        `expected cursor local plugin at ${localPlugin}`,
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { auditInstall, opencodePluginSpec, runClientSync } from "../src/cli/install-kit.js";
import { buildProgram } from "../src/cli/index.js";
import { cleanup, tempProject, withTempUserHome } from "./helpers.js";

const repoRoot = path.resolve(import.meta.dirname, "..");

test("client install prunes retired assets, bundles runtime, and audits OpenCode config", async () => {
  await withTempUserHome(async (home) => {
    const source = await fs.mkdtemp(path.join(os.tmpdir(), "ch-install-source-"));
    const external = await fs.mkdtemp(path.join(os.tmpdir(), "ch-install-external-"));
    const project = await tempProject("ch-install-project-");
    const priorOpenCode = process.env.OPENCODE_CLI_PATH;
    try {
      await fs.cp(path.join(repoRoot, "plugin"), path.join(source, "plugin"), { recursive: true });
      await fs.cp(path.join(repoRoot, ".opencode"), path.join(source, ".opencode"), { recursive: true });
      await fs.mkdir(path.join(source, "dist", "cli"), { recursive: true });
      await fs.writeFile(path.join(source, "dist", "cli", "index.js"), 'process.stdout.write("{\\"decision\\":\\"block\\",\\"reason\\":\\"fixture\\"}\\n");', "utf8");
      await fs.writeFile(path.join(source, "package.json"), '{"name":"fixture","type":"module"}\n', "utf8");
      for (const dependency of ["commander", "zod"]) {
        const dependencyRoot = path.join(source, "node_modules", dependency);
        await fs.mkdir(dependencyRoot, { recursive: true });
        await fs.writeFile(path.join(dependencyRoot, "package.json"), `{"name":"${dependency}"}\n`, "utf8");
        await fs.writeFile(path.join(dependencyRoot, "index.js"), "", "utf8");
      }

      const installed = path.join(home, ".cursor", "plugins", "ycm-harness");
      const unmanagedSibling = path.join(home, ".cursor", "plugins", "unmanaged.txt");
      const sentinel = path.join(external, "sentinel.txt");
      await fs.mkdir(path.join(external, ".codex-plugin"), { recursive: true });
      await fs.writeFile(path.join(external, ".codex-plugin", "plugin.json"), "stale", "utf8");
      await fs.writeFile(sentinel, "outside", "utf8");
      await fs.mkdir(path.dirname(installed), { recursive: true });
      await fs.symlink(external, installed, process.platform === "win32" ? "junction" : "dir");
      await fs.writeFile(unmanagedSibling, "preserve", "utf8");
      await runClientSync({ cursor: true, force: true, sourceRoot: source });

      assert.equal((await fs.lstat(installed)).isSymbolicLink(), false);
      assert.equal(
        JSON.parse(await fs.readFile(path.join(installed, ".codex-plugin", "plugin.json"), "utf8")).name,
        "ycm-harness",
      );
      assert.equal(await fs.readFile(unmanagedSibling, "utf8"), "preserve");
      assert.equal(await fs.readFile(sentinel, "utf8"), "outside");
      const runtimeRoot = path.join(installed, "runtime");
      await fs.rm(runtimeRoot, { recursive: true, force: true });
      await fs.symlink(external, runtimeRoot, process.platform === "win32" ? "junction" : "dir");
      const codexManifest = path.join(installed, ".codex-plugin", "plugin.json");
      await fs.mkdir(path.dirname(codexManifest), { recursive: true });
      await fs.writeFile(codexManifest, "stale", "utf8");
      await runClientSync({ cursor: true, force: true, sourceRoot: source });
      assert.equal((await fs.lstat(runtimeRoot)).isSymbolicLink(), false);
      assert.equal(JSON.parse(await fs.readFile(codexManifest, "utf8")).name, "ycm-harness");
      assert.equal(await fs.readFile(sentinel, "utf8"), "outside");
      const runtimeCli = path.join(installed, "runtime", "dist", "cli", "index.js");
      assert.match(await fs.readFile(runtimeCli, "utf8"), /fixture/);
      const stop = spawnSync(process.execPath, [path.join(installed, "scripts", "stop-hook.mjs")], {
        cwd: project,
        encoding: "utf8",
        input: "{}",
        env: { ...process.env, PATH: "" },
      });
      assert.equal(stop.status, 0, stop.stderr);
      assert.equal(JSON.parse(stop.stdout).reason, "fixture");
      const cursorAudit = (await auditInstall(project, source)).audit.cursor_plugin;
      assert.deepEqual(cursorAudit.filter((item) => item.status !== "ok"), []);

      const configDir = path.join(home, ".config", "opencode");
      await fs.mkdir(configDir, { recursive: true });
      await fs.writeFile(path.join(configDir, "opencode.json"), '{"plugin":["ycm-harness@old"]}\\n', "utf8");
      assert.equal((await auditInstall(project, source)).audit.opencode_config.status, "stale");
      process.env.OPENCODE_CLI_PATH = "missing-opencode-cli-for-test";
      await runClientSync({ opencode: true, force: true, sourceRoot: source });
      assert.equal((await auditInstall(project, source)).audit.opencode_config.status, "ok");
      const config = JSON.parse(await fs.readFile(path.join(configDir, "opencode.json"), "utf8")) as { plugin: string[] };
      assert.ok(config.plugin.includes(opencodePluginSpec(source)));

      const install = buildProgram(project).commands.find((command) => command.name() === "install");
      assert.ok(install?.options.some((option) => option.long === "--client"));
    } finally {
      if (priorOpenCode === undefined) delete process.env.OPENCODE_CLI_PATH;
      else process.env.OPENCODE_CLI_PATH = priorOpenCode;
      await cleanup(source);
      await cleanup(external);
      await cleanup(project);
    }
  });
});

test("install --client routes documented selectors and rejects invalid combinations", async () => {
  await withTempUserHome(async (home) => {
    const project = await tempProject("ch-install-routing-");
    const priorCodex = process.env.CODEX_CLI_PATH;
    const priorOpenCode = process.env.OPENCODE_CLI_PATH;
    process.env.CODEX_CLI_PATH = "missing-codex-cli-for-test";
    process.env.OPENCODE_CLI_PATH = "missing-opencode-cli-for-test";
    try {
      await buildProgram(project).parseAsync(["install", "--client", "cursor", "--force"], { from: "user" });
      await fs.stat(path.join(home, ".cursor", "plugins", "ycm-harness", "runtime", "dist", "cli", "index.js"));

      await buildProgram(project).parseAsync(["install", "--client", "opencode", "--force"], { from: "user" });
      const opencodeConfig = JSON.parse(await fs.readFile(path.join(home, ".config", "opencode", "opencode.json"), "utf8")) as { plugin: string[] };
      assert.ok(opencodeConfig.plugin.includes(opencodePluginSpec(repoRoot)));

      await buildProgram(project).parseAsync(["install", "--client", "all", "--force"], { from: "user" });
      assert.match(
        await fs.readFile(path.join(home, ".codex", "config.toml"), "utf8"),
        /marketplaces\.ycm-harness[\s\S]*source_type = "git"[\s\S]*johnyuencm\/ycm-harness\.git/,
      );

      await assert.rejects(
        buildProgram(project).parseAsync(["install", "--client", "codex"], { from: "user" }),
        /client must be cursor, opencode, or all/,
      );
      await assert.rejects(
        buildProgram(project).parseAsync(["install", "--client", "cursor", "--user"], { from: "user" }),
        /--client cannot be combined with scope options/,
      );
    } finally {
      if (priorCodex === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = priorCodex;
      if (priorOpenCode === undefined) delete process.env.OPENCODE_CLI_PATH;
      else process.env.OPENCODE_CLI_PATH = priorOpenCode;
      await cleanup(project);
    }
  });
});

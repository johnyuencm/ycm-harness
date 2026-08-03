import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditInstall,
  opencodePluginSpec,
  packageRoot,
  runClientSync,
  runInstallScopes,
} from "../src/cli/install-kit.js";
import { SCOUT_BRIEF_HEADINGS, SCOUT_BRIEF_VERSION } from "../src/autonomy/scout-brief.js";
import { createContext } from "../src/cli/context.js";
import { HarnessStore } from "../src/state/store.js";
import { cleanup, tempProject, withTempUserHome } from "./helpers.js";

function hash(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function fileHash(file: string): Promise<string> {
  return hash(await fs.readFile(file));
}

async function treeHash(root: string): Promise<string> {
  const rows: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, "/");
      if (entry.isDirectory()) await walk(full);
      else rows.push(`${relative}\0${await fileHash(full)}`);
    }
  }
  await walk(root);
  return hash(rows.join("\n"));
}

async function sourceFileHashes(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  async function walk(dir: string): Promise<void> {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.set(path.relative(root, full), await fileHash(full));
    }
  }
  await walk(root);
  return files;
}

async function assertSourceFilesMatch(sourceRoot: string, destinationRoots: readonly string[]): Promise<void> {
  const sourceHashes = await sourceFileHashes(sourceRoot);
  assert.ok(sourceHashes.size > 0, `expected managed source files under ${sourceRoot}`);
  for (const [relative, sourceDigest] of sourceHashes) {
    for (const destinationRoot of destinationRoots) {
      assert.equal(
        await fileHash(path.join(destinationRoot, relative)),
        sourceDigest,
        `managed projection mismatch: ${path.join(destinationRoot, relative)}`,
      );
    }
  }
}

async function writeNoopShim(root: string, name: string): Promise<string> {
  const win = process.platform === "win32";
  const file = path.join(root, win ? `${name}.cmd` : name);
  await fs.writeFile(file, win ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n", "utf8");
  if (!win) await fs.chmod(file, 0o755);
  return file;
}

async function writeCodexCacheShim(root: string): Promise<string> {
  const script = path.join(root, "codex-cache-shim.cjs");
  await fs.writeFile(script, [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const home = process.env.YCM_HARNESS_HOME || process.env.USERPROFILE || process.env.HOME;',
    'const source = path.join(home, ".cursor", "plugins", "ycm-harness");',
    'const cacheBase = path.join(home, ".codex", "plugins", "cache", "ycm-harness", "ycm-harness");',
    'const action = process.argv.includes("add") ? "add" : process.argv.includes("remove") ? "remove" : "unknown";',
    'if (action === "remove") fs.rmSync(cacheBase, { recursive: true, force: true });',
    'if (action === "add") {',
    '  const version = JSON.parse(fs.readFileSync(path.join(source, ".cursor-plugin", "plugin.json"), "utf8")).version;',
    '  fs.mkdirSync(cacheBase, { recursive: true });',
    '  fs.cpSync(source, path.join(cacheBase, version), { recursive: true });',
    '}',
  ].join("\n"), "utf8");
  const win = process.platform === "win32";
  const shim = path.join(root, win ? "codex-cache-shim.cmd" : "codex-cache-shim");
  const command = win
    ? `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`
    : `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`;
  await fs.writeFile(shim, command, "utf8");
  if (!win) await fs.chmod(shim, 0o755);
  return shim;
}

function runNode(script: string, cwd: string, input?: unknown, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [script], {
    cwd,
    encoding: "utf8",
    env: { ...env, PATH: "" },
    input: input === undefined ? undefined : JSON.stringify(input),
  });
}

async function projectAllOnce(project: string, source: string): Promise<string[]> {
  const reports = await runInstallScopes(createContext(project), { project: true, force: true, sourceRoot: source });
  reports.push(...await runClientSync({
    cursor: true,
    codex: true,
    opencode: true,
    force: true,
    sourceRoot: source,
    refreshCodexCache: true,
  }));
  return reports;
}

async function restoreTempTree(target: string, snapshot: string): Promise<void> {
  const relative = path.relative(os.tmpdir(), path.resolve(target));
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), `refusing non-temp restore: ${target}`);
  await fs.rm(target, { recursive: true, force: true });
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(snapshot, target, { recursive: true });
}

function additionalContext(stdout: string): string {
  const parsed = JSON.parse(stdout) as { additional_context?: string; hookSpecificOutput?: { additionalContext?: string } };
  return parsed.additional_context ?? parsed.hookSpecificOutput?.additionalContext ?? "";
}

test("installed Cursor/Codex SessionStart and OpenCode config/runtime projection are PATH-independent and reversible", async () => {
  await withTempUserHome(async (home) => {
    const project = await tempProject("ch-scout-installed-");
    const homePreimage = await tempProject("ch-scout-home-preimage-");
    const homeProjection = await tempProject("ch-scout-home-projection-");
    const projectPreimage = await tempProject("ch-scout-project-preimage-");
    const projectProjection = await tempProject("ch-scout-project-projection-");
    const source = packageRoot();
    const oldCodex = process.env.CODEX_CLI_PATH;
    const oldOpenCode = process.env.OPENCODE_CLI_PATH;
    const oldOpenCodeConfig = process.env.OPENCODE_CONFIG_DIR;
    try {
      const sourcePackage = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8")) as {
        version: string;
        main: string;
      };
      const cursorHome = path.join(home, ".cursor");
      const codexHome = path.join(home, ".codex");
      const openCodeHome = path.join(home, ".config", "opencode");
      const projectCursor = path.join(project, ".cursor");
      const cursorRoot = path.join(cursorHome, "plugins", "ycm-harness");
      const codexRoot = path.join(codexHome, "plugins", "cache", "ycm-harness", "ycm-harness", sourcePackage.version);
      const enabledRoot = path.join(codexHome, "plugins", "cache", "ycm-harness", "ycm-harness", sourcePackage.version);
      const cursorHook = path.join(cursorRoot, "scripts", "session-start-hook.mjs");
      const codexHook = path.join(codexRoot, "scripts", "session-start-hook.mjs");
      const enabledHook = path.join(enabledRoot, "scripts", "session-start-hook.mjs");
      const codexConfig = path.join(codexHome, "config.toml");
      const openCodeConfigPath = path.join(openCodeHome, "opencode.json");
      const projectRule = path.join(projectCursor, "rules", "ycm-harness.mdc");
      const priorHook = "// pre-phase-3 managed hook\n";
      const priorCodexConfig = "# pre-phase-3 managed Codex config\n";
      const priorOpenCodeConfig = `${JSON.stringify({ plugin: ["ycm-harness@file:/pre-phase-3"] }, null, 2)}\n`;
      const priorProjectRule = "pre-phase-3 managed project rule\n";
      for (const dir of [
        path.dirname(cursorHook),
        path.dirname(codexHook),
        path.dirname(enabledHook),
        openCodeHome,
        path.dirname(projectRule),
      ]) await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(cursorHome, "unrelated.txt"), "keep-cursor", "utf8");
      await fs.writeFile(path.join(codexHome, "unrelated.txt"), "keep-codex", "utf8");
      await fs.writeFile(path.join(openCodeHome, "unrelated.txt"), "keep-opencode", "utf8");
      await fs.writeFile(path.join(projectCursor, "unrelated.txt"), "keep-project", "utf8");
      await fs.writeFile(cursorHook, priorHook, "utf8");
      await fs.writeFile(codexHook, priorHook, "utf8");
      await fs.writeFile(enabledHook, priorHook, "utf8");
      await fs.writeFile(codexConfig, priorCodexConfig, "utf8");
      await fs.writeFile(openCodeConfigPath, priorOpenCodeConfig, "utf8");
      await fs.writeFile(projectRule, priorProjectRule, "utf8");
      await fs.cp(home, homePreimage, { recursive: true });
      await fs.cp(projectCursor, projectPreimage, { recursive: true });
      const homePreimageHash = await treeHash(homePreimage);
      const projectPreimageHash = await treeHash(projectPreimage);

      process.env.CODEX_CLI_PATH = await writeCodexCacheShim(project);
      process.env.OPENCODE_CLI_PATH = await writeNoopShim(project, "opencode-shim");
      process.env.OPENCODE_CONFIG_DIR = openCodeHome;
      const projectionReports = await projectAllOnce(project, source);
      assert.ok(
        projectionReports.includes("codex plugin add: installed/enabled via Codex CLI"),
        projectionReports.join("\n"),
      );
      await fs.cp(home, homeProjection, { recursive: true });
      await fs.cp(projectCursor, projectProjection, { recursive: true });

      const store = new HarnessStore(project);
      await store.init();
      await store.update((state) => {
        state.goals.goal = {
          id: "goal", title: "Installed scout", status: "active", worktree_status: "active",
          created_at: state.created_at, updated_at: state.updated_at,
        };
        state.active_goal_id = "goal";
        return state;
      });

      await assertSourceFilesMatch(path.join(source, "plugin"), [cursorRoot, codexRoot, enabledRoot]);
      await assertSourceFilesMatch(path.join(source, "dist"), [
        path.join(cursorRoot, "runtime", "dist"),
        path.join(codexRoot, "runtime", "dist"),
        path.join(enabledRoot, "runtime", "dist"),
      ]);
      assert.equal((await auditInstall(project, source)).needs_sync, false);
      const openCodeConfig = JSON.parse(await fs.readFile(openCodeConfigPath, "utf8")) as { plugin?: string[] };
      assert.equal(openCodeConfig.plugin?.find((item) => item.startsWith("ycm-harness@")), opencodePluginSpec(source));
      assert.equal(sourcePackage.main, ".opencode/plugins/ycm-harness.js");

      // OpenCode has no supported SessionStart host event; prove its actual config + source-backed runtime seam.
      const openCodeRuntime = path.join(source, sourcePackage.main);
      const openCodeCanary = `
        const mod = await import(process.argv[1]);
        const plugin = await mod.default();
        const config = {};
        await plugin.config(config);
        process.stdout.write(JSON.stringify({
          config: typeof plugin.config,
          transform: typeof plugin["experimental.chat.messages.transform"],
          paths: config.skills?.paths ?? [],
        }));
      `;
      const openCode = spawnSync(process.execPath, ["--input-type=module", "--eval", openCodeCanary, pathToFileURL(openCodeRuntime).href], {
        cwd: project,
        encoding: "utf8",
        env: { ...process.env, PATH: "", OPENCODE_CONFIG_DIR: openCodeHome },
      });
      assert.equal(openCode.status, 0, openCode.stderr);
      const openCodeResult = JSON.parse(openCode.stdout) as { config: string; transform: string; paths: string[] };
      assert.equal(openCodeResult.config, "function");
      assert.equal(openCodeResult.transform, "function");
      assert.ok(openCodeResult.paths.includes(path.join(openCodeHome, "skills", "ycm-harness")));

      const payload = {
        hook_event_name: "SessionStart", source: "startup", cwd: project,
        session_id: "installed-generation", agent_type: "parent", is_subagent: false,
      };
      const cursorFresh = runNode(cursorHook, project, { ...payload, session_id: "cursor-installed-generation" });
      assert.equal(cursorFresh.status, 0, cursorFresh.stderr);
      assert.match(additionalContext(cursorFresh.stdout), /SCOUT_OBLIGATION_V1 key=scout-v1-/);

      const fresh = runNode(codexHook, project, payload);
      assert.equal(fresh.status, 0, fresh.stderr);
      const obligation = additionalContext(fresh.stdout).match(/key=(scout-v1-[0-9a-f-]+)/)?.[1];
      assert.ok(obligation);

      const cli = path.join(codexRoot, "runtime", "dist", "cli", "index.js");
      const fulfilled = spawnSync(process.execPath, [cli, "autonomy", "scout", "fulfill", "--obligation", obligation], {
        cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" },
      });
      assert.equal(fulfilled.status, 0, fulfilled.stderr);
      assert.equal((JSON.parse(fulfilled.stdout) as { status?: string }).status, "accepted");

      const resumed = runNode(codexHook, project, { ...payload, source: "resume" });
      assert.equal(resumed.status, 0, resumed.stderr);
      const resumedContext = additionalContext(resumed.stdout);
      assert.match(resumedContext, new RegExp(SCOUT_BRIEF_VERSION));
      for (const heading of SCOUT_BRIEF_HEADINGS) assert.match(resumedContext, new RegExp(heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      const resumedAgain = runNode(codexHook, project, { ...payload, source: "resume" });
      assert.doesNotMatch(additionalContext(resumedAgain.stdout), /SCOUT_BRIEF_V1/);
      const child = runNode(codexHook, project, { ...payload, is_subagent: true, agent_type: "explore", parent_agent_id: "parent" });
      assert.equal(child.status, 0, child.stderr);
      const childContext = additionalContext(child.stdout);
      assert.match(childContext, /^# ycm-harness\n/);
      assert.match(childContext, /Goal: Installed scout/);
      assert.doesNotMatch(childContext, /Scout obligation|SCOUT_BRIEF_V1/);

      const disabled = runNode(codexHook, project, { ...payload, session_id: "disabled" }, {
        ...process.env, YCM_HARNESS_SCOUT_ENABLED: "0",
      });
      assert.equal(disabled.status, 0, disabled.stderr);
      const disabledContext = additionalContext(disabled.stdout);
      assert.match(disabledContext, /^# ycm-harness\n/);
      assert.match(disabledContext, /Goal: Installed scout/);
      assert.doesNotMatch(disabledContext, /Scout obligation|SCOUT_BRIEF_V1/);

      const guardModule = pathToFileURL(path.join(codexRoot, "runtime", "dist", "autonomy", "scout-guard.js")).href;
      const safe = path.join(project, "safe.txt");
      const harmless = path.join(project, "must-not-exist.txt");
      const secret = path.join(project, ".env");
      await fs.writeFile(safe, "safe", "utf8");
      await fs.writeFile(secret, "SECRET=test", "utf8");
      const guardCanary = `
        import { readFile, writeFile } from "node:fs/promises";
        import { executeGuardedScoutAdapter } from ${JSON.stringify(guardModule)};
        const [root, safe, harmless, secret] = process.argv.slice(1);
        const scope = { projectRoot: root, cwd: root };
        const read = await executeGuardedScoutAdapter(scope, { adapter: "project", operation: "read", target: safe }, () => readFile(safe, "utf8"));
        let writeBlocked = false; try { await executeGuardedScoutAdapter(scope, { adapter: "project", operation: "write", target: harmless }, () => writeFile(harmless, "bad")); } catch { writeBlocked = true; }
        let secretBlocked = false; try { await executeGuardedScoutAdapter(scope, { adapter: "project", operation: "read", target: secret }, () => readFile(secret, "utf8")); } catch { secretBlocked = true; }
        process.stdout.write(JSON.stringify({ read, writeBlocked, secretBlocked }));
      `;
      const guarded = spawnSync(process.execPath, ["--input-type=module", "--eval", guardCanary, project, safe, harmless, secret], {
        cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" },
      });
      assert.equal(guarded.status, 0, guarded.stderr);
      assert.deepEqual(JSON.parse(guarded.stdout), { read: "safe", writeBlocked: true, secretBlocked: true });
      await assert.rejects(fs.stat(harmless));

      const guardOff = spawnSync(process.execPath, ["--input-type=module", "--eval", guardCanary, project, safe, harmless, secret], {
        cwd: project, encoding: "utf8", env: { ...process.env, PATH: "", YCM_HARNESS_SCOUT_GUARD_ENABLED: "0" },
      });
      assert.notEqual(guardOff.status, 0);
      assert.match(guardOff.stderr, /scout_guard_guard_disabled/);
      await assert.rejects(fs.stat(harmless));

      const cliBackup = `${cli}.backup`;
      await fs.rename(cli, cliBackup);
      const failOpen = runNode(codexHook, project, { ...payload, session_id: "failure" });
      assert.equal(failOpen.status, 0, failOpen.stderr);
      assert.match(additionalContext(failOpen.stdout), /CLI is not available/);
      await fs.rename(cliBackup, cli);

      await fs.appendFile(cursorHook, "\n// intentionally stale\n", "utf8");
      assert.equal((await auditInstall(project, source)).needs_sync, true);

      const evidence = path.join(project, ".ycm-harness", "autonomy", "scout");
      const evidenceHash = await treeHash(evidence);
      await restoreTempTree(home, homePreimage);
      await restoreTempTree(projectCursor, projectPreimage);
      assert.equal(await treeHash(home), homePreimageHash);
      assert.equal(await treeHash(projectCursor), projectPreimageHash);
      assert.equal(await fs.readFile(cursorHook, "utf8"), priorHook);
      assert.equal(await fs.readFile(codexHook, "utf8"), priorHook);
      assert.equal(await fs.readFile(enabledHook, "utf8"), priorHook);
      assert.equal(await fs.readFile(codexConfig, "utf8"), priorCodexConfig);
      assert.equal(await fs.readFile(openCodeConfigPath, "utf8"), priorOpenCodeConfig);
      assert.equal(await fs.readFile(projectRule, "utf8"), priorProjectRule);
      assert.equal(await treeHash(evidence), evidenceHash);
      assert.equal(await fs.readFile(path.join(cursorHome, "unrelated.txt"), "utf8"), "keep-cursor");
      assert.equal(await fs.readFile(path.join(codexHome, "unrelated.txt"), "utf8"), "keep-codex");
      assert.equal(await fs.readFile(path.join(openCodeHome, "unrelated.txt"), "utf8"), "keep-opencode");
      assert.equal(await fs.readFile(path.join(projectCursor, "unrelated.txt"), "utf8"), "keep-project");

      await restoreTempTree(home, homeProjection);
      await restoreTempTree(projectCursor, projectProjection);
      assert.equal((await auditInstall(project, source)).needs_sync, false);
      await assertSourceFilesMatch(path.join(source, "plugin"), [cursorRoot, codexRoot, enabledRoot]);
      await assertSourceFilesMatch(path.join(source, "dist"), [
        path.join(cursorRoot, "runtime", "dist"),
        path.join(codexRoot, "runtime", "dist"),
        path.join(enabledRoot, "runtime", "dist"),
      ]);
      assert.equal(await treeHash(evidence), evidenceHash);
      assert.equal(await fs.readFile(path.join(home, ".cursor", "unrelated.txt"), "utf8"), "keep-cursor");
      assert.equal(await fs.readFile(path.join(home, ".codex", "unrelated.txt"), "utf8"), "keep-codex");
      assert.equal(await fs.readFile(path.join(home, ".config", "opencode", "unrelated.txt"), "utf8"), "keep-opencode");
      assert.equal(await fs.readFile(path.join(projectCursor, "unrelated.txt"), "utf8"), "keep-project");
      const restoredOpenCode = JSON.parse(await fs.readFile(openCodeConfigPath, "utf8")) as { plugin?: string[] };
      assert.ok(restoredOpenCode.plugin?.includes(opencodePluginSpec(source)));

      const reenabledCursor = runNode(cursorHook, project, { ...payload, session_id: "reenabled-cursor-generation" });
      assert.equal(reenabledCursor.status, 0, reenabledCursor.stderr);
      assert.match(additionalContext(reenabledCursor.stdout), /SCOUT_OBLIGATION_V1 key=scout-v1-/);
      const reenabledCodex = runNode(codexHook, project, { ...payload, session_id: "reenabled-codex-generation" });
      assert.equal(reenabledCodex.status, 0, reenabledCodex.stderr);
      assert.match(additionalContext(reenabledCodex.stdout), /SCOUT_OBLIGATION_V1 key=scout-v1-/);
    } finally {
      if (oldCodex === undefined) delete process.env.CODEX_CLI_PATH; else process.env.CODEX_CLI_PATH = oldCodex;
      if (oldOpenCode === undefined) delete process.env.OPENCODE_CLI_PATH; else process.env.OPENCODE_CLI_PATH = oldOpenCode;
      if (oldOpenCodeConfig === undefined) delete process.env.OPENCODE_CONFIG_DIR; else process.env.OPENCODE_CONFIG_DIR = oldOpenCodeConfig;
      await cleanup(project);
      await cleanup(homePreimage);
      await cleanup(homeProjection);
      await cleanup(projectPreimage);
      await cleanup(projectProjection);
    }
  });
});

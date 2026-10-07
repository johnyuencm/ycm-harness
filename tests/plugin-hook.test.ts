import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { HarnessStore } from "../src/state/store.js";
import { cleanup, tempProject } from "./helpers.js";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const hookScript = path.join(
  repoRoot,
  "plugin",
  "scripts",
  "session-start-hook.mjs",
);
const postToolUseScript = path.join(
  repoRoot,
  "plugin",
  "scripts",
  "post-tool-use-hook.mjs",
);
const stopScript = path.join(
  repoRoot,
  "plugin",
  "scripts",
  "stop-hook.mjs",
);
const opencodePlugin = path.join(
  repoRoot,
  ".opencode",
  "plugins",
  "ycm-harness.js",
);

function runHook(stdin: string, cwd = repoRoot, env?: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [hookScript], {
    cwd,
    encoding: "utf8",
    input: stdin,
    env: env ?? process.env,
  });
}

function parseHookJson(stdout: string): Record<string, unknown> {
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

function assertNativeSessionStartJson(
  stdout: string,
  additionalContext?: string,
) {
  const parsed = parseHookJson(stdout);
  assert.equal(parsed.additional_context, undefined);
  const specific = parsed.hookSpecificOutput as Record<string, unknown> | undefined;
  assert.ok(specific && typeof specific === "object");
  assert.equal(specific.hookEventName, "SessionStart");
  if (additionalContext !== undefined) {
    assert.equal(specific.additionalContext, additionalContext);
  } else if (specific.additionalContext !== undefined) {
    assert.equal(typeof specific.additionalContext, "string");
  }
}

test("session-start hook stays silent without active context", async () => {
  const root = await tempProject("ch-hook-silent-");
  try {
    const result = runHook("", root);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {});
  } finally {
    await cleanup(root);
  }
});

test("session-start hook keeps SessionStart stdin silent without active context", async () => {
  const root = await tempProject("ch-hook-silent-stdin-");
  try {
    const result = runHook(
      JSON.stringify({ hook_event_name: "SessionStart", cwd: root }),
      root,
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout.trim()), {});
  } finally {
    await cleanup(root);
  }
});

test("Claude/Codex SessionStart emits hookSpecificOutput instead of Cursor additional_context", async () => {
  const root = await tempProject("ch-hook-claude-envelope-");
  try {
    const result = runHook(
      JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "claude-session",
        cwd: root,
      }),
      root,
    );
    assert.equal(result.status, 0, result.stderr);
    assertNativeSessionStartJson(result.stdout);
  } finally {
    await cleanup(root);
  }
});

test("CLAUDE_PLUGIN_ROOT forces the native SessionStart envelope even without source", async () => {
  const root = await tempProject("ch-hook-claude-env-");
  try {
    const result = runHook(
      JSON.stringify({ hook_event_name: "SessionStart", cwd: root }),
      root,
      { ...process.env, CLAUDE_PLUGIN_ROOT: root },
    );
    assert.equal(result.status, 0, result.stderr);
    assertNativeSessionStartJson(result.stdout);
  } finally {
    await cleanup(root);
  }
});

test("PLUGIN_ROOT under .codex forces the native SessionStart envelope", async () => {
  const root = await tempProject("ch-hook-codex-plugin-root-");
  try {
    const result = runHook(
      JSON.stringify({ hook_event_name: "SessionStart", cwd: root }),
      root,
      {
        ...process.env,
        PLUGIN_ROOT: path.join(root, ".codex", "plugins", "ycm-harness"),
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assertNativeSessionStartJson(result.stdout);
  } finally {
    await cleanup(root);
  }
});

test("session-start wrapper enforces the stdin byte boundary without trusting dropped input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-session-forward-"));
  try {
    const scripts = path.join(root, "plugin", "scripts");
    const dist = path.join(root, "dist", "cli");
    await fs.mkdir(scripts, { recursive: true });
    await fs.mkdir(dist, { recursive: true });
    await fs.copyFile(hookScript, path.join(scripts, "session-start-hook.mjs"));
    await fs.copyFile(
      path.join(repoRoot, "plugin", "scripts", "harness-cli-path.mjs"),
      path.join(scripts, "harness-cli-path.mjs"),
    );
    await fs.writeFile(path.join(dist, "index.js"), `
      let raw = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", chunk => raw += chunk);
      process.stdin.on("end", () => {
        const context = raw
          ? Buffer.byteLength(raw, "utf8") + ":" + JSON.parse(raw).source + ":" + JSON.parse(raw).session_id
          : "empty";
        process.stdout.write(JSON.stringify({ additional_context: context }));
      });
    `, "utf8");
    const run = (input: string) => spawnSync(process.execPath, [path.join(scripts, "session-start-hook.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: "" },
      input,
    });
    const sized = (bytes: number) => {
      const value = {
        hook_event_name: "SessionStart",
        source: "startup",
        session_id: "generation-boundary",
        agent_type: "parent",
        padding: "",
      };
      const base = JSON.stringify(value);
      value.padding = "x".repeat(bytes - Buffer.byteLength(base, "utf8"));
      const raw = JSON.stringify(value);
      assert.equal(Buffer.byteLength(raw, "utf8"), bytes);
      return raw;
    };

    const exact = run(sized(128 * 1024));
    assert.equal(exact.status, 0, exact.stderr);
    assertNativeSessionStartJson(exact.stdout, "131072:startup:generation-boundary");

    const oversized = run(sized(128 * 1024 + 1));
    assert.equal(oversized.status, 0, oversized.stderr);
    assert.equal(JSON.parse(oversized.stdout).additional_context, "empty");
    assert.equal(JSON.parse(oversized.stdout).hookSpecificOutput, undefined);

    const malformed = run("{");
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.equal(JSON.parse(malformed.stdout).additional_context, "empty");
    assert.equal(JSON.parse(malformed.stdout).hookSpecificOutput, undefined);

    const claudeEnv = spawnSync(process.execPath, [path.join(scripts, "session-start-hook.mjs")], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, PATH: "", CLAUDE_PLUGIN_ROOT: root },
      input: "",
    });
    assert.equal(claudeEnv.status, 0, claudeEnv.stderr);
    assertNativeSessionStartJson(claudeEnv.stdout, "empty");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
test("OpenCode plugin registers design, work, and lite skill paths", async () => {
  const mod = await import(
    `${pathToFileURL(opencodePlugin).href}?t=${Date.now()}`
  );
  const plugin = await mod.default();
  const config = { skills: { paths: [] as string[] } };

  await plugin.config(config);

  assert.ok(
    config.skills.paths.some(
      (p) =>
        p.endsWith(path.join("skills", "ycm-harness")) ||
        p.endsWith(path.join("skills", "ycm-harness-work")),
    ),
  );
  assert.ok(
    config.skills.paths.some((p) =>
      p.endsWith(path.join("skills", "ycm-harness-design")),
    ),
  );
  assert.ok(
    config.skills.paths.some((p) =>
      p.endsWith(path.join("skills", "ycm-harness-work-lite")),
    ),
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
    assert.equal(
      config.skills.paths.some((p) =>
        p.replace(/\\/g, "/").endsWith(`/plugin/skills/${external}`),
      ),
      false,
      `OpenCode must not register repo-vendored Matt path for ${external}`,
    );
  }
  // When mattpocock-skills is installed, paths resolve under the Claude plugin cache.
  const mattPaths = config.skills.paths.filter((p) =>
    /mattpocock|skills[/\\](?:engineering|productivity)[/\\]/.test(p),
  );
  if (mattPaths.length > 0) {
    assert.ok(
      mattPaths.some((p) => /tdd|to-spec|grill/.test(p)),
      "expected at least one mattpocock skill path when plugin is present",
    );
  }
});

test("OpenCode plugin falls back per skill during managed-skill upgrades", async () => {
  const configDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ch-opencode-upgrade-"),
  );
  const priorConfigDir = process.env.OPENCODE_CONFIG_DIR;
  try {
    const managedWork = path.join(configDir, "skills", "ycm-harness");
    await fs.mkdir(managedWork, { recursive: true });
    await fs.writeFile(
      path.join(managedWork, "SKILL.md"),
      "---\nname: ycm-harness-work\n---\n",
      "utf8",
    );
    process.env.OPENCODE_CONFIG_DIR = configDir;

    const mod = await import(
      `${pathToFileURL(opencodePlugin).href}?t=${Date.now()}`
    );
    const plugin = await mod.default();
    const config = { skills: { paths: [] as string[] } };

    await plugin.config(config);

    assert.ok(config.skills.paths.includes(managedWork));
    assert.ok(
      config.skills.paths.some((p) =>
        p.endsWith(path.join("plugin", "skills", "ycm-harness-design")),
      ),
      "missing design skill should fall back to the repo plugin path",
    );
  } finally {
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test("OpenCode plugin ignores old managed monolithic work skill", async () => {
  const configDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "ch-opencode-old-work-"),
  );
  const priorConfigDir = process.env.OPENCODE_CONFIG_DIR;
  try {
    const managedWork = path.join(configDir, "skills", "ycm-harness");
    await fs.mkdir(managedWork, { recursive: true });
    await fs.writeFile(
      path.join(managedWork, "SKILL.md"),
      "---\nname: ycm-harness\n---\nold",
      "utf8",
    );
    process.env.OPENCODE_CONFIG_DIR = configDir;

    const mod = await import(
      `${pathToFileURL(opencodePlugin).href}?t=${Date.now()}`
    );
    const plugin = await mod.default();
    const config = { skills: { paths: [] as string[] } };

    await plugin.config(config);

    assert.equal(config.skills.paths.includes(managedWork), false);
    assert.ok(
      config.skills.paths.some((p) =>
        p.endsWith(path.join("plugin", "skills", "ycm-harness-work")),
      ),
      "old managed work skill should fall back to repo ycm-harness-work",
    );
  } finally {
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR;
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir;
    await fs.rm(configDir, { recursive: true, force: true });
  }
});

test("OpenCode bootstrap content names design, work, and lite harness skills", async () => {
  const mod = await import(
    `${pathToFileURL(opencodePlugin).href}?t=${Date.now()}`
  );
  const plugin = await mod.default();
  const output = {
    messages: [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "start" }],
      },
    ],
  };

  await plugin["experimental.chat.messages.transform"]({}, output);

  const injected = output.messages[0]?.parts[0]?.text ?? "";
  assert.match(injected, /ycm-harness-design/);
  assert.match(injected, /ycm-harness-work/);
  assert.match(injected, /ycm-harness-work-lite/);
  assert.doesNotMatch(injected, /reload `ycm-harness`/);
});

test("production hook scripts dispatch current payload JSON through the CLI", async () => {
  const root = await tempProject("ch-plugin-hook-");
  try {
    const store = new HarnessStore(root);
    await store.init();
    await store.update((state) => {
      state.goals.goal = {
        id: "goal",
        title: "Hook goal",
        status: "active",
        worktree_status: "active",
        created_at: state.created_at,
        updated_at: state.updated_at,
      };
      state.active_goal_id = "goal";
      return state;
    });
    const post = spawnSync(process.execPath, [postToolUseScript], {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "session",
        turn_id: "turn",
        cwd: root,
        hook_event_name: "PostToolUse",
        model: "test",
        tool_name: "apply_patch",
        tool_input: { patch: "PRIVATE" },
        tool_response: { success: true },
        tool_use_id: "tool",
      }),
    });
    assert.equal(post.status, 0, post.stderr);
    assert.equal(post.stdout, "");

    const stop = spawnSync(process.execPath, [stopScript], {
      cwd: root,
      encoding: "utf8",
      input: JSON.stringify({
        session_id: "session",
        turn_id: "turn",
        cwd: root,
        hook_event_name: "Stop",
        last_assistant_message: "ordinary completion",
      }),
    });
    assert.equal(stop.status, 0, stop.stderr);
    // Standard goals are advisory: Stop emits {} rather than a block decision.
    assert.deepEqual(JSON.parse(stop.stdout), {});
  } finally {
    await cleanup(root);
  }
});

test("production PostToolUse hook scripts fail open when bundled CLI dispatch breaks", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-plugin-hook-fail-"));
  try {
    const scripts = path.join(root, "plugin", "scripts");
    const dist = path.join(root, "dist", "cli");
    await fs.mkdir(scripts, { recursive: true });
    await fs.mkdir(dist, { recursive: true });
    await fs.copyFile(postToolUseScript, path.join(scripts, "post-tool-use-hook.mjs"));
    await fs.copyFile(stopScript, path.join(scripts, "stop-hook.mjs"));
    await fs.copyFile(path.join(repoRoot, "plugin", "scripts", "harness-cli-path.mjs"), path.join(scripts, "harness-cli-path.mjs"));
    await fs.writeFile(path.join(dist, "index.js"), 'process.stderr.write("RAW SECRET"); process.exit(7);', "utf8");

    const post = spawnSync(process.execPath, [path.join(scripts, "post-tool-use-hook.mjs")], {
      cwd: root,
      encoding: "utf8",
      input: "{}",
    });
    assert.equal(post.status, 0);
    assert.equal(post.stderr, "");
    assert.equal(post.stdout, "");

    const stop = spawnSync(process.execPath, [path.join(scripts, "stop-hook.mjs")], {
      cwd: root,
      encoding: "utf8",
      input: "{}",
    });
    assert.equal(stop.status, 0);
    assert.equal(stop.stderr, "");
    // Master's stop-hook fails open with {} (no universal block; no secret leak).
    assert.deepEqual(JSON.parse(stop.stdout), {});
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("findHarnessCli keeps each client tree on its own runtime", async () => {
  // Regression: the resolver used to fall back to ~/.cursor for any caller, so a
  // Codex hook with its own CLI missing silently ran the Cursor runtime instead
  // of failing open with the CLI-unavailable notice.
  const { findHarnessCli } = await import(
    pathToFileURL(path.join(repoRoot, "plugin", "scripts", "harness-cli-path.mjs")).href
  ) as { findHarnessCli: (scriptDir: string) => string | undefined };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-cli-path-"));
  const prior = { home: process.env.YCM_HARNESS_HOME, root: process.env.PLUGIN_ROOT };
  try {
    const cursorCli = path.join(root, ".cursor", "plugins", "ycm-harness", "runtime", "dist", "cli", "index.js");
    await fs.mkdir(path.dirname(cursorCli), { recursive: true });
    await fs.writeFile(cursorCli, "");
    const codexDir = path.join(root, ".codex", "plugins", "cache", "ycm-harness", "ycm-harness", "0.3.0", "scripts");
    const cursorDir = path.join(root, ".cursor", "plugins", "ycm-harness", "scripts");
    process.env.YCM_HARNESS_HOME = root;

    delete process.env.PLUGIN_ROOT;
    assert.equal(findHarnessCli(codexDir), undefined, "codex tree must not borrow the cursor CLI");
    process.env.PLUGIN_ROOT = path.join(root, ".codex", "plugins", "cache", "ycm-harness", "ycm-harness", "0.3.0");
    assert.equal(findHarnessCli(codexDir), undefined, "PLUGIN_ROOT under .codex must not borrow the cursor CLI");
    assert.equal(findHarnessCli(cursorDir), cursorCli, "cursor tree may use the cursor projection");
  } finally {
    if (prior.home === undefined) delete process.env.YCM_HARNESS_HOME; else process.env.YCM_HARNESS_HOME = prior.home;
    if (prior.root === undefined) delete process.env.PLUGIN_ROOT; else process.env.PLUGIN_ROOT = prior.root;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a Claude cache hook finds the shared ~/.cursor CLI", async () => {
  // Regression: the Codex fix also cut Claude off from the ~/.cursor projection.
  // Claude cache installs ship no runtime/ of their own (install-kit.ts:1196), so
  // the SessionStart hook must still reach the synced Cursor runtime, as at a411797.
  const { findHarnessCli } = await import(
    pathToFileURL(path.join(repoRoot, "plugin", "scripts", "harness-cli-path.mjs")).href
  ) as { findHarnessCli: (scriptDir: string) => string | undefined };
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-claude-cli-path-"));
  const prior = {
    home: process.env.YCM_HARNESS_HOME,
    claudeRoot: process.env.CLAUDE_PLUGIN_ROOT,
    claudeEnv: process.env.CLAUDE_ENV_FILE,
    pluginRoot: process.env.PLUGIN_ROOT,
  };
  try {
    const cursorCli = path.join(root, ".cursor", "plugins", "ycm-harness", "runtime", "dist", "cli", "index.js");
    await fs.mkdir(path.dirname(cursorCli), { recursive: true });
    await fs.writeFile(cursorCli, "");
    const claudeRoot = path.join(root, ".claude", "plugins", "cache", "ycm-harness", "ycm-harness", "0.3.0");
    const claudeScripts = path.join(claudeRoot, "scripts");
    process.env.YCM_HARNESS_HOME = root;
    process.env.CLAUDE_PLUGIN_ROOT = claudeRoot;
    delete process.env.PLUGIN_ROOT;

    assert.equal(
      findHarnessCli(claudeScripts),
      cursorCli,
      "a Claude cache hook must reach the shared cursor runtime CLI",
    );
  } finally {
    if (prior.home === undefined) delete process.env.YCM_HARNESS_HOME; else process.env.YCM_HARNESS_HOME = prior.home;
    if (prior.claudeRoot === undefined) delete process.env.CLAUDE_PLUGIN_ROOT; else process.env.CLAUDE_PLUGIN_ROOT = prior.claudeRoot;
    if (prior.claudeEnv === undefined) delete process.env.CLAUDE_ENV_FILE; else process.env.CLAUDE_ENV_FILE = prior.claudeEnv;
    if (prior.pluginRoot === undefined) delete process.env.PLUGIN_ROOT; else process.env.PLUGIN_ROOT = prior.pluginRoot;
    await fs.rm(root, { recursive: true, force: true });
  }
});

async function runNotesCheck(
  turn: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-notes-check-"));
  try {
    const transcript = path.join(root, "transcript.jsonl");
    await fs.writeFile(transcript, turn.map((entry) => JSON.stringify(entry)).join("\n"), "utf8");
    const stop = spawnSync(process.execPath, [stopScript], {
      cwd: root,
      encoding: "utf8",
      env,
      input: JSON.stringify({
        session_id: "session",
        cwd: root,
        hook_event_name: "Stop",
        stop_hook_active: false,
        last_assistant_message: "Done.",
        transcript_path: transcript,
        ...extra,
      }),
    });
    assert.equal(stop.status, 0, stop.stderr);
    return JSON.parse(stop.stdout) as Record<string, unknown>;
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

const userPrompt = (text: string) => ({ type: "user", message: { role: "user", content: text } });
const toolUse = (name: string, input: Record<string, unknown> = {}) => ({
  type: "assistant",
  message: { role: "assistant", content: [{ type: "tool_use", id: name, name, input }] },
});
const toolResult = { type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "x", content: "ok" }] } };

test("Stop asks for a notes check once after a turn that changed files", async () => {
  const output = await runNotesCheck([userPrompt("fix it"), toolUse("Edit", { file_path: "a.ts" }), toolResult]);
  assert.equal(output.decision, "block");
  assert.match(String(output.reason), /notes/i);
  assert.match(String(output.reason), /issue|PR|wiki|journal|memory/i);

  // Claude sets stop_hook_active on the continuation, so the check never loops.
  assert.deepEqual(await runNotesCheck([userPrompt("fix it"), toolUse("Write")], { stop_hook_active: true }), {});
});

test("Stop notes check fires on git and tracker writes, not on reads", async () => {
  for (const command of ["git commit -m x", "git -C repo push -u origin b", "gh pr create --title t", "gh issue comment 3 --body b"]) {
    const output = await runNotesCheck([userPrompt("ship"), toolUse("Bash", { command }), toolResult]);
    assert.equal(output.decision, "block", command);
  }
  for (const command of ["git status --porcelain", "git merge-base main HEAD", "gh pr view 3", "gh issue list"]) {
    assert.deepEqual(await runNotesCheck([userPrompt("look"), toolUse("Bash", { command }), toolResult]), {}, command);
  }
  assert.deepEqual(await runNotesCheck([userPrompt("look"), toolUse("Read"), toolUse("Grep"), toolResult]), {});
});

test("Stop notes check only looks at the current turn and can be turned off", async () => {
  // The edit belongs to an earlier turn; this turn only answered a question.
  assert.deepEqual(await runNotesCheck([userPrompt("fix it"), toolUse("Edit"), toolResult, userPrompt("what changed?")]), {});
  assert.deepEqual(
    await runNotesCheck([userPrompt("fix it"), toolUse("Edit")], {}, { ...process.env, YCM_NOTES_CHECK: "off" }),
    {},
  );
  // No readable transcript: fail open.
  assert.deepEqual(await runNotesCheck([userPrompt("fix it"), toolUse("Edit")], { transcript_path: "missing.jsonl" }), {});
});

const cursorUser = (text: string) => ({ role: "user", message: { content: [{ type: "text", text: `<user_query>${text}</user_query>` }] } });
const cursorTool = (name: string, input: Record<string, unknown> = {}) => ({
  role: "assistant",
  message: { content: [{ type: "tool_use", name, input }] },
});
const cursorStop = (extra: Record<string, unknown> = {}) => ({
  hook_event_name: "stop",
  conversation_id: "conversation",
  generation_id: "generation",
  workspace_roots: [os.tmpdir()],
  status: "completed",
  loop_count: 0,
  ...extra,
});

test("Stop notes check speaks Cursor: followup_message once, then loop_count stops it", async () => {
  const edited = await runNotesCheck([cursorUser("fix"), cursorTool("StrReplace", { path: "a.tex" })], cursorStop());
  assert.match(String(edited.followup_message), /notes/i);
  assert.equal(edited.decision, undefined);
  const shell = await runNotesCheck([cursorUser("ship"), cursorTool("Shell", { command: "git push" })], cursorStop());
  assert.match(String(shell.followup_message), /notes/i);
  assert.deepEqual(await runNotesCheck([cursorUser("look"), cursorTool("Shell", { command: "git status" })], cursorStop()), {});
  assert.deepEqual(await runNotesCheck([cursorUser("fix"), cursorTool("Write")], cursorStop({ loop_count: 1 })), {});
  assert.deepEqual(
    await runNotesCheck([cursorUser("fix"), cursorTool("Write"), { role: "turn_ended" }, cursorUser("thanks")], cursorStop()),
    {},
  );
});

const codexTurn = { type: "event_msg", payload: { type: "task_started", turn_id: "t" } };
const codexExec = (cmd: string) => ({
  type: "response_item",
  payload: { type: "custom_tool_call", name: "exec", input: `const r=await tools.exec_command({cmd:${JSON.stringify(cmd)}})` },
});
const codexPatch = {
  type: "response_item",
  payload: { type: "function_call", name: "apply_patch", arguments: JSON.stringify({ input: "*** Begin Patch\n*** Update File: a.ts\n" }) },
};

test("Stop notes check reads Codex rollouts: tool calls in the current task only", async () => {
  assert.equal((await runNotesCheck([codexTurn, codexPatch])).decision, "block");
  assert.equal((await runNotesCheck([codexTurn, codexExec("git commit -m x")])).decision, "block");
  assert.deepEqual(await runNotesCheck([codexTurn, codexExec("git status --short")]), {});
  assert.deepEqual(await runNotesCheck([codexTurn, codexPatch, codexTurn, codexExec("git log -1")]), {});
  assert.deepEqual(await runNotesCheck([codexTurn, codexPatch], { stop_hook_active: true, last_assistant_message: null }), {});
});

test("Stop wrapper finds the CLI, gives Cursor a CLI-shaped payload, and translates a block", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-stop-cli-"));
  try {
    const cli = path.join(root, "fake-cli.mjs");
    const seen = path.join(root, "seen.json");
    await fs.writeFile(
      cli,
      `import { readFileSync, writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(seen)}, readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify({ decision: "block", reason: "Finish ticket T-1." }));`,
      "utf8",
    );
    const env = { ...process.env, YCM_HARNESS_CLI: cli };
    const claude = await runNotesCheck([userPrompt("look")], {}, env);
    assert.equal(claude.decision, "block");
    assert.equal(claude.reason, "Finish ticket T-1.");

    const cursor = await runNotesCheck([cursorUser("look")], cursorStop({ loop_count: 2 }), env);
    assert.deepEqual(cursor, { followup_message: "Finish ticket T-1." });
    const forwarded = JSON.parse(await fs.readFile(seen, "utf8")) as Record<string, unknown>;
    assert.equal(forwarded.hook_event_name, "Stop");
    assert.equal(forwarded.session_id, "conversation");
    assert.equal(forwarded.cwd, os.tmpdir());
    assert.equal(forwarded.stop_hook_active, true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

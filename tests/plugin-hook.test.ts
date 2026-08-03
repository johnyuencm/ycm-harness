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

function runHook(stdin: string, cwd = repoRoot) {
  return spawnSync(process.execPath, [hookScript], {
    cwd,
    encoding: "utf8",
    input: stdin,
  });
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

test("session-start wrapper enforces the stdin byte boundary without trusting dropped input", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-session-forward-"));
  try {
    const scripts = path.join(root, "plugin", "scripts");
    const dist = path.join(root, "dist", "cli");
    await fs.mkdir(scripts, { recursive: true });
    await fs.mkdir(dist, { recursive: true });
    await fs.copyFile(hookScript, path.join(scripts, "session-start-hook.mjs"));
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
    assert.equal(JSON.parse(exact.stdout).additional_context,
      "131072:startup:generation-boundary");

    const oversized = run(sized(128 * 1024 + 1));
    assert.equal(oversized.status, 0, oversized.stderr);
    assert.equal(JSON.parse(oversized.stdout).additional_context, "empty");
    assert.equal(JSON.parse(oversized.stdout).hookSpecificOutput, undefined);

    const malformed = run("{");
    assert.equal(malformed.status, 0, malformed.stderr);
    assert.equal(JSON.parse(malformed.stdout).additional_context, "empty");
    assert.equal(JSON.parse(malformed.stdout).hookSpecificOutput, undefined);
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

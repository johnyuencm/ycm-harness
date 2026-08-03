import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "..");

test("client SessionStart adapter keeps silent results empty", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ch-session-silent-"));
  const result = spawnSync(process.execPath, [path.join(root, "plugin", "scripts", "session-start-hook.mjs")], {
    cwd: tmp,
    encoding: "utf8",
    input: "",
    env: { ...process.env, HOME: tmp, YCM_HARNESS_HOME: tmp },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test("SessionStart absent CLI stays silent without a runtime projection", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ch-session-start-"));
  const scripts = path.join(tmp, "scripts");
  await fs.mkdir(scripts, { recursive: true });
  await fs.copyFile(
    path.join(root, "plugin", "scripts", "session-start-hook.mjs"),
    path.join(scripts, "session-start-hook.mjs"),
  );
  const result = spawnSync(process.execPath, [path.join(scripts, "session-start-hook.mjs")], {
    cwd: tmp,
    encoding: "utf8",
    input: "",
    env: { ...process.env, HOME: tmp, YCM_HARNESS_HOME: tmp, PATH: "" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {});
});

test("OpenCode adapter registers source-mode harness skills", () => {
  const url = pathToFileURL(path.join(root, ".opencode", "plugins", "ycm-harness.js")).href;
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "const mod = await import(" + JSON.stringify(url) + "); const adapter = await mod.default(); const config = { skills: { paths: [] } }; await adapter.config(config); console.log(JSON.stringify(config));",
  ], { cwd: root, encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const config = JSON.parse(child.stdout) as { skills: { paths: string[] } };
  assert.ok(config.skills.paths.some((item) =>
    item.endsWith(path.join("skills", "ycm-harness-work")) ||
    item.endsWith(path.join("skills", "ycm-harness")),
  ));
  assert.ok(config.skills.paths.some((item) => item.endsWith(path.join("skills", "ycm-harness-design"))));
  assert.ok(config.skills.paths.some((item) => item.endsWith(path.join("skills", "ycm-harness-work-lite"))));
  assert.equal(
    config.skills.paths.some((item) =>
      item.replace(/\\/g, "/").endsWith("/plugin/skills/tdd"),
    ),
    false,
    "tdd must not come from repo-vendored plugin/skills",
  );
});

test("Cursor projection uses shared SessionStart and Stop adapters", () => {
  const manifest = JSON.parse(readFileSync(path.join(root, "plugin", "hooks", "hooks-cursor.json"), "utf8"));
  assert.ok(Array.isArray(manifest.hooks.sessionStart));
  assert.ok(Array.isArray(manifest.hooks.stop));
  assert.match(manifest.hooks.sessionStart[0].command, /session-start-hook/);
  assert.match(manifest.hooks.stop[0].command, /stop-hook/);
});

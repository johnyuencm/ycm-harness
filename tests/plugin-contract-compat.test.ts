import assert from "node:assert/strict";
import { existsSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "..");
const pluginRoot = path.join(repoRoot, "plugin");
const validator = path.join(
  homedir(),
  ".codex",
  "skills",
  ".system",
  "plugin-creator",
  "scripts",
  "validate_plugin.py",
);

function runValidator(root: string) {
  return spawnSync("python", [validator, root], { encoding: "utf8" });
}

test("current plugin hooks are valid", () => {
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  assert.equal(manifest.hooks, "./hooks/hooks-codex.json");

  const hooksPath = path.resolve(pluginRoot, manifest.hooks);
  assert.equal(hooksPath.startsWith(`${pluginRoot}${path.sep}`), true);
  const config = JSON.parse(readFileSync(hooksPath, "utf8"));
  for (const event of ["SessionStart", "PostToolUse", "Stop"]) {
    assert.equal(Array.isArray(config.hooks?.[event]), true);
    assert.equal(config.hooks[event].length > 0, true);
    for (const group of config.hooks[event]) {
      assert.equal(Array.isArray(group.hooks), true);
      for (const hook of group.hooks) {
        assert.equal(hook.type, "command");
        assert.match(hook.command, /\$\{PLUGIN_ROOT\}/);
        assert.equal(hook.async, false);
      }
    }
  }
  assert.equal(config.hooks.Stop.length, 1, "must not install a competing Stop hook");
});

test(
  "bundled validator mismatch is hooks-only",
  { skip: !existsSync(validator) },
  (t) => {
  const direct = runValidator(pluginRoot);
  const directOutput = `${direct.stdout}\n${direct.stderr}`.trim();
  assert.equal(direct.status, 1);
  assert.match(directOutput, /plugin\.json field `hooks` is not accepted/);
  assert.doesNotMatch(directOutput, /\n- (?!plugin\.json field `hooks`)/);

  const tempRoot = mkdtempSync(path.join(tmpdir(), "ycm-harness-plugin-validator-"));
  t.after(() => rmSync(tempRoot, { recursive: true, force: true }));
  const tempPlugin = path.join(tempRoot, "plugin");
  cpSync(pluginRoot, tempPlugin, { recursive: true });
  const tempManifestPath = path.join(tempPlugin, ".codex-plugin", "plugin.json");
  const tempManifest = JSON.parse(readFileSync(tempManifestPath, "utf8"));
  delete tempManifest.hooks;
  writeFileSync(tempManifestPath, `${JSON.stringify(tempManifest, null, 2)}\n`);

  const compatible = runValidator(tempPlugin);
  assert.equal(
    compatible.status,
    0,
    `plugin without the validator-version exception must pass:\n${compatible.stdout}\n${compatible.stderr}`,
  );
  },
);

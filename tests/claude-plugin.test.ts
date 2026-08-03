import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  claudeMarketplaceSource,
  packageRoot,
} from "../src/cli/install-kit.js";

test("Claude marketplace + plugin manifests exist and validate shape", async () => {
  const root = packageRoot();
  const marketplacePath = path.join(root, ".claude-plugin", "marketplace.json");
  const pluginPath = path.join(
    root,
    "plugin",
    ".claude-plugin",
    "plugin.json",
  );
  const hooksPath = path.join(root, "plugin", "hooks", "hooks-claude.json");

  const marketplace = JSON.parse(await fs.readFile(marketplacePath, "utf8")) as {
    name: string;
    plugins: Array<{ name: string; source: string }>;
  };
  const plugin = JSON.parse(await fs.readFile(pluginPath, "utf8")) as {
    name: string;
    hooks?: string;
    version?: string;
  };
  type HookRegistration = {
    matcher?: string;
    hooks: Array<{ type: string; command: string; timeout?: number }>;
  };
  const hooks = JSON.parse(await fs.readFile(hooksPath, "utf8")) as {
    hooks: Record<string, HookRegistration[]>;
  };

  assert.equal(marketplace.name, "harness");
  assert.equal(marketplace.plugins[0]?.name, "ycm-harness");
  assert.equal(marketplace.plugins[0]?.source, "./plugin");
  assert.equal(plugin.name, "ycm-harness");
  assert.equal(plugin.hooks, "./hooks/hooks-claude.json");
  // Omit version so every git commit on the tracked ref counts as a new version.
  assert.equal(plugin.version, undefined);
  assert.ok(hooks.hooks.PreCompact);
  assert.ok(hooks.hooks.PostCompact);
  assert.ok(hooks.hooks.SessionStart);
  assert.ok(hooks.hooks.Stop);

  const pre = hooks.hooks.PreCompact?.[0];
  const post = hooks.hooks.PostCompact?.[0];
  const session = hooks.hooks.SessionStart ?? [];
  assert.equal(pre?.matcher, "manual|auto");
  assert.equal(post?.matcher, "manual|auto");
  assert.deepEqual(session.map((entry) => entry.matcher), ["startup|resume|clear", "compact"]);
  assert.match(pre?.hooks[0]?.command ?? "", /pre-compact-hook\.mjs/u);
  assert.match(post?.hooks[0]?.command ?? "", /post-compact-hook\.mjs/u);
  assert.match(session[1]?.hooks[0]?.command ?? "", /session-start-hook\.mjs/u);
  for (const registration of [pre, post, ...session]) {
    assert.equal(registration?.hooks[0]?.type, "command");
    assert.equal(registration?.hooks[0]?.timeout, 5);
  }
});

test("claudeMarketplaceSource picks local path or GitHub ref", () => {
  const root = packageRoot();
  assert.equal(claudeMarketplaceSource(root), path.resolve(root));
  assert.equal(
    claudeMarketplaceSource(root, { useGit: true }),
    "https://github.com/johnyuencm/ycm-harness.git",
  );
  assert.equal(
    claudeMarketplaceSource(root, { useGit: true, ref: "master" }),
    "https://github.com/johnyuencm/ycm-harness.git",
  );
  assert.equal(
    claudeMarketplaceSource(root, { useGit: true, ref: "harness/lean-0.3" }),
    "https://github.com/johnyuencm/ycm-harness.git#harness/lean-0.3",
  );
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import {
  parseGithubOwnerRepo,
  githubCloneUrl,
  listPinnedCursorPluginRoots,
  listPinnedClaudePluginRoots,
  cursorLocalInstallRoot,
  resolvePluginProjectRoot,
} from "../src/cli/cursor-github-plugin.js";
import {
  refreshCursorPluginAssets,
  refreshCursorPluginsFromGithub,
  listCursorPluginDestinations,
} from "../src/cli/install-kit.js";
import { withTempUserHome } from "./helpers.js";

test("parseGithubOwnerRepo accepts ssh, https, and owner/repo", () => {
  assert.equal(
    parseGithubOwnerRepo("git@github.com:johnyuencm/harness.git"),
    "johnyuencm/harness",
  );
  assert.equal(
    parseGithubOwnerRepo("https://github.com/johnyuencm/ycm-harness.git"),
    "johnyuencm/ycm-harness",
  );
  assert.equal(
    parseGithubOwnerRepo("git+https://github.com/johnyuen/harness.git"),
    "johnyuen/harness",
  );
  assert.equal(parseGithubOwnerRepo("johnyuen/harness"), "johnyuen/harness");
  assert.equal(
    githubCloneUrl("johnyuen/harness"),
    "https://github.com/johnyuen/harness.git",
  );
  assert.equal(
    githubCloneUrl("--upload-pack=evil"),
    "https://github.com/johnyuen/harness.git",
  );
});

test("listPinnedCursorPluginRoots finds SHA-pinned ycm-harness cache copies", async () => {
  await withTempUserHome(async (home) => {
    const sha = "3ed7e70c22144bb3264dce9cd1e1b0425dca5af2";
    const pinned = path.join(
      home,
      ".cursor",
      "plugins",
      "cache",
      "johnyuencm-harness",
      "ycm-harness",
      sha,
    );
    await fs.mkdir(path.join(pinned, ".cursor-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pinned, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    await fs.mkdir(path.join(pinned, "rules"), { recursive: true });
    await fs.writeFile(
      path.join(pinned, "rules", "ycm-harness.mdc"),
      "Dispatch spec_reviewer and uiux\n",
      "utf8",
    );
    await fs.mkdir(path.join(pinned, "agents"), { recursive: true });
    await fs.writeFile(path.join(pinned, "agents", "spec_reviewer.md"), "old\n", "utf8");
    await fs.writeFile(path.join(pinned, "agents", "uiux.md"), "old\n", "utf8");

    const found = await listPinnedCursorPluginRoots();
    assert.equal(found.length, 1);
    assert.equal(path.resolve(found[0]!), path.resolve(pinned));

    const dests = await listCursorPluginDestinations();
    assert.ok(dests.some((dir) => path.resolve(dir) === path.resolve(pinned)));
    assert.ok(
      dests.some(
        (dir) => path.resolve(dir) === path.resolve(cursorLocalInstallRoot()),
      ),
    );
  });
});

test("refreshCursorPluginAssets overwrites pinned cache and prunes retired agents", async () => {
  await withTempUserHome(async (home) => {
    const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const pinned = path.join(
      home,
      ".cursor",
      "plugins",
      "cache",
      "johnyuencm-harness",
      "ycm-harness",
      sha,
    );
    await fs.mkdir(path.join(pinned, ".cursor-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pinned, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    await fs.mkdir(path.join(pinned, "agents"), { recursive: true });
    await fs.writeFile(path.join(pinned, "agents", "spec_reviewer.md"), "old\n", "utf8");
    await fs.writeFile(path.join(pinned, "agents", "uiux.md"), "old\n", "utf8");
    await fs.mkdir(path.join(pinned, "extra-cursor-meta"), { recursive: true });
    await fs.writeFile(path.join(pinned, "extra-cursor-meta", "keep.txt"), "keep\n", "utf8");

    const claudePinned = path.join(
      home,
      ".claude",
      "plugins",
      "cache",
      "harness",
      "ycm-harness",
      "3ed7e70c2214",
    );
    await fs.mkdir(path.join(claudePinned, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(claudePinned, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    await fs.mkdir(path.join(claudePinned, "agents"), { recursive: true });
    await fs.writeFile(
      path.join(claudePinned, "agents", "spec_reviewer.md"),
      "old\n",
      "utf8",
    );
    await fs.mkdir(path.join(claudePinned, "claude-extra"), { recursive: true });
    await fs.writeFile(
      path.join(claudePinned, "claude-extra", "keep.txt"),
      "keep\n",
      "utf8",
    );

    const fakeRepo = path.join(home, "src-repo");
    await fs.mkdir(path.join(fakeRepo, "plugin", "rules"), { recursive: true });
    await fs.mkdir(path.join(fakeRepo, "plugin", "agents"), { recursive: true });
    await fs.mkdir(path.join(fakeRepo, "plugin", ".cursor-plugin"), {
      recursive: true,
    });
    await fs.mkdir(path.join(fakeRepo, "plugin", "skills", "ycm-harness-work"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(fakeRepo, "plugin", "rules", "ycm-harness.mdc"),
      "two-phase panel; do not dispatch spec_reviewer\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(fakeRepo, "plugin", "skills", "ycm-harness-work", "SKILL.md"),
      "two-phase\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(fakeRepo, "plugin", ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );

    process.env.YCM_HARNESS_GITHUB_PLUGIN = "1";
    try {
      const reports = await refreshCursorPluginAssets(fakeRepo, true);
      assert.ok(reports.length > 0);
    } finally {
      delete process.env.YCM_HARNESS_GITHUB_PLUGIN;
    }

    const rule = await fs.readFile(
      path.join(pinned, "rules", "ycm-harness.mdc"),
      "utf8",
    );
    assert.match(rule, /two-phase panel/);
    await assert.rejects(fs.stat(path.join(pinned, "agents", "spec_reviewer.md")));
    await assert.rejects(fs.stat(path.join(pinned, "agents", "uiux.md")));
    assert.equal(
      await fs.readFile(path.join(pinned, "extra-cursor-meta", "keep.txt"), "utf8"),
      "keep\n",
    );

    const localRule = path.join(
      cursorLocalInstallRoot(),
      "rules",
      "ycm-harness.mdc",
    );
    assert.match(await fs.readFile(localRule, "utf8"), /two-phase panel/);
    assert.match(
      await fs.readFile(path.join(claudePinned, "rules", "ycm-harness.mdc"), "utf8"),
      /two-phase panel/,
    );
    await assert.rejects(fs.stat(path.join(claudePinned, "agents", "spec_reviewer.md")));
    assert.equal(
      await fs.readFile(path.join(claudePinned, "claude-extra", "keep.txt"), "utf8"),
      "keep\n",
    );
  });
});

test("syncCursorGithubClone can clone a local git remote", async () => {
  await withTempUserHome(async (home) => {
    const remote = path.join(home, "remote.git");
    const work = path.join(home, "work");
    await fs.mkdir(path.join(work, "plugin", ".cursor-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(work, "plugin", ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    await fs.writeFile(path.join(work, "README.md"), "remote\n", "utf8");
    const git = (args: string[], cwd: string) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
    };
    git(["init", "-b", "master"], work);
    git(["config", "user.email", "test@example.com"], work);
    git(["config", "user.name", "test"], work);
    git(["add", "."], work);
    git(["commit", "-m", "init"], work);
    git(["clone", "--bare", work, remote], home);

    process.env.YCM_HARNESS_GITHUB_PLUGIN = "1";
    process.env.YCM_HARNESS_GITHUB_REMOTE = remote;
    try {
      const { syncCursorGithubClone, cursorGitCloneRoot, cursorGithubPluginRoot } =
        await import("../src/cli/cursor-github-plugin.js");
      const result = await syncCursorGithubClone({
        sourceRoot: work,
        ref: "master",
      });
      assert.ok(result.root, result.reports.join("\n"));
      const pluginRoot = await cursorGithubPluginRoot(cursorGitCloneRoot());
      assert.ok(pluginRoot);
      assert.equal(
        JSON.parse(
          await fs.readFile(path.join(pluginRoot, ".cursor-plugin", "plugin.json"), "utf8"),
        ).name,
        "ycm-harness",
      );
    } finally {
      delete process.env.YCM_HARNESS_GITHUB_PLUGIN;
      delete process.env.YCM_HARNESS_GITHUB_REMOTE;
    }
  });
});

test("listPinnedClaudePluginRoots finds Claude SHA-pinned ycm-harness copies", async () => {
  await withTempUserHome(async (home) => {
    const pinned = path.join(
      home,
      ".claude",
      "plugins",
      "cache",
      "harness",
      "ycm-harness",
      "3ed7e70c2214",
    );
    await fs.mkdir(path.join(pinned, ".claude-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pinned, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    const found = await listPinnedClaudePluginRoots();
    assert.equal(found.length, 1);
    assert.equal(path.resolve(found[0]!), path.resolve(pinned));
  });
});

test("resolvePluginProjectRoot rejects a CLI runtime tree", async () => {
  await withTempUserHome(async (home) => {
    const runtime = path.join(home, "runtime");
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(
      path.join(runtime, "package.json"),
      JSON.stringify({ name: "runtime-poison" }),
      "utf8",
    );
    assert.equal(await resolvePluginProjectRoot(runtime), undefined);

    const repo = path.join(home, "checkout");
    await fs.mkdir(path.join(repo, "plugin", ".cursor-plugin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repo, "plugin", ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    assert.equal(
      path.resolve((await resolvePluginProjectRoot(repo))!),
      path.resolve(repo),
    );
  });
});

test("refreshCursorPluginsFromGithub does not copy a CLI runtime tree into dests", async () => {
  await withTempUserHome(async (home) => {
    const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const pinned = path.join(
      home,
      ".cursor",
      "plugins",
      "cache",
      "pub",
      "ycm-harness",
      sha,
    );
    await fs.mkdir(path.join(pinned, ".cursor-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pinned, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    await fs.mkdir(path.join(pinned, "rules"), { recursive: true });
    await fs.writeFile(
      path.join(pinned, "rules", "ycm-harness.mdc"),
      "STALE_FIVE_SEAT\n",
      "utf8",
    );

    const runtime = path.join(home, "runtime");
    await fs.mkdir(runtime, { recursive: true });
    await fs.writeFile(
      path.join(runtime, "package.json"),
      JSON.stringify({ name: "runtime-poison" }),
      "utf8",
    );

    process.env.YCM_HARNESS_GITHUB_PLUGIN = "1";
    process.env.YCM_HARNESS_SKIP_GITHUB_PLUGIN = "1";
    try {
      const reports = await refreshCursorPluginsFromGithub({
        sourceRoot: runtime,
        force: true,
      });
      assert.ok(
        reports.some((line) => /local overlay/.test(line)),
        reports.join("\n"),
      );
    } finally {
      delete process.env.YCM_HARNESS_GITHUB_PLUGIN;
      delete process.env.YCM_HARNESS_SKIP_GITHUB_PLUGIN;
    }

    assert.equal(
      await fs.readFile(path.join(pinned, "rules", "ycm-harness.mdc"), "utf8"),
      "STALE_FIVE_SEAT\n",
    );
    await assert.rejects(fs.stat(path.join(pinned, "package.json")));
  });
});

test("refreshCursorPluginsFromGithub uses checkout plugin when clone is skipped", async () => {
  await withTempUserHome(async (home) => {
    const sha = "cccccccccccccccccccccccccccccccccccccccc";
    const pinned = path.join(
      home,
      ".cursor",
      "plugins",
      "cache",
      "pub",
      "ycm-harness",
      sha,
    );
    await fs.mkdir(path.join(pinned, ".cursor-plugin"), { recursive: true });
    await fs.writeFile(
      path.join(pinned, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    await fs.mkdir(path.join(pinned, "rules"), { recursive: true });
    await fs.writeFile(
      path.join(pinned, "rules", "ycm-harness.mdc"),
      "STALE_FIVE_SEAT\n",
      "utf8",
    );

    const repo = path.join(home, "checkout");
    await fs.mkdir(path.join(repo, "plugin", "rules"), { recursive: true });
    await fs.mkdir(path.join(repo, "plugin", ".cursor-plugin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repo, "plugin", ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(repo, "plugin", "rules", "ycm-harness.mdc"),
      "two-phase panel from checkout\n",
      "utf8",
    );

    process.env.YCM_HARNESS_GITHUB_PLUGIN = "1";
    process.env.YCM_HARNESS_GITHUB_REMOTE = path.join(home, "missing-remote.git");
    try {
      const reports = await refreshCursorPluginsFromGithub({
        sourceRoot: repo,
        force: true,
      });
      assert.ok(
        reports.some((line) => /checkout plugin/.test(line)),
        reports.join("\n"),
      );
    } finally {
      delete process.env.YCM_HARNESS_GITHUB_PLUGIN;
      delete process.env.YCM_HARNESS_GITHUB_REMOTE;
    }

    assert.match(
      await fs.readFile(path.join(pinned, "rules", "ycm-harness.mdc"), "utf8"),
      /two-phase panel from checkout/,
    );
  });
});

test("refreshCursorPluginAssets keeps runtime on unmanaged Cursor dests", async () => {
  await withTempUserHome(async (home) => {
    const dest = path.join(home, ".cursor", "plugins", "ycm-harness");
    await fs.mkdir(path.join(dest, "runtime"), { recursive: true });
    await fs.writeFile(path.join(dest, "runtime", "keep.txt"), "cli\n", "utf8");

    const fakeRepo = path.join(home, "src-repo");
    await fs.mkdir(path.join(fakeRepo, "plugin", "rules"), { recursive: true });
    await fs.mkdir(path.join(fakeRepo, "plugin", ".cursor-plugin"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(fakeRepo, "plugin", ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(fakeRepo, "plugin", "rules", "ycm-harness.mdc"),
      "two-phase\n",
      "utf8",
    );

    await refreshCursorPluginAssets(fakeRepo, true);
    assert.equal(
      await fs.readFile(path.join(dest, "runtime", "keep.txt"), "utf8"),
      "cli\n",
    );
    assert.match(
      await fs.readFile(path.join(dest, "rules", "ycm-harness.mdc"), "utf8"),
      /two-phase/,
    );
  });
});

test("failed git fetch does not copy a stale clone onto dests", async () => {
  await withTempUserHome(async (home) => {
    const remote = path.join(home, "remote.git");
    const work = path.join(home, "work");
    await fs.mkdir(path.join(work, "plugin", ".cursor-plugin"), { recursive: true });
    await fs.mkdir(path.join(work, "plugin", "rules"), { recursive: true });
    await fs.writeFile(
      path.join(work, "plugin", ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(work, "plugin", "rules", "ycm-harness.mdc"),
      "OLD_CLONE\n",
      "utf8",
    );
    const git = (args: string[], cwd: string) => {
      const result = spawnSync("git", args, {
        cwd,
        encoding: "utf8",
        windowsHide: true,
      });
      assert.equal(result.status, 0, result.stderr);
    };
    git(["init", "-b", "master"], work);
    git(["config", "user.email", "test@example.com"], work);
    git(["config", "user.name", "test"], work);
    git(["add", "."], work);
    git(["commit", "-m", "init"], work);
    git(["clone", "--bare", work, remote], home);

    const sha = "dddddddddddddddddddddddddddddddddddddddd";
    const pinned = path.join(
      home,
      ".cursor",
      "plugins",
      "cache",
      "pub",
      "ycm-harness",
      sha,
    );
    await fs.mkdir(path.join(pinned, ".cursor-plugin"), { recursive: true });
    await fs.mkdir(path.join(pinned, "rules"), { recursive: true });
    await fs.writeFile(
      path.join(pinned, ".cursor-plugin", "plugin.json"),
      JSON.stringify({ name: "ycm-harness" }),
      "utf8",
    );
    await fs.writeFile(
      path.join(pinned, "rules", "ycm-harness.mdc"),
      "NEW_FROM_SYNC\n",
      "utf8",
    );

    process.env.YCM_HARNESS_GITHUB_PLUGIN = "1";
    process.env.YCM_HARNESS_GITHUB_REMOTE = remote;
    try {
      const { syncCursorGithubClone, cursorGitCloneRoot } = await import(
        "../src/cli/cursor-github-plugin.js"
      );
      const cloned = await syncCursorGithubClone({
        sourceRoot: work,
        ref: "master",
      });
      assert.ok(cloned.root, cloned.reports.join("\n"));
      git(
        ["remote", "set-url", "origin", path.join(home, "gone.git")],
        cursorGitCloneRoot(),
      );

      const runtime = path.join(home, "runtime");
      await fs.mkdir(runtime, { recursive: true });
      await fs.writeFile(
        path.join(runtime, "package.json"),
        JSON.stringify({ name: "runtime-poison" }),
        "utf8",
      );

      const reports = await refreshCursorPluginsFromGithub({
        sourceRoot: runtime,
        force: true,
      });
      assert.ok(
        reports.some((line) => /fetch failed|skipped dest copy/.test(line)),
        reports.join("\n"),
      );
    } finally {
      delete process.env.YCM_HARNESS_GITHUB_PLUGIN;
      delete process.env.YCM_HARNESS_GITHUB_REMOTE;
    }

    assert.equal(
      await fs.readFile(path.join(pinned, "rules", "ycm-harness.mdc"), "utf8"),
      "NEW_FROM_SYNC\n",
    );
  });
});

test("SessionStart hook script refreshes via sibling github-refresh.mjs", async () => {
  const hook = await fs.readFile(
    new URL("../plugin/scripts/session-start-hook.mjs", import.meta.url),
    "utf8",
  );
  assert.match(hook, /github-refresh\.mjs/);
  assert.match(hook, /findHarnessCli/);
});

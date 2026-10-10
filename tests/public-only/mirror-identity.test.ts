import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Mirror-side backstop for a bad promote.
 *
 * A private-first promote copies this repo's files from a checkout that names
 * itself differently. These checks read this repo's own manifests and its own
 * plugin/skills/ listing, so they fail on any constant or skill list that
 * drifted to the private values, whatever route it arrived by. Nothing here
 * hard-codes the private names: the basis is what this repo says it is.
 */
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const readJson = async (rel: string) =>
  JSON.parse(await fs.readFile(path.join(repo, rel), "utf8"));

/** `owner/repo` of a GitHub URL. */
function githubSlug(url: string): string {
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?]|$)/.exec(url);
  assert.ok(m, `not a GitHub URL: ${url}`);
  return `${m[1]}/${m[2]}`;
}

test("install-kit identity constants match this repo's own manifests", async () => {
  const pkg = await readJson("package.json");
  const market = await readJson(".claude-plugin/marketplace.json");
  const slug = githubSlug(pkg.repository.url);
  const kit = await fs.readFile(path.join(repo, "src", "cli", "install-kit.ts"), "utf8");

  const value = (name: string): string => {
    const m = new RegExp(`const ${name} = \`?"?([^"\`\\n]*)`).exec(kit);
    assert.ok(m, `install-kit.ts has no ${name}`);
    return m[1];
  };

  // An install points at the repo it was published from, never another one.
  assert.equal(value("CLAUDE_GITHUB_REPO"), slug);
  assert.match(
    kit,
    new RegExp(`const OPENCODE_PLUGIN_GIT_REMOTE = .*github\\.com/${slug}\\.git`),
    `OPENCODE_PLUGIN_GIT_REMOTE must clone ${slug}`,
  );
  // The marketplace this installer writes is the one this repo publishes.
  assert.equal(value("CLAUDE_MARKETPLACE_NAME"), market.name);
  // The private tree migrates away from a marketplace with this repo's name.
  // That migration deletes the live entry here, so it must never arrive.
  assert.doesNotMatch(
    kit,
    /LEGACY_CLAUDE_MARKETPLACE_NAME/,
    "install-kit.ts carries the private legacy-marketplace migration",
  );
});

test("no file in this mirror points installs at a different repository", async () => {
  const pkg = await readJson("package.json");
  const slug = githubSlug(pkg.repository.url);
  const owner = slug.split("/")[0];
  // The anchor. Both checkouts publish the same package name, so a promote
  // cannot move it; the repository this package ships from is named after it.
  assert.equal(slug.split("/")[1], pkg.name, "package.json names another repository");
  const files = [
    "package.json",
    ".claude-plugin/marketplace.json",
    "plugin/.claude-plugin/plugin.json",
    "src/cli/install-kit.ts",
    "src/cli/cursor-github-plugin.ts",
    "plugin/scripts/github-refresh.mjs",
  ];
  const other = new RegExp(`github\\.com[/:]${owner}/(?!${slug.split("/")[1]}\\b)[\\w.-]+`, "g");
  for (const rel of files) {
    const body = await fs.readFile(path.join(repo, rel), "utf8");
    assert.deepEqual([...new Set(body.match(other) ?? [])], [], `${rel} names another repository`);
  }
});

test("EXTRA_SKILLS names only skills this mirror ships", async () => {
  const onDisk = new Set(
    (await fs.readdir(path.join(repo, "plugin", "skills"), { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name),
  );
  const source = await fs.readFile(
    path.join(repo, "tests", "plugin-extra-skills.test.ts"),
    "utf8",
  );
  const block = /const EXTRA_SKILLS = \[([\s\S]*?)\] as const/.exec(source);
  assert.ok(block, "plugin-extra-skills.test.ts has no EXTRA_SKILLS list");
  const named = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(named.length > 0);
  assert.deepEqual(
    named.filter((name) => !onDisk.has(name)),
    [],
    "EXTRA_SKILLS names a skill absent from plugin/skills/",
  );
});

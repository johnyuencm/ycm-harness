import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  legacyStateNeedsRename,
  migrateRenameCommandHint,
  renameHarnessDirs,
} from "../src/migration/rename.ts";
import { HARNESS_DIR_NAME, LEGACY_HARNESS_DIR_NAME, CLI_NAME } from "../src/branding.ts";

async function tmpRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

describe("migrate rename", () => {
  it("renames project legacy dir when new is missing", async () => {
    const root = await tmpRoot("ycm-rename-proj-");
    await fs.mkdir(path.join(root, LEGACY_HARNESS_DIR_NAME));
    await fs.writeFile(path.join(root, LEGACY_HARNESS_DIR_NAME, "state.json"), "{}");

    const result = await renameHarnessDirs({
      projectRoot: root,
      home: await tmpRoot("ycm-rename-home-empty-"),
      project: true,
      user: false,
    });

    assert.equal(result.results[0]!.action, "renamed");
    assert.equal(await fs.access(path.join(root, HARNESS_DIR_NAME)).then(() => true, () => false), true);
    assert.equal(await fs.access(path.join(root, LEGACY_HARNESS_DIR_NAME)).then(() => true, () => false), false);
    assert.ok(result.postHints.some((h) => h.includes(`${CLI_NAME} install --user --force`)));
  });

  it("renames user legacy dir when new is missing", async () => {
    const home = await tmpRoot("ycm-rename-user-");
    await fs.mkdir(path.join(home, LEGACY_HARNESS_DIR_NAME));

    const result = await renameHarnessDirs({
      projectRoot: await tmpRoot("ycm-rename-proj-empty-"),
      home,
      project: false,
      user: true,
    });

    assert.equal(result.results[0]!.action, "renamed");
    assert.equal(await fs.access(path.join(home, HARNESS_DIR_NAME)).then(() => true, () => false), true);
  });

  it("errors when both dirs exist without --force", async () => {
    const root = await tmpRoot("ycm-rename-both-");
    await fs.mkdir(path.join(root, LEGACY_HARNESS_DIR_NAME));
    await fs.mkdir(path.join(root, HARNESS_DIR_NAME));

    await assert.rejects(
      () =>
        renameHarnessDirs({
          projectRoot: root,
          project: true,
          user: false,
        }),
      /both .* exist/,
    );
  });

  it("force keeps new and leaves legacy when both exist", async () => {
    const root = await tmpRoot("ycm-rename-force-");
    await fs.mkdir(path.join(root, LEGACY_HARNESS_DIR_NAME));
    await fs.mkdir(path.join(root, HARNESS_DIR_NAME));

    const result = await renameHarnessDirs({
      projectRoot: root,
      project: true,
      user: false,
      force: true,
    });

    assert.equal(result.results[0]!.action, "force_keep_both");
    assert.equal(await fs.access(path.join(root, LEGACY_HARNESS_DIR_NAME)).then(() => true, () => false), true);
    assert.equal(await fs.access(path.join(root, HARNESS_DIR_NAME)).then(() => true, () => false), true);
  });

  it("reports already_new when only new dir exists", async () => {
    const root = await tmpRoot("ycm-rename-new-");
    await fs.mkdir(path.join(root, HARNESS_DIR_NAME));

    const result = await renameHarnessDirs({
      projectRoot: root,
      project: true,
      user: false,
    });

    assert.equal(result.results[0]!.action, "already_new");
  });

  it("defaults to both scopes when neither flag set", async () => {
    const root = await tmpRoot("ycm-rename-default-proj-");
    const home = await tmpRoot("ycm-rename-default-home-");
    await fs.mkdir(path.join(root, LEGACY_HARNESS_DIR_NAME));
    await fs.mkdir(path.join(home, LEGACY_HARNESS_DIR_NAME));

    const result = await renameHarnessDirs({ projectRoot: root, home });

    assert.equal(result.results.length, 2);
    assert.ok(result.results.every((r) => r.action === "renamed"));
  });

  it("doctor hint uses migrate rename command", async () => {
    const root = await tmpRoot("ycm-rename-doctor-");
    const home = await tmpRoot("ycm-rename-doctor-home-");
    await fs.mkdir(path.join(root, LEGACY_HARNESS_DIR_NAME));

    const needs = await legacyStateNeedsRename(root, home);
    assert.equal(needs.project, true);
    assert.equal(needs.user, false);
    assert.equal(migrateRenameCommandHint(needs), `${CLI_NAME} migrate rename --project`);
  });
});

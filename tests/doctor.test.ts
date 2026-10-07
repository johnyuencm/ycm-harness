import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { createContext } from "../src/cli/context.js";
import { registerDoctor } from "../src/cli/commands/doctor.js";
import { auditInstall, runClientSync } from "../src/cli/install-kit.js";
import { cleanup, tempProject, withTempUserHome } from "./helpers.js";

async function runDoctor(cwd: string, args: string[]): Promise<Record<string, unknown>> {
  const jsons: unknown[] = [];
  const program = new Command();
  program.exitOverride();
  registerDoctor(program, createContext(cwd), {
    out() {},
    err() {},
    json(value: unknown) {
      jsons.push(value);
    },
  });
  await program.parseAsync(["doctor", ...args, "--json"], { from: "user" });
  return jsons.at(-1) as Record<string, unknown>;
}

test("auditInstall reports missing user skills in an empty home", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-");
    try {
      const { needs_sync, audit } = await auditInstall(project);
      assert.equal(needs_sync, true);
      assert.ok(audit.user_skill.some((f) => f.status === "missing"));
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor reports only global health, the same from any cwd", async () => {
  await withTempUserHome(async () => {
    const first = await tempProject("ch-doctor-a-");
    const second = await tempProject("ch-doctor-b-");
    try {
      await runClientSync({ cursor: true, force: true });
      const a = await runDoctor(first, []);
      const b = await runDoctor(second, []);
      assert.equal(a.needs_sync, false);
      assert.deepEqual(a.audit, b.audit);
      for (const key of ["project_skill_gaps", "project_rule_status"]) {
        assert.equal(key in a, false, `doctor must not report ${key}`);
      }
    } finally {
      await cleanup(first);
      await cleanup(second);
    }
  });
});

test("doctor reports leftover project copies and --repair removes only harness-managed paths", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-leftovers-");
    try {
      await runClientSync({ cursor: true, force: true });
      const cursor = path.join(project, ".cursor");
      const leftovers = [
        path.join(cursor, "agents", "ycm-harness"),
        path.join(cursor, "rules", "ycm-harness.mdc"),
        path.join(cursor, "skills", "llm-wiki"),
        path.join(cursor, "skills", "ycm-harness"),
      ];
      const foreign = [
        path.join(cursor, "agents", "team-agent.md"),
        path.join(cursor, "rules", "team.mdc"),
        path.join(cursor, "skills", "team-skill", "SKILL.md"),
        // Vendor skills the user may install per project; harness never owns these here.
        path.join(cursor, "skills", "tdd", "SKILL.md"),
      ];
      for (const file of [
        path.join(leftovers[0]!, "tech_lead.md"),
        leftovers[1]!,
        path.join(leftovers[2]!, "SKILL.md"),
        path.join(leftovers[3]!, "SKILL.md"),
        ...foreign,
      ]) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, "old copy", "utf8");
      }

      const before = await runDoctor(project, []);
      assert.equal(before.needs_sync, true);
      assert.deepEqual(before.project_leftovers, leftovers);

      const after = await runDoctor(project, ["--repair"]);
      assert.equal(after.repaired, true);
      assert.equal(after.needs_sync, false);
      assert.deepEqual(after.project_leftovers, []);
      for (const leftover of leftovers) {
        await assert.rejects(fs.stat(leftover), { code: "ENOENT" });
      }
      for (const file of foreign) {
        assert.equal(await fs.readFile(file, "utf8"), "old copy");
      }
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor --repair never deletes through linked project dirs", async () => {
  await withTempUserHome(async (home) => {
    const project = await tempProject("ch-doctor-links-");
    try {
      await runClientSync({ cursor: true, force: true });
      const cursor = path.join(project, ".cursor");
      await fs.mkdir(cursor, { recursive: true });
      // A linked skills dir points at the global skills: no leftovers there.
      await fs.symlink(path.join(home, ".cursor", "skills"), path.join(cursor, "skills"), "junction");
      // A linked managed dir is a leftover: remove the link, keep its target.
      await fs.mkdir(path.join(cursor, "agents"));
      await fs.symlink(
        path.join(home, ".cursor", "agents", "ycm-harness"),
        path.join(cursor, "agents", "ycm-harness"),
        "junction",
      );
      const report = await runDoctor(project, ["--repair"]);
      assert.deepEqual(report.project_leftovers, []);
      await assert.rejects(fs.lstat(path.join(cursor, "agents", "ycm-harness")), { code: "ENOENT" });
      await fs.stat(path.join(home, ".cursor", "skills", "ycm-harness", "SKILL.md"));
      await fs.stat(path.join(home, ".cursor", "agents", "ycm-harness", "tech_lead.md"));
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor --repair run from the home directory keeps the global installs", async () => {
  await withTempUserHome(async (home) => {
    await runClientSync({ cursor: true, force: true });
    // In the home directory, <cwd>/.cursor is the global Cursor home itself.
    await fs.rm(path.join(home, ".cursor", "agents", "ycm-harness", "tech_lead.md"));
    const report = await runDoctor(home, ["--repair"]);
    assert.deepEqual(report.project_leftovers, []);
    assert.equal(report.needs_sync, false);
    await fs.stat(path.join(home, ".cursor", "skills", "ycm-harness", "SKILL.md"));
    await fs.stat(path.join(home, ".cursor", "agents", "ycm-harness", "tech_lead.md"));
  });
});

test("doctor --repair repairs global installs and writes nothing into the project", async () => {
  await withTempUserHome(async (home) => {
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    const project = await tempProject("ch-doctor-repair-");
    const priorCodex = process.env.CODEX_CLI_PATH;
    process.env.CODEX_CLI_PATH = "missing-codex-cli-for-test";
    try {
      const report = await runDoctor(project, ["--repair"]);
      assert.equal(report.repaired, true);
      assert.equal(report.needs_sync, false);
      const codexPlugin = path.join(home, ".codex", "marketplaces", "ycm-harness", "plugins", "ycm-harness", ".codex-plugin", "plugin.json");
      await fs.stat(codexPlugin);
      await assert.rejects(fs.stat(path.join(project, ".cursor")), { code: "ENOENT" });
    } finally {
      if (priorCodex === undefined) delete process.env.CODEX_CLI_PATH;
      else process.env.CODEX_CLI_PATH = priorCodex;
      await cleanup(project);
    }
  });
});

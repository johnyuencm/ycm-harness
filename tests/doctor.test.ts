import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { createContext } from "../src/cli/context.js";
import { registerDoctor } from "../src/cli/commands/doctor.js";
import { auditInstall } from "../src/cli/install-kit.js";
import { withTempUserHome } from "./helpers.js";

async function tempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(process.env.TEMP ?? process.env.TMP ?? "C:\\tmp", prefix));
}

test("auditInstall detects missing project skill files", async () => {
  await withTempUserHome(async () => {
    const project = await tempDir("ch-doctor-");
    try {
      const { needs_sync, audit } = await auditInstall(project);
      assert.equal(needs_sync, true);
      assert.ok(audit.project_skill.some((f) => f.status === "missing"));
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});

test("doctor --repair clears needs_sync in a temp project", async () => {
  await withTempUserHome(async (home) => {
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    const project = await tempDir("ch-doctor-repair-");
    const stdout: string[] = [];
    const jsons: unknown[] = [];
    const ctx = createContext(project);
    const out = {
      out(t: string) {
        stdout.push(t);
      },
      err() { },
      json(v: unknown) {
        jsons.push(v);
      },
    };
    const program = new Command();
    program.exitOverride();
    registerDoctor(program, ctx, out);

    try {
      await program.parseAsync(["doctor", "--repair"], { from: "user" });
      const after = await auditInstall(project);
      assert.equal(after.needs_sync, false);
      const rule = path.join(project, ".cursor", "rules", "ycm-harness.mdc");
      const codexPlugin = path.join(home, ".codex", "marketplaces", "ycm-harness", "plugins", "ycm-harness", ".codex-plugin", "plugin.json");
      assert.ok(await fs.stat(rule).then(() => true).catch(() => false));
      assert.ok(await fs.stat(codexPlugin).then(() => true).catch(() => false));
    } finally {
      await fs.rm(project, { recursive: true, force: true });
    }
  });
});

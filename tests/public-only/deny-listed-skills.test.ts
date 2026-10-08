import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { createContext } from "../../src/cli/context.js";
import { registerDoctor } from "../../src/cli/commands/doctor.js";
import { packageRoot, runClientSync } from "../../src/cli/install-kit.js";
import { cleanup, tempProject, withTempUserHome } from "../helpers.js";

function pluginRoot(): string {
  return path.join(packageRoot(), "plugin");
}

const DENY_LISTED_SKILLS = [
  "building-ios-ipa-sideloadly",
  "deploying-to-mumu-emulator",
  "setup-autonomy-p1-p7",
] as const;

async function plantCopy(dest: string, src: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
}

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

test("doctor keeps same-named project folders for deny-listed skills absent from plugin/skills", async () => {
  for (const name of DENY_LISTED_SKILLS) {
    await assert.rejects(fs.stat(path.join(pluginRoot(), "skills", name)), { code: "ENOENT" });
  }
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-deny-listed-");
    try {
      await runClientSync({ cursor: true, force: true });
      const leftoverPaths = DENY_LISTED_SKILLS.map((name) =>
        path.join(project, ".cursor", "skills", name),
      );
      for (const leftover of leftoverPaths) {
        await fs.mkdir(leftover, { recursive: true });
        await fs.writeFile(path.join(leftover, "SKILL.md"), "# project local\n", "utf8");
      }
      const identical = path.join(project, ".cursor", "skills", "llm-wiki");
      await plantCopy(identical, path.join(pluginRoot(), "skills", "llm-wiki"));

      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [identical]);
      assert.deepEqual([...before.project_leftovers_kept as string[]].sort(), [...leftoverPaths].sort());
      assert.equal(before.needs_sync, true);

      const after = await runDoctor(project, ["--repair"]);
      assert.deepEqual(after.project_leftovers, []);
      assert.deepEqual([...after.project_leftovers_kept as string[]].sort(), [...leftoverPaths].sort());
      for (const leftover of leftoverPaths) {
        assert.equal(await fs.readFile(path.join(leftover, "SKILL.md"), "utf8"), "# project local\n");
      }
      await assert.rejects(fs.stat(identical), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import fsSync, { promises as fs } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Command } from "commander";
import { createContext } from "../src/cli/context.js";
import { registerDoctor } from "../src/cli/commands/doctor.js";
import {
  auditInstall,
  leftoverMatchesHarnessCopy,
  packageRoot,
  runClientSync,
} from "../src/cli/install-kit.js";
import { cleanup, tempProject, withTempUserHome } from "./helpers.js";

const execFileAsync = promisify(execFile);

/** Release a blocked FIFO reader so a timed-out leftover compare cannot hang the file. */
function registerFifoUnblock(t: TestContext, fifoPath: string): void {
  let forced = false;
  const unblock = (): void => {
    try {
      const fd = fsSync.openSync(
        fifoPath,
        fsSync.constants.O_WRONLY | fsSync.constants.O_NONBLOCK,
      );
      fsSync.closeSync(fd);
    } catch {
      /* ENXIO if no blocked reader; ENOENT if already cleaned up */
    }
  };
  // 9s is below the 10s test timeout and above the 8s promptness assert, so a
  // hung open() fails that assert (or the timeout) instead of deadlocking
  // withTempUserHome.
  const timer = setTimeout(() => {
    forced = true;
    unblock();
  }, 9_000);
  t.after(() => {
    clearTimeout(timer);
    unblock();
    if (forced) {
      throw new Error(`${fifoPath} had to be force-unblocked: doctor opened the FIFO`);
    }
  });
}

async function skipUnlessProbeEacces(
  t: TestContext,
  probe: () => Promise<unknown>,
): Promise<boolean> {
  try {
    await probe();
    t.skip("EACCES cannot be simulated (root or non-POSIX fs)");
    return false;
  } catch (err) {
    assert.equal((err as NodeJS.ErrnoException).code, "EACCES");
    return true;
  }
}

function pluginRoot(): string {
  return path.join(packageRoot(), "plugin");
}

async function plantCopy(dest: string, src: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.cp(src, dest, { recursive: true });
}

async function runDoctorCommand(
  cwd: string,
  args: string[],
  jsonMode: boolean,
): Promise<{ payload?: Record<string, unknown>; lines: string[]; exitCode: number }> {
  const jsons: unknown[] = [];
  const lines: string[] = [];
  const program = new Command();
  program.exitOverride();
  registerDoctor(program, createContext(cwd), {
    out(line: string) {
      lines.push(line);
    },
    err() {},
    json(value: unknown) {
      jsons.push(value);
    },
  });
  let exitCode = 0;
  try {
    await program.parseAsync(
      jsonMode ? ["doctor", ...args, "--json"] : ["doctor", ...args],
      { from: "user" },
    );
  } catch (err) {
    const code = (err as { exitCode?: unknown }).exitCode;
    if (typeof code !== "number") throw err;
    exitCode = code;
  }
  return {
    payload: jsons.at(-1) as Record<string, unknown> | undefined,
    lines,
    exitCode,
  };
}

async function runDoctor(cwd: string, args: string[]): Promise<Record<string, unknown>> {
  const { payload, exitCode } = await runDoctorCommand(cwd, args, true);
  assert.equal(exitCode, 0, `doctor ${args.join(" ")} --json exited ${exitCode}`);
  assert.ok(payload, "doctor --json produced no payload");
  return payload;
}

async function runDoctorText(cwd: string, args: string[]): Promise<string[]> {
  const { lines, exitCode } = await runDoctorCommand(cwd, args, false);
  assert.equal(exitCode, 0, `doctor ${args.join(" ")} exited ${exitCode}`);
  return lines;
}

function isRootUser(): boolean {
  return typeof process.getuid === "function" && process.getuid() === 0;
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
      assert.deepEqual(a.repair_errors, []);
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
      const plugin = pluginRoot();
      await plantCopy(leftovers[0]!, path.join(plugin, "agents"));
      await plantCopy(leftovers[1]!, path.join(plugin, "rules", "ycm-harness.mdc"));
      await plantCopy(leftovers[2]!, path.join(plugin, "skills", "llm-wiki"));
      await plantCopy(leftovers[3]!, path.join(plugin, "skills", "ycm-harness-work"));
      for (const file of foreign) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, "old copy", "utf8");
      }

      const before = await runDoctor(project, []);
      assert.equal(before.needs_sync, true);
      assert.deepEqual(before.project_leftovers, leftovers);
      assert.deepEqual(before.project_leftovers_kept, []);

      const after = await runDoctor(project, ["--repair"]);
      assert.equal(after.repaired, true);
      assert.equal(after.needs_sync, false);
      assert.deepEqual(after.repair_errors, []);
      assert.deepEqual(after.project_leftovers, []);
      assert.deepEqual(after.project_leftovers_kept, []);
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

test("doctor --repair removes an identical leftover skill copy", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-identical-leftover-");
    try {
      await runClientSync({ cursor: true, force: true });
      const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
      await plantCopy(leftover, path.join(pluginRoot(), "skills", "llm-wiki"));

      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [leftover]);
      assert.deepEqual(before.project_leftovers_kept, []);
      assert.equal(before.needs_sync, true);

      const after = await runDoctor(project, ["--repair"]);
      assert.equal(after.repaired, true);
      assert.equal(after.needs_sync, false);
      assert.deepEqual(after.project_leftovers, []);
      await assert.rejects(fs.stat(leftover), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor keeps a same-named project skill whose content differs from the harness copy", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-kept-skill-");
    try {
      await runClientSync({ cursor: true, force: true });
      const leftover = path.join(project, ".cursor", "skills", "create-skill");
      const identical = path.join(project, ".cursor", "skills", "llm-wiki");
      await fs.mkdir(leftover, { recursive: true });
      await fs.writeFile(path.join(leftover, "SKILL.md"), "# project create-skill\n", "utf8");
      const keptOnly = await runDoctor(project, []);
      assert.deepEqual(keptOnly.project_leftovers, []);
      assert.deepEqual(keptOnly.project_leftovers_kept, [leftover]);
      // Kept paths must not keep needs_sync true, or --repair can never clear.
      assert.equal(keptOnly.needs_sync, false);

      await plantCopy(identical, path.join(pluginRoot(), "skills", "llm-wiki"));

      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [identical]);
      assert.deepEqual(before.project_leftovers_kept, [leftover]);
      assert.equal(before.needs_sync, true);

      const lines = await runDoctorText(project, []);
      assert.ok(
        lines.includes(
          `project leftover kept (differs from the harness copy): ${leftover} (inspect it; delete it manually if it is an old harness copy)`,
        ),
      );

      const after = await runDoctor(project, ["--repair"]);
      assert.equal(after.repaired, true);
      assert.equal(after.needs_sync, false);
      assert.deepEqual(after.project_leftovers, []);
      assert.deepEqual(after.project_leftovers_kept, [leftover]);
      assert.equal(await fs.readFile(path.join(leftover, "SKILL.md"), "utf8"), "# project create-skill\n");
      await assert.rejects(fs.stat(identical), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor keeps a harness leftover that has one extra user file", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-extra-file-");
    try {
      await runClientSync({ cursor: true, force: true });
      const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
      const identical = path.join(project, ".cursor", "agents", "ycm-harness");
      await plantCopy(leftover, path.join(pluginRoot(), "skills", "llm-wiki"));
      await fs.writeFile(path.join(leftover, "USER-NOTES.md"), "keep me\n", "utf8");
      await plantCopy(identical, path.join(pluginRoot(), "agents"));

      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [identical]);
      assert.deepEqual(before.project_leftovers_kept, [leftover]);
      assert.equal(before.needs_sync, true);

      const after = await runDoctor(project, ["--repair"]);
      assert.equal(after.needs_sync, false);
      assert.deepEqual(after.project_leftovers_kept, [leftover]);
      assert.equal(await fs.readFile(path.join(leftover, "USER-NOTES.md"), "utf8"), "keep me\n");
      await fs.stat(path.join(leftover, "SKILL.md"));
      await assert.rejects(fs.stat(identical), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor keeps an edited rules/ycm-harness.mdc leftover", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-edited-rule-");
    try {
      await runClientSync({ cursor: true, force: true });
      const leftover = path.join(project, ".cursor", "rules", "ycm-harness.mdc");
      const identical = path.join(project, ".cursor", "skills", "llm-wiki");
      await plantCopy(leftover, path.join(pluginRoot(), "rules", "ycm-harness.mdc"));
      await fs.appendFile(leftover, "\n# project edit\n", "utf8");
      await plantCopy(identical, path.join(pluginRoot(), "skills", "llm-wiki"));

      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [identical]);
      assert.deepEqual(before.project_leftovers_kept, [leftover]);
      assert.equal(before.needs_sync, true);

      const after = await runDoctor(project, ["--repair"]);
      assert.equal(after.needs_sync, false);
      assert.deepEqual(after.project_leftovers_kept, [leftover]);
      assert.match(await fs.readFile(leftover, "utf8"), /# project edit/);
      await assert.rejects(fs.stat(identical), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor --repair removes a leftover that differs only by CRLF", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-crlf-leftover-");
    try {
      await runClientSync({ cursor: true, force: true });
      const leftover = path.join(project, ".cursor", "rules", "ycm-harness.mdc");
      const source = await fs.readFile(path.join(pluginRoot(), "rules", "ycm-harness.mdc"));
      const lf = source.toString("utf8").replace(/\r\n/g, "\n");
      const crlf = lf.replace(/\n/g, "\r\n");
      await fs.mkdir(path.dirname(leftover), { recursive: true });
      await fs.writeFile(leftover, source.includes(0x0d) ? lf : crlf);

      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [leftover]);
      assert.deepEqual(before.project_leftovers_kept, []);

      const after = await runDoctor(project, ["--repair"]);
      assert.deepEqual(after.project_leftovers, []);
      await assert.rejects(fs.stat(leftover), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor keeps a leftover with an unreadable nested dir and does not crash", async (t) => {
  if (isRootUser()) {
    t.skip("chmod 000 is ineffective as root");
    return;
  }
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-eacces-leftover-");
    const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
    const locked = path.join(leftover, "agents");
    const identical = path.join(project, ".cursor", "agents", "ycm-harness");
    try {
      await runClientSync({ cursor: true, force: true });
      await plantCopy(leftover, path.join(pluginRoot(), "skills", "llm-wiki"));
      await plantCopy(identical, path.join(pluginRoot(), "agents"));
      await fs.chmod(locked, 0o000);
      if (!(await skipUnlessProbeEacces(t, () => fs.readdir(locked)))) return;
      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [identical]);
      assert.deepEqual(before.project_leftovers_kept, [leftover]);
      const after = await runDoctor(project, ["--repair"]);
      assert.deepEqual(after.project_leftovers, []);
      assert.deepEqual(after.project_leftovers_kept, [leftover]);
      await fs.stat(path.join(leftover, "SKILL.md"));
      await assert.rejects(fs.stat(identical), { code: "ENOENT" });
    } finally {
      await fs.chmod(locked, 0o755).catch(() => undefined);
      await cleanup(project);
    }
  });
});

test("doctor keeps a leftover whose SKILL.md is a FIFO without hanging", { timeout: 10_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("mkfifo is not available on win32");
    return;
  }
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-fifo-leftover-");
    const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
    const fifo = path.join(leftover, "SKILL.md");
    const identical = path.join(project, ".cursor", "agents", "ycm-harness");
    try {
      await runClientSync({ cursor: true, force: true });
      await plantCopy(leftover, path.join(pluginRoot(), "skills", "llm-wiki"));
      await plantCopy(identical, path.join(pluginRoot(), "agents"));
      await fs.rm(fifo);
      await execFileAsync("mkfifo", [fifo]);
      registerFifoUnblock(t, fifo);
      const started = Date.now();
      const before = await runDoctor(project, []);
      assert.ok(Date.now() - started < 8_000, "FIFO leftover compare must return promptly");
      assert.deepEqual(before.project_leftovers, [identical]);
      assert.deepEqual(before.project_leftovers_kept, [leftover]);
      const after = await runDoctor(project, ["--repair"]);
      assert.deepEqual(after.project_leftovers, []);
      assert.deepEqual(after.project_leftovers_kept, [leftover]);
      const st = await fs.lstat(fifo);
      assert.equal(st.isFIFO(), true);
      await assert.rejects(fs.stat(identical), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor --repair removes a truncated subset leftover copy", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-truncated-leftover-");
    try {
      await runClientSync({ cursor: true, force: true });
      const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
      await plantCopy(leftover, path.join(pluginRoot(), "skills", "llm-wiki"));
      await fs.rm(path.join(leftover, "agents", "openai.yaml"));

      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [leftover]);
      assert.deepEqual(before.project_leftovers_kept, []);

      const after = await runDoctor(project, ["--repair"]);
      assert.deepEqual(after.project_leftovers, []);
      await assert.rejects(fs.stat(leftover), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor --repair removes a leftover that is itself a symlink and leaves the target intact", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-symlink-leftover-");
    try {
      await runClientSync({ cursor: true, force: true });
      const target = path.join(project, "real-llm-wiki");
      const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
      await plantCopy(target, path.join(pluginRoot(), "skills", "llm-wiki"));
      await fs.mkdir(path.dirname(leftover), { recursive: true });
      await fs.symlink(target, leftover, "junction");

      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [leftover]);
      assert.deepEqual(before.project_leftovers_kept, []);

      const after = await runDoctor(project, ["--repair"]);
      assert.deepEqual(after.project_leftovers, []);
      await assert.rejects(fs.lstat(leftover), { code: "ENOENT" });
      await fs.stat(path.join(target, "SKILL.md"));
      await fs.stat(path.join(target, "agents", "openai.yaml"));
    } finally {
      await cleanup(project);
    }
  });
});

test("leftover file compare is strict when either buffer contains NUL", async () => {
  const dir = await tempProject("ch-leftover-nul-");
  try {
    const expected = path.join(dir, "expected.bin");
    const actual = path.join(dir, "actual.bin");
    await fs.writeFile(expected, Buffer.from([0x41, 0x0d, 0x0a, 0x00, 0x42]));
    await fs.writeFile(actual, Buffer.from([0x41, 0x0a, 0x00, 0x42]));
    assert.equal(await leftoverMatchesHarnessCopy(actual, expected), false);
    await fs.writeFile(actual, Buffer.from([0x41, 0x0d, 0x0a, 0x00, 0x42]));
    assert.equal(await leftoverMatchesHarnessCopy(actual, expected), true);
    await fs.writeFile(expected, Buffer.from("a\r\nb"));
    await fs.writeFile(actual, Buffer.from("a\nb"));
    assert.equal(await leftoverMatchesHarnessCopy(actual, expected), true);
  } finally {
    await cleanup(dir);
  }
});

test("doctor --repair removes a leftover containing a symlink leaf and leaves the target intact", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-inner-symlink-leftover-");
    try {
      await runClientSync({ cursor: true, force: true });
      const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
      const skillTarget = path.join(project, "outside-SKILL.md");
      await plantCopy(leftover, path.join(pluginRoot(), "skills", "llm-wiki"));
      await fs.rename(path.join(leftover, "SKILL.md"), skillTarget);
      await fs.symlink(skillTarget, path.join(leftover, "SKILL.md"));

      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [leftover]);
      assert.deepEqual(before.project_leftovers_kept, []);

      const after = await runDoctor(project, ["--repair"]);
      assert.deepEqual(after.project_leftovers, []);
      await assert.rejects(fs.lstat(leftover), { code: "ENOENT" });
      assert.equal(
        await fs.readFile(skillTarget, "utf8"),
        await fs.readFile(path.join(pluginRoot(), "skills", "llm-wiki", "SKILL.md"), "utf8"),
      );
    } finally {
      await cleanup(project);
    }
  });
});

test("audit reports stale when a global installed file differs from source only by CRLF", async () => {
  await withTempUserHome(async (home) => {
    const project = await tempProject("ch-doctor-audit-crlf-");
    try {
      await runClientSync({ cursor: true, force: true });
      const healthy = await auditInstall(project);
      assert.equal(healthy.needs_sync, false);
      const installed = path.join(home, ".cursor", "skills", "llm-wiki", "SKILL.md");
      const source = await fs.readFile(path.join(pluginRoot(), "skills", "llm-wiki", "SKILL.md"));
      const lf = source.toString("utf8").replace(/\r\n/g, "\n");
      const crlf = lf.replace(/\n/g, "\r\n");
      const flipped = source.includes(0x0d) ? lf : crlf;
      assert.notEqual(flipped, source.toString("utf8"), "fixture must actually differ by CRLF");
      await fs.writeFile(installed, flipped);
      const { needs_sync, audit } = await auditInstall(project);
      const item = audit.user_skill.find((entry) => entry.path === installed);
      assert.ok(item, "audit must include the CRLF-divergent global skill file");
      assert.equal(item.status, "stale");
      assert.equal(needs_sync, true);
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor keeps a leftover with an inner symlink to a FIFO without hanging", { timeout: 10_000 }, async (t) => {
  if (process.platform === "win32") {
    t.skip("mkfifo is not available on win32");
    return;
  }
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-symlink-fifo-");
    const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
    const fifo = path.join(project, "pipe.fifo");
    const identical = path.join(project, ".cursor", "agents", "ycm-harness");
    try {
      await runClientSync({ cursor: true, force: true });
      await plantCopy(leftover, path.join(pluginRoot(), "skills", "llm-wiki"));
      await plantCopy(identical, path.join(pluginRoot(), "agents"));
      await execFileAsync("mkfifo", [fifo]);
      registerFifoUnblock(t, fifo);
      await fs.rm(path.join(leftover, "SKILL.md"));
      await fs.symlink(fifo, path.join(leftover, "SKILL.md"));
      const started = Date.now();
      const before = await runDoctor(project, []);
      assert.ok(Date.now() - started < 8_000, "symlink-to-FIFO leftover compare must return promptly");
      assert.deepEqual(before.project_leftovers, [identical]);
      assert.deepEqual(before.project_leftovers_kept, [leftover]);
      const after = await runDoctor(project, ["--repair"]);
      assert.deepEqual(after.project_leftovers, []);
      assert.deepEqual(after.project_leftovers_kept, [leftover]);
      await fs.lstat(path.join(leftover, "SKILL.md"));
      await assert.rejects(fs.stat(identical), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor keeps a leftover with an inner symlink to a directory", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-symlink-dir-");
    const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
    const dirTarget = path.join(project, "outside-dir");
    const identical = path.join(project, ".cursor", "agents", "ycm-harness");
    try {
      await runClientSync({ cursor: true, force: true });
      await plantCopy(leftover, path.join(pluginRoot(), "skills", "llm-wiki"));
      await plantCopy(identical, path.join(pluginRoot(), "agents"));
      await fs.mkdir(dirTarget);
      await fs.rm(path.join(leftover, "SKILL.md"));
      await fs.symlink(dirTarget, path.join(leftover, "SKILL.md"));
      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [identical]);
      assert.deepEqual(before.project_leftovers_kept, [leftover]);
      const after = await runDoctor(project, ["--repair"]);
      assert.deepEqual(after.project_leftovers, []);
      assert.deepEqual(after.project_leftovers_kept, [leftover]);
      const st = await fs.lstat(path.join(leftover, "SKILL.md"));
      assert.equal(st.isSymbolicLink(), true);
      await assert.rejects(fs.stat(identical), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor keeps a leftover with a dangling inner symlink", async () => {
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-dangling-symlink-");
    const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
    const identical = path.join(project, ".cursor", "agents", "ycm-harness");
    try {
      await runClientSync({ cursor: true, force: true });
      await plantCopy(leftover, path.join(pluginRoot(), "skills", "llm-wiki"));
      await plantCopy(identical, path.join(pluginRoot(), "agents"));
      await fs.rm(path.join(leftover, "SKILL.md"));
      await fs.symlink(path.join(project, "missing-target"), path.join(leftover, "SKILL.md"));
      const before = await runDoctor(project, []);
      assert.deepEqual(before.project_leftovers, [identical]);
      assert.deepEqual(before.project_leftovers_kept, [leftover]);
      const after = await runDoctor(project, ["--repair"]);
      assert.deepEqual(after.project_leftovers, []);
      assert.deepEqual(after.project_leftovers_kept, [leftover]);
      const st = await fs.lstat(path.join(leftover, "SKILL.md"));
      assert.equal(st.isSymbolicLink(), true);
      await assert.rejects(fs.stat(identical), { code: "ENOENT" });
    } finally {
      await cleanup(project);
    }
  });
});

test("doctor keeps a leftover when a plugin source subdir is unreadable and does not crash", async (t) => {
  if (isRootUser()) {
    t.skip("chmod 000 is ineffective as root");
    return;
  }
  await withTempUserHome(async () => {
    const source = await tempProject("ch-doctor-unreadable-src-");
    const project = await tempProject("ch-doctor-unreadable-src-leftover-");
    const pluginLlm = path.join(pluginRoot(), "skills", "llm-wiki");
    const expected = path.join(source, "plugin", "skills", "llm-wiki");
    const leftover = path.join(project, ".cursor", "skills", "llm-wiki");
    const locked = path.join(expected, "agents");
    try {
      await runClientSync({ cursor: true, force: true });
      await plantCopy(expected, pluginLlm);
      await plantCopy(leftover, pluginLlm);
      await fs.chmod(locked, 0o000);
      if (!(await skipUnlessProbeEacces(t, () => fs.readdir(locked)))) return;
      const started = Date.now();
      let matched: boolean | undefined;
      let threw: unknown;
      try {
        matched = await leftoverMatchesHarnessCopy(leftover, expected);
      } catch (err) {
        threw = err;
      }
      assert.equal(threw, undefined, "unreadable plugin source must not crash leftover compare");
      assert.equal(matched, false);
      assert.ok(Date.now() - started < 8_000, "unreadable source compare must return promptly");
      await fs.stat(path.join(leftover, "SKILL.md"));
      const before = await runDoctor(project, []);
      assert.ok(
        (before.project_leftovers as string[]).includes(leftover) ||
          (before.project_leftovers_kept as string[]).includes(leftover),
        "doctor must still classify the leftover without crashing",
      );
    } finally {
      await fs.chmod(locked, 0o755).catch(() => undefined);
      await cleanup(source);
      await cleanup(project);
    }
  });
});

test("doctor --repair reports when a project leftover cannot be removed", async (t) => {
  if (isRootUser()) {
    t.skip("chmod 555 is ineffective as root");
    return;
  }
  await withTempUserHome(async () => {
    const project = await tempProject("ch-doctor-rm-eacces-");
    const leftover = path.join(project, ".cursor", "rules", "ycm-harness.mdc");
    const parent = path.dirname(leftover);
    try {
      await runClientSync({ cursor: true, force: true });
      await plantCopy(leftover, path.join(pluginRoot(), "rules", "ycm-harness.mdc"));
      await fs.chmod(parent, 0o555);
      if (
        !(await skipUnlessProbeEacces(t, () =>
          fs.rm(leftover, { recursive: true, force: true }),
        ))
      ) {
        return;
      }
      const { lines, exitCode: textExit } = await runDoctorCommand(
        project,
        ["--repair"],
        false,
      );
      assert.equal(textExit, 1);
      const report = lines.find((line) =>
        line.startsWith(`project leftover not removed: ${leftover} (`),
      );
      assert.ok(report, `expected leftover-not-removed line, got: ${lines.join("\n")}`);
      assert.match(report, /\([A-Z]+\)/);
      assert.equal(
        lines.some((line) => line === `project leftover removed: ${leftover}`),
        false,
      );
      await fs.stat(leftover);

      const { payload, exitCode } = await runDoctorCommand(
        project,
        ["--repair"],
        true,
      );
      assert.equal(exitCode, 1);
      assert.equal(payload?.repaired, true);
      assert.equal(payload?.needs_sync, true);
      assert.deepEqual(payload?.project_leftovers, [leftover]);
      const repairErrors = payload?.repair_errors as Array<{ path: string; code: string }>;
      assert.equal(repairErrors.length, 1);
      assert.equal(repairErrors[0]?.path, leftover);
      assert.match(repairErrors[0]?.code ?? "", /^[A-Z]+$/);
    } finally {
      await fs.chmod(parent, 0o755).catch(() => undefined);
      await cleanup(project);
    }
  });
});

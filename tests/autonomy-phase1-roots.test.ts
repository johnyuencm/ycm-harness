import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Command } from "commander";
import { createContext } from "../src/cli/context.js";
import { runCli } from "../src/cli/index.js";
import { packageRoot, runClientSync } from "../src/cli/install-kit.js";
import { registerDoctor } from "../src/cli/commands/doctor.js";

async function temp(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function exists(file: string): Promise<boolean> {
  return fs.stat(file).then(() => true).catch(() => false);
}

function output() {
  const jsons: unknown[] = [];
  return {
    jsons,
    out() { /* quiet */ },
    err() { /* quiet */ },
    json(value: unknown) { jsons.push(value); },
  };
}

test("global --cwd selects project state before context creation", async () => {
  const spaced = await temp("ch-p1-cwd-spaced-");
  const equals = await temp("ch-p1-cwd-equals-");
  const missing = path.join(os.tmpdir(), `ch-p1-missing-${Date.now()}`);
  try {
    assert.equal(await runCli(["--cwd", spaced, "init"]), 0);
    assert.equal(await runCli([`--cwd=${equals}`, "init"]), 0);
    assert.equal(await runCli(["--cwd", missing, "init"]), 1);
    assert.equal(await exists(path.join(spaced, ".ycm-harness", "state.json")), true);
    assert.equal(await exists(path.join(equals, ".ycm-harness", "state.json")), true);
    assert.equal(await exists(missing), false);
  } finally {
    await fs.rm(spaced, { recursive: true, force: true });
    await fs.rm(equals, { recursive: true, force: true });
  }
});

test("smoke run keeps its local --cwd separate from global project --cwd", async () => {
  const project = await temp("ch-p1-smoke-project-");
  const runDir = await temp("ch-p1-smoke-run-");
  try {
    assert.equal(await runCli(["--cwd", project, "init"]), 0);
    assert.equal(await runCli(["--cwd", project, "goal", "create", "Smoke cwd"]), 0);
    assert.equal(await runCli(["--cwd", project, "phase", "start", "explore"]), 0);
    const state = await createContext(project).store.readState();
    const activePhase = Object.values(state.phases).find((phase) => phase.status === "active");
    assert.ok(activePhase);
    const command = process.platform === "win32" ? "cd" : "pwd";
    assert.equal(await runCli([
      "--cwd", project, "smoke", "run", "--phase", activePhase.id,
      "--command", command, "--cwd", runDir,
    ]), 0);
    const after = await createContext(project).store.readState();
    const evidence = Object.values(after.smoke).at(-1);
    assert.equal(evidence?.actual?.trim(), runDir);
  } finally {
    await fs.rm(project, { recursive: true, force: true });
    await fs.rm(runDir, { recursive: true, force: true });
  }
});

test("client sync uses selected sourceRoot rather than accidental parent checkout", async () => {
  const home = await temp("ch-p1-sync-home-");
  const parent = await temp("ch-p1-sync-parent-");
  const selected = await temp("ch-p1-sync-selected-");
  const prior = process.env.YCM_HARNESS_HOME;
  try {
    await fs.cp(path.join(packageRoot(), "plugin"), path.join(parent, "plugin"), { recursive: true });
    await fs.cp(path.join(packageRoot(), "plugin"), path.join(selected, "plugin"), { recursive: true });
    await fs.cp(path.join(packageRoot(), "dist"), path.join(selected, "dist"), { recursive: true });
    await fs.copyFile(
      path.join(packageRoot(), "package.json"),
      path.join(selected, "package.json"),
    );
    for (const dependency of ["commander", "zod"]) {
      const dependencyRoot = path.join(selected, "node_modules", dependency);
      await fs.mkdir(dependencyRoot, { recursive: true });
      await fs.writeFile(path.join(dependencyRoot, "package.json"), `{"name":"${dependency}"}\n`, "utf8");
      await fs.writeFile(path.join(dependencyRoot, "index.js"), "", "utf8");
    }
    await fs.writeFile(path.join(parent, "plugin", "PARENT_ONLY_SENTINEL.tmp"), "parent", "utf8");
    process.env.YCM_HARNESS_HOME = home;
    await fs.mkdir(path.join(home, ".codex"), { recursive: true });
    await runClientSync({
      codex: true,
      force: true,
      sourceRoot: selected,
    });
    const installed = path.join(home, ".codex", "marketplaces", "ycm-harness", "plugins", "ycm-harness");
    assert.equal(await exists(path.join(installed, "PARENT_ONLY_SENTINEL.tmp")), false);
  } finally {
    if (prior === undefined) delete process.env.YCM_HARNESS_HOME;
    else process.env.YCM_HARNESS_HOME = prior;
    await fs.rm(home, { recursive: true, force: true });
    await fs.rm(parent, { recursive: true, force: true });
    await fs.rm(selected, { recursive: true, force: true });
  }
});

test("doctor reports the repo project as its source root", async () => {
  const home = await temp("ch-p1-doctor-home-");
  const prior = process.env.YCM_HARNESS_HOME;
  try {
    process.env.YCM_HARNESS_HOME = home;
    const out = output();
    const program = new Command();
    registerDoctor(program, createContext(packageRoot()), out);
    await program.parseAsync(["doctor", "--json"], { from: "user" });
    const payload = out.jsons.at(-1) as { project_root?: string; source_root?: string };
    assert.equal(payload.project_root, packageRoot());
    assert.equal(payload.source_root, packageRoot());
  } finally {
    if (prior === undefined) delete process.env.YCM_HARNESS_HOME;
    else process.env.YCM_HARNESS_HOME = prior;
    await fs.rm(home, { recursive: true, force: true });
  }
});


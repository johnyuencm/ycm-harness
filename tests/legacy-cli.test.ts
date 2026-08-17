import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import type { CliContext } from "../src/cli/context.js";
import type { CliOutput } from "../src/cli/output.js";
import { registerArtifact } from "../src/cli/commands/artifact.js";
import { registerCaveman } from "../src/cli/commands/caveman.js";
import { registerCommit } from "../src/cli/commands/commit.js";
import { registerPhase } from "../src/cli/commands/phase.js";
import { registerReview } from "../src/cli/commands/review.js";
import { registerRitual } from "../src/cli/commands/ritual.js";
import { registerSession } from "../src/cli/commands/session.js";
import { registerPlugin } from "../src/cli/commands/plugin.js";
import { registerUserWiki } from "../src/cli/commands/user-wiki.js";
import { registerWiki } from "../src/cli/commands/wiki.js";

const ctx = {} as CliContext;
const out: CliOutput = { out() {}, err() {}, json() {} };

const cases: Array<[string, (program: Command, ctx: CliContext, out: CliOutput) => void, string]> = [
  ["phase", registerPhase, "goal status / ticket list"],
  ["review", registerReview, "ticket submit + verify"],
  ["ritual", registerRitual, "verify run / verify verdict"],
  ["session", registerSession, "status / checkpoint"],
  ["user-wiki", registerUserWiki, "wiki"],
  ["caveman", registerCaveman, "deprecated"],
  ["artifact", registerArtifact, "checkpoint or wiki"],
  ["commit", registerCommit, "ticket submit"],
  ["plugin", registerPlugin, "install --force"],
];

test("legacy commands fail closed with exit code 2 and a replacement", async () => {
  for (const [name, register, replacement] of cases) {
    const program = new Command().exitOverride();
    register(program, ctx, out);
    await assert.rejects(
      () => program.parseAsync([name, "old-subcommand", "--old-flag"], { from: "user" }),
      (error: unknown) => {
        const e = error as { exitCode?: number; message?: string };
        assert.equal(e.exitCode, 2, name);
        assert.match(e.message ?? "", new RegExp(`deprecated`, "i"), name);
        if (name !== "caveman") assert.match(e.message ?? "", new RegExp(replacement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), name);
        return true;
      },
    );
  }
});

test("plugin update delegates to install --force when available", async () => {
  const program = new Command().exitOverride();
  let forced = false;
  program.command("install").option("--force").action((opts: { force?: boolean }) => {
    forced = opts.force === true;
  });
  registerPlugin(program, ctx, out);
  await program.parseAsync(["plugin", "update"], { from: "user" });
  assert.equal(forced, true);
});

test("retired wiki subcommands fail closed including nested list/show", async () => {
  const retired = [
    ["wiki", "init"],
    ["wiki", "query", "x"],
    ["wiki", "lint"],
    ["wiki", "source", "list"],
    ["wiki", "source", "add", "x"],
    ["wiki", "page", "list"],
    ["wiki", "page", "show", "x"],
    ["wiki", "page", "upsert", "--id", "x", "--title", "t", "--body", "b"],
    ["wiki", "promote", "x"],
    ["wiki", "checkpoint", "-n", "n"],
  ];
  for (const args of retired) {
    const program = new Command().name("ycm-harness").exitOverride();
    registerWiki(program, ctx, out);
    await assert.rejects(
      () => program.parseAsync(args, { from: "user" }),
      (error: unknown) => {
        const e = error as { exitCode?: number; message?: string };
        assert.equal(e.exitCode, 2, args.join(" "));
        assert.match(e.message ?? "", /deprecated/i, args.join(" "));
        return true;
      },
    );
  }
});


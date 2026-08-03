import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { tempProject, cleanup, withTempUserHome } from "./helpers.js";
import { createContext } from "../src/cli/context.js";
import type { CliOutput } from "../src/cli/output.js";
import { registerInit } from "../src/cli/commands/init.js";
import { registerGoal } from "../src/cli/commands/goal.js";
import { registerPhase } from "../src/cli/commands/phase.js";
import { registerTask } from "../src/cli/commands/task.js";
import { registerHook } from "../src/cli/commands/hook.js";
import { registerWiki } from "../src/cli/commands/wiki.js";
import {
  WikiPage,
  WikiSource,
  WikiLogEntry,
  emptyWikiState,
} from "../src/schema/wiki.js";

interface CapturedOutput extends CliOutput {
  stdout: string[];
  stderr: string[];
  jsons: unknown[];
}

function captureOutput(): CapturedOutput {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const jsons: unknown[] = [];
  return {
    out(text) {
      stdout.push(text);
    },
    err(text) {
      stderr.push(text);
    },
    json(value) {
      jsons.push(value);
      stdout.push(JSON.stringify(value));
    },
    stdout,
    stderr,
    jsons,
  };
}

function buildProgram(cwd: string, out: CliOutput): Command {
  const ctx = createContext(cwd);
  const program = new Command();
  program.name("ycm-harness").exitOverride();
  registerInit(program, ctx, out);
  registerGoal(program, ctx, out);
  registerPhase(program, ctx, out);
  registerTask(program, ctx, out);
  registerHook(program, ctx, out);
  registerWiki(program, ctx, out);
  return program;
}

async function run(cwd: string, out: CapturedOutput, args: string[]): Promise<void> {
  const program = buildProgram(cwd, out);
  await program.parseAsync(args, { from: "user" });
}

test("wiki schemas round-trip through Zod parsers", () => {
  const at = new Date().toISOString();
  const source = WikiSource.parse({
    id: "src_x",
    title: "X",
    raw_path: "src_x.md",
    added_at: at,
    updated_at: at,
  });
  const page = WikiPage.parse({
    id: "page_y",
    title: "Y",
    body_path: "pages/page_y.md",
    source_ids: [source.id],
    tags: ["tag_a"],
    created_at: at,
    updated_at: at,
  });
  const log = WikiLogEntry.parse({
    id: "wlg_z",
    kind: "wiki.created",
    at,
  });
  const empty = emptyWikiState();
  assert.equal(empty.initialized, false);
  assert.equal(empty.log.length, 0);
  assert.equal(source.id, "src_x");
  assert.equal(page.source_ids[0], "src_x");
  assert.equal(log.kind, "wiki.created");
});

test("wiki schemas reject bad enum values", () => {
  const at = new Date().toISOString();
  assert.throws(() =>
    WikiLogEntry.parse({ id: "wlg_bad", kind: "definitely.not.a.kind", at }),
  );
});

test("wiki golden path: init -> source add -> page upsert -> query -> lint detects orphan/missing-ref/clean", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    const sourceFile = path.join(root, "source.md");
    await fs.writeFile(sourceFile, "# original\n\nbody for ingestion\n", "utf8");

    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "Wiki test"]);
    await run(root, out, ["phase", "start", "explore"]);

    await run(root, out, ["wiki", "init"]);
    const wikiDir = path.join(root, ".ycm-harness", "wiki");
    for (const f of ["schema.md", "index.md", "log.md"]) {
      await fs.access(path.join(wikiDir, f));
    }

    await run(root, out, [
      "wiki",
      "source",
      "add",
      sourceFile,
      "--id",
      "src_one",
      "--title",
      "Source One",
    ]);
    const rawCopy = path.join(wikiDir, "raw", "src_one.md");
    await fs.access(rawCopy);

    const bodyFile = path.join(root, "body.md");
    await fs.writeFile(
      bodyFile,
      "First page body referencing [[ghost]] which does not exist.",
      "utf8",
    );
    await run(root, out, [
      "wiki",
      "page",
      "upsert",
      "--id",
      "page_one",
      "--title",
      "Page One",
      "--source",
      "src_one",
      "--body-file",
      bodyFile,
    ]);

    out.stdout.length = 0;
    await run(root, out, ["wiki", "query", "ghost"]);
    assert.ok(
      out.stdout.some((line) => line.includes("page_one") && line.includes("ghost")),
      `expected query to find 'ghost' in page_one, got: ${out.stdout.join("|")}`,
    );

    out.jsons.length = 0;
    await run(root, out, ["wiki", "lint", "--json"]);
    const lintWithRef = out.jsons.at(-1) as { findings: string[]; count: number };
    assert.equal(lintWithRef.count, 1);
    assert.match(lintWithRef.findings[0] ?? "", /missing-ref/);

    const orphanBody = path.join(root, "orphan.md");
    await fs.writeFile(orphanBody, "Orphan body", "utf8");
    await run(root, out, [
      "wiki",
      "page",
      "upsert",
      "--id",
      "orphan_one",
      "--title",
      "Orphan",
      "--body-file",
      orphanBody,
    ]);
    out.jsons.length = 0;
    await run(root, out, ["wiki", "lint", "--json"]);
    const lint2 = out.jsons.at(-1) as { findings: string[]; count: number };
    assert.equal(lint2.count, 2);
    assert.ok(lint2.findings.some((f) => f.startsWith("orphan: ")));
    assert.ok(lint2.findings.some((f) => f.startsWith("missing-ref: ")));

    const cleanBody = path.join(root, "clean.md");
    await fs.writeFile(cleanBody, "Clean body, no broken refs.", "utf8");
    await run(root, out, [
      "wiki",
      "page",
      "upsert",
      "--id",
      "page_one",
      "--title",
      "Page One",
      "--source",
      "src_one",
      "--body-file",
      cleanBody,
    ]);
    await run(root, out, [
      "wiki",
      "page",
      "upsert",
      "--id",
      "orphan_one",
      "--title",
      "Orphan",
      "--source",
      "src_one",
      "--body-file",
      cleanBody,
    ]);
    out.jsons.length = 0;
    await run(root, out, ["wiki", "lint", "--json"]);
    const lint3 = out.jsons.at(-1) as { findings: string[]; count: number };
    assert.equal(lint3.count, 0);
  } finally {
    await cleanup(root);
  }
});

test("session digest renders wiki block when wiki is initialized", async () => {
  await withTempUserHome(async () => {
    const root = await tempProject();
    try {
      const out = captureOutput();
      await run(root, out, ["init"]);
      await run(root, out, ["goal", "create", "Digest test"]);
      await run(root, out, ["phase", "start", "explore"]);
      await run(root, out, ["wiki", "init"]);
      out.stdout.length = 0;
      await run(root, out, ["hook", "session-start"]);
      const blob = out.stdout.join("\n");
      assert.match(blob, /Wiki: pages=0 sources=0/);
      assert.match(blob, /Recent wiki log:/);
    } finally {
      await cleanup(root);
    }
  });
});

test("lint ignores [[id]] tokens inside backticked code spans and code blocks", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    const sourceFile = path.join(root, "source.md");
    await fs.writeFile(sourceFile, "ref doc", "utf8");
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "Lint code-span test"]);
    await run(root, out, ["phase", "start", "explore"]);
    await run(root, out, ["wiki", "init"]);
    await run(root, out, [
      "wiki",
      "source",
      "add",
      sourceFile,
      "--id",
      "src_one",
      "--title",
      "S",
    ]);
    const body = path.join(root, "doc.md");
    await fs.writeFile(
      body,
      [
        "Use the syntax `[[other-page-id]]` to link.",
        "",
        "```",
        "[[also-not-a-real-ref]]",
        "```",
        "",
        "And [[real-target]] is a real link.",
      ].join("\n"),
      "utf8",
    );
    await run(root, out, [
      "wiki",
      "page",
      "upsert",
      "--id",
      "demo",
      "--title",
      "Demo",
      "--source",
      "src_one",
      "--body-file",
      body,
    ]);
    out.jsons.length = 0;
    await run(root, out, ["wiki", "lint", "--json"]);
    const lint = out.jsons.at(-1) as { findings: string[]; count: number };
    assert.equal(lint.count, 1);
    assert.match(lint.findings[0] ?? "", /real-target/);
  } finally {
    await cleanup(root);
  }
});

test("upsert rejects unknown source ids", async () => {
  const root = await tempProject();
  try {
    const out = captureOutput();
    await run(root, out, ["init"]);
    await run(root, out, ["goal", "create", "Reject test"]);
    await run(root, out, ["phase", "start", "explore"]);
    await run(root, out, ["wiki", "init"]);
    const bodyFile = path.join(root, "body.md");
    await fs.writeFile(bodyFile, "x", "utf8");
    await assert.rejects(
      run(root, out, [
        "wiki",
        "page",
        "upsert",
        "--id",
        "x",
        "--title",
        "X",
        "--source",
        "src_does_not_exist",
        "--body-file",
        bodyFile,
      ]),
      /Unknown source/,
    );
  } finally {
    await cleanup(root);
  }
});

#!/usr/bin/env node
/**
 * P6-D combined verification helper for the orchestrator.
 *
 * Runs targeted suites, typecheck, and clean build. The isolated-HOME full suite
 * is opt-in via --full because it is heavy; client sync is deferred until after
 * final-head Standards/Spec acceptance (orchestrator T5).
 *
 * Requires Node >=20 (package.json engines).
 *
 * Usage:
 *   node scripts/p6d-combined-verify.mjs
 *   node scripts/p6d-combined-verify.mjs --full
 *
 * Equivalent isolated-HOME full suite (also used by --full):
 *   HOME=$(mktemp -d) YCM_HARNESS_HOME=$HOME npm test
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const full = process.argv.includes("--full");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
  process.stderr.write(
    `P6-D verify requires Node >=20 (package.json engines); got ${process.version}\n`,
  );
  process.exit(1);
}

function run(label, command, args, env = process.env) {
  process.stdout.write(`\n== ${label} ==\n`);
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    process.stderr.write(`${label} failed with exit ${result.status}\n`);
    process.exit(result.status ?? 1);
  }
}

run("typecheck", "npm", ["run", "typecheck"]);
run("build", "npm", ["run", "build"]);
run("targeted P6 suites", process.execPath, [
  "--test",
  "--import",
  "tsx/esm",
  "tests/strategic-review.test.ts",
  "tests/strategic-action.test.ts",
  "tests/knowledge-promotion.test.ts",
  "tests/strategic-installed.test.ts",
  "tests/autonomy-phase1-integrity.test.ts",
]);

if (full) {
  const isolatedHome = mkdtempSync(path.join(os.tmpdir(), "p6d-isolated-home-"));
  process.stdout.write(`isolated HOME=${isolatedHome}\n`);
  run(
    "isolated-HOME full suite",
    "npm",
    ["test"],
    {
      ...process.env,
      HOME: isolatedHome,
      YCM_HARNESS_HOME: isolatedHome,
    },
  );
} else {
  process.stdout.write("\n== isolated-HOME full suite ==\n");
  process.stdout.write(
    "SKIPPED (pass --full). Equivalent: HOME=$(mktemp -d) YCM_HARNESS_HOME=$HOME npm test (Node >=20)\n",
  );
}

process.stdout.write("\n== client sync ==\n");
process.stdout.write(
  "DEFERRED until final-head Standards/Spec PASS (orchestrator post-T5). Do not run ycm-harness install here.\n",
);

process.stdout.write("\nP6-D combined verification: PASS (targeted)\n");

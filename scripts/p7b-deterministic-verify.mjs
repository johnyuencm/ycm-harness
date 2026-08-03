#!/usr/bin/env node
/**
 * P7-B deterministic verification + fresh-install safety canaries.
 *
 * Records every command/canary with exit codes. Any failure opens/reuses one
 * live correction issue under .ycm-harness/autonomy/p7b-corrections/ and
 * returns PARTIAL — never a synthetic PASS.
 *
 * Usage:
 *   node scripts/p7b-deterministic-verify.mjs
 *   node scripts/p7b-deterministic-verify.mjs --full
 *   node scripts/p7b-deterministic-verify.mjs --dry-run
 *
 * Dry-run: prints the planned check matrix and exits 0 with verdict PARTIAL
 * (reason_code=DRY_RUN). It does not invent PASS.
 *
 * Requires Node >=20. Canary aggregation loads TypeScript via tsx.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const full = process.argv.includes("--full");
const dryRun = process.argv.includes("--dry-run");

const nodeMajor = Number(process.versions.node.split(".")[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
  process.stderr.write(
    `P7-B verify requires Node >=20 (package.json engines); got ${process.version}\n`,
  );
  process.exit(1);
}

function record(label, command, args, env = process.env) {
  process.stdout.write(`\n== ${label} ==\n`);
  if (dryRun) {
    process.stdout.write(`DRY-RUN plan: ${command} ${args.join(" ")}\n`);
    return { id: label, exit_code: 0, ok: false, detail: "dry-run: not executed" };
  }
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    env,
    stdio: "inherit",
  });
  const exit_code = result.status ?? 1;
  if (exit_code !== 0) {
    process.stderr.write(`${label} failed with exit ${exit_code}\n`);
  }
  return { id: label, exit_code, ok: exit_code === 0 };
}

const commandRecords = [];

commandRecords.push(record("typecheck", "npm", ["run", "typecheck"]));
if (!dryRun && !commandRecords.at(-1).ok) {
  // continue recording — do not invent PASS by early-exiting without canaries
}

commandRecords.push(record("build", "npm", ["run", "build"]));

commandRecords.push(
  record("targeted_p7b_tests", process.execPath, [
    "--test",
    "--import",
    "tsx/esm",
    "tests/p7b-deterministic-verify.test.ts",
    "tests/missed-slot-watchdog.test.ts",
    "tests/strategic-installed.test.ts",
    "tests/autonomy-scout-guard.test.ts",
  ]),
);

const lintScript = spawnSync("npm", ["pkg", "get", "scripts.lint"], {
  cwd: root,
  encoding: "utf8",
});
const hasLint = lintScript.status === 0 && lintScript.stdout.trim() !== "{}" && !lintScript.stdout.includes("undefined");
if (hasLint) {
  commandRecords.push(record("lint", "npm", ["run", "lint"]));
} else {
  process.stdout.write("\n== lint ==\n");
  process.stdout.write("SKIPPED (no scripts.lint in package.json)\n");
  commandRecords.push({ id: "lint", exit_code: 0, ok: true, detail: "not_configured" });
}

process.stdout.write("\n== static_config ==\n");
if (dryRun) {
  process.stdout.write("DRY-RUN plan: engines.node>=20, tsconfig.json present\n");
  commandRecords.push({ id: "static_config", exit_code: 0, ok: false, detail: "dry-run: not executed" });
} else {
  const enginesOk = nodeMajor >= 20;
  const tsconfigCheck = spawnSync(
    process.execPath,
    ["-e", "import('node:fs').then(fs=>fs.promises.access('tsconfig.json')).then(()=>process.exit(0)).catch(()=>process.exit(1))"],
    { cwd: root, encoding: "utf8" },
  );
  const ok = enginesOk && tsconfigCheck.status === 0;
  process.stdout.write(
    ok
      ? `OK engines.node=${process.version} tsconfig=present\n`
      : `FAIL enginesOk=${enginesOk} tsconfig_exit=${tsconfigCheck.status}\n`,
  );
  commandRecords.push({ id: "static_config", exit_code: ok ? 0 : 1, ok });
}

if (full && !dryRun) {
  const isolatedHome = mkdtempSync(path.join(os.tmpdir(), "p7b-isolated-home-"));
  process.stdout.write(`isolated HOME=${isolatedHome}\n`);
  commandRecords.push(
    record("isolated_HOME_full_suite", "npm", ["test"], {
      ...process.env,
      HOME: isolatedHome,
      YCM_HARNESS_HOME: isolatedHome,
    }),
  );
} else {
  process.stdout.write("\n== isolated_HOME_full_suite ==\n");
  process.stdout.write(
    dryRun
      ? "DRY-RUN plan: HOME=$(mktemp -d) YCM_HARNESS_HOME=$HOME npm test\n"
      : "SKIPPED (pass --full). Equivalent: HOME=$(mktemp -d) YCM_HARNESS_HOME=$HOME npm test\n",
  );
  if (dryRun) {
    commandRecords.push({
      id: "isolated_HOME_full_suite",
      exit_code: 0,
      ok: false,
      detail: "dry-run: not executed",
    });
  }
}

const resultsPath = path.join(
  mkdtempSync(path.join(os.tmpdir(), "p7b-verify-")),
  "command-records.json",
);
writeFileSync(resultsPath, JSON.stringify({ dryRun, commandRecords }, null, 2), "utf8");

const reportPath = path.join(path.dirname(resultsPath), "report.json");
const aggregateTs = path.join(root, "scripts", "p7b-aggregate.ts");

process.stdout.write("\n== safety_canaries_and_aggregate ==\n");
const agg = spawnSync(
  process.execPath,
  ["--import", "tsx/esm", aggregateTs, resultsPath, reportPath, root],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (agg.stdout) process.stdout.write(agg.stdout);
if (agg.status !== 0 && agg.status !== null) {
  process.stderr.write(`P7-B aggregate exit ${agg.status}\n`);
}

process.stdout.write(`\nReport: ${reportPath}\n`);
process.stdout.write(
  dryRun
    ? "\nP7-B deterministic verification: PARTIAL (dry-run; not a synthetic PASS)\n"
    : "\nP7-B deterministic verification: see aggregate verdict above\n",
);

process.exit(agg.status ?? 1);

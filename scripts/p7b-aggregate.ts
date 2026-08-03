#!/usr/bin/env node
/**
 * Aggregate pre-recorded command results with P7-B safety canaries.
 * Invoked by scripts/p7b-deterministic-verify.mjs — not usually run alone.
 *
 * Usage:
 *   node --import tsx/esm scripts/p7b-aggregate.ts <command-records.json> <report-out.json> <project-root>
 */
import { readFileSync, writeFileSync } from "node:fs";
import {
  createCliCanaryContext,
  createFileCorrectionIssueAdapter,
  createPassingCanaryContext,
  runP7bDeterministicVerify,
} from "../src/autonomy/p7b-deterministic-verify.js";

const recordsPath = process.argv[2];
const reportPath = process.argv[3];
const root = process.argv[4];
if (!recordsPath || !reportPath || !root) {
  process.stderr.write("usage: p7b-aggregate.ts <records.json> <report.json> <root>\n");
  process.exit(2);
}

const payload = JSON.parse(readFileSync(recordsPath, "utf8")) as {
  dryRun: boolean;
  commandRecords: Array<{ id: string; exit_code: number; ok: boolean; detail?: string }>;
};

const canaries = payload.dryRun
  ? createPassingCanaryContext()
  : await createCliCanaryContext(root);

const report = await runP7bDeterministicVerify({
  dryRun: payload.dryRun,
  commands: payload.commandRecords.map((row) => ({
    id: row.id,
    run: async () => ({ exit_code: row.exit_code, detail: row.detail }),
  })),
  canaries,
  corrections: createFileCorrectionIssueAdapter(root),
});

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
process.stdout.write(`${JSON.stringify({
  verdict: report.verdict,
  reason_code: report.reason_code,
  synthetic_pass: report.synthetic_pass,
  correction_issue_id: report.correction_issue_id ?? null,
  failed: report.checks.filter((c) => !c.ok).map((c) => c.id),
  check_count: report.checks.length,
}, null, 2)}\n`);

// Dry-run is an honest PARTIAL, not a failure of the tool itself.
if (report.reason_code === "DRY_RUN") process.exit(0);
process.exit(report.verdict === "PASS" ? 0 : 1);

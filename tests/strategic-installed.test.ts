import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { packageRoot, runClientSync } from "../src/cli/install-kit.js";
import {
  assertStrategicReviewProfileCapabilities,
  compareStrategicInstalledParity,
  loadStrategicReviewProfileCatalog,
  sourcePluginRoot,
  STRATEGIC_INSTALLED_ASSET_PATHS,
} from "../src/autonomy/strategic-installed-parity.js";
import {
  runStrategicInstalledManualCanary,
  runStrategicInstalledManualCanaryTrace,
} from "../src/autonomy/strategic-installed-canary.js";
import { STRATEGIC_ACTION_SELECTOR_OPERATIONS } from "../src/autonomy/strategic-action.js";
import { emptyStateV3 } from "../src/schema/v3.js";
import { HarnessStore } from "../src/state/store.js";
import { cleanup, tempProject, withTempUserHome } from "./helpers.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const REQUIRED_OPERATOR_PHRASES = [
  "pm-17:00",
  "nightly-workspace",
  "operations-cron-output",
  "optional-domain",
  "bounded-snapshot",
  "FACT",
  "INFERENCE",
  "UNKNOWN",
  "UNAVAILABLE",
  "evaluate",
  "apply",
  "promote",
  "status",
  "replay",
  "pause",
  "rollback",
  "later-worker",
  "PARTIAL",
  "BLOCKED",
  "schedule",
  "delivery",
  "manual",
];

async function activeProject(prefix: string, goalId = "goal-phase-6-fixture"): Promise<string> {
  const root = await tempProject(prefix);
  const store = new HarnessStore(root);
  const now = "2026-07-21T00:00:00.000Z";
  const state = emptyStateV3(now);
  state.goals[goalId] = {
    id: goalId,
    title: "Strategic installed canary",
    status: "active",
    assurance: "standard",
    backend: { kind: "local" },
    worktree_status: "active",
    stop_enforcement: false,
    created_at: now,
    updated_at: now,
  };
  state.active_goal_id = goalId;
  await store.writeStateV3(state);
  return root;
}

test("installed operator assets describe Phase 6 profiles and surfaces", async () => {
  const plugin = await sourcePluginRoot();
  const operator = await fs.readFile(
    path.join(plugin, "skills/autonomous-harness/references/strategic-review-operator.md"),
    "utf8",
  );
  const skill = await fs.readFile(path.join(plugin, "skills/autonomous-harness/SKILL.md"), "utf8");
  for (const phrase of REQUIRED_OPERATOR_PHRASES) {
    assert.match(operator, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), phrase);
  }
  assert.match(skill, /strategic-review-operator\.md/);
  const catalog = await loadStrategicReviewProfileCatalog(plugin);
  assert.equal(catalog.profiles.length, 4);
  assert.equal(catalog.forbidden_capability_expansion, true);
  assert.deepEqual(
    catalog.profiles.map((profile) => profile.profile),
    ["pm-17:00", "nightly-workspace", "operations-cron-output", "optional-domain"],
  );
  for (const profile of catalog.profiles) {
    assert.deepEqual(profile.capabilities, [...STRATEGIC_ACTION_SELECTOR_OPERATIONS]);
  }
});

test("profile configuration is installation-owned and rejects capability expansion", async () => {
  const plugin = await sourcePluginRoot();
  const ok = await assertStrategicReviewProfileCapabilities(
    plugin,
    "pm-17:00",
    [...STRATEGIC_ACTION_SELECTOR_OPERATIONS],
  );
  assert.equal(ok.ok, true);
  const expanded = await assertStrategicReviewProfileCapabilities(
    plugin,
    "pm-17:00",
    [...STRATEGIC_ACTION_SELECTOR_OPERATIONS, "schedule"],
  );
  assert.equal(expanded.ok, false);
  if (!expanded.ok) assert.equal(expanded.reason_code, "ACTION_NOT_AUTHORIZED");
  const reordered = await assertStrategicReviewProfileCapabilities(
    plugin,
    "pm-17:00",
    ["rollback", ...STRATEGIC_ACTION_SELECTOR_OPERATIONS.slice(0, 4)],
  );
  assert.equal(reordered.ok, false);
});

test("source and projected installed assets have exact manifest parity", async () => {
  await withTempUserHome(async (home) => {
    const project = await tempProject("ch-p6d-parity-");
    try {
      process.env.CODEX_CLI_PATH = path.join(project, "codex-shim");
      process.env.OPENCODE_CLI_PATH = path.join(project, "opencode-shim");
      await fs.writeFile(process.env.CODEX_CLI_PATH, "#!/bin/sh\nexit 0\n", "utf8");
      await fs.writeFile(process.env.OPENCODE_CLI_PATH, "#!/bin/sh\nexit 0\n", "utf8");
      await fs.chmod(process.env.CODEX_CLI_PATH, 0o755);
      await fs.chmod(process.env.OPENCODE_CLI_PATH, 0o755);
      await runClientSync({ cursor: true, codex: false, opencode: false, force: true, sourceRoot: packageRoot() });
      const source = await sourcePluginRoot();
      const projected = path.join(home, ".cursor", "plugins", "ycm-harness");
      const parity = await compareStrategicInstalledParity(source, projected);
      assert.equal(parity.ok, true, JSON.stringify(parity.rows.filter((row) => !row.match), null, 2));
      assert.equal(parity.reason_code, "INSTALLED_PARITY_OK");
      assert.equal(parity.rows.length, STRATEGIC_INSTALLED_ASSET_PATHS.length);
      assert.ok(parity.rows.every((row) => row.match));
    } finally {
      await cleanup(project);
    }
  });
});

test("manual strategic canary covers four profiles, snapshot, loop, honest stop, and non-natural safety", async () => {
  const root = await activeProject("ch-p6d-canary-");
  try {
    const trace = await runStrategicInstalledManualCanaryTrace(root);
    assert.equal(trace.schema_version, 1);
    assert.deepEqual(Object.keys(trace.commands.profiles).sort(), [
      "nightly-workspace",
      "operations-cron-output",
      "optional-domain",
      "pm-17:00",
    ]);
    for (const profile of Object.values(trace.commands.profiles)) {
      assert.equal(profile.ok, true);
      assert.equal(profile.status, "PASS");
      assert.equal(profile.mutation_count, 0);
    }
    assert.equal(trace.commands.snapshot.status, "SNAPSHOT");
    assert.equal(trace.commands.snapshot.mutation_count, 0);
    assert.equal(trace.commands.ticket.status, "APPLIED");
    assert.equal(trace.commands.pause.status, "APPLIED");
    assert.equal(trace.commands.rollback.status, "ROLLED_BACK");
    assert.equal(trace.commands.promote.status, "PROMOTED");
    assert.equal(trace.commands.promote.receipt.git_mutation.commit, false);
    assert.equal(trace.commands.promote.receipt.git_mutation.push, false);
    assert.equal(trace.commands.promote.receipt.git_mutation.merge, false);
    assert.equal(trace.commands.promote.receipt.git_mutation.history_rewrite, false);
    assert.equal(trace.commands.honest_stop.ok, false);
    if (!trace.commands.honest_stop.ok) {
      assert.ok(trace.commands.honest_stop.status === "BLOCKED" || trace.commands.honest_stop.status === "PARTIAL");
    }
    assert.equal(trace.commands.ticket_replay.mutation_count, 0);
    assert.equal(trace.commands.promote_replay.mutation_count, 0);
    assert.equal(trace.commands.ticket_replay.receipt_id, trace.commands.ticket.receipt_id);
    assert.equal(trace.commands.promote_replay.receipt_id, trace.commands.promote.receipt_id);

    const report = trace.report;
    assert.equal(report.verdict, "PARTIAL");
    assert.equal(report.reason_code, "STRATEGIC_NATURAL_EVIDENCE_MISSING");
    assert.equal(report.evidence_class, "manual_local_provider");
    assert.equal(report.natural_schedule, false);
    assert.deepEqual(report.safety, {
      provider_lifecycle_mutations: 0,
      schedule_mutations: 0,
      deliveries: 0,
      merge: 0,
      push: 0,
      commit: 0,
      history_mutation: 0,
    });
    assert.equal(report.bounded_snapshot.mutation_count, 0);
    assert.equal(report.replay.duplicate_mutation, false);
    assert.equal(report.replay.duplicate_knowledge_event, false);

    const replay = await runStrategicInstalledManualCanary(root);
    assert.deepEqual(replay, report);
    assert.equal(replay.report_id, report.report_id);
  } finally {
    await cleanup(root);
  }
});

test("source and installed canary processes return equivalent canonical output and stable reasons", async () => {
  await withTempUserHome(async (home) => {
    const sourceProject = await activeProject("ch-p6d-source-");
    const installedProject = await activeProject("ch-p6d-installed-");
    try {
      // Use tsc only — `npm run build` runs clean-dist and races parallel suite files off dist/.
      const tsc = path.join(repoRoot, "node_modules", "typescript", "bin", "tsc");
      const build = spawnSync(process.execPath, [tsc, "-p", "tsconfig.json"], {
        cwd: repoRoot,
        encoding: "utf8",
        env: process.env,
      });
      assert.equal(build.status, 0, build.stderr || build.stdout);

      process.env.CODEX_CLI_PATH = path.join(sourceProject, "codex-shim");
      process.env.OPENCODE_CLI_PATH = path.join(sourceProject, "opencode-shim");
      await fs.writeFile(process.env.CODEX_CLI_PATH, "#!/bin/sh\nexit 0\n", "utf8");
      await fs.writeFile(process.env.OPENCODE_CLI_PATH, "#!/bin/sh\nexit 0\n", "utf8");
      await fs.chmod(process.env.CODEX_CLI_PATH, 0o755);
      await fs.chmod(process.env.OPENCODE_CLI_PATH, 0o755);
      await runClientSync({ cursor: true, codex: false, opencode: false, force: true, sourceRoot: packageRoot() });

      const sourceRuntime = path.join(repoRoot, "dist", "index.js");
      const installedPlugin = path.join(home, ".cursor", "plugins", "ycm-harness");
      const installedOperator = path.join(installedPlugin, "scripts", "strategic-installed-canary.mjs");

      const sourceEval = `
import path from "node:path";
import { pathToFileURL } from "node:url";
const { runStrategicInstalledManualCanaryTrace } = await import(pathToFileURL(process.argv[1]).href);
const pluginRoot = path.resolve(process.argv[3]);
const trace = await runStrategicInstalledManualCanaryTrace(path.resolve(process.argv[2]), { pluginRoot });
process.stdout.write(JSON.stringify({
  reason_code: trace.report.reason_code,
  evidence_class: trace.report.evidence_class,
  natural_schedule: trace.report.natural_schedule,
  profiles: trace.report.profiles,
  safety: trace.report.safety,
  honest_stop: trace.report.honest_stop,
  bounded_snapshot: trace.report.bounded_snapshot.mutation_count,
  replay: trace.report.replay,
}) + "\\n");
`;
      const sourceRun = spawnSync(process.execPath, [
        "--input-type=module", "--eval", sourceEval, sourceRuntime, sourceProject, path.join(repoRoot, "plugin"),
      ], { cwd: sourceProject, encoding: "utf8", env: { ...process.env, PATH: "" } });
      assert.equal(sourceRun.status, 0, sourceRun.stderr);

      const installedRun = spawnSync(process.execPath, [installedOperator, "--root", installedProject], {
        cwd: installedProject,
        encoding: "utf8",
        env: { ...process.env, PATH: "" },
      });
      assert.equal(installedRun.status, 0, installedRun.stderr);
      const installedTrace = JSON.parse(installedRun.stdout);
      const installedCanonical = {
        reason_code: installedTrace.report.reason_code,
        evidence_class: installedTrace.report.evidence_class,
        natural_schedule: installedTrace.report.natural_schedule,
        profiles: installedTrace.report.profiles,
        safety: installedTrace.report.safety,
        honest_stop: installedTrace.report.honest_stop,
        bounded_snapshot: installedTrace.report.bounded_snapshot.mutation_count,
        replay: installedTrace.report.replay,
      };
      assert.deepEqual(JSON.parse(sourceRun.stdout), installedCanonical);
      assert.equal(installedCanonical.reason_code, "STRATEGIC_NATURAL_EVIDENCE_MISSING");
      assert.equal(installedCanonical.natural_schedule, false);
      assert.equal(installedCanonical.safety.schedule_mutations, 0);
      assert.equal(installedCanonical.safety.deliveries, 0);
    } finally {
      await cleanup(sourceProject);
      await cleanup(installedProject);
    }
  });
});

test("hygiene: no secrets in installed Phase 6 assets and worktree clean after canary files stay ignored", async () => {
  const plugin = await sourcePluginRoot();
  for (const relative of STRATEGIC_INSTALLED_ASSET_PATHS) {
    const bytes = await fs.readFile(path.join(plugin, relative), "utf8");
    assert.doesNotMatch(bytes, /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/);
    assert.doesNotMatch(bytes, /AKIA[0-9A-Z]{16}/);
  }
  const ignore = await fs.readFile(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(ignore, /\.ycm-harness\//);
});

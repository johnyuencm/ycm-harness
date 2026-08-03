import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { packageRoot, runClientSync } from "../src/cli/install-kit.js";
import { pmWorkerRunRoot } from "../src/autonomy/pm.js";
import { runPmInstalledManualCanary } from "../src/autonomy/pm-installed-canary.js";
import { persistPinnedLocalArtifacts } from "../src/autonomy/pinned-local-artifact-store.js";
import { emptyStateV3 } from "../src/schema/v3.js";
import { HarnessStore } from "../src/state/store.js";
import { cleanup, tempProject, withTempUserHome, skipUnlessLinux } from "./helpers.js";

const sha = (value: Buffer | string): string => createHash("sha256").update(value).digest("hex");

function runCli(cli: string, project: string, command: string, input: unknown) {
  return spawnSync(process.execPath, [cli, "--cwd", project, "autonomy", "pm", command], {
    cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" }, input: JSON.stringify(input),
  });
}

const RUNTIME_CANARY = `
import path from "node:path";
import { pathToFileURL } from "node:url";
try {
  const { runPmInstalledManualCanary } = await import(pathToFileURL(path.resolve(process.argv[1])).href);
  const report = await runPmInstalledManualCanary(path.resolve(process.argv[2]));
  process.stdout.write(JSON.stringify(report, null, 2) + "\\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, reason_code: error instanceof Error ? error.message : String(error) }) + "\\n");
  process.exit(1);
}`;

const RUNTIME_CANARY_TRACE = `
import path from "node:path";
import { pathToFileURL } from "node:url";
try {
  const { runPmInstalledManualCanaryTrace } = await import(pathToFileURL(path.resolve(process.argv[1])).href);
  const trace = await runPmInstalledManualCanaryTrace(path.resolve(process.argv[2]));
  process.stdout.write(JSON.stringify(trace, null, 2) + "\\n");
} catch (error) {
  process.stderr.write(JSON.stringify({ ok: false, reason_code: error instanceof Error ? error.message : String(error) }) + "\\n");
  process.exit(1);
}`;

function runRuntimeCanary(runtime: string, project: string) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", RUNTIME_CANARY, runtime, project], {
    cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" },
  });
}

function runRuntimeCanaryTrace(runtime: string, project: string) {
  return spawnSync(process.execPath, ["--input-type=module", "--eval", RUNTIME_CANARY_TRACE, runtime, project], {
    cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" },
  });
}

function runInstalledOperator(script: string, project: string) {
  return spawnSync(process.execPath, [script, "--root", project], {
    cwd: project, encoding: "utf8", env: { ...process.env, PATH: "" },
  });
}

async function activeProject(prefix: string, goalId = "goal"): Promise<string> {
  const root = await tempProject(prefix); const store = new HarnessStore(root);
  const now = "2026-07-16T00:00:00.000Z"; const state = emptyStateV3(now);
  state.goals[goalId] = { id: goalId, title: "Installed PM canary", status: "active", assurance: "standard",
    backend: { kind: "local" }, worktree_status: "active", stop_enforcement: false, created_at: now, updated_at: now };
  state.active_goal_id = goalId; await store.writeStateV3(state);
  return root;
}

async function contentTree(root: string): Promise<string[]> {
  const rows: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else rows.push(`${path.relative(root, file).replace(/\\/g, "/")}:${sha(await fs.readFile(file))}`);
    }
  };
  await walk(root); return rows;
}

async function exactTree(root: string): Promise<string[]> {
  const rows: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else {
        const stat = await fs.stat(file);
        rows.push(`${path.relative(root, file).replace(/\\/g, "/")}:${sha(await fs.readFile(file))}:${stat.mtimeMs}`);
      }
    }
  };
  await walk(root); return rows;
}

async function assertNoPrivateKey(root: string): Promise<void> {
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await walk(file);
      else assert.doesNotMatch((await fs.readFile(file)).toString("utf8"), /-----BEGIN (?:ENCRYPTED )?PRIVATE KEY-----/,
        `installed projection shipped private-key material in ${path.relative(root, file)}`);
    }
  };
  await walk(root);
}

async function assertNoCanaryReceipts(root: string): Promise<void> {
  const pm = path.join(root, ".ycm-harness", "autonomy", "pm");
  for (const directory of ["prepare", "claims", "handoff", "review", "gaps", "gates", "commits"]) {
    const names = await fs.readdir(path.join(pm, directory)).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error));
    assert.deepEqual(names, [], `${directory} advanced before artifact safety rejection`);
  }
}

async function writeLegacyReport(
  root: string,
  goalId: string,
  claimId: string,
  schemaVersion: 1 | 2,
): Promise<{ file: string; bytes: string; claimId: string }> {
  const receiptIds = {
    prepare: `pm-${"1".repeat(32)}`, handoff: `pmh-${"2".repeat(32)}`,
    review: `pmr-${"3".repeat(32)}`, gap: `pmg-${"4".repeat(32)}`,
  };
  const identity = {
    schema_version: schemaVersion, goal_id: goalId, verdict: "PARTIAL", reason_code: "PM_NATURAL_EVIDENCE_MISSING",
    evidence_class: "manual_local_provider", provider: "deterministic_local_double", claim_id: claimId,
    receipt_ids: receiptIds, evidence_ids: Object.values(receiptIds).sort(),
    safety: { provider_lifecycle_mutations: 0, schedule_mutations: 0, deliveries: 0 },
  };
  const reportId = `p5e-${sha(JSON.stringify(identity)).slice(0, 32)}`;
  const core = { schema_version: schemaVersion, report_id: reportId, goal_id: identity.goal_id, verdict: identity.verdict,
    reason_code: identity.reason_code, evidence_class: identity.evidence_class, provider: identity.provider,
    claim_id: claimId, receipt_ids: receiptIds, evidence_ids: identity.evidence_ids, safety: identity.safety };
  const bytes = `${JSON.stringify({ ...core, protected_state_sha256: sha(JSON.stringify(core)) }, null, 2)}\n`;
  const file = path.join(root, ".ycm-harness", "autonomy", "pm", "gates", `${reportId}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, "utf8");
  return { file, bytes, claimId };
}

function assertArtifactUnsafe(result: ReturnType<typeof runRuntimeCanary>): void {
  assert.equal(result.status, 1, result.stderr);
  assert.deepEqual(JSON.parse(result.stderr), { ok: false, reason_code: "pm_canary_artifact_unsafe" });
}

test("manual PM canary rejects an unsupported artifact store before advancing receipts", async () => {
  const project = await activeProject("ch-pm-canary-unsupported-");
  try {
    for (const artifactStore of [
      { forcePlatformUnsupported: true },
      { forceNoFollowUnsupported: true },
      { forceDirectoryUnsupported: true },
      { forceDescriptorUnsupported: true },
    ]) {
      await assert.rejects(
        runPmInstalledManualCanary(project, { artifactStore }),
        /pm_canary_artifact_unsupported/,
      );
      await assertNoCanaryReceipts(project);
      await assert.rejects(fs.access(path.join(project, ".ycm-harness", "autonomy", "pm", "runs")));
    }
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary rejects a project-root replacement while the artifact store is being pinned", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-pre-pin-");
  const authenticated = `${project}-authenticated`;
  let replaced = false;
  try {
    await assert.rejects(
      runPmInstalledManualCanary(project, { artifactStore: {
        async afterDirectoryPrecheck(directory) {
          if (directory !== project || replaced) return;
          replaced = true;
          await fs.rename(project, authenticated);
          await fs.mkdir(project);
        },
      } }),
      /pm_canary_artifact_unsafe/,
    );
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readdir(project), []);
    await assertNoCanaryReceipts(authenticated);
  } finally {
    await cleanup(project);
    await cleanup(authenticated);
  }
});

test("manual PM canary rejects a post-pin ancestor replacement before prepare", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-post-pin-");
  const authenticated = `${project}-authenticated`;
  let replaced = false;
  try {
    await assert.rejects(
      runPmInstalledManualCanary(project, { artifactStore: {
        async afterStorePreflight() {
          replaced = true;
          await fs.rename(project, authenticated);
          await fs.mkdir(project);
        },
      } }),
      /pm_canary_artifact_unsafe/,
    );
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readdir(project), []);
    await assertNoCanaryReceipts(authenticated);
    assert.equal((await contentTree(authenticated)).some((row) => row.includes("/runs/") && /(?:prompt|output|exit-status)\.txt:/.test(row)), false);
  } finally {
    await cleanup(project);
    await cleanup(authenticated);
  }
});

test("manual PM canary rejects an ancestor replacement immediately after pinning without advancing receipts", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-after-pin-");
  const authenticated = `${project}-authenticated`;
  let replaced = false;
  try {
    await assert.rejects(
      runPmInstalledManualCanary(project, { artifactStore: {
        async afterDirectoryPinned(directory) {
          if (directory !== project || replaced) return;
          replaced = true;
          await fs.rename(project, authenticated);
          await fs.mkdir(project);
        },
      } }),
      /pm_canary_artifact_unsafe/,
    );
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readdir(project), []);
    await assertNoCanaryReceipts(authenticated);
  } finally {
    await cleanup(project);
    await cleanup(authenticated);
  }
});

test("manual PM canary publishes only to the pinned inode after an ancestor replacement without advancing receipts", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-publish-pin-");
  const authenticated = `${project}-authenticated`;
  let replaced = false;
  try {
    await assert.rejects(
      runPmInstalledManualCanary(project, { artifactStore: {
        async beforeArtifactPublish() {
          if (replaced) return;
          replaced = true;
          await fs.rename(project, authenticated);
          await fs.mkdir(project);
        },
      } }),
      /pm_canary_artifact_unsafe/,
    );
    assert.equal(replaced, true);
    assert.deepEqual(await fs.readdir(project), []);
    await assertNoCanaryReceipts(authenticated);
    const authenticatedTree = await contentTree(authenticated);
    assert(authenticatedTree.some((row) => row.includes("/runs/") && row.includes("exit-status.txt:")));
  } finally {
    await cleanup(project);
    await cleanup(authenticated);
  }
});

test("manual PM canary recovers idempotently from a crash before artifact publication", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-before-link-");
  try {
    await assert.rejects(
      runPmInstalledManualCanary(project, { artifactStore: { faultAt: "before_link" } }),
      /pm_canary_artifact_fault_before_link/,
    );
    await assertNoCanaryReceipts(project);
    const recovered = await runPmInstalledManualCanary(project);
    assert.equal(recovered.verdict, "PARTIAL");
    const replay = await runPmInstalledManualCanary(project);
    assert.deepEqual(replay, recovered);
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary recovers idempotently from a crash after artifact publication", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-after-link-");
  try {
    await assert.rejects(
      runPmInstalledManualCanary(project, { artifactStore: { faultAt: "after_link" } }),
      /pm_canary_artifact_fault_after_link/,
    );
    await assertNoCanaryReceipts(project);
    const recovered = await runPmInstalledManualCanary(project);
    assert.equal(recovered.verdict, "PARTIAL");
    assert.deepEqual(await runPmInstalledManualCanary(project), recovered);
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary recovers from a partial artifact write without accepting the poisoned attempt", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-during-write-");
  try {
    await assert.rejects(
      runPmInstalledManualCanary(project, { artifactStore: { faultAt: "during_write" } }),
      /pm_canary_artifact_fault_during_write/,
    );
    await assertNoCanaryReceipts(project);
    const runRoots = path.join(project, ".ycm-harness", "autonomy", "pm", "runs");
    const [runRootName] = await fs.readdir(runRoots);
    const runRoot = path.join(runRoots, runRootName!);
    const partials = (await fs.readdir(runRoot)).filter((name) => /^\.pm-artifact-[0-9a-f]{64}\.stage$/.test(name)).sort();
    assert.equal(partials.length, 1);
    assert((await fs.stat(path.join(runRoot, partials[0]!))).size > 0);
    const recovered = await runPmInstalledManualCanary(project);
    assert.equal(recovered.verdict, "PARTIAL");
    assert.deepEqual(await runPmInstalledManualCanary(project), recovered);
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary rejects a non-prefix deterministic artifact stage without overwrite or deletion", async (t) => {
  if (skipUnlessLinux(t)) return;
  const seed = await activeProject("ch-pm-canary-stage-poison-seed-");
  const project = await activeProject("ch-pm-canary-stage-poison-");
  try {
    const claimId = (await runPmInstalledManualCanary(seed)).claim_id;
    const runRoot = pmWorkerRunRoot(project, "goal", claimId);
    await fs.mkdir(runRoot, { recursive: true });
    const expected = "Run the installed deterministic local-only PM evidence canary.\n";
    const stage = `.pm-artifact-${createHash("sha256").update(`prompt.txt\0${expected}`).digest("hex")}.stage`;
    const poison = "not-a-prefix\n";
    await fs.writeFile(path.join(runRoot, stage), poison, { encoding: "utf8", flag: "wx" });
    const before = await fs.stat(path.join(runRoot, stage));
    await assert.rejects(runPmInstalledManualCanary(project), /pm_canary_artifact_conflict/);
    const after = await fs.stat(path.join(runRoot, stage));
    assert.equal(await fs.readFile(path.join(runRoot, stage), "utf8"), poison);
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
    await assertNoCanaryReceipts(project);
  } finally {
    await cleanup(seed); await cleanup(project);
  }
});

test("manual PM canary exposes no canonical receipts when it crashes before the immutable commit index", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-before-index-");
  try {
    await assert.rejects(runPmInstalledManualCanary(project, { artifactStore: { faultAt: "before_commit_index" } }),
      /pm_canary_fault_before_commit_index/);
    await assertNoCanaryReceipts(project);
    const recovered = await runPmInstalledManualCanary(project);
    assert.equal(recovered.verdict, "PARTIAL");
    assert.deepEqual(await runPmInstalledManualCanary(project), recovered);
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary resumes an exact commit-index prefix but rejects a non-prefix without overwrite", async (t) => {
  if (skipUnlessLinux(t)) return;
  const seed = await activeProject("ch-pm-canary-index-prefix-seed-");
  const resumable = await activeProject("ch-pm-canary-index-prefix-");
  const hostile = await activeProject("ch-pm-canary-index-nonprefix-");
  try {
    const claimId = (await runPmInstalledManualCanary(seed)).claim_id;
    const commitName = `pm-commit-${createHash("sha256").update(`goal\0${claimId}`).digest("hex").slice(0, 32)}.json`;
    const resumableCommit = path.join(resumable, ".ycm-harness", "autonomy", "pm", "commits", commitName);
    await fs.mkdir(path.dirname(resumableCommit), { recursive: true });
    await fs.writeFile(resumableCommit, '{\n  "schema_version": 1', { encoding: "utf8", flag: "wx" });
    const repaired = await runPmInstalledManualCanary(resumable);
    assert.equal(repaired.claim_id, claimId);
    const repairedTree = await exactTree(resumable);
    assert.deepEqual(await runPmInstalledManualCanary(resumable), repaired);
    assert.deepEqual(await exactTree(resumable), repairedTree);

    const hostileCommit = path.join(hostile, ".ycm-harness", "autonomy", "pm", "commits", commitName);
    await fs.mkdir(path.dirname(hostileCommit), { recursive: true });
    const poison = '{"attacker":true}\n';
    await fs.writeFile(hostileCommit, poison, { encoding: "utf8", flag: "wx" });
    const before = await fs.stat(hostileCommit);
    await assert.rejects(runPmInstalledManualCanary(hostile), /pm_canary_commit_index_tampered/);
    const after = await fs.stat(hostileCommit);
    assert.equal(await fs.readFile(hostileCommit, "utf8"), poison);
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
    const gates = path.join(hostile, ".ycm-harness", "autonomy", "pm", "gates");
    assert.deepEqual(await fs.readdir(gates).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error)), []);
  } finally {
    await cleanup(seed); await cleanup(resumable); await cleanup(hostile);
  }
});

test("manual PM canary rejects a staged record mutated after commit publication before canonical reload", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-post-index-record-");
  let mutated = false;
  try {
    await assert.rejects(runPmInstalledManualCanary(project, { artifactStore: {
      async afterCommitIndexPublished() {
        const staging = path.join(project, ".ycm-harness", "autonomy", "pm", "staging");
        const [claimId] = await fs.readdir(staging);
        const records = path.join(staging, claimId!, "records");
        const [record] = (await fs.readdir(records)).filter((name) => name.startsWith("pm-record-")).sort();
        assert(record, "commit index did not bind a staged record");
        await fs.writeFile(path.join(records, record), '{"attacker":true}\n', "utf8");
        mutated = true;
      },
    } }), /pm_canary_commit_index_tampered/);
    assert.equal(mutated, true);
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary rejects a commit index mutated between exclusive publication and canonical reload", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-post-index-index-");
  let mutated = false;
  try {
    await assert.rejects(runPmInstalledManualCanary(project, { artifactStore: {
      async afterCommitIndexPublished() {
        const commits = path.join(project, ".ycm-harness", "autonomy", "pm", "commits");
        const [commit] = await fs.readdir(commits);
        assert(commit, "commit index was not published");
        const file = path.join(commits, commit);
        const value = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
        await fs.writeFile(file, `${JSON.stringify({ ...value, protected_state_sha256: "0".repeat(64) })}\n`, "utf8");
        mutated = true;
      },
    } }), /pm_canary_commit_index_tampered/);
    assert.equal(mutated, true);
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary rejects an indexed record mutated after handoff before committing", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-record-mutation-");
  let mutated = false;
  try {
    await assert.rejects(runPmInstalledManualCanary(project, { artifactStore: {
      async afterPmPhase(phase) {
        if (phase !== "handoff" || mutated) return;
        const staging = path.join(project, ".ycm-harness", "autonomy", "pm", "staging");
        const [claimId] = await fs.readdir(staging);
        const records = path.join(staging, claimId!, "records");
        const [record] = (await fs.readdir(records)).filter((name) => name.startsWith("pm-record-")).sort();
        assert(record, "handoff did not stage an indexed record");
        await fs.writeFile(path.join(records, record), '{"attacker":true}\n', "utf8");
        mutated = true;
      },
    } }), /pm_canary_stage_conflict/);
    assert.equal(mutated, true);
    await assertNoCanaryReceipts(project);
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary rejects a foreign staged record immediately before commit publication", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-foreign-precommit-");
  let injected = false;
  try {
    await assert.rejects(runPmInstalledManualCanary(project, { artifactStore: {
      async beforeCommitIndex() {
        const staging = path.join(project, ".ycm-harness", "autonomy", "pm", "staging");
        const [claimId] = await fs.readdir(staging);
        const records = path.join(staging, claimId!, "records");
        const foreign = `pm-record-${"a".repeat(32)}-${"b".repeat(64)}.json`;
        await fs.writeFile(path.join(records, foreign), '{"foreign":true}\n', { encoding: "utf8", flag: "wx" });
        injected = true;
      },
    } }), /pm_canary_stage_conflict/);
    assert.equal(injected, true);
    await assertNoCanaryReceipts(project);
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary replay rejects a staged record absent from the commit index", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-foreign-replay-");
  try {
    const report = await runPmInstalledManualCanary(project);
    const records = path.join(project, ".ycm-harness", "autonomy", "pm", "staging", report.claim_id, "records");
    const foreign = `pm-record-${"c".repeat(32)}-${"d".repeat(64)}.json`;
    await fs.writeFile(path.join(records, foreign), '{"foreign":true}\n', { encoding: "utf8", flag: "wx" });
    await assert.rejects(runPmInstalledManualCanary(project), /pm_canary_commit_index_tampered/);
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary retains capabilities across post-batch and per-phase ancestor swaps", async (t) => {
  if (skipUnlessLinux(t)) return;
  for (const phase of ["batch", "prepare", "handoff", "review", "status"] as const) {
    const project = await activeProject(`ch-pm-canary-cap-${phase}-`);
    const authenticated = `${project}-authenticated`;
    let replaced = false;
    const replace = async () => {
      if (replaced) return;
      replaced = true;
      await fs.rename(project, authenticated);
      await fs.mkdir(project);
    };
    try {
      await assert.rejects(runPmInstalledManualCanary(project, { artifactStore: {
        afterArtifactBatchValidated: phase === "batch" ? replace : undefined,
        afterPmPhase: async (current) => { if (current === phase) await replace(); },
      } }), /pm_canary_artifact_unsafe/);
      assert.equal(replaced, true);
      assert.deepEqual(await fs.readdir(project), []);
      await assertNoCanaryReceipts(authenticated);
    } finally {
      await cleanup(project); await cleanup(authenticated);
    }
  }
});

test("manual PM canary rejects a swapped earlier final as a batch before advancing receipts", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-batch-swap-");
  const attacker = "attacker-controlled-output\n";
  let swapped = false;
  try {
    await assert.rejects(
      runPmInstalledManualCanary(project, { artifactStore: {
        async beforeArtifactPublish(name) {
          if (name !== "prompt.txt" || swapped) return;
          swapped = true;
          const runs = path.join(project, ".ycm-harness", "autonomy", "pm", "runs");
          const [runRoot] = await fs.readdir(runs);
          await fs.writeFile(path.join(runs, runRoot!, "output.txt"), attacker, "utf8");
        },
      } }),
      /pm_canary_artifact_conflict/,
    );
    assert.equal(swapped, true);
    await assertNoCanaryReceipts(project);
    const runs = path.join(project, ".ycm-harness", "autonomy", "pm", "runs");
    const [runRoot] = await fs.readdir(runs);
    assert.equal(await fs.readFile(path.join(runs, runRoot!, "output.txt"), "utf8"), attacker);
  } finally {
    await cleanup(project);
  }
});

test("pinned artifact store rejects an unbounded artifact batch before mutation", async () => {
  const project = await activeProject("ch-pm-canary-artifact-count-");
  let callbackCalled = false;
  try {
    await assert.rejects(
      persistPinnedLocalArtifacts(project, [".ycm-harness", "autonomy", "pm", "runs", "bounded"],
        Array.from({ length: 65 }, (_, index) => ({ name: `artifact-${index}.txt`, content: "x\n" })),
        async () => { callbackCalled = true; }),
      /pm_canary_artifact_unsafe/,
    );
    assert.equal(callbackCalled, false);
    await assert.rejects(fs.access(path.join(project, ".ycm-harness", "autonomy", "pm", "runs")));
    await assertNoCanaryReceipts(project);
  } finally {
    await cleanup(project);
  }
});

test("pinned artifact store retains artifact capabilities until asynchronous post-commit readback settles", async (t) => {
  if (skipUnlessLinux(t)) return;
  const project = await activeProject("ch-pm-canary-after-commit-await-");
  const storeSegments = [".ycm-harness", "autonomy", "pm", "runs", "after-commit-await"];
  let readAfterCompletion: (() => Promise<Buffer>) | undefined;
  try {
    const result = await persistPinnedLocalArtifacts(project, storeSegments, [{ name: "output.txt", content: "committed\n" }],
      async () => "output.txt", {}, { goalId: "goal", claimId: "after-commit-await" }, async (execution, artifactName) => {
        const file = path.join(execution.resolved.root, ...storeSegments, artifactName);
        readAfterCompletion = () => execution.readArtifact(file, 64);
        await new Promise<void>((resolve) => setImmediate(resolve));
        return (await execution.readArtifact(file, 64)).toString("utf8");
      });
    assert.equal(result, "committed\n");
    assert(readAfterCompletion);
    await assert.rejects(readAfterCompletion(), /pm_canary_artifact_unsafe/);
  } finally {
    await cleanup(project);
  }
});

test("manual PM canary accepts an exact pre-existing final artifact without overwriting it", async (t) => {
  if (skipUnlessLinux(t)) return;
  const seed = await activeProject("ch-pm-canary-exact-seed-");
  const project = await activeProject("ch-pm-canary-exact-final-");
  try {
    const claimId = (await runPmInstalledManualCanary(seed)).claim_id;
    const runRoot = pmWorkerRunRoot(project, "goal", claimId);
    await fs.mkdir(runRoot, { recursive: true });
    const prompt = "Run the installed deterministic local-only PM evidence canary.\n";
    await fs.writeFile(path.join(runRoot, "prompt.txt"), prompt, { encoding: "utf8", flag: "wx" });
    const before = await fs.stat(path.join(runRoot, "prompt.txt"));
    const report = await runPmInstalledManualCanary(project);
    const after = await fs.stat(path.join(runRoot, "prompt.txt"));
    assert.equal(report.verdict, "PARTIAL");
    assert.equal(await fs.readFile(path.join(runRoot, "prompt.txt"), "utf8"), prompt);
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
  } finally {
    await cleanup(seed);
    await cleanup(project);
  }
});

test("manual PM canary rejects a conflicting final artifact before prepare", async (t) => {
  if (skipUnlessLinux(t)) return;
  const seed = await activeProject("ch-pm-canary-conflict-seed-");
  const project = await activeProject("ch-pm-canary-conflict-");
  try {
    const claimId = (await runPmInstalledManualCanary(seed)).claim_id;
    const runRoot = pmWorkerRunRoot(project, "goal", claimId);
    await fs.mkdir(runRoot, { recursive: true });
    const file = path.join(runRoot, "prompt.txt");
    await fs.writeFile(file, "attacker-content\n", { encoding: "utf8", flag: "wx" });
    const before = await fs.stat(file);
    await assert.rejects(runPmInstalledManualCanary(project), /pm_canary_artifact_conflict/);
    const after = await fs.stat(file);
    assert.equal(await fs.readFile(file, "utf8"), "attacker-content\n");
    assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino);
    await assertNoCanaryReceipts(project);
  } finally {
    await cleanup(seed);
    await cleanup(project);
  }
});

test("installed PM operator fails closed on missing, nonregular, symlinked, and escaped runtimes", async () => {
  const source = packageRoot();
  const sourceScript = path.join(source, "plugin", "scripts", "pm-installed-canary.mjs");
  const sourceRuntime = path.join(source, "dist", "index.js");
  const project = await activeProject("ch-pm-operator-layout-project-");
  const projections: string[] = [];
  const makeProjection = async (prefix: string): Promise<string> => {
    const root = await tempProject(prefix); projections.push(root);
    await fs.mkdir(path.join(root, "scripts"), { recursive: true });
    await fs.copyFile(sourceScript, path.join(root, "scripts", "pm-installed-canary.mjs"));
    return root;
  };
  try {
    const missing = await makeProjection("ch-pm-operator-missing-");
    const escaped = await makeProjection("ch-pm-operator-escaped-");
    await fs.mkdir(path.join(escaped, "dist"), { recursive: true });
    await fs.copyFile(sourceRuntime, path.join(escaped, "dist", "index.js"));
    const nonregular = await makeProjection("ch-pm-operator-nonregular-");
    await fs.mkdir(path.join(nonregular, "runtime", "dist", "index.js"), { recursive: true });
    const symlinked = await makeProjection("ch-pm-operator-symlink-runtime-");
    await fs.mkdir(path.join(symlinked, "runtime", "dist"), { recursive: true });
    await fs.symlink(sourceRuntime, path.join(symlinked, "runtime", "dist", "index.js"), "file");
    const scriptLink = await tempProject("ch-pm-operator-symlink-script-"); projections.push(scriptLink);
    await fs.mkdir(path.join(scriptLink, "scripts"), { recursive: true });
    await fs.symlink(sourceScript, path.join(scriptLink, "scripts", "pm-installed-canary.mjs"), "file");

    for (const root of [missing, escaped, nonregular, symlinked, scriptLink]) {
      const result = runInstalledOperator(path.join(root, "scripts", "pm-installed-canary.mjs"), project);
      assert.equal(result.status, 1, result.stderr);
      assert.deepEqual(JSON.parse(result.stderr), { ok: false, reason_code: "pm_canary_runtime_missing" });
    }
  } finally {
    await cleanup(project);
    for (const projection of projections) await cleanup(projection);
  }
});

test("PM operator contract documents the exact hashed stores and bounded authority", async () => {
  const source = packageRoot();
  const contract = await fs.readFile(path.join(source, "plugin", "skills", "autonomous-harness", "references", "pm-operator.md"), "utf8");
  assert.match(contract, /runs\/pm-run-<24-lowercase-hex>/);
  assert.match(contract, /staging\/<claim-id>\/records\/pm-record-<32-lowercase-hex>-<64-lowercase-hex>\.json/);
  assert.match(contract, /commits\/pm-commit-<32-lowercase-hex>\.json/);
  assert.match(contract, /singular `handoff`, singular `review`/);
  assert.doesNotMatch(contract, /runs\/<goal>\/<claim>/);
  assert.match(contract, /without `--record-gap` is read-only/);
  assert.match(contract, /`--record-gap` is the sole bounded, idempotent local receipt mutation/);
  assert.doesNotMatch(contract, /`autonomy pm status --file request\.json` is read-only/);
  assert.match(contract, /Phase 6 owns strategic nightly learning/);
  assert.match(contract, /Phase 7 owns\s+scheduler lifecycle integration/);
  assert.match(await fs.readFile(path.join(source, ".gitignore"), "utf8"), /(?:^|\r?\n)\.ycm-harness\/(?:\r?\n|$)/);
});

test("v3 manual installed canary retains legacy v1 and v2 report bytes while superseding their claims", async (t) => {
  if (skipUnlessLinux(t)) return;
  const legacyGoal = "goal_autonomy-phase-5-daily-pm-execution-and-independent-correction_5d01";
  const legacyClaim = "pmc-58b6aac99182162bd8baac96f1d94c63";
  const project = await activeProject("ch-pm-canary-worker-provenance-upgrade-", legacyGoal);
  try {
    const legacyV1 = await writeLegacyReport(project, legacyGoal, legacyClaim, 1);
    const legacyV2 = await writeLegacyReport(project, legacyGoal, `pmc-${"7".repeat(32)}`, 2);
    const report = await runPmInstalledManualCanary(project);
    assert.equal(report.schema_version, 3);
    assert.notEqual(report.claim_id, legacyV1.claimId); assert.notEqual(report.claim_id, legacyV2.claimId);
    assert.equal(await fs.readFile(legacyV1.file, "utf8"), legacyV1.bytes);
    assert.equal(await fs.readFile(legacyV2.file, "utf8"), legacyV2.bytes);
    const beforeReplay = await exactTree(project);
    assert.deepEqual(await runPmInstalledManualCanary(project), report);
    assert.deepEqual(await exactTree(project), beforeReplay);
  } finally { await cleanup(project); }
});

test("fresh installed PM runtime has parity and persists one honest PARTIAL gate", async (t) => {
  if (skipUnlessLinux(t)) return;
  await withTempUserHome(async (home) => {
    const sourceProject = await activeProject("ch-pm-built-canary-");
    const installedProject = await activeProject("ch-pm-installed-canary-");
    try {
      const source = packageRoot();
      await runClientSync({ cursor: true, codex: false, opencode: false, force: true, sourceRoot: source });
      const builtCli = path.join(source, "dist", "cli", "index.js");
      const installedRoot = path.join(home, ".cursor", "plugins", "ycm-harness");
      const installedCli = path.join(installedRoot, "runtime", "dist", "cli", "index.js");
      const builtRuntime = path.join(source, "dist", "index.js");
      const installedRuntime = path.join(installedRoot, "runtime", "dist", "index.js");
      const installedOperator = path.join(installedRoot, "scripts", "pm-installed-canary.mjs");
      const sourceActorManifest = await fs.readFile(path.join(source, "plugin", "config", "pm-actor-origins.json"), "utf8");
      const installedActorManifest = await fs.readFile(path.join(installedRoot, "config", "pm-actor-origins.json"), "utf8");
      assert.equal(installedActorManifest, sourceActorManifest);
      assert.deepEqual(JSON.parse(installedActorManifest), { schema_version: 1, origins: [] });
      assert.doesNotMatch(installedActorManifest, /PRIVATE KEY/);
      await assertNoPrivateKey(installedRoot);
      for (const [command, reason] of new Map([
        ["prepare", "pm_invalid_request"], ["handoff", "pm_invalid_handoff_request"],
        ["review", "pm_invalid_review_request"], ["status", "pm_invalid_status_request"],
      ])) {
        const built = runCli(builtCli, installedProject, command, {});
        const installed = runCli(installedCli, installedProject, command, {});
        assert.equal(built.status, 1, built.stderr); assert.equal(installed.status, 1, installed.stderr);
        assert.equal(installed.stderr, built.stderr);
        assert.equal((JSON.parse(installed.stderr) as { reason_code: string }).reason_code, reason);
      }

      const sourceRun = runRuntimeCanaryTrace(builtRuntime, sourceProject);
      const installedRun = runInstalledOperator(installedOperator, installedProject);
      assert.equal(sourceRun.status, 0, sourceRun.stderr); assert.equal(installedRun.status, 0, installedRun.stderr);
      assert.equal(installedRun.stdout, sourceRun.stdout);
      const trace = JSON.parse(installedRun.stdout) as { schema_version: number; commands: Record<string, unknown>; report: {
        report_id: string; verdict: string; reason_code: string; claim_id: string; evidence_class: string; provider: string;
        receipt_ids: Record<string, string>; safety: Record<string, number> } };
      assert.equal(trace.schema_version, 3);
      assert.deepEqual(Object.keys(trace.commands), ["prepare", "handoff", "review", "status"]);
      for (const command of Object.values(trace.commands)) assert.equal(typeof command, "object");
      const report = trace.report;
      assert.equal((report as { schema_version?: number }).schema_version, 3);
      assert.equal(report.verdict, "PARTIAL"); assert.equal(report.reason_code, "PM_NATURAL_EVIDENCE_MISSING");
      assert.equal(report.evidence_class, "manual_local_provider"); assert.equal(report.provider, "deterministic_local_double");
      assert.deepEqual(report.safety, { provider_lifecycle_mutations: 0, schedule_mutations: 0, deliveries: 0 });
      assert.match(report.receipt_ids.gap!, /^pmg-[0-9a-f]{32}$/);
      const handoff = trace.commands.handoff as { worker_origin?: { assurance?: string; selector?: unknown } };
      const review = trace.commands.review as { reviewer_origin?: { assurance?: string; selector?: unknown } };
      assert.equal(handoff.worker_origin?.assurance, "manual_local_double");
      assert.equal(review.reviewer_origin?.assurance, "manual_local_double");
      const installedRunRoot = pmWorkerRunRoot(installedProject, "goal", report.claim_id);
      const runNames = await fs.readdir(installedRunRoot);
      const temps = runNames.filter((name) => /^\.pm-artifact-[0-9a-f]{64}\.stage$/.test(name));
      assert.equal(temps.length, 4);
      for (const finalName of ["prompt.txt", "output.txt", "exit-status.txt", "meaningful.log"]) {
        const finalStat = await fs.stat(path.join(installedRunRoot, finalName));
        const matchingTemps = [];
        for (const temp of temps) {
          const tempStat = await fs.stat(path.join(installedRunRoot, temp));
          if (tempStat.dev === finalStat.dev && tempStat.ino === finalStat.ino) matchingTemps.push(temp);
        }
        assert.equal(matchingTemps.length, 1, `${finalName} was not atomically linked from one exclusive attempt temp`);
      }
      const beforeReplay = await exactTree(installedProject);
      const replay = runInstalledOperator(installedOperator, installedProject);
      assert.equal(replay.status, 0, replay.stderr); assert.equal(replay.stdout, installedRun.stdout);
      assert.deepEqual(await exactTree(installedProject), beforeReplay);
      const pmRoot = path.join(installedProject, ".ycm-harness", "autonomy", "pm");
      const gaps = await fs.readdir(path.join(pmRoot, "gaps")).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
      const gates = await fs.readdir(path.join(pmRoot, "gates")).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
      assert.deepEqual(gaps, []); assert.deepEqual(gates, []);
      const commits = await fs.readdir(path.join(pmRoot, "commits"));
      assert.equal(commits.length, 1);
      const commitFile = path.join(pmRoot, "commits", commits[0]!);
      const commitIndex = JSON.parse(await fs.readFile(commitFile, "utf8")) as {
        current: Array<{ key: string; ref: string }>; artifacts: Array<{ name: string; sha256: string }>;
      };
      assert.equal(commitIndex.current.filter((row) => row.key.includes("/gaps/")).length, 1);
      assert.deepEqual(commitIndex.current.filter((row) => row.key.includes("/gates/")).map((row) => path.basename(row.key)),
        [`${report.report_id}.json`]);
      assert.equal(commitIndex.artifacts.length, 4);

      for (const [runtime, prefix] of [
        [builtRuntime, "ch-pm-source-runroot-link-"],
        [installedRuntime, "ch-pm-installed-runroot-link-"],
      ]) {
        const attackProject = await activeProject(prefix);
        const outside = await tempProject(`${prefix}outside-`);
        try {
          const runRoot = pmWorkerRunRoot(attackProject, "goal", report.claim_id);
          await fs.mkdir(path.dirname(runRoot), { recursive: true });
          await fs.symlink(outside, runRoot, "dir");
          const outsideBefore = await contentTree(outside);
          assertArtifactUnsafe(runRuntimeCanary(runtime, attackProject));
          assert.deepEqual(await contentTree(outside), outsideBefore);
          await assertNoCanaryReceipts(attackProject);
        } finally {
          await cleanup(attackProject); await cleanup(outside);
        }
      }

      const artifactAttack = await activeProject("ch-pm-installed-artifact-link-");
      const artifactOutside = await tempProject("ch-pm-installed-artifact-outside-");
      try {
        const runRoot = pmWorkerRunRoot(artifactAttack, "goal", report.claim_id);
        await fs.mkdir(runRoot, { recursive: true });
        await fs.symlink(path.join(artifactOutside, "captured.txt"), path.join(runRoot, "prompt.txt"), "file");
        const outsideBefore = await contentTree(artifactOutside);
        assertArtifactUnsafe(runRuntimeCanary(installedRuntime, artifactAttack));
        assert.deepEqual(await contentTree(artifactOutside), outsideBefore);
        await assertNoCanaryReceipts(artifactAttack);
      } finally {
        await cleanup(artifactAttack); await cleanup(artifactOutside);
      }

      const indexValue = JSON.parse(await fs.readFile(commitFile, "utf8")) as Record<string, unknown>;
      await fs.writeFile(commitFile, `${JSON.stringify({ ...indexValue, protected_state_sha256: "0".repeat(64) })}\n`, "utf8");
      const tampered = runRuntimeCanary(installedRuntime, installedProject);
      assert.equal(tampered.status, 1); assert.match(tampered.stderr, /pm_canary_commit_index_tampered/);
    } finally {
      await cleanup(sourceProject); await cleanup(installedProject);
    }
  });
});

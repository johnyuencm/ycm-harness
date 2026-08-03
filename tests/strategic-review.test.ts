import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { review as publicReview } from "../src/index.js";
import { withStrategicReviewTestDependencies } from "../src/autonomy/strategic-review.js";
import {
  bindCoordination,
  type MulticaInvocation,
  type MulticaRunner,
} from "../src/autonomy/coordination.js";
import { readContinuationAudits } from "../src/continuation/audit.js";
import { emptyStateV3 } from "../src/schema/v3.js";
import { HarnessStore } from "../src/state/store.js";
import { providerForState as actualProviderForState } from "../src/tickets/provider.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function canonicalTestJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]));
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

async function createSignedReviewInstallation(authenticatedRequest: Record<string, any>): Promise<string> {
  const installationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-installation-"));
  const configRoot = path.join(installationRoot, "config");
  const recordRoot = path.join(installationRoot, "records");
  await fs.mkdir(configRoot, { recursive: true });
  await fs.mkdir(recordRoot, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const originId = authenticatedRequest.evidence_origin?.origin_id ?? "installed-review-origin";
  const recordId = authenticatedRequest.evidence_origin?.record_id ?? `review-evidence-${authenticatedRequest.profile.replace(/[^A-Za-z0-9._:-]/g, "-")}`;
  authenticatedRequest.evidence_origin = { origin_id: originId, record_id: recordId };
  const keyId = "review-key-1";
  await fs.writeFile(path.join(configRoot, "strategic-review-origins.json"), JSON.stringify({
    schema_version: 1,
    origins: [{
      origin_id: originId,
      record_root: recordRoot,
      key_id: keyId,
      public_key_pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      profiles: [{
        profile: authenticatedRequest.profile,
        domain: authenticatedRequest.authority.domain,
        proof: authenticatedRequest.authority.proof,
        recurrence_threshold: 2,
      }],
    }],
  }), "utf8");
  const recordBytes = Buffer.from(JSON.stringify({
    schema_version: 1,
    origin_id: originId,
    record_id: recordId,
    key_id: keyId,
    installation_id: authenticatedRequest.authority.installation_id,
    profile: authenticatedRequest.profile,
    domain: authenticatedRequest.authority.domain,
    evidence: authenticatedRequest.evidence,
  }), "utf8");
  await fs.writeFile(path.join(recordRoot, `${recordId}.json`), recordBytes);
  await fs.writeFile(path.join(recordRoot, `${recordId}.sig`), signBytes(null, recordBytes, privateKey).toString("base64"), "utf8");
  return installationRoot;
}

async function projectSourceCliIntoInstallation(installationRoot: string): Promise<string> {
  const packageRoot = path.join(installationRoot, "runtime");
  await fs.mkdir(path.join(installationRoot, ".cursor-plugin"), { recursive: true });
  await fs.copyFile(
    path.join(repoRoot, "plugin", ".cursor-plugin", "plugin.json"),
    path.join(installationRoot, ".cursor-plugin", "plugin.json"),
  );
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.copyFile(path.join(repoRoot, "package.json"), path.join(packageRoot, "package.json"));
  await fs.cp(path.join(repoRoot, "src"), path.join(packageRoot, "src"), { recursive: true });
  await fs.symlink(path.join(repoRoot, "node_modules"), path.join(packageRoot, "node_modules"), "dir");
  return path.join(packageRoot, "src", "cli", "index.ts");
}

async function review(
  request: Record<string, any>,
  authenticatedRequest: Record<string, any> = request,
  dependencies: Parameters<typeof withStrategicReviewTestDependencies>[0] = {},
): ReturnType<typeof publicReview> {
  const installationRoot = await createSignedReviewInstallation(authenticatedRequest);
  request.evidence_origin ??= authenticatedRequest.evidence_origin;
  try {
    return await withStrategicReviewTestDependencies(
      { ...dependencies, installationRoot: async () => installationRoot },
      () => publicReview(request as Parameters<typeof publicReview>[0]),
    );
  } finally {
    await fs.rm(installationRoot, { recursive: true, force: true });
  }
}

async function reviewFromInstallation(
  request: Record<string, any>,
  installationRoot: string,
): ReturnType<typeof publicReview> {
  return withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => publicReview(request as Parameters<typeof publicReview>[0]),
  );
}

async function reviewWithoutEnrollment(request: Record<string, any>): ReturnType<typeof publicReview> {
  const installationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-installation-"));
  try {
    await fs.mkdir(path.join(installationRoot, "config"), { recursive: true });
    await fs.writeFile(path.join(installationRoot, "config", "strategic-review-origins.json"), JSON.stringify({
      schema_version: 1,
      origins: [],
    }), "utf8");
    request.evidence_origin ??= { origin_id: "installed-review-origin", record_id: "missing-review-evidence" };
    return await reviewFromInstallation(request, installationRoot);
  } finally {
    await fs.rm(installationRoot, { recursive: true, force: true });
  }
}

test("review rejects a profile not enrolled by the installation", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const result = await review({
      cwd,
      operation: "evaluate",
      profile: "generic-strategic-review",
      mode: "normal",
      producer: {
        id: "reviewer-1",
        slot: "daily-review",
      },
      authority: {
        installation_id: "installation-1",
        profile: "generic-strategic-review",
        domain: "generic",
        proof: "fixture-authority-proof",
      },
      evidence: {
        maximum_references: 1,
        references: [],
      },
    });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "PROFILE_NOT_AUTHORIZED",
      mutation_count: 0,
    });
    assert.deepEqual(await fs.readdir(cwd), []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("bounded snapshot returns an honest four-class report without mutation", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-snapshot.json", import.meta.url),
      "utf8",
    ));
    const result = await review({ cwd, ...fixture });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, "SNAPSHOT");
    assert.equal(result.report.schema_version, 1);
    assert.equal(result.report.profile, "pm-17:00");
    assert.equal(result.report.mode, "bounded_snapshot");
    assert.deepEqual(
      result.report.evidence.references.map((reference) => reference.classification),
      ["FACT", "INFERENCE", "UNKNOWN", "UNAVAILABLE"],
    );
    assert.deepEqual(result.report.exemptions, [
      "durable_tracking",
      "closed_loop_action",
      "mutation",
    ]);
    assert.match(result.report_id, /^review-[a-f0-9]{64}$/);
    assert.match(result.report_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(JSON.parse(result.report_bytes).report, result.report);
    assert.equal(result.mutation_count, 0);
    assert.deepEqual(await fs.readdir(cwd), []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("bounded snapshot rejects continuation-bearing and mutation-capable requests without changing state", async () => {
  const cases: Array<[string, (fixture: Record<string, any>) => void]> = [
    ["continuation", (fixture) => {
      fixture.continuation = {
        parent_id: "caller-parent",
        run_id: "snapshot-run",
        session_id: "snapshot-session",
        response_text: "fabricated continuation",
        tickets: {},
        mutations: [],
      };
    }],
    ["integrity follow-up", (fixture) => {
      fixture.integrity = {
        observed_source_ownership_sha256: "f".repeat(64),
        follow_up: {
          operation: "create_or_reuse",
          stable_key: "caller-key",
          finding_id: "caller-finding",
          ticket_id: "CALLER-1",
          evidence_reference_id: "current-plan",
        },
      };
    }],
    ["tracked lane", (fixture) => {
      fixture.analysis = {
        lanes: {
          NOW: [{
            finding_id: "snapshot-finding",
            action: "mutate",
            evidence: ["current-plan"],
            disposition: "TRACKED",
          }],
          NEXT: [],
          LATER: [],
        },
      };
    }],
  ];

  for (const [name, mutate] of cases) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
    try {
      await fs.writeFile(path.join(cwd, "sentinel.txt"), "unchanged", "utf8");
      const fixture = JSON.parse(await fs.readFile(
        new URL("./fixtures/strategic-review/pm-snapshot.json", import.meta.url),
        "utf8",
      ));
      mutate(fixture);
      const before = await fs.readdir(cwd);

      const result = await review({ cwd, ...fixture });

      assert.deepEqual(result, {
        ok: false,
        status: "BLOCKED",
        reason: "SNAPSHOT_MUTATION_FORBIDDEN",
        mutation_count: 0,
      }, name);
      assert.deepEqual(await fs.readdir(cwd), before, name);
      assert.equal(await fs.readFile(path.join(cwd, "sentinel.txt"), "utf8"), "unchanged", name);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
});

test("review rejects installation-authority expansion", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-snapshot.json", import.meta.url),
      "utf8",
    ));
    fixture.authority.domain = "workspace-operations";
    fixture.authority.proof = "strategic-review/v1/pm-17:00/workspace-operations";

    const result = await review({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "PROFILE_AUTHORITY_EXPANSION",
      mutation_count: 0,
    });
    assert.deepEqual(await fs.readdir(cwd), []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("bounded snapshot rejects an evidence manifest over its declared bound", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-snapshot.json", import.meta.url),
      "utf8",
    ));
    fixture.evidence.maximum_references = 3;

    const result = await review({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "SNAPSHOT_BOUND_EXCEEDED",
      mutation_count: 0,
    });
    assert.deepEqual(await fs.readdir(cwd), []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("normal review satisfies all twelve obligations through existing policy and continuation authorities", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    const result = await review({ cwd, ...fixture });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, "PASS");
    assert.equal(result.report.mode, "normal");
    assert.equal(result.report.obligations.length, 12);
    assert.ok(result.report.obligations.every((obligation) => obligation.status === "PASS"));
    assert.equal(result.report.resource_stewardship.verdict, "PASS");
    assert.deepEqual(result.report.resource_stewardship.trace.model_invocations, [], "no-agent performs zero model calls");
    assert.equal(result.report.continuation.status, "PASS");
    assert.deepEqual(Object.keys(result.report.lanes), ["NOW", "NEXT", "LATER"]);
    assert.equal(result.report.lanes.NEXT.length, 0);
    assert.equal(result.report.lanes.LATER.length, 0);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("normal review requires at least one prior commitment and one user feedback item", async () => {
  for (const field of ["prior_commitments", "user_feedback"] as const) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
    try {
      const fixture = JSON.parse(await fs.readFile(
        new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
        "utf8",
      ));
      fixture.analysis[field] = [];

      const result = await review({ cwd, ...fixture });

      assert.deepEqual(result, {
        ok: false,
        status: "BLOCKED",
        reason: "REVIEW_CONTRACT_INCOMPLETE",
        mutation_count: 0,
      }, field);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
});

test("generic appendix and fabricated FACT evidence cannot authenticate a normal review", async () => {
  for (const tamper of ["generic_appendix", "fabricated_digest"] as const) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
    try {
      const fixture = JSON.parse(await fs.readFile(
        new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
        "utf8",
      ));
      const authenticatedFixture = structuredClone(fixture);
      if (tamper === "generic_appendix") fixture.evidence.references[0].source = "fixture://generic/appendix";
      else fixture.evidence.references[0].digest = "f".repeat(64);

      const result = await review({ cwd, ...fixture }, authenticatedFixture);

      assert.equal(result.ok, false, tamper);
      if (result.ok) continue;
      assert.equal(result.reason, "EVIDENCE_UNAVAILABLE", tamper);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
});

test("corrupt installation state is an integrity failure rather than ordinary unenrollment", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  const installationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-installation-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/optional-domain-normal.json", import.meta.url),
      "utf8",
    ));
    fixture.evidence_origin = { origin_id: "installed-review-origin", record_id: "optional-domain-evidence" };
    await fs.mkdir(path.join(installationRoot, "config"), { recursive: true });
    await fs.writeFile(path.join(installationRoot, "config", "strategic-review-origins.json"), "{not-json", "utf8");

    const result = await reviewFromInstallation({ cwd, ...fixture }, installationRoot);

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "REVIEW_INTEGRITY_FAILURE",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    await fs.rm(installationRoot, { recursive: true, force: true });
  }
});

test("recurrence evidence cannot be consolidated under a different finding identity", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    for (const reference of fixture.evidence.references) {
      if (reference.role === "recurrence_7d" || reference.role === "recurrence_30d") {
        reference.finding_id = "different-finding";
      }
    }

    const result = await review({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "REVIEW_CONTRACT_INCOMPLETE",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("recurring duplicate symptoms cannot become separate cleanup actions", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    fixture.analysis.lanes.NOW = [
      {
        finding_id: "triage-root-cause",
        action: "Clean late-triage symptom",
        evidence: ["recurrence-week"],
        disposition: "TRACKED",
        ticket_id: "PM-1",
      },
      {
        finding_id: "triage-root-cause",
        action: "Clean stale-triage symptom",
        evidence: ["recurrence-month"],
        disposition: "TRACKED",
        ticket_id: "PM-1",
      },
    ];

    const result = await review({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "RECURRENCE_ROOT_CAUSE_REQUIRED",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("cost-policy failure preserves the existing reason and one idempotent correction pair", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    fixture.resource_stewardship.execution_policy = {
      stages: [
        { stage: "no_agent", outcome: "inapplicable", reason: "requires_synthesis", evidence_reference: "current-plan", observation_count: 1 },
        { stage: "script", outcome: "skipped" },
        { stage: "targeted_read", outcome: "insufficient", reason: "targeted_read_insufficient", evidence_reference: "current-plan", observation_count: 1 },
        { stage: "reuse_reference", outcome: "insufficient", reason: "reference_insufficient", evidence_reference: "prior-plan", observation_count: 1 },
        { stage: "model", outcome: "sufficient" },
      ],
      required_capabilities: ["synthesis"],
      model_roster: [
        { model_id: "bounded-low", tier: "bounded", cost_rank: 1, capabilities: ["synthesis"] },
      ],
      model_invocations: [
        { role: "executor", model_id: "bounded-low", required_capabilities: ["synthesis"], recursive: false },
      ],
    };

    const first = await review({ cwd, ...fixture });
    const replay = await review({ cwd, ...fixture });

    assert.equal(first.ok, false);
    assert.equal(replay.ok, false);
    if (first.ok || replay.ok) return;
    assert.equal(first.reason, "POLICY_STAGE_SKIPPED:script");
    assert.deepEqual(first.reasons, ["POLICY_STAGE_SKIPPED:script"]);
    const audits = (await readContinuationAudits(cwd)).filter((record) =>
      record.schema_version === 2
      && record.surface === "strategic-review"
      && record.mode === "normal"
      && record.policy.verdict === "FAIL");
    assert.equal(audits.length, 1);
    const audit = audits[0];
    assert.ok(audit?.schema_version === 2);
    assert.match(first.policy_failure_id, /^[a-f0-9]{64}$/);
    assert.match(first.correction_reservation_id, /^[a-f0-9]{64}$/);
    assert.equal(first.policy_failure_id, audit.policy.policy_failure_id);
    assert.equal(first.correction_reservation_id, audit.policy.correction_reservation_id);
    assert.equal(replay.policy_failure_id, audit.policy.policy_failure_id);
    assert.equal(replay.correction_reservation_id, audit.policy.correction_reservation_id);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("a second correction is rejected without an open retry route", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url), "utf8"));
    fixture.resource_stewardship.execution_policy = {
      stages: [
        { stage: "no_agent", outcome: "inapplicable", reason: "requires_synthesis", evidence_reference: "current-plan", observation_count: 1 },
        { stage: "script", outcome: "insufficient", reason: "script_insufficient", evidence_reference: "current-plan", observation_count: 1 },
        { stage: "targeted_read", outcome: "insufficient", reason: "read_insufficient", evidence_reference: "current-plan", observation_count: 1 },
        { stage: "reuse_reference", outcome: "insufficient", reason: "reuse_insufficient", evidence_reference: "prior-plan", observation_count: 1 },
        { stage: "model", outcome: "sufficient" },
      ],
      required_capabilities: ["synthesis"],
      model_roster: [{ model_id: "bounded-low", tier: "bounded", cost_rank: 1, capabilities: ["synthesis"] }],
      model_invocations: [
        { role: "executor", model_id: "bounded-low", required_capabilities: ["synthesis"], recursive: false },
        { role: "correction", model_id: "bounded-low", required_capabilities: ["synthesis"], recursive: false },
        { role: "correction", model_id: "bounded-low", required_capabilities: ["synthesis"], recursive: false },
      ],
    };

    const result = await review({ cwd, ...fixture });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.ok(result.reasons?.includes("CORRECTION_BUDGET_EXCEEDED"));
    assert.match(result.correction_reservation_id ?? "", /^[a-f0-9]{64}$/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("accepted normal review is content-addressed and read back byte-for-byte", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    const result = await review({ cwd, ...fixture });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.report_id, /^review-[a-f0-9]{64}$/);
    assert.match(result.report_sha256, /^[a-f0-9]{64}$/);
    assert.equal(result.storage_reference, `.ycm-harness/autonomy/strategic-reviews/reports/${result.report_id}.json`);
    const stored = await fs.readFile(path.join(cwd, result.storage_reference), "utf8");
    assert.equal(stored, result.report_bytes);
    assert.deepEqual(JSON.parse(stored).report, result.report);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("replay returns the accepted report byte-for-byte without duplicate storage", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    const evaluated = await review({ cwd, ...fixture });
    assert.equal(evaluated.ok, true);
    if (!evaluated.ok || evaluated.status !== "PASS") return;
    const reports = path.join(cwd, ".ycm-harness", "autonomy", "strategic-reviews", "reports");
    const before = await fs.readdir(reports);

    const replayed = await review({
      cwd,
      ...fixture,
      operation: "replay",
      report_id: evaluated.report_id,
    });

    assert.equal(replayed.ok, true);
    if (!replayed.ok || replayed.status !== "PASS") return;
    assert.equal(replayed.report_id, evaluated.report_id);
    assert.equal(replayed.report_bytes, evaluated.report_bytes);
    assert.deepEqual(await fs.readdir(reports), before);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("replay conflicts when continuation run or live-proof identity drifts", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    const evaluated = await review({ cwd, ...fixture });
    assert.equal(evaluated.ok, true);
    if (!evaluated.ok || evaluated.status !== "PASS") return;

    fixture.continuation.run_id = "different-run";
    fixture.continuation.tickets["PM-1"].readback_at = "2026-07-18T17:01:00.000Z";
    const result = await review({
      cwd,
      ...fixture,
      operation: "replay",
      report_id: evaluated.report_id,
    });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "REVIEW_REPLAY_CONFLICT",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("replay fails closed when a stored identity is presented under another profile", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    const evaluated = await review({ cwd, ...fixture });
    assert.equal(evaluated.ok, true);
    if (!evaluated.ok || evaluated.status !== "PASS") return;

    const result = await review({
      cwd,
      ...fixture,
      operation: "replay",
      report_id: evaluated.report_id,
      profile: "nightly-workspace",
      authority: {
        ...fixture.authority,
        profile: "nightly-workspace",
        domain: "workspace",
        proof: "strategic-review/v1/nightly-workspace/workspace",
      },
    });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "REVIEW_REPLAY_CONFLICT",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("status authenticates an accepted report without repairing or rewriting it", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    const evaluated = await review({ cwd, ...fixture });
    assert.equal(evaluated.ok, true);
    if (!evaluated.ok || evaluated.status !== "PASS") return;
    const reportPath = path.join(cwd, evaluated.storage_reference);
    const before = await fs.stat(reportPath);

    const result = await review({
      cwd,
      ...fixture,
      operation: "status",
      report_id: evaluated.report_id,
    });

    assert.equal(result.ok, true);
    if (!result.ok || !("receipt" in result)) return;
    assert.deepEqual(result.receipt, {
      schema_version: 1,
      report_id: evaluated.report_id,
      report_sha256: evaluated.report_sha256,
      profile: "pm-17:00",
      mode: "normal",
      report_status: "PASS",
      storage_reference: evaluated.storage_reference,
    });
    assert.equal((await fs.stat(reportPath)).mtimeMs, before.mtimeMs);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("status and replay reject canonical extra stored fields", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    const evaluated = await review({ cwd, ...fixture });
    assert.equal(evaluated.ok, true);
    if (!evaluated.ok || evaluated.status !== "PASS") return;
    const target = path.join(cwd, ...evaluated.storage_reference.split("/"));
    const stored = JSON.parse(await fs.readFile(target, "utf8"));
    stored.forged_extra_top_level = "not-committed";
    await fs.writeFile(target, `${canonicalTestJson(stored)}\n`, "utf8");

    for (const operation of ["status", "replay"] as const) {
      const result = await review({
        cwd,
        ...fixture,
        operation,
        report_id: evaluated.report_id,
      });
      assert.deepEqual(result, {
        ok: false,
        status: "BLOCKED",
        reason: "REVIEW_INTEGRITY_FAILURE",
        mutation_count: 0,
      }, operation);
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("status and replay reauthenticate signed evidence before returning PASS", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    const authenticatedFixture = structuredClone(fixture);
    const evaluated = await review({ cwd, ...fixture }, authenticatedFixture);
    assert.equal(evaluated.ok, true);
    if (!evaluated.ok || evaluated.status !== "PASS") return;
    fixture.evidence.references[0].digest = "f".repeat(64);

    for (const operation of ["status", "replay"] as const) {
      const result = await review({
        cwd,
        ...fixture,
        operation,
        report_id: evaluated.report_id,
      }, authenticatedFixture);
      assert.equal(result.ok, false, operation);
      if (!result.ok) assert.equal(result.reason, "EVIDENCE_UNAVAILABLE", operation);
    }
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("material findings cannot expand beyond the installed profile domain", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    fixture.analysis.findings[0].domain = "workspace";

    const result = await review({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "PROFILE_AUTHORITY_EXPANSION",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("snapshot reports unauthenticated current evidence as unavailable instead of PASS", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-snapshot.json", import.meta.url),
      "utf8",
    ));
    fixture.evidence.references[0].digest = "not-authenticated";

    const result = await review({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "PARTIAL",
      reason: "EVIDENCE_UNAVAILABLE",
      mutation_count: 0,
    });
    assert.deepEqual(await fs.readdir(cwd), []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("bounded snapshot replay is byte-identical and remains mutation-free", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-snapshot.json", import.meta.url),
      "utf8",
    ));
    const evaluated = await review({ cwd, ...fixture });
    assert.equal(evaluated.ok, true);
    if (!evaluated.ok || evaluated.status !== "SNAPSHOT") return;

    const replayed = await review({
      cwd,
      ...fixture,
      operation: "replay",
      report_id: evaluated.report_id,
    });

    assert.equal(replayed.ok, true);
    if (!replayed.ok || replayed.status !== "SNAPSHOT") return;
    assert.equal(replayed.report_id, evaluated.report_id);
    assert.equal(replayed.report_bytes, evaluated.report_bytes);
    assert.deepEqual(await fs.readdir(cwd), []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("caller-provided optional-domain enrollment cannot authorize the profile", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/optional-domain-normal.json", import.meta.url),
      "utf8",
    ));
    fixture.authority.enabled = true;

    const result = await reviewWithoutEnrollment({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "PROFILE_NOT_AUTHORIZED",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("optional-domain profile requires explicit installation enrollment", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/optional-domain-normal.json", import.meta.url),
      "utf8",
    ));
    delete fixture.authority.enabled;

    const result = await reviewWithoutEnrollment({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "PROFILE_NOT_AUTHORIZED",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("installation-owned enrollment authorizes the optional-domain profile", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/optional-domain-normal.json", import.meta.url),
      "utf8",
    ));
    delete fixture.authority.enabled;

    const result = await review({ cwd, ...fixture });

    assert.equal(result.ok, true);
    if (!result.ok || result.status !== "PASS" || !("report" in result)) return;
    assert.equal(result.report.profile, "optional-domain");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("all four installation-owned profiles satisfy the same twelve-obligation contract", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixtures = [
      "pm-normal.json",
      "nightly-workspace-normal.json",
      "operations-normal.json",
      "optional-domain-normal.json",
    ];
    const accepted: string[] = [];
    for (const name of fixtures) {
      const fixture = JSON.parse(await fs.readFile(
        new URL(`./fixtures/strategic-review/${name}`, import.meta.url),
        "utf8",
      ));
      const result = await review({ cwd, ...fixture });
      assert.equal(result.ok, true, name);
      if (!result.ok || result.status !== "PASS" || !("report" in result)) continue;
      assert.equal(result.report.obligations.length, 12, name);
      assert.ok(result.report.obligations.every((obligation) => obligation.status === "PASS"), name);
      accepted.push(result.report.profile);
    }
    assert.deepEqual(accepted, [
      "pm-17:00",
      "nightly-workspace",
      "operations-cron-output",
      "optional-domain",
    ]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

const T62_WORKSPACE = "11111111-1111-4111-8111-111111111111";
const T62_PARENT = "22222222-2222-4222-8222-222222222222";
const T62_REMOTE = "33333333-3333-4333-8333-333333333333";
const T62_SERVER_DIGEST = "d".repeat(64);
const T62_OBSERVED = "a".repeat(64);
const T62_ACTION = `Create or reuse T62 source ownership drift follow-up ${T62_OBSERVED.slice(0, 12)}`;
const noGit = async (): Promise<undefined> => undefined;

type T62ProofMode = "ok" | "missing_action" | "missing_evidence" | "parent_mismatch" | "missing" | "outage" | "nonverified";

function t62Runner(mode: T62ProofMode = "ok"): {
  runner: MulticaRunner;
  calls: MulticaInvocation[];
  remotes: Map<string, Record<string, unknown>>;
} {
  const calls: MulticaInvocation[] = [];
  const remotes = new Map<string, Record<string, unknown>>();
  let remoteReads = 0;
  const parent = {
    id: T62_PARENT,
    identifier: "AUT-3",
    workspace_id: T62_WORKSPACE,
  };
  const runner: MulticaRunner = async (call) => {
    calls.push(call);
    if (call.argv.includes("identity")) {
      return { stdout: JSON.stringify({
        profile: "dev",
        server_origin: "https://example.com",
        workspace_id: T62_WORKSPACE,
      }) };
    }
    const issue = call.argv.indexOf("issue");
    const command = issue >= 0 ? call.argv[issue + 1] : undefined;
    if (command === "comment" && call.argv[issue + 2] === "list") return { stdout: "[]" };
    if (command === "metadata" && call.argv[issue + 2] === "set") return { stdout: JSON.stringify({ ok: true }) };
    if (command === "metadata" && call.argv[issue + 2] === "list") {
      const remote = [...remotes.values()][0];
      return { stdout: JSON.stringify({ continuation_key: remote?.client_idempotency_key }) };
    }
    if (command === "create") {
      const key = call.argv[call.argv.indexOf("--idempotency-key") + 1]!;
      const existing = remotes.get(key);
      const remote = existing ?? {
        id: T62_REMOTE,
        identifier: "P6-62",
        workspace_id: T62_WORKSPACE,
        parent_issue_id: T62_PARENT,
        title: call.argv[call.argv.indexOf("--title") + 1],
        description: call.stdin,
        status: "todo",
        priority: "medium",
        client_idempotency_key: key,
        client_idempotency_digest: T62_SERVER_DIGEST,
      };
      remotes.set(key, remote);
      return { stdout: JSON.stringify({
        id: T62_REMOTE,
        identifier: "P6-62",
        client_idempotency_key: key,
        client_idempotency_digest: T62_SERVER_DIGEST,
        reused: Boolean(existing),
      }) };
    }
    if (command === "get") {
      const reference = call.argv[issue + 2]!;
      if (reference === T62_PARENT || reference === "AUT-3") return { stdout: JSON.stringify(parent) };
      const remote = [...remotes.values()].find((candidate) =>
        candidate.id === reference || candidate.identifier === reference);
      if (!remote) throw new Error(`missing remote ${reference}`);
      remoteReads += 1;
      if (mode === "outage" && remoteReads >= 2) throw new Error("provider outage");
      if (mode === "missing" && remoteReads >= 2) {
        throw new Error(`resolve issue: GET /api/issues/${reference} returned 404: {"error":"issue not found"}`);
      }
      const projected = structuredClone(remote);
      if (mode === "nonverified" && remoteReads === 1) projected.client_idempotency_digest = "e".repeat(64);
      if (mode === "missing_action" && remoteReads >= 2) {
        projected.description = String(projected.description).replace(`- ${T62_ACTION}`, "- action omitted");
      }
      if (mode === "missing_evidence" && remoteReads >= 2) {
        projected.description = String(projected.description).replace("- source-matrix-drift", "- evidence omitted");
      }
      if (mode === "parent_mismatch" && remoteReads >= 2) {
        projected.parent_issue_id = "44444444-4444-4444-8444-444444444444";
      }
      return { stdout: JSON.stringify(projected) };
    }
    throw new Error(`unexpected argv: ${call.argv.join(" ")}`);
  };
  return { runner, calls, remotes };
}

async function initializeT62Harness(cwd: string, runner: MulticaRunner): Promise<void> {
  const now = "2026-07-18T16:00:00.000Z";
  const state = emptyStateV3(now);
  state.goals["goal-phase-6-fixture"] = {
    id: "goal-phase-6-fixture",
    title: "Phase 6 fixture",
    status: "active",
    assurance: "standard",
    backend: {
      kind: "multica",
      origin: "https://example.com",
      workspace_id: T62_WORKSPACE,
      parent_issue_id: T62_PARENT,
    },
    worktree_status: "active",
    stop_enforcement: false,
    created_at: now,
    updated_at: now,
  };
  state.active_goal_id = "goal-phase-6-fixture";
  await new HarnessStore(cwd).writeStateV3(state);
  await bindCoordination({
    cwd,
    goal: "goal-phase-6-fixture",
    mode: "profile",
    profile: "dev",
    workspaceId: T62_WORKSPACE,
    parent: "AUT-3",
  }, { runner, gitProbe: noGit });
}

async function t62Fixture(): Promise<Record<string, any>> {
  const fixture = JSON.parse(await fs.readFile(
    new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
    "utf8",
  ));
  fixture.integrity = { observed_source_ownership_sha256: T62_OBSERVED };
  fixture.evidence.maximum_references = 6;
  fixture.evidence.references.push({
    id: "source-matrix-drift",
    role: "integrity_drift",
    classification: "FACT",
    source: "fixture://integrity/source-matrix-drift",
    observed_at: "2026-07-18T16:59:00.000Z",
    digest: T62_OBSERVED,
    finding_id: "t62-source-integrity-drift",
  });
  fixture.analysis.findings.push({
    id: "t62-source-integrity-drift",
    material: true,
    defect_type: "measurement",
    domain: "product-management",
    owner: "phase-6-owner",
    control: "phase-source-integrity",
    recurrence_count: 0,
    symptoms: ["source-ownership-drift"],
    evidence: ["source-matrix-drift"],
  });
  fixture.analysis.lanes.NOW = [{
    finding_id: "t62-source-integrity-drift",
    action: T62_ACTION,
    evidence: ["source-matrix-drift"],
    disposition: "TRACKED",
    ticket_id: "P6-62",
  }];
  const ledger = JSON.parse(fixture.continuation.response_text.match(/```continuation-ledger\n([\s\S]*?)\n```/)[1]);
  ledger.items = [{
    lane: "NOW",
    action: T62_ACTION,
    disposition: "TRACKED",
    evidence: "source-matrix-drift",
    expected_impact: "Restore the authoritative Phase 1 through Phase 7 source ownership map",
    cost_class: "no_agent",
    evidence_horizon: "before-phase-6-close",
    ticket_id: "P6-62",
  }];
  fixture.continuation.response_text = `\`\`\`continuation-ledger\n${JSON.stringify(ledger)}\n\`\`\``;
  fixture.continuation.parent_id = "caller-parent-is-not-authority";
  fixture.continuation.tickets = {
    "P6-62": {
      ticket_id: "P6-62",
      configured_parent_id: "caller-parent-is-not-authority",
      parent_id: "caller-parent-is-not-authority",
      status: "todo",
      content_strings: ["caller-only fabricated proof"],
      evidence_reference_ids: ["caller-only-evidence"],
      readback_at: "2000-01-01T00:00:00.000Z",
    },
  };
  fixture.continuation.mutations = [{ caller_only: true }];
  return fixture;
}

test("T62 drift creates or reuses one tracked follow-up with live readback", async () => {
  const callerOnlyCwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const callerOnly = await review({ cwd: callerOnlyCwd, ...await t62Fixture() });
    assert.equal(callerOnly.ok, false);
    if (!callerOnly.ok) assert.equal(callerOnly.reason, "REVIEW_INTEGRITY_FAILURE");
  } finally {
    await fs.rm(callerOnlyCwd, { recursive: true, force: true });
  }

  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = await t62Fixture();
    const fake = t62Runner();
    await initializeT62Harness(cwd, fake.runner);
    const dependencies = { coordination: { runner: fake.runner, gitProbe: noGit } };

    const first = await review({ cwd, ...fixture }, fixture, dependencies);
    const replay = await review({ cwd, ...fixture }, fixture, dependencies);

    assert.equal(first.ok, true, JSON.stringify({ first, calls: fake.calls.map((call) => call.argv), remotes: [...fake.remotes.values()] }));
    assert.equal(replay.ok, true, JSON.stringify(replay));
    if (!first.ok || first.status !== "PASS" || !("report" in first)
      || !replay.ok || replay.status !== "PASS" || !("report" in replay)) return;
    assert.equal(first.report.integrity.verdict, "DRIFT_TRACKED");
    assert.equal(replay.report.integrity.verdict, "DRIFT_TRACKED");
    if (first.report.integrity.verdict !== "DRIFT_TRACKED"
      || replay.report.integrity.verdict !== "DRIFT_TRACKED") return;
    assert.equal(first.report.integrity.follow_up.ticket_id, "P6-62");
    assert.equal(first.report.integrity.follow_up.evidence_reference_id, "source-matrix-drift");
    assert.match(first.report.integrity.follow_up.stable_key, /^ch-[a-f0-9]{24}$/);
    assert.match(first.report.integrity.follow_up.proof_sha256, /^[a-f0-9]{64}$/);
    assert.equal(replay.report_id, first.report_id);
    assert.deepEqual(replay.report.integrity, first.report.integrity);
    assert.equal(fake.remotes.size, 1);
    const continuationFiles = await fs.readdir(path.join(cwd, ".ycm-harness", "autonomy", "continuations"));
    assert.equal(continuationFiles.length, 1);
    const remote = [...fake.remotes.values()][0]!;
    const descriptionLines = String(remote.description).split("\n").map((line) => line.trim());
    assert.ok(descriptionLines.includes(`- ${T62_ACTION}`));
    assert.ok(descriptionLines.includes("- source-matrix-drift"));
    assert.ok(fake.calls.some((call) => call.argv.includes("comment") && call.argv.includes("list")));
    assert.equal(first.report.integrity.follow_up.ticket_id, fixture.analysis.lanes.NOW[0].ticket_id);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("T62 drift blocks missing, stale, conflicting, non-verified, or unreadable live proof", async () => {
  const scenarios: Array<{
    name: string;
    mode: T62ProofMode;
    stale?: boolean;
  }> = [
    { name: "missing action", mode: "missing_action" },
    { name: "missing evidence", mode: "missing_evidence" },
    { name: "parent mismatch", mode: "parent_mismatch" },
    { name: "missing proof", mode: "missing" },
    { name: "provider outage", mode: "outage" },
    { name: "non-verified continuation", mode: "nonverified" },
    { name: "stale proof", mode: "ok", stale: true },
  ];

  for (const scenario of scenarios) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
    try {
      const fixture = await t62Fixture();
      const fake = t62Runner(scenario.mode);
      await initializeT62Harness(cwd, fake.runner);
      const dependencies: Parameters<typeof withStrategicReviewTestDependencies>[0] = {
        coordination: { runner: fake.runner, gitProbe: noGit },
        ...(scenario.stale ? {
          ticketProviderForState: (state, goalId, deps) => {
            const provider = actualProviderForState(state, goalId, deps);
            return {
              ...provider,
              async readProof(id: string) {
                const read = await provider.readProof(id);
                return read.kind === "found"
                  ? { kind: "found" as const, proof: { ...read.proof, readback_at: "2000-01-01T00:00:00.000Z" } }
                  : read;
              },
            };
          },
        } : {}),
      };

      const result = await review({ cwd, ...fixture }, fixture, dependencies);

      assert.equal(result.ok, false, scenario.name);
      if (!result.ok) assert.equal(result.reason, "REVIEW_INTEGRITY_FAILURE", scenario.name);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }
});

test("normal mode rejects a current-artifact-only review", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    fixture.evidence.references = fixture.evidence.references.filter((reference) => reference.role === "current");
    fixture.analysis.prior_commitments = [];
    fixture.analysis.user_feedback = [];
    fixture.analysis.recurrence = { seven_day: [], thirty_day: [] };
    fixture.analysis.reviewer_self_correction.evidence = ["current-plan"];
    fixture.analysis.findings[0].evidence = ["current-plan"];
    fixture.analysis.lanes.NOW[0].evidence = ["current-plan"];
    const ledger = JSON.parse(fixture.continuation.response_text.match(/```continuation-ledger\n([\s\S]*?)\n```/)[1]);
    ledger.items[0].evidence = "current-plan";
    fixture.continuation.response_text = `\`\`\`continuation-ledger\n${JSON.stringify(ledger)}\n\`\`\``;
    fixture.continuation.tickets["PM-1"].evidence_reference_ids = ["current-plan"];

    const result = await review({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "REVIEW_CONTRACT_INCOMPLETE",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("lane ticket identity must match the authenticated continuation item", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    fixture.analysis.lanes.NOW[0].ticket_id = "FAKE-1";

    const result = await review({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "REVIEW_CONTRACT_INCOMPLETE",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("lane evidence must belong to the lane finding identity", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    fixture.evidence.maximum_references = 6;
    fixture.evidence.references.push({
      id: "other-finding-only",
      role: "finding_evidence",
      classification: "FACT",
      source: "fixture://pm/other-finding",
      observed_at: "2026-07-18T16:59:00.000Z",
      digest: "6666666666666666666666666666666666666666666666666666666666666666",
      finding_id: "other-finding",
    });
    fixture.analysis.findings.push({
      id: "other-finding",
      material: false,
      defect_type: "product",
      domain: "product-management",
      owner: "pm-owner",
      control: "other-control",
      recurrence_count: 0,
      symptoms: [],
      evidence: ["other-finding-only"],
    });
    fixture.analysis.lanes.NOW[0].evidence = ["other-finding-only"];
    const ledger = JSON.parse(fixture.continuation.response_text.match(/```continuation-ledger\n([\s\S]*?)\n```/)[1]);
    ledger.items[0].evidence = "other-finding-only";
    fixture.continuation.response_text = `\`\`\`continuation-ledger\n${JSON.stringify(ledger)}\n\`\`\``;
    fixture.continuation.tickets["PM-1"].evidence_reference_ids = ["other-finding-only"];

    const result = await review({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "REVIEW_CONTRACT_INCOMPLETE",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("UNKNOWN evidence cannot authenticate a tracked lane action", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    fixture.evidence.maximum_references = 6;
    fixture.evidence.references.push({
      id: "untracked-unknown",
      role: "finding_evidence",
      classification: "UNKNOWN",
      source: "fixture://pm/unknown-action-evidence",
      observed_at: "2026-07-18T16:59:00.000Z",
    });
    fixture.analysis.lanes.NOW[0].evidence = ["untracked-unknown"];
    const ledger = JSON.parse(fixture.continuation.response_text.match(/```continuation-ledger\n([\s\S]*?)\n```/)[1]);
    ledger.items[0].evidence = "untracked-unknown";
    fixture.continuation.response_text = `\`\`\`continuation-ledger\n${JSON.stringify(ledger)}\n\`\`\``;
    fixture.continuation.tickets["PM-1"].evidence_reference_ids = ["untracked-unknown"];

    const result = await review({ cwd, ...fixture });

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "REVIEW_CONTRACT_INCOMPLETE",
      mutation_count: 0,
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("canonical continuation live-proof reasons are preserved unchanged", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-"));
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
      "utf8",
    ));
    fixture.continuation.tickets["PM-1"].parent_id = "wrong-parent";

    const result = await review({ cwd, ...fixture });

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.reason, "WRONG_TICKET_PARENT:PM-1");
    assert.deepEqual(result.reasons, ["WRONG_TICKET_PARENT:PM-1"]);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("fresh CLI process delegates evaluate to the same mutation-free review interface", async () => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-review-cli-"));
  let installationRoot: string | undefined;
  try {
    const fixture = JSON.parse(await fs.readFile(
      new URL("./fixtures/strategic-review/pm-snapshot.json", import.meta.url),
      "utf8",
    ));
    installationRoot = await createSignedReviewInstallation(fixture);
    const projectedSourceCli = await projectSourceCliIntoInstallation(installationRoot);
    delete fixture.operation;
    const result = spawnSync(process.execPath, [
      "--import",
      "tsx",
      projectedSourceCli,
      "--cwd",
      cwd,
      "autonomy",
      "review",
      "evaluate",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
      input: JSON.stringify(fixture),
    });

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.ok, true);
    assert.equal(output.status, "SNAPSHOT");
    assert.equal(output.report.profile, "pm-17:00");
    assert.deepEqual(await fs.readdir(cwd), []);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
    if (installationRoot) await fs.rm(installationRoot, { recursive: true, force: true });
  }
});

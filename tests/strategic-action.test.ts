import assert from "node:assert/strict";
import { generateKeyPairSync, sign as signBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import { registerAutonomy } from "../src/cli/commands/autonomy.js";
import { createContext } from "../src/cli/context.js";
import {
  apply as publicApply,
  review as publicReview,
  STRATEGIC_ACTION_SELECTOR_OPERATIONS,
  type StrategicActionRequest,
  type StrategicReviewNormalSuccess,
  type StrategicReviewSnapshotSuccess,
} from "../src/index.js";
import {
  canonicalStrategicActionIdentity,
  withStrategicActionTestDependencies,
  type StrategicActionDependencies,
} from "../src/autonomy/strategic-action.js";
import { withStrategicReviewTestDependencies } from "../src/autonomy/strategic-review.js";
import { coordinationBindingPath } from "../src/autonomy/coordination.js";
import { readInstalledLoopState } from "../src/autonomy/installed-loop-state.js";
import { emptyStateV3 } from "../src/schema/v3.js";
import { HarnessStore } from "../src/state/store.js";

interface AcceptedReviewFixture {
  cwd: string;
  installationRoot: string;
  request: Record<string, any>;
  accepted: StrategicReviewNormalSuccess;
}

async function createSignedReviewInstallation(request: Record<string, any>): Promise<string> {
  const installationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-action-installation-"));
  const configRoot = path.join(installationRoot, "config");
  const recordRoot = path.join(installationRoot, "records");
  await fs.mkdir(configRoot, { recursive: true });
  await fs.mkdir(recordRoot, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const originId = request.evidence_origin.origin_id;
  const recordId = request.evidence_origin.record_id;
  const keyId = "strategic-action-review-key";
  await fs.writeFile(path.join(configRoot, "strategic-review-origins.json"), JSON.stringify({
    schema_version: 1,
    origins: [{
      origin_id: originId,
      record_root: recordRoot,
      key_id: keyId,
      public_key_pem: publicKey.export({ format: "pem", type: "spki" }).toString(),
      profiles: [{
        profile: request.profile,
        domain: request.authority.domain,
        proof: request.authority.proof,
        recurrence_threshold: 2,
      }],
    }],
  }), "utf8");
  const recordBytes = Buffer.from(JSON.stringify({
    schema_version: 1,
    origin_id: originId,
    record_id: recordId,
    key_id: keyId,
    installation_id: request.authority.installation_id,
    profile: request.profile,
    domain: request.authority.domain,
    evidence: request.evidence,
  }), "utf8");
  await fs.writeFile(path.join(recordRoot, `${recordId}.json`), recordBytes);
  await fs.writeFile(path.join(recordRoot, `${recordId}.sig`), signBytes(null, recordBytes, privateKey).toString("base64"), "utf8");
  return installationRoot;
}

async function acceptedReviewFixture(): Promise<AcceptedReviewFixture> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-action-"));
  const request = JSON.parse(await fs.readFile(
    new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
    "utf8",
  ));
  const installationRoot = await createSignedReviewInstallation(request);
  const result = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => publicReview({ cwd, ...request }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "PASS");
  return { cwd, installationRoot, request, accepted: result as StrategicReviewNormalSuccess };
}

async function acceptedReviewWithActions(actions: string[]): Promise<AcceptedReviewFixture> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-action-multi-"));
  const request = JSON.parse(await fs.readFile(
    new URL("./fixtures/strategic-review/pm-normal.json", import.meta.url),
    "utf8",
  ));
  const laneItems = actions.map((action, index) => ({
    finding_id: "triage-root-cause",
    action,
    evidence: ["explicit-feedback"],
    disposition: "TRACKED",
    ticket_id: `PM-${index + 10}`,
    independent_action: true,
  }));
  request.analysis.lanes.NOW = laneItems;
  request.continuation.response_text = `\`\`\`continuation-ledger\n${JSON.stringify({
    items: laneItems.map((item) => ({
      lane: "NOW",
      action: item.action,
      disposition: item.disposition,
      evidence: "explicit-feedback",
      expected_impact: "The strategic action remains durably dispositioned.",
      cost_class: "no_agent",
      evidence_horizon: "7d",
      ticket_id: item.ticket_id,
    })),
  })}\n\`\`\``;
  request.continuation.tickets = Object.fromEntries(laneItems.map((item) => [item.ticket_id, {
    ticket_id: item.ticket_id,
    configured_parent_id: request.continuation.parent_id,
    parent_id: request.continuation.parent_id,
    status: "todo",
    content_strings: [item.action],
    evidence_reference_ids: ["explicit-feedback"],
    readback_at: "2026-07-18T17:00:00.000Z",
  }]));
  const installationRoot = await createSignedReviewInstallation(request);
  const result = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => publicReview({ cwd, ...request }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "PASS");
  return { cwd, installationRoot, request, accepted: result as StrategicReviewNormalSuccess };
}

async function acceptedSnapshotFixture(): Promise<{
  cwd: string;
  installationRoot: string;
  request: Record<string, any>;
  accepted: StrategicReviewSnapshotSuccess;
}> {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-action-snapshot-"));
  const request = JSON.parse(await fs.readFile(
    new URL("./fixtures/strategic-review/pm-snapshot.json", import.meta.url),
    "utf8",
  ));
  const installationRoot = await createSignedReviewInstallation(request);
  const result = await withStrategicReviewTestDependencies(
    { installationRoot: async () => installationRoot },
    () => publicReview({ cwd, ...request }),
  );
  assert.equal(result.ok, true);
  assert.equal(result.status, "SNAPSHOT");
  return { cwd, installationRoot, request, accepted: result as StrategicReviewSnapshotSuccess };
}

function actionRequest(fixture: AcceptedReviewFixture): StrategicActionRequest {
  const lane = fixture.accepted.report.lanes.NOW[0]!;
  const finding = fixture.accepted.report.findings.find(({ id }) => id === lane.finding_id)!;
  const { operation: _operation, ...authentication } = fixture.request;
  const actionIdentity = canonicalStrategicActionIdentity(
    fixture.accepted.report.profile,
    lane.finding_id,
    lane.action,
  );
  return {
    cwd: fixture.cwd,
    operation: "apply",
    report: {
      report_id: fixture.accepted.report_id,
      report_sha256: fixture.accepted.report_sha256,
      report_bytes: fixture.accepted.report_bytes,
      authentication,
    },
    authority: {
      installation_id: fixture.accepted.report.authority.installation_id,
      profile: fixture.accepted.report.profile,
      domain: fixture.accepted.report.authority.domain,
      capability_proof: `strategic-action/v1/${fixture.accepted.report.profile}/${fixture.accepted.report.authority.domain}`,
      capabilities: [
        "ticket_reuse_or_create",
        "ticket_comment",
        "ticket_priority",
        "installed_loop_pause",
        "rollback",
      ],
    },
    action_identity: actionIdentity,
    selector: {
      operation: "ticket_reuse_or_create",
      finding_id: lane.finding_id,
      action: lane.action,
      root_cause: finding.root_cause!,
      evidence_reference_ids: [...lane.evidence],
      owner: null,
      ticket: {
        title: lane.action,
        brief: finding.root_cause!,
        acceptance: [finding.postcondition!],
      },
    },
    expected_before: {
      kind: "ticket_search",
      root_cause: finding.root_cause!,
      action_identity: actionIdentity,
      owner: null,
      matching_ticket_ids: [],
    },
  };
}

function unavailableDependencies(calls: string[]): Partial<StrategicActionDependencies> {
  return {
    ticket: {
      async search() {
        calls.push("ticket.search");
        throw new Error("provider offline");
      },
      async read() {
        calls.push("ticket.read");
        return undefined;
      },
      async create() {
        calls.push("ticket.create");
      },
      async comment() {
        calls.push("ticket.comment");
      },
      async setPriority() {
        calls.push("ticket.priority");
      },
    },
  };
}

async function applyFixture(
  fixture: AcceptedReviewFixture,
  request: StrategicActionRequest,
  dependencies: Partial<StrategicActionDependencies>,
) {
  return withStrategicReviewTestDependencies(
    { installationRoot: async () => fixture.installationRoot },
    () => withStrategicActionTestDependencies(dependencies, () => publicApply(request)),
  );
}

test("apply authenticates an accepted normal content-addressed action before provider search", async () => {
  const fixture = await acceptedReviewFixture();
  const calls: string[] = [];
  try {
    const result = await applyFixture(fixture, actionRequest(fixture), unavailableDependencies(calls));

    assert.deepEqual(result, {
      ok: false,
      status: "BLOCKED",
      reason: "ACTION_PROVIDER_UNAVAILABLE",
      action_identity: actionRequest(fixture).action_identity,
      mutation_count: 0,
    });
    assert.deepEqual(calls, ["ticket.search"]);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("apply rejects report-matched authority that is not independently installation-owned", async () => {
  const fixture = await acceptedReviewFixture();
  const calls: string[] = [];
  const request = actionRequest(fixture);
  // Report-derived authority matches the accepted report, but the live authentication
  // authority (installation-owned) disagrees. Report alone must not grant action authority.
  request.report.authentication = {
    ...request.report.authentication,
    authority: {
      ...request.report.authentication.authority,
      installation_id: "installation-owned-not-report",
    },
  };
  const forgedReport = {
    ok: true as const,
    status: "PASS" as const,
    report_id: fixture.accepted.report_id,
    report_sha256: fixture.accepted.report_sha256,
    report_bytes: fixture.accepted.report_bytes,
    storage_reference: fixture.accepted.storage_reference,
    report: fixture.accepted.report,
    mutation_count: 0 as const,
  };
  try {
    const result = await withStrategicActionTestDependencies({
      reviewReport: async () => forgedReport,
      ...unavailableDependencies(calls),
    }, () => publicApply(request));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "ACTION_NOT_AUTHORIZED");
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("apply rejects report bytes, hash, profile, and installation authority drift before provider access", async () => {
  const fixture = await acceptedReviewFixture();
  const cases: Array<{ name: string; mutate(request: StrategicActionRequest): void; reason: string }> = [
    { name: "bytes", mutate: (request) => { request.report.report_bytes += " "; }, reason: "REPORT_AUTHENTICATION_FAILED" },
    { name: "hash", mutate: (request) => { request.report.report_sha256 = "0".repeat(64); }, reason: "REPORT_AUTHENTICATION_FAILED" },
    { name: "profile", mutate: (request) => { request.report.authentication.profile = "nightly-workspace"; }, reason: "REPORT_AUTHENTICATION_FAILED" },
    { name: "authority", mutate: (request) => { request.authority.installation_id = "different-installation"; }, reason: "ACTION_NOT_AUTHORIZED" },
  ];
  try {
    for (const entry of cases) {
      const calls: string[] = [];
      const request = structuredClone(actionRequest(fixture));
      entry.mutate(request);
      const result = await applyFixture(fixture, request, unavailableDependencies(calls));
      assert.equal(result.reason, entry.reason, entry.name);
      assert.deepEqual(calls, [], entry.name);
    }
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("apply rejects fabricated evidence and noncanonical selected action identity before provider access", async () => {
  const fixture = await acceptedReviewFixture();
  try {
    for (const field of ["evidence", "identity"] as const) {
      const calls: string[] = [];
      const request = structuredClone(actionRequest(fixture));
      if (field === "evidence") request.selector.evidence_reference_ids = ["fabricated-evidence"];
      else request.action_identity = `action-${"0".repeat(64)}`;
      const result = await applyFixture(fixture, request, unavailableDependencies(calls));
      assert.equal(result.reason, "ACTION_SELECTOR_INVALID", field);
      assert.deepEqual(calls, [], field);
    }
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("bounded snapshot reports cannot authorize strategic actions", async () => {
  const fixture = await acceptedSnapshotFixture();
  const action = "Bind explicit feedback evidence to daily triage";
  const actionIdentity = canonicalStrategicActionIdentity(fixture.request.profile, "triage-root-cause", action);
  const { operation: _operation, ...authentication } = fixture.request;
  const request = {
    cwd: fixture.cwd,
    operation: "apply",
    report: {
      report_id: fixture.accepted.report_id,
      report_sha256: fixture.accepted.report_sha256,
      report_bytes: fixture.accepted.report_bytes,
      authentication,
    },
    authority: {
      installation_id: fixture.request.authority.installation_id,
      profile: fixture.request.profile,
      domain: fixture.request.authority.domain,
      capability_proof: `strategic-action/v1/${fixture.request.profile}/${fixture.request.authority.domain}`,
      capabilities: [...STRATEGIC_ACTION_SELECTOR_OPERATIONS],
    },
    action_identity: actionIdentity,
    selector: {
      operation: "ticket_reuse_or_create",
      finding_id: "triage-root-cause",
      action,
      root_cause: "Priority feedback was not bound to the daily triage control.",
      evidence_reference_ids: ["current-plan"],
      owner: null,
      ticket: { title: action, brief: action, acceptance: [action] },
    },
    expected_before: {
      kind: "ticket_search",
      root_cause: "Priority feedback was not bound to the daily triage control.",
      action_identity: actionIdentity,
      owner: null,
      matching_ticket_ids: [],
    },
  } satisfies StrategicActionRequest;
  const calls: string[] = [];
  try {
    const result = await withStrategicReviewTestDependencies(
      { installationRoot: async () => fixture.installationRoot },
      () => withStrategicActionTestDependencies(unavailableDependencies(calls), () => publicApply(request)),
    );
    assert.equal(result.reason, "SNAPSHOT_MUTATION_FORBIDDEN");
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("protected operation strings are absent from the selector union and reject before adapters", async () => {
  const fixture = await acceptedReviewFixture();
  const protectedOperations = [
    "edit_code", "write_credentials", "publish", "pay", "delete", "schedule", "deliver",
    "provider_lifecycle", "merge", "push", "commit", "rewrite_git_history",
  ];
  try {
    assert.deepEqual(STRATEGIC_ACTION_SELECTOR_OPERATIONS, [
      "ticket_reuse_or_create", "ticket_comment", "ticket_priority", "installed_loop_pause", "rollback",
    ]);
    for (const operation of protectedOperations) {
      const calls: string[] = [];
      const request = structuredClone(actionRequest(fixture)) as StrategicActionRequest & {
        selector: { operation: string };
      };
      request.selector.operation = operation;
      const result = await applyFixture(fixture, request as StrategicActionRequest, unavailableDependencies(calls));
      assert.equal(result.reason, "ACTION_SELECTOR_INVALID", operation);
      assert.deepEqual(calls, [], operation);
    }
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

function ticketState(
  request: StrategicActionRequest,
  ticketId: string,
  overrides: Partial<{
    action_identities: string[];
    owner: string | null;
    priority: "urgent" | "high" | "medium" | "low";
    comments: Array<{ id: string; content: string; action_identity: string }>;
  }> = {},
) {
  if (request.selector.operation !== "ticket_reuse_or_create") throw new Error("ticket fixture requires create selector");
  return {
    kind: "ticket" as const,
    ticket_id: ticketId,
    title: request.selector.ticket.title,
    root_cause: request.selector.root_cause,
    action_identities: overrides.action_identities ?? [request.action_identity],
    owner: overrides.owner ?? null,
    priority: overrides.priority ?? "medium" as const,
    comments: overrides.comments ?? [],
    provider_proof: {
      source: `fixture://ticket/${ticketId}`,
      digest: ticketId === "PM-20" ? "b".repeat(64) : "a".repeat(64),
      read_at: "2026-07-20T00:00:00.000Z",
    },
  };
}

test("ticket owner flow persists intent before create, live-reads the ownerless ticket, and replays one receipt", async () => {
  const fixture = await acceptedReviewFixture();
  const request = actionRequest(fixture);
  const calls: string[] = [];
  let created: ReturnType<typeof ticketState> | undefined;
  const intentPath = path.join(
    fixture.cwd,
    ".ycm-harness",
    "autonomy",
    "strategic-actions",
    "intents",
    `${request.action_identity}.json`,
  );
  const dependencies: Partial<StrategicActionDependencies> = {
    now: () => "2026-07-20T00:00:00.000Z",
    ticket: {
      async search() {
        calls.push("ticket.search");
        return created ? [created] : [];
      },
      async read(ticketId) {
        calls.push("ticket.read");
        return created?.ticket_id === ticketId ? created : undefined;
      },
      async create() {
        calls.push("ticket.create");
        const pending = JSON.parse(await fs.readFile(intentPath, "utf8"));
        assert.equal(pending.state, "pending");
        assert.equal(pending.mutation_attempted, true);
        assert.equal(pending.mutated_at, "2026-07-20T00:00:00.000Z");
        assert.deepEqual(pending.authenticated_before, request.expected_before);
        created = ticketState(request, "PM-20");
      },
      async comment() { calls.push("ticket.comment"); },
      async setPriority() { calls.push("ticket.priority"); },
    },
  };
  try {
    const first = await applyFixture(fixture, request, dependencies);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.status, "APPLIED");
    assert.equal(first.mutation_count, 1);
    assert.equal(first.receipt.after.kind, "ticket");
    if (first.receipt.after.kind === "ticket") assert.equal(first.receipt.after.ticket_id, "PM-20");
    assert.equal(await fs.readFile(path.join(fixture.cwd, ...first.storage_reference.split("/")), "utf8"), first.receipt_bytes);

    const replay = await applyFixture(fixture, structuredClone(request), dependencies);
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.mutation_count, 0);
    assert.equal(replay.receipt_bytes, first.receipt_bytes);
    assert.equal(replay.receipt_id, first.receipt_id);
    assert.deepEqual(calls, ["ticket.search", "ticket.create", "ticket.search", "ticket.read"]);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("canonical receipt bytes survive a crash before immutable receipt creation", async () => {
  const fixture = await acceptedReviewFixture();
  const request = actionRequest(fixture);
  let created: ReturnType<typeof ticketState> | undefined;
  let createCalls = 0;
  const dependencies: Partial<StrategicActionDependencies> = {
    now: () => "2026-07-20T00:00:00.000Z",
    faultAt: "after_receipt_intent_before_receipt_write",
    ticket: {
      async search() { return created ? [structuredClone(created)] : []; },
      async read(ticketId) { return created?.ticket_id === ticketId ? structuredClone(created) : undefined; },
      async create() { createCalls += 1; created = ticketState(request, "PM-21"); },
      async comment() { throw new Error("unexpected comment"); },
      async setPriority() { throw new Error("unexpected priority"); },
    },
  };
  const intentPath = path.join(
    fixture.cwd,
    ".ycm-harness",
    "autonomy",
    "strategic-actions",
    "intents",
    `${request.action_identity}.json`,
  );
  try {
    await assert.rejects(
      applyFixture(fixture, request, dependencies),
      /action_fault_after_receipt_intent_before_receipt_write/,
    );
    const intent = JSON.parse(await fs.readFile(intentPath, "utf8")) as {
      state: string;
      receipt_id: string;
      receipt_bytes: string;
    };
    assert.equal(intent.state, "pending");
    assert.equal(JSON.parse(intent.receipt_bytes).receipt_id, intent.receipt_id);
    const receiptPath = path.join(
      fixture.cwd,
      ".ycm-harness",
      "autonomy",
      "strategic-actions",
      "receipts",
      `${intent.receipt_id}.json`,
    );
    await assert.rejects(fs.access(receiptPath));

    dependencies.faultAt = undefined;
    const replay = structuredClone(request);
    replay.operation = "replay";
    const recovered = await applyFixture(fixture, replay, dependencies);
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(recovered.mutation_count, 0);
    assert.equal(recovered.receipt_id, intent.receipt_id);
    assert.equal(recovered.receipt_bytes, intent.receipt_bytes);
    assert.equal(await fs.readFile(receiptPath, "utf8"), intent.receipt_bytes);
    assert.equal(createCalls, 1);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("ticket owner flow reuses one suitable ordinary live ticket without prior action identities", async () => {
  const fixture = await acceptedReviewFixture();
  const request = actionRequest(fixture);
  if (request.expected_before.kind !== "ticket_search") throw new Error("expected ticket search state");
  request.expected_before.matching_ticket_ids = ["PM-1"];
  const existing = ticketState(request, "PM-1", { action_identities: [] });
  const calls: string[] = [];
  try {
    const result = await applyFixture(fixture, request, {
      now: () => "2026-07-20T00:00:00.000Z",
      ticket: {
        async search() { calls.push("ticket.search"); return [existing]; },
        async read(ticketId) { calls.push("ticket.read"); return ticketId === existing.ticket_id ? existing : undefined; },
        async create() { calls.push("ticket.create"); throw new Error("create must not run"); },
        async comment() { calls.push("ticket.comment"); },
        async setPriority() { calls.push("ticket.priority"); },
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.mutation_count, 0);
    assert.equal(result.receipt.after.kind, "ticket");
    if (result.receipt.after.kind === "ticket") assert.equal(result.receipt.after.ticket_id, "PM-1");
    assert.deepEqual(calls, ["ticket.search", "ticket.read"]);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("root-cause consolidation retains independent action identities instead of reusing unrelated work", async () => {
  const fixture = await acceptedReviewFixture();
  const request = actionRequest(fixture);
  const unrelated = ticketState(request, "PM-OLD", { action_identities: [`action-${"c".repeat(64)}`] });
  let created: ReturnType<typeof ticketState> | undefined;
  const calls: string[] = [];
  try {
    const result = await applyFixture(fixture, request, {
      now: () => "2026-07-20T00:00:00.000Z",
      ticket: {
        async search() { calls.push("ticket.search"); return created ? [unrelated, created] : [unrelated]; },
        async read(ticketId) { calls.push("ticket.read"); return ticketId === created?.ticket_id ? created : undefined; },
        async create() { calls.push("ticket.create"); created = ticketState(request, "PM-NEW"); },
        async comment() { calls.push("ticket.comment"); },
        async setPriority() { calls.push("ticket.priority"); },
      },
    });

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.receipt.after.kind, "ticket");
    if (result.receipt.after.kind === "ticket") {
      assert.deepEqual(result.receipt.after.action_identities, [request.action_identity]);
      assert.notDeepEqual(result.receipt.after.action_identities, unrelated.action_identities);
    }
    assert.deepEqual(calls, ["ticket.search", "ticket.create", "ticket.search", "ticket.read"]);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("ticket comment persists before-state, exact-reads provenance, replays, and rejects conflicting content", async () => {
  const fixture = await acceptedReviewWithActions(["Attach the accepted feedback evidence to PM-10"]);
  const lane = fixture.accepted.report.lanes.NOW[0]!;
  const request = actionRequest(fixture);
  request.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, lane.finding_id, lane.action);
  request.selector = {
    operation: "ticket_comment",
    finding_id: lane.finding_id,
    action: lane.action,
    evidence_reference_ids: [...lane.evidence],
    ticket_id: "PM-10",
    content: "Accepted evidence: explicit-feedback",
  };
  let live = {
    kind: "ticket" as const,
    ticket_id: "PM-10",
    title: lane.action,
    root_cause: fixture.accepted.report.findings[0]!.root_cause!,
    action_identities: [request.action_identity],
    owner: "pm-owner",
    priority: "medium" as const,
    comments: [] as Array<{ id: string; content: string; action_identity: string }>,
    provider_proof: {
      source: "fixture://ticket/PM-10",
      digest: "d".repeat(64),
      read_at: "2026-07-20T00:00:00.000Z",
    },
  };
  request.expected_before = structuredClone(live);
  const calls: string[] = [];
  const intentPath = path.join(fixture.cwd, ".ycm-harness", "autonomy", "strategic-actions", "intents", `${request.action_identity}.json`);
  const dependencies: Partial<StrategicActionDependencies> = {
    now: () => "2026-07-20T00:00:00.000Z",
    ticket: {
      async search() { calls.push("ticket.search"); return []; },
      async read(ticketId) { calls.push("ticket.read"); return ticketId === live.ticket_id ? structuredClone(live) : undefined; },
      async create() { calls.push("ticket.create"); },
      async comment(ticketId, content, identity) {
        calls.push("ticket.comment");
        const pending = JSON.parse(await fs.readFile(intentPath, "utf8"));
        assert.equal(pending.state, "pending");
        assert.deepEqual(pending.authenticated_before, request.expected_before);
        if (!live.comments.some((comment) => comment.content === content && comment.action_identity === identity)) {
          live = {
            ...live,
            comments: [...live.comments, { id: "comment-1", content, action_identity: identity }],
            provider_proof: { ...live.provider_proof, digest: "e".repeat(64) },
          };
        }
        assert.equal(ticketId, live.ticket_id);
      },
      async setPriority() { calls.push("ticket.priority"); },
    },
  };
  try {
    const first = await applyFixture(fixture, request, dependencies);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.status, "APPLIED");
    assert.equal(first.mutation_count, 1);
    assert.deepEqual(first.receipt.provenance.evidence_reference_ids, ["explicit-feedback"]);
    assert.equal(first.receipt.after.kind, "ticket");
    if (first.receipt.after.kind === "ticket") assert.deepEqual(first.receipt.after.comments, live.comments);

    const replay = await applyFixture(fixture, structuredClone(request), dependencies);
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.receipt_bytes, first.receipt_bytes);
    assert.equal(replay.mutation_count, 0);

    const conflict = structuredClone(request);
    if (conflict.selector.operation !== "ticket_comment") throw new Error("expected comment selector");
    conflict.selector.content = "Conflicting replacement comment";
    const blocked = await applyFixture(fixture, conflict, dependencies);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.reason, "ACTION_REPLAY_CONFLICT");
    assert.deepEqual(calls, ["ticket.read", "ticket.comment", "ticket.read"]);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("ticket priority applies one exact live-read change and returns an immutable replay receipt", async () => {
  const fixture = await acceptedReviewWithActions(["Raise PM-11 to high priority"]);
  const lane = fixture.accepted.report.lanes.NOW[0]!;
  const request = actionRequest(fixture);
  request.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, lane.finding_id, lane.action);
  request.selector = {
    operation: "ticket_priority",
    finding_id: lane.finding_id,
    action: lane.action,
    evidence_reference_ids: [...lane.evidence],
    ticket_id: "PM-11",
    priority: "high",
  };
  let live = {
    kind: "ticket" as const,
    ticket_id: "PM-11",
    title: lane.action,
    root_cause: fixture.accepted.report.findings[0]!.root_cause!,
    action_identities: [request.action_identity],
    owner: "pm-owner",
    priority: "medium" as "urgent" | "high" | "medium" | "low",
    comments: [] as Array<{ id: string; content: string; action_identity: string }>,
    provider_proof: {
      source: "fixture://ticket/PM-11",
      digest: "1".repeat(64),
      read_at: "2026-07-20T00:00:00.000Z",
    },
  };
  request.expected_before = structuredClone(live);
  const calls: string[] = [];
  const dependencies: Partial<StrategicActionDependencies> = {
    now: () => "2026-07-20T00:00:00.000Z",
    ticket: {
      async search() { calls.push("ticket.search"); return []; },
      async read(ticketId) { calls.push("ticket.read"); return ticketId === live.ticket_id ? structuredClone(live) : undefined; },
      async create() { calls.push("ticket.create"); },
      async comment() { calls.push("ticket.comment"); },
      async setPriority(ticketId, priority, identity) {
        calls.push("ticket.priority");
        assert.equal(ticketId, live.ticket_id);
        assert.equal(identity, request.action_identity);
        live = {
          ...live,
          priority,
          provider_proof: { ...live.provider_proof, digest: "2".repeat(64) },
        };
      },
    },
  };
  try {
    const first = await applyFixture(fixture, request, dependencies);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.receipt.before.kind, "ticket");
    assert.equal(first.receipt.after.kind, "ticket");
    if (first.receipt.before.kind === "ticket" && first.receipt.after.kind === "ticket") {
      assert.equal(first.receipt.before.priority, "medium");
      assert.equal(first.receipt.after.priority, "high");
    }
    assert.match(first.receipt_id, /^action-receipt-[a-f0-9]{64}$/);

    const replay = await applyFixture(fixture, structuredClone(request), dependencies);
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.receipt_bytes, first.receipt_bytes);
    assert.deepEqual(calls, ["ticket.read", "ticket.priority", "ticket.read"]);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("installed-loop pause and compensating rollback persist intent, exact-read state, and retain receipts", async () => {
  const fixture = await acceptedReviewWithActions([
    "Pause the installed PM loop until the unsafe state is corrected",
    "Restore the installed PM loop to its last authenticated safe state",
  ]);
  const [pauseLane, rollbackLane] = fixture.accepted.report.lanes.NOW;
  assert.ok(pauseLane);
  assert.ok(rollbackLane);
  const safeState = {
    kind: "installed_loop" as const,
    loop_id: "pm-17-00-loop",
    profile: fixture.accepted.report.profile,
    paused: false,
    state_version: "state-v1",
    protected_state_digest: "3".repeat(64),
    read_at: "2026-07-20T00:00:00.000Z",
  };
  let live = structuredClone(safeState);
  const calls: string[] = [];
  const dependencies: Partial<StrategicActionDependencies> = {
    now: () => "2026-07-20T00:00:00.000Z",
    loop: {
      async read(loopId) { calls.push("loop.read"); return loopId === live.loop_id ? structuredClone(live) : undefined; },
      async setPaused(loopId, paused, identity) {
        calls.push(paused ? "loop.pause" : "loop.restore");
        assert.equal(loopId, live.loop_id);
        const intentPath = path.join(fixture.cwd, ".ycm-harness", "autonomy", "strategic-actions", "intents", `${identity}.json`);
        const pending = JSON.parse(await fs.readFile(intentPath, "utf8"));
        assert.equal(pending.state, "pending");
        assert.equal(pending.mutation_attempted, true);
        assert.equal(pending.mutated_at, "2026-07-20T00:00:00.000Z");
        live = paused ? {
          ...live,
          paused: true,
          state_version: "state-v2",
          protected_state_digest: "4".repeat(64),
        } : structuredClone(safeState);
      },
    },
  };
  const pause = actionRequest(fixture);
  pause.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, pauseLane.finding_id, pauseLane.action);
  pause.selector = {
    operation: "installed_loop_pause",
    finding_id: pauseLane.finding_id,
    action: pauseLane.action,
    evidence_reference_ids: [...pauseLane.evidence],
    loop_id: safeState.loop_id,
    reason: "Unsafe recurrent state requires a bounded pause.",
  };
  pause.expected_before = structuredClone(safeState);
  try {
    const paused = await applyFixture(fixture, pause, dependencies);
    assert.equal(paused.ok, true);
    if (!paused.ok) return;
    assert.equal(paused.status, "APPLIED");
    assert.equal(paused.receipt.after.kind, "installed_loop");
    if (paused.receipt.after.kind === "installed_loop") assert.equal(paused.receipt.after.paused, true);

    const rollback = actionRequest(fixture);
    rollback.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, rollbackLane.finding_id, rollbackLane.action);
    rollback.selector = {
      operation: "rollback",
      finding_id: rollbackLane.finding_id,
      action: rollbackLane.action,
      evidence_reference_ids: [...rollbackLane.evidence],
      target_receipt_id: paused.receipt_id,
    };
    rollback.expected_before = structuredClone(live);
    const restored = await applyFixture(fixture, rollback, dependencies);
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.status, "ROLLED_BACK");
    assert.deepEqual(restored.receipt.after, safeState);

    const replay = await applyFixture(fixture, structuredClone(rollback), dependencies);
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.receipt_bytes, restored.receipt_bytes);
    assert.deepEqual(calls, ["loop.read", "loop.pause", "loop.read", "loop.read", "loop.restore", "loop.read"]);
    const receiptNames = await fs.readdir(path.join(fixture.cwd, ".ycm-harness", "autonomy", "strategic-actions", "receipts"));
    assert.equal(receiptNames.length, 2);
    assert.ok(receiptNames.includes(`${paused.receipt_id}.json`));
    assert.ok(receiptNames.includes(`${restored.receipt_id}.json`));
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("rollback rejects a stale authenticated target before compensating mutation", async () => {
  const fixture = await acceptedReviewWithActions(["Pause unsafe loop", "Rollback unsafe loop"]);
  const [pauseLane, rollbackLane] = fixture.accepted.report.lanes.NOW;
  assert.ok(pauseLane);
  assert.ok(rollbackLane);
  let live = {
    kind: "installed_loop" as const,
    loop_id: "pm-stale-loop",
    profile: fixture.accepted.report.profile,
    paused: false,
    state_version: "state-v1",
    protected_state_digest: "5".repeat(64),
    read_at: "2026-07-20T00:00:00.000Z",
  };
  const calls: string[] = [];
  const dependencies: Partial<StrategicActionDependencies> = {
    now: () => "2026-07-20T00:00:00.000Z",
    loop: {
      async read() { calls.push("loop.read"); return structuredClone(live); },
      async setPaused(_loopId, paused) {
        calls.push(paused ? "loop.pause" : "loop.restore");
        live = {
          ...live,
          paused,
          state_version: paused ? "state-v2" : "state-v1",
          protected_state_digest: (paused ? "6" : "5").repeat(64),
        };
      },
    },
  };
  const pause = actionRequest(fixture);
  pause.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, pauseLane.finding_id, pauseLane.action);
  pause.selector = {
    operation: "installed_loop_pause",
    finding_id: pauseLane.finding_id,
    action: pauseLane.action,
    evidence_reference_ids: [...pauseLane.evidence],
    loop_id: live.loop_id,
    reason: "Unsafe state",
  };
  pause.expected_before = structuredClone(live);
  try {
    const paused = await applyFixture(fixture, pause, dependencies);
    assert.equal(paused.ok, true);
    if (!paused.ok) return;
    const authenticatedAfter = structuredClone(paused.receipt.after);
    live = { ...live, state_version: "state-v3", protected_state_digest: "7".repeat(64) };

    const rollback = actionRequest(fixture);
    rollback.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, rollbackLane.finding_id, rollbackLane.action);
    rollback.selector = {
      operation: "rollback",
      finding_id: rollbackLane.finding_id,
      action: rollbackLane.action,
      evidence_reference_ids: [...rollbackLane.evidence],
      target_receipt_id: paused.receipt_id,
    };
    rollback.expected_before = authenticatedAfter;
    const result = await applyFixture(fixture, rollback, dependencies);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "ROLLBACK_TARGET_INVALID");
    assert.deepEqual(calls, ["loop.read", "loop.pause", "loop.read", "loop.read"]);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("readback outage stays PARTIAL, status is read-only, and replay finalizes live state without duplicate mutation", async () => {
  const fixture = await acceptedReviewWithActions(["Attach crash-window evidence to PM-30"]);
  const lane = fixture.accepted.report.lanes.NOW[0]!;
  const request = actionRequest(fixture);
  request.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, lane.finding_id, lane.action);
  request.selector = {
    operation: "ticket_comment",
    finding_id: lane.finding_id,
    action: lane.action,
    evidence_reference_ids: [...lane.evidence],
    ticket_id: "PM-30",
    content: "Crash-window evidence: explicit-feedback",
  };
  let live = {
    kind: "ticket" as const,
    ticket_id: "PM-30",
    title: lane.action,
    root_cause: fixture.accepted.report.findings[0]!.root_cause!,
    action_identities: [request.action_identity],
    owner: "pm-owner",
    priority: "medium" as const,
    comments: [] as Array<{ id: string; content: string; action_identity: string }>,
    provider_proof: {
      source: "fixture://ticket/PM-30",
      digest: "8".repeat(64),
      read_at: "2026-07-20T00:00:00.000Z",
    },
  };
  request.expected_before = structuredClone(live);
  let readbackOutage = true;
  let reads = 0;
  const calls: string[] = [];
  const dependencies: Partial<StrategicActionDependencies> = {
    now: () => "2026-07-20T00:00:00.000Z",
    ticket: {
      async search() { calls.push("ticket.search"); return []; },
      async read() {
        calls.push("ticket.read");
        reads += 1;
        if (readbackOutage && reads > 1) throw new Error("readback outage");
        return structuredClone(live);
      },
      async create() { calls.push("ticket.create"); },
      async comment(_ticketId, content, identity) {
        calls.push("ticket.comment");
        if (!live.comments.some((comment) => comment.content === content && comment.action_identity === identity)) {
          live = {
            ...live,
            comments: [...live.comments, { id: "comment-crash", content, action_identity: identity }],
            provider_proof: { ...live.provider_proof, digest: "9".repeat(64) },
          };
        }
      },
      async setPriority() { calls.push("ticket.priority"); },
    },
  };
  try {
    const partial = await applyFixture(fixture, request, dependencies);
    assert.equal(partial.ok, false);
    if (partial.ok) return;
    assert.equal(partial.status, "PARTIAL");
    assert.equal(partial.reason, "ACTION_READBACK_UNAVAILABLE");
    assert.equal(partial.mutation_count, 1);
    assert.equal(partial.pending_receipt?.action_identity, request.action_identity);

    const statusRequest = structuredClone(request);
    statusRequest.operation = "status";
    const status = await applyFixture(fixture, statusRequest, dependencies);
    assert.equal(status.ok, false);
    if (!status.ok) {
      assert.equal(status.status, "PARTIAL");
      assert.equal(status.reason, "ACTION_PENDING");
    }
    assert.deepEqual(calls, ["ticket.read", "ticket.comment", "ticket.read"]);

    readbackOutage = false;
    const replayRequest = structuredClone(request);
    replayRequest.operation = "replay";
    const recovered = await applyFixture(fixture, replayRequest, dependencies);
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(recovered.status, "APPLIED");
    assert.equal(recovered.mutation_count, 0);
    assert.equal(live.comments.length, 1);
    assert.deepEqual(calls, ["ticket.read", "ticket.comment", "ticket.read", "ticket.read"]);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("mutation attempt is durable before invocation and an uncertain exception replays without duplicate mutation", async () => {
  const fixture = await acceptedReviewWithActions(["Attach uncertain-attempt evidence to PM-31"]);
  const lane = fixture.accepted.report.lanes.NOW[0]!;
  const request = actionRequest(fixture);
  request.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, lane.finding_id, lane.action);
  request.selector = {
    operation: "ticket_comment",
    finding_id: lane.finding_id,
    action: lane.action,
    evidence_reference_ids: [...lane.evidence],
    ticket_id: "PM-31",
    content: "Uncertain attempt evidence",
  };
  let live = {
    kind: "ticket" as const,
    ticket_id: "PM-31",
    title: lane.action,
    root_cause: fixture.accepted.report.findings[0]!.root_cause!,
    action_identities: [request.action_identity],
    owner: "pm-owner",
    priority: "medium" as const,
    comments: [] as Array<{ id: string; content: string; action_identity: string }>,
    provider_proof: {
      source: "fixture://ticket/PM-31",
      digest: "1".repeat(64),
      read_at: "2026-07-20T00:00:00.000Z",
    },
  };
  request.expected_before = structuredClone(live);
  let mutationCalls = 0;
  const dependencies: Partial<StrategicActionDependencies> = {
    now: () => "2026-07-20T00:00:00.000Z",
    ticket: {
      async search() { return []; },
      async read() { return structuredClone(live); },
      async create() { throw new Error("unexpected create"); },
      async comment(_ticketId, content, identity) {
        mutationCalls += 1;
        const intentFile = path.join(
          fixture.cwd,
          ".ycm-harness",
          "autonomy",
          "strategic-actions",
          "intents",
          `${request.action_identity}.json`,
        );
        const intent = JSON.parse(await fs.readFile(intentFile, "utf8")) as {
          state: string;
          mutation_attempted: boolean;
          mutated_at?: string;
        };
        assert.equal(intent.state, "pending");
        assert.equal(intent.mutation_attempted, true);
        assert.equal(intent.mutated_at, "2026-07-20T00:00:00.000Z");
        live = {
          ...live,
          comments: [{ id: "comment-uncertain", content, action_identity: identity }],
          provider_proof: { ...live.provider_proof, digest: "2".repeat(64) },
        };
        throw new Error("transport closed after acceptance");
      },
      async setPriority() { throw new Error("unexpected priority"); },
    },
  };
  try {
    const partial = await applyFixture(fixture, request, dependencies);
    assert.equal(partial.ok, false);
    if (partial.ok) return;
    assert.equal(partial.status, "PARTIAL");
    assert.equal(partial.reason, "ACTION_MUTATION_OUTCOME_UNKNOWN");
    assert.equal(partial.mutation_count, 1);

    const replay = structuredClone(request);
    replay.operation = "replay";
    const recovered = await applyFixture(fixture, replay, dependencies);
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(recovered.status, "APPLIED");
    assert.equal(recovered.mutation_count, 0);
    assert.equal(mutationCalls, 1);
    assert.equal(live.comments.length, 1);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("concurrent equivalent requests converge through the coordination lease to one mutation and receipt", async () => {
  const fixture = await acceptedReviewWithActions(["Add one concurrent-safe comment to PM-40"]);
  const lane = fixture.accepted.report.lanes.NOW[0]!;
  const request = actionRequest(fixture);
  request.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, lane.finding_id, lane.action);
  request.selector = {
    operation: "ticket_comment",
    finding_id: lane.finding_id,
    action: lane.action,
    evidence_reference_ids: [...lane.evidence],
    ticket_id: "PM-40",
    content: "Concurrent evidence comment",
  };
  let live = {
    kind: "ticket" as const,
    ticket_id: "PM-40",
    title: lane.action,
    root_cause: fixture.accepted.report.findings[0]!.root_cause!,
    action_identities: [request.action_identity],
    owner: "pm-owner",
    priority: "medium" as const,
    comments: [] as Array<{ id: string; content: string; action_identity: string }>,
    provider_proof: {
      source: "fixture://ticket/PM-40",
      digest: "a".repeat(64),
      read_at: "2026-07-20T00:00:00.000Z",
    },
  };
  request.expected_before = structuredClone(live);
  let mutationCount = 0;
  const dependencies: Partial<StrategicActionDependencies> = {
    now: () => "2026-07-20T00:00:00.000Z",
    ticket: {
      async search() { return []; },
      async read() { return structuredClone(live); },
      async create() { throw new Error("unexpected create"); },
      async comment(_ticketId, content, identity) {
        mutationCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        live = {
          ...live,
          comments: [{ id: "comment-concurrent", content, action_identity: identity }],
          provider_proof: { ...live.provider_proof, digest: "b".repeat(64) },
        };
      },
      async setPriority() { throw new Error("unexpected priority"); },
    },
  };
  try {
    const [left, right] = await Promise.all([
      applyFixture(fixture, structuredClone(request), dependencies),
      applyFixture(fixture, structuredClone(request), dependencies),
    ]);
    assert.equal(left.ok, true);
    assert.equal(right.ok, true);
    if (!left.ok || !right.ok) return;
    assert.equal(mutationCount, 1);
    assert.equal(left.receipt_id, right.receipt_id);
    assert.equal(left.receipt_bytes, right.receipt_bytes);
    assert.deepEqual([left.mutation_count, right.mutation_count].sort(), [0, 1]);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("provider read outage blocks before mutation and live mismatch never becomes APPLIED", async () => {
  const fixture = await acceptedReviewWithActions(["Set PM-41 to high priority"]);
  const lane = fixture.accepted.report.lanes.NOW[0]!;
  const request = actionRequest(fixture);
  request.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, lane.finding_id, lane.action);
  request.selector = {
    operation: "ticket_priority",
    finding_id: lane.finding_id,
    action: lane.action,
    evidence_reference_ids: [...lane.evidence],
    ticket_id: "PM-41",
    priority: "high",
  };
  const before = {
    kind: "ticket" as const,
    ticket_id: "PM-41",
    title: lane.action,
    root_cause: fixture.accepted.report.findings[0]!.root_cause!,
    action_identities: [request.action_identity],
    owner: "pm-owner",
    priority: "medium" as "urgent" | "high" | "medium" | "low",
    comments: [] as Array<{ id: string; content: string; action_identity: string }>,
    provider_proof: {
      source: "fixture://ticket/PM-41",
      digest: "c".repeat(64),
      read_at: "2026-07-20T00:00:00.000Z",
    },
  };
  request.expected_before = structuredClone(before);
  let writes = 0;
  try {
    const outage = await applyFixture(fixture, request, {
      ticket: {
        async search() { return []; },
        async read() { throw new Error("provider read outage"); },
        async create() { writes += 1; },
        async comment() { writes += 1; },
        async setPriority() { writes += 1; },
      },
    });
    assert.equal(outage.ok, false);
    if (!outage.ok) assert.equal(outage.status, "BLOCKED");
    assert.equal(writes, 0);

    let live = structuredClone(before);
    const mismatch = await applyFixture(fixture, request, {
      now: () => "2026-07-20T00:00:00.000Z",
      ticket: {
        async search() { return []; },
        async read() { return structuredClone(live); },
        async create() { writes += 1; },
        async comment() { writes += 1; },
        async setPriority() {
          writes += 1;
          live = { ...live, priority: "low", provider_proof: { ...live.provider_proof, digest: "d".repeat(64) } };
        },
      },
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.reason, "ACTION_READBACK_MISMATCH");
    assert.equal(writes, 1);

    const statusRequest = structuredClone(request);
    statusRequest.operation = "status";
    const status = await applyFixture(fixture, statusRequest, {
      ticket: {
        async search() { throw new Error("status must be read-only"); },
        async read() { throw new Error("status must be read-only"); },
        async create() { throw new Error("status must be read-only"); },
        async comment() { throw new Error("status must be read-only"); },
        async setPriority() { throw new Error("status must be read-only"); },
      },
    });
    assert.equal(status.ok, false);
    if (!status.ok) {
      assert.equal(status.status, "BLOCKED");
      assert.equal(status.reason, "ACTION_PENDING");
    }

    // Still-mismatched live state: replay re-reads and stays BLOCKED without another mutation.
    const mismatchedReplay = structuredClone(request);
    mismatchedReplay.operation = "replay";
    const stillBlocked = await applyFixture(fixture, mismatchedReplay, {
      ticket: {
        async search() { return []; },
        async read() { return structuredClone(live); },
        async create() { writes += 1; },
        async comment() { writes += 1; },
        async setPriority() { writes += 1; },
      },
    });
    assert.equal(stillBlocked.ok, false);
    if (!stillBlocked.ok) {
      assert.equal(stillBlocked.status, "BLOCKED");
      assert.equal(stillBlocked.reason, "ACTION_READBACK_MISMATCH");
    }
    assert.equal(writes, 1);

    // Correct the live state to the intended priority; replay must finalize without re-mutating.
    live = { ...live, priority: "high", provider_proof: { ...live.provider_proof, digest: "e".repeat(64) } };
    const recovered = await applyFixture(fixture, mismatchedReplay, {
      now: () => "2026-07-20T00:00:01.000Z",
      ticket: {
        async search() { return []; },
        async read() { return structuredClone(live); },
        async create() { writes += 1; },
        async comment() { writes += 1; },
        async setPriority() { writes += 1; },
      },
    });
    assert.equal(recovered.ok, true);
    if (!recovered.ok) return;
    assert.equal(recovered.status, "APPLIED");
    assert.equal(recovered.mutation_count, 0);
    assert.equal(writes, 1);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("apply rejects a stale expected ticket search state before mutation", async () => {
  const fixture = await acceptedReviewFixture();
  const request = actionRequest(fixture);
  const calls: string[] = [];
  try {
    const result = await applyFixture(fixture, request, {
      ticket: {
        async search() {
          calls.push("ticket.search");
          return [{
            kind: "ticket",
            ticket_id: "PM-9",
            title: request.selector.action,
            root_cause: request.expected_before.kind === "ticket_search" ? request.expected_before.root_cause : "",
            action_identities: [request.action_identity],
            owner: null,
            priority: "medium",
            comments: [],
            provider_proof: {
              source: "fixture://ticket/PM-9",
              digest: "a".repeat(64),
              read_at: "2026-07-20T00:00:00.000Z",
            },
          }];
        },
        async read() { calls.push("ticket.read"); return undefined; },
        async create() { calls.push("ticket.create"); },
        async comment() { calls.push("ticket.comment"); },
        async setPriority() { calls.push("ticket.priority"); },
      },
    });

    assert.equal(result.reason, "ACTION_EXPECTED_STATE_STALE");
    assert.deepEqual(calls, ["ticket.search"]);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

async function installProductionActionHarness(root: string): Promise<{
  bin: string;
  stateFile: string;
  restorePath: string | undefined;
  restoreFakeState: string | undefined;
  restoreFakeWrapper: string | undefined;
}> {
  const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const parent = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
  const now = "2026-07-20T00:00:00.000Z";
  const state = emptyStateV3(now);
  state.goals.goal = {
    id: "goal",
    title: "Strategic action production fixture",
    status: "active",
    assurance: "standard",
    backend: { kind: "multica", origin: "https://example.com", workspace_id: workspace, parent_issue_id: parent },
    worktree_status: "active",
    stop_enforcement: false,
    created_at: now,
    updated_at: now,
  };
  state.active_goal_id = "goal";
  await new HarnessStore(root).writeStateV3(state);
  const bindingFile = coordinationBindingPath(root, "goal");
  await fs.mkdir(path.dirname(bindingFile), { recursive: true });
  await fs.writeFile(bindingFile, `${JSON.stringify({
    schema_version: 1,
    goal_id: "goal",
    credential_mode: "profile",
    profile: "dev",
    server_origin: "https://example.com",
    workspace_id: workspace,
    parent_id: parent,
    parent_identifier: "AUT-3",
    project_source: "parent",
    issue_prefix: "AUT",
    verified_at: now,
  })}\n`, "utf8");
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), "strategic-action-bin-"));
  const script = path.join(bin, "multica.js");
  const stateFile = path.join(bin, "state.json");
  await fs.writeFile(stateFile, JSON.stringify({ issues: [], calls: [] }), "utf8");
  await fs.writeFile(script, `
const fs = require("node:fs");
const args = process.argv.slice(2);
const stateFile = require("node:path").join(__dirname, "state.json");
const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
const issueAt = args.indexOf("issue");
const issueArgs = issueAt >= 0 ? args.slice(issueAt) : [];
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state));
const output = (value) => process.stdout.write(JSON.stringify(value));
state.calls.push(issueArgs.length ? issueArgs : args);
if (args.includes("config") && args.includes("identity")) {
  save();
  output({ profile: "dev", server_origin: "https://example.com", workspace_id: "${workspace}" });
} else if (issueArgs[1] === "get" && issueArgs[2] === "${parent}") {
  save();
  output({ id: "${parent}", identifier: "AUT-3", workspace_id: "${workspace}", title: "Parent", status: "todo" });
} else if (issueArgs[1] === "get") {
  const row = state.issues.find((item) => item.id === issueArgs[2] || item.identifier === issueArgs[2]);
  if (!row) {
    save();
    process.stderr.write('resolve issue: GET /api/issues/' + encodeURIComponent(issueArgs[2]) + ' returned 404: {"error":"issue not found"}');
    process.exitCode = 1;
  } else {
    save();
    output(row);
  }
} else if (issueArgs[1] === "search") {
  const query = String(issueArgs[2] || "");
  const rows = state.issues.filter((item) => JSON.stringify(item).includes(query));
  save();
  output({ issues: rows, total: rows.length, limit: 200, offset: 0, has_more: false });
} else if (issueArgs[1] === "create") {
  const stdin = fs.readFileSync(0, "utf8");
  const row = {
    id: "dddddddd-dddd-4ddd-8ddd-ddddddddddd4",
    identifier: "AUT-35",
    title: issueArgs[issueArgs.indexOf("--title") + 1],
    description: stdin,
    status: "todo",
    priority: "medium",
    parent_issue_id: "${parent}",
    assignee_id: null,
    assignee_type: null,
    comments: [],
  };
  state.issues.push(row);
  save();
  output(row);
} else if (issueArgs[1] === "comment" && issueArgs[2] === "add") {
  const row = state.issues.find((item) => item.id === issueArgs[3]);
  const stdin = fs.readFileSync(0, "utf8");
  if (!row) process.exitCode = 1;
  else {
    const comment = { id: "comment-" + (row.comments.length + 1), content: stdin };
    row.comments.push(comment);
    save();
    output(comment);
  }
} else if (issueArgs[1] === "update") {
  const row = state.issues.find((item) => item.id === issueArgs[2]);
  if (!row) process.exitCode = 1;
  else {
    row.priority = issueArgs[issueArgs.indexOf("--priority") + 1];
    save();
    output(row);
  }
} else {
  save();
  process.stderr.write("unexpected fake multica call: " + args.join(" "));
  process.exitCode = 2;
}
`);
  if (process.platform === "win32") {
    await fs.writeFile(path.join(bin, "multica.cmd"), `@node "%~dp0multica.js" %*\r\n`);
  } else {
    await fs.writeFile(path.join(bin, "multica"), `#!/usr/bin/env node\n${await fs.readFile(script, "utf8")}`, { encoding: "utf8", mode: 0o755 });
  }
  const restorePath = process.env.PATH;
  const restoreFakeState = process.env.MULTICA_FAKE_STATE;
  const restoreFakeWrapper = process.env.MULTICA_FAKE_WRAPPER;
  process.env.PATH = `${bin}${path.delimiter}${restorePath ?? ""}`;
  process.env.MULTICA_FAKE_STATE = stateFile;
  process.env.MULTICA_FAKE_WRAPPER = script;
  return { bin, stateFile, restorePath, restoreFakeState, restoreFakeWrapper };
}

test("public apply uses the production installed-loop state and replays pause plus rollback without action injection", async () => {
  const fixture = await acceptedReviewWithActions([
    "Pause the installed PM loop through production state",
    "Restore the installed PM loop through production state",
  ]);
  const [pauseLane, rollbackLane] = fixture.accepted.report.lanes.NOW;
  assert.ok(pauseLane);
  assert.ok(rollbackLane);
  const runtime = await installProductionActionHarness(fixture.cwd);
  const loopId = "pm-17-00-loop";
  const authority = {
    installation_id: fixture.accepted.report.authority.installation_id,
    profile: fixture.accepted.report.profile,
    loop_id: loopId,
  };
  const applyProduction = (request: StrategicActionRequest) => withStrategicReviewTestDependencies(
    { installationRoot: async () => fixture.installationRoot },
    () => publicApply(request),
  );
  try {
    const before = await readInstalledLoopState(fixture.cwd, authority);
    assert.equal(before.paused, false);
    const pause = actionRequest(fixture);
    pause.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, pauseLane.finding_id, pauseLane.action);
    pause.selector = {
      operation: "installed_loop_pause",
      finding_id: pauseLane.finding_id,
      action: pauseLane.action,
      evidence_reference_ids: [...pauseLane.evidence],
      loop_id: loopId,
      reason: "Authenticated production pause",
    };
    pause.expected_before = before;

    const paused = await applyProduction(pause);
    assert.equal(paused.ok, true, JSON.stringify(paused));
    if (!paused.ok) return;
    assert.equal(paused.status, "APPLIED");
    assert.equal(paused.receipt.after.kind, "installed_loop");
    if (paused.receipt.after.kind === "installed_loop") assert.equal(paused.receipt.after.paused, true);
    const replay = await applyProduction(structuredClone(pause));
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.receipt_bytes, paused.receipt_bytes);
    assert.equal(replay.mutation_count, 0);

    const rollback = actionRequest(fixture);
    rollback.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, rollbackLane.finding_id, rollbackLane.action);
    rollback.selector = {
      operation: "rollback",
      finding_id: rollbackLane.finding_id,
      action: rollbackLane.action,
      evidence_reference_ids: [...rollbackLane.evidence],
      target_receipt_id: paused.receipt_id,
    };
    rollback.expected_before = paused.receipt.after;
    const restored = await applyProduction(rollback);
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.status, "ROLLED_BACK");
    assert.equal((await readInstalledLoopState(fixture.cwd, authority)).paused, false);
    const history = await fs.readdir(path.join(
      fixture.cwd, ".ycm-harness", "autonomy", "installed-loops", "history", loopId,
    ));
    assert.equal(history.length, 2);
  } finally {
    process.env.PATH = runtime.restorePath;
    if (runtime.restoreFakeState === undefined) delete process.env.MULTICA_FAKE_STATE;
    else process.env.MULTICA_FAKE_STATE = runtime.restoreFakeState;
    if (runtime.restoreFakeWrapper === undefined) delete process.env.MULTICA_FAKE_WRAPPER;
    else process.env.MULTICA_FAKE_WRAPPER = runtime.restoreFakeWrapper;
    await fs.rm(runtime.bin, { recursive: true, force: true });
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("public apply resolves the verified Multica provider for create, comment, priority, and replay", async () => {
  const fixture = await acceptedReviewWithActions([
    "Create durable ownership for accepted feedback",
    "Attach accepted feedback evidence to the created ticket",
    "Raise the created ticket to high priority",
  ]);
  const [createLane, commentLane, priorityLane] = fixture.accepted.report.lanes.NOW;
  assert.ok(createLane);
  assert.ok(commentLane);
  assert.ok(priorityLane);
  const runtime = await installProductionActionHarness(fixture.cwd);
  const applyProduction = (request: StrategicActionRequest) => withStrategicReviewTestDependencies(
    { installationRoot: async () => fixture.installationRoot },
    () => publicApply(request),
  );
  try {
    const create = actionRequest(fixture);
    create.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, createLane.finding_id, createLane.action);
    if (create.selector.operation !== "ticket_reuse_or_create" || create.expected_before.kind !== "ticket_search") {
      throw new Error("expected create request");
    }
    create.selector.action = createLane.action;
    create.selector.ticket.title = createLane.action;
    create.expected_before.action_identity = create.action_identity;
    create.selector.evidence_reference_ids = [...createLane.evidence];
    const created = await applyProduction(create);
    assert.equal(created.ok, true, JSON.stringify({
      created,
      fake: JSON.parse(await fs.readFile(runtime.stateFile, "utf8")),
    }));
    if (!created.ok || created.receipt.after.kind !== "ticket") return;
    assert.equal(created.mutation_count, 1);
    assert.equal(created.receipt.after.ticket_id, "dddddddd-dddd-4ddd-8ddd-ddddddddddd4");
    assert.deepEqual(created.receipt.after.action_identities, [create.action_identity]);

    const comment = actionRequest(fixture);
    comment.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, commentLane.finding_id, commentLane.action);
    comment.selector = {
      operation: "ticket_comment",
      finding_id: commentLane.finding_id,
      action: commentLane.action,
      evidence_reference_ids: [...commentLane.evidence],
      ticket_id: created.receipt.after.ticket_id,
      content: "Accepted evidence: explicit-feedback",
    };
    comment.expected_before = created.receipt.after;
    const commented = await applyProduction(comment);
    assert.equal(commented.ok, true);
    if (!commented.ok || commented.receipt.after.kind !== "ticket") return;
    assert.equal(commented.receipt.after.comments.length, 1);
    assert.equal(commented.receipt.after.comments[0]?.action_identity, comment.action_identity);

    const priority = actionRequest(fixture);
    priority.action_identity = canonicalStrategicActionIdentity(fixture.accepted.report.profile, priorityLane.finding_id, priorityLane.action);
    priority.selector = {
      operation: "ticket_priority",
      finding_id: priorityLane.finding_id,
      action: priorityLane.action,
      evidence_reference_ids: [...priorityLane.evidence],
      ticket_id: created.receipt.after.ticket_id,
      priority: "high",
    };
    priority.expected_before = commented.receipt.after;
    const prioritized = await applyProduction(priority);
    assert.equal(prioritized.ok, true);
    if (!prioritized.ok || prioritized.receipt.after.kind !== "ticket") return;
    assert.equal(prioritized.receipt.after.priority, "high");
    const replay = await applyProduction(structuredClone(priority));
    assert.equal(replay.ok, true);
    if (!replay.ok) return;
    assert.equal(replay.receipt_bytes, prioritized.receipt_bytes);
    assert.equal(replay.mutation_count, 0);

    const fake = JSON.parse(await fs.readFile(runtime.stateFile, "utf8"));
    const issueCalls: string[][] = fake.calls;
    assert.equal(issueCalls.filter((args) => args[1] === "create").length, 1);
    assert.equal(issueCalls.filter((args) => args[1] === "comment" && args[2] === "add").length, 1);
    assert.equal(issueCalls.filter((args) => args[1] === "update" && args.includes("--priority")).length, 1);
    assert.ok(issueCalls.some((args) => args[1] === "search"));
    assert.ok(issueCalls.every((args) => !args.includes("list") && !args.includes("--idempotency-key")));
  } finally {
    process.env.PATH = runtime.restorePath;
    if (runtime.restoreFakeState === undefined) delete process.env.MULTICA_FAKE_STATE;
    else process.env.MULTICA_FAKE_STATE = runtime.restoreFakeState;
    if (runtime.restoreFakeWrapper === undefined) delete process.env.MULTICA_FAKE_WRAPPER;
    else process.env.MULTICA_FAKE_WRAPPER = runtime.restoreFakeWrapper;
    await fs.rm(runtime.bin, { recursive: true, force: true });
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("provider search outage before mutation stays BLOCKED with zero mutation", async () => {
  const fixture = await acceptedReviewFixture();
  const request = actionRequest(fixture);
  let writes = 0;
  try {
    const result = await applyFixture(fixture, request, {
      ticket: {
        async search() { throw new Error("provider search outage"); },
        async read() { writes += 1; return undefined; },
        async create() { writes += 1; },
        async comment() { writes += 1; },
        async setPriority() { writes += 1; },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, "BLOCKED");
      assert.equal(result.mutation_count, 0);
    }
    assert.equal(writes, 0);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("ticket priority rollback restores authenticated before-state and rejects conflicting content", async () => {
  const fixture = await acceptedReviewWithActions([
    "Raise PM-61 to high priority",
    "Restore PM-61 to the last authenticated priority",
  ]);
  const [priorityLane, rollbackLane] = fixture.accepted.report.lanes.NOW;
  assert.ok(priorityLane);
  assert.ok(rollbackLane);
  const priorityIdentity = canonicalStrategicActionIdentity(
    fixture.accepted.report.profile,
    priorityLane.finding_id,
    priorityLane.action,
  );
  const safeBefore = {
    kind: "ticket" as const,
    ticket_id: "PM-61",
    title: priorityLane.action,
    root_cause: fixture.accepted.report.findings[0]!.root_cause!,
    action_identities: [priorityIdentity],
    owner: "pm-owner" as string | null,
    priority: "medium" as "urgent" | "high" | "medium" | "low",
    comments: [] as Array<{ id: string; content: string; action_identity: string }>,
    provider_proof: {
      source: "fixture://ticket/PM-61",
      digest: "f".repeat(64),
      read_at: "2026-07-20T00:00:00.000Z",
    },
  };
  let live = structuredClone(safeBefore);
  const calls: string[] = [];
  const dependencies: Partial<StrategicActionDependencies> = {
    now: () => "2026-07-20T00:00:00.000Z",
    ticket: {
      async search() { calls.push("ticket.search"); return []; },
      async read() { calls.push("ticket.read"); return structuredClone(live); },
      async create() { calls.push("ticket.create"); },
      async comment() { calls.push("ticket.comment"); },
      async setPriority(_ticketId, priority) {
        calls.push("ticket.priority");
        live = priority === safeBefore.priority
          ? structuredClone(safeBefore)
          : {
            ...live,
            priority,
            provider_proof: { ...live.provider_proof, digest: "a".repeat(64) },
          };
      },
    },
  };
  try {
    const priority = actionRequest(fixture);
    priority.action_identity = priorityIdentity;
    priority.selector = {
      operation: "ticket_priority",
      finding_id: priorityLane.finding_id,
      action: priorityLane.action,
      evidence_reference_ids: [...priorityLane.evidence],
      ticket_id: "PM-61",
      priority: "high",
    };
    priority.expected_before = structuredClone(live);
    const raised = await applyFixture(fixture, priority, dependencies);
    assert.equal(raised.ok, true);
    if (!raised.ok) return;
    assert.equal(raised.receipt.after.kind, "ticket");
    if (raised.receipt.after.kind === "ticket") assert.equal(raised.receipt.after.priority, "high");

    const conflict = structuredClone(priority);
    if (conflict.selector.operation !== "ticket_priority") throw new Error("expected priority");
    conflict.selector.priority = "urgent";
    const blocked = await applyFixture(fixture, conflict, dependencies);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.reason, "ACTION_REPLAY_CONFLICT");

    const rollback = actionRequest(fixture);
    rollback.action_identity = canonicalStrategicActionIdentity(
      fixture.accepted.report.profile,
      rollbackLane.finding_id,
      rollbackLane.action,
    );
    rollback.selector = {
      operation: "rollback",
      finding_id: rollbackLane.finding_id,
      action: rollbackLane.action,
      evidence_reference_ids: [...rollbackLane.evidence],
      target_receipt_id: raised.receipt_id,
    };
    rollback.expected_before = raised.receipt.after;
    const restored = await applyFixture(fixture, rollback, dependencies);
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.status, "ROLLED_BACK");
    assert.equal(restored.receipt.after.kind, "ticket");
    if (restored.receipt.after.kind === "ticket") assert.equal(restored.receipt.after.priority, "medium");
    assert.equal(live.priority, "medium");
    assert.ok(calls.includes("ticket.priority"));
    const receiptNames = await fs.readdir(path.join(
      fixture.cwd, ".ycm-harness", "autonomy", "strategic-actions", "receipts",
    ));
    assert.equal(receiptNames.length, 2);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

test("CLI autonomy action apply routes the public apply seam without adapter injection", async () => {
  const fixture = await acceptedReviewFixture();
  const request = actionRequest(fixture);
  const json: unknown[] = [];
  const program = new Command();
  program.exitOverride();
  registerAutonomy(program, createContext(fixture.cwd), {
    out() {},
    err() {},
    json(value) { json.push(value); },
  });
  const requestFile = path.join(fixture.cwd, "action-request.json");
  const { cwd: _cwd, operation: _operation, ...body } = request;
  await fs.writeFile(requestFile, JSON.stringify(body), "utf8");
  try {
    await withStrategicReviewTestDependencies(
      { installationRoot: async () => fixture.installationRoot },
      () => withStrategicActionTestDependencies({
        ticket: {
          async search() { throw new Error("provider search outage"); },
          async read() { return undefined; },
          async create() {},
          async comment() {},
          async setPriority() {},
        },
      }, async () => {
        await program.parseAsync(
          ["autonomy", "action", "apply", "--file", requestFile],
          { from: "user" },
        );
      }),
    );
    assert.equal(json.length, 1);
    const result = json[0] as { ok: boolean; status?: string; reason?: string; mutation_count?: number };
    assert.equal(result.ok, false);
    assert.equal(result.status, "BLOCKED");
    assert.equal(result.mutation_count, 0);
  } finally {
    await fs.rm(fixture.cwd, { recursive: true, force: true });
    await fs.rm(fixture.installationRoot, { recursive: true, force: true });
  }
});

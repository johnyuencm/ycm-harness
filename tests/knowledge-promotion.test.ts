import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign as signBytes } from "node:crypto";
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
  promote as publicPromote,
  STRATEGIC_ACTION_SELECTOR_OPERATIONS,
  canonicalStrategicActionIdentity,
  canonicalKnowledgePromotionIdentity,
  withKnowledgePromotionTestDependencies,
  type KnowledgePromotionRequest,
  type StrategicActionRequest,
  type StrategicReviewNormalSuccess,
} from "../src/index.js";
import { withStrategicActionTestDependencies } from "../src/autonomy/strategic-action.js";
import { withStrategicReviewTestDependencies } from "../src/autonomy/strategic-review.js";
import type { StrategicTicketCapability, StrategicTicketRead } from "../src/tickets/provider.js";

interface AcceptedReviewFixture {
  cwd: string;
  installationRoot: string;
  request: Record<string, any>;
  accepted: StrategicReviewNormalSuccess;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

async function createSignedReviewInstallation(request: Record<string, any>): Promise<string> {
  const installationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-promotion-installation-"));
  const configRoot = path.join(installationRoot, "config");
  const recordRoot = path.join(installationRoot, "records");
  await fs.mkdir(configRoot, { recursive: true });
  await fs.mkdir(recordRoot, { recursive: true });
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const originId = request.evidence_origin.origin_id;
  const recordId = request.evidence_origin.record_id;
  const keyId = "knowledge-promotion-review-key";
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
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-promotion-"));
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

function memoryTicket(seed: StrategicTicketRead): StrategicTicketCapability & { store: Map<string, StrategicTicketRead> } {
  const store = new Map<string, StrategicTicketRead>([[seed.ticket_id, structuredClone(seed)]]);
  return {
    store,
    async search() { return [...store.values()]; },
    async read(id) { return store.has(id) ? structuredClone(store.get(id)!) : undefined; },
    async create(input) {
      const ticket: StrategicTicketRead = {
        kind: "ticket",
        ticket_id: `PROM-${store.size + 1}`,
        title: input.title,
        description: input.brief,
        root_cause: input.root_cause,
        action_identities: [input.action_identity],
        owner: null,
        priority: "medium",
        status: "todo",
        comments: [],
        provider_proof: { source: "memory", digest: sha256(input.title), read_at: new Date().toISOString() },
      };
      store.set(ticket.ticket_id, ticket);
      return structuredClone(ticket);
    },
    async comment(id, content, actionIdentity) {
      const ticket = store.get(id);
      if (!ticket) throw new Error("missing");
      ticket.comments.push({ id: `c-${ticket.comments.length + 1}`, content, action_identity: actionIdentity });
      ticket.provider_proof = { source: "memory", digest: sha256(content), read_at: new Date().toISOString() };
      return structuredClone(ticket);
    },
    async setPriority(id, priority) {
      const ticket = store.get(id);
      if (!ticket) throw new Error("missing");
      ticket.priority = priority;
      ticket.provider_proof = { source: "memory", digest: sha256(priority), read_at: new Date().toISOString() };
      return structuredClone(ticket);
    },
  };
}

async function acceptedActionFixture(): Promise<{
  fixture: AcceptedReviewFixture;
  action: Extract<Awaited<ReturnType<typeof publicApply>>, { ok: true }>;
  promotionTicket: StrategicTicketRead;
  tickets: ReturnType<typeof memoryTicket>;
}> {
  const fixture = await acceptedReviewFixture();
  const lane = Object.values(fixture.accepted.report.lanes).flat()[0]!;
  const actionIdentity = canonicalStrategicActionIdentity(
    fixture.accepted.report.profile,
    lane.finding_id,
    lane.action,
  );
  const created: StrategicTicketRead = {
    kind: "ticket",
    ticket_id: "ACT-1",
    title: lane.action,
    description: lane.action,
    root_cause: fixture.accepted.report.findings[0]!.root_cause,
    action_identities: [actionIdentity],
    owner: null,
    priority: "medium",
    status: "todo",
    comments: [],
    provider_proof: { source: "memory", digest: sha256("act"), read_at: "2026-07-18T17:01:00.000Z" },
  };
  const tickets = memoryTicket(created);
  const { operation: _operation, ...authentication } = fixture.request;
  const actionRequest: StrategicActionRequest = {
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
      finding_id: lane.finding_id,
      action: lane.action,
      root_cause: fixture.accepted.report.findings[0]!.root_cause,
      evidence_reference_ids: [...lane.evidence],
      owner: null,
      ticket: { title: lane.action, brief: lane.action, acceptance: [lane.action] },
    },
    expected_before: {
      kind: "ticket_search",
      root_cause: fixture.accepted.report.findings[0]!.root_cause,
      action_identity: actionIdentity,
      owner: null,
      matching_ticket_ids: [],
    },
  };
  let actionTicket: StrategicTicketRead | undefined;
  const action = await withStrategicReviewTestDependencies(
    { installationRoot: async () => fixture.installationRoot },
    () => withStrategicActionTestDependencies({
      ticket: {
        async search() { return actionTicket ? [actionTicket] : []; },
        async read(id) {
          return actionTicket?.ticket_id === id ? structuredClone(actionTicket) : undefined;
        },
        async create(input) {
          actionTicket = {
            kind: "ticket",
            ticket_id: "ACT-1",
            title: input.title,
            root_cause: input.root_cause,
            action_identities: [input.action_identity],
            owner: null,
            priority: "medium",
            comments: [],
            provider_proof: {
              source: "fixture://ticket/ACT-1",
              digest: "a".repeat(64),
              read_at: "2026-07-18T17:05:00.000Z",
            },
          };
          tickets.store.set(actionTicket.ticket_id, structuredClone(actionTicket));
          return structuredClone(actionTicket);
        },
        async comment(id, content, actionIdentity) {
          return tickets.comment(id, content, actionIdentity);
        },
        async setPriority(id, priority) { return tickets.setPriority(id, priority); },
      },
      now: () => "2026-07-18T17:05:00.000Z",
    }, () => publicApply(actionRequest)),
  );
  assert.equal(action.ok, true);
  if (!action.ok) throw new Error("action failed");
  const promotionTicket = await tickets.create({
    title: "Promote reusable triage lesson",
    brief: "Curate the verified reusable lesson from accepted action evidence into the knowledge base.",
    acceptance: ["Raw immutable", "Curated page linked", "Index/log updated"],
    root_cause: "Reusable lesson from accepted action is not yet curated.",
    action_identity: actionIdentity,
    owner: null,
  });
  await tickets.comment(promotionTicket.ticket_id, `promotion-of:${action.receipt_id}`, actionIdentity);
  const live = await tickets.read(promotionTicket.ticket_id);
  assert.ok(live);
  return { fixture, action, promotionTicket: live!, tickets };
}

function promotionRequest(
  ctx: Awaited<ReturnType<typeof acceptedActionFixture>>,
  overrides: Partial<KnowledgePromotionRequest> = {},
): KnowledgePromotionRequest {
  const { fixture, action, promotionTicket } = ctx;
  const pageId = "triage-root-cause-binding-lesson";
  const rawBytes = "Verified reusable lesson: bind explicit feedback evidence to daily triage control before disposition.";
  const promotionIdentity = canonicalKnowledgePromotionIdentity({
    ticket_id: promotionTicket.ticket_id,
    action_receipt_id: action.receipt_id,
    page_id: pageId,
    raw_body_sha256: sha256(rawBytes),
  });
  const { operation: _op, ...authentication } = fixture.request;
  const base: KnowledgePromotionRequest = {
    cwd: fixture.cwd,
    operation: "promote",
    promotion_identity: promotionIdentity,
    worker: {
      worker_id: "later-worker-promoter",
      authenticated_at: "2026-07-18T18:00:00.000Z",
      proof: `knowledge-promotion/v1/${fixture.request.profile}/${fixture.request.authority.domain}`,
    },
    ticket: {
      ticket_id: promotionTicket.ticket_id,
      linked_action_receipt_id: action.receipt_id,
      linked_action_identity: action.receipt.action_identity,
    },
    report: {
      report_id: fixture.accepted.report_id,
      report_sha256: fixture.accepted.report_sha256,
      report_bytes: fixture.accepted.report_bytes,
      authentication,
    },
    action: {
      receipt_id: action.receipt_id,
      receipt_sha256: action.receipt_sha256,
      receipt_bytes: action.receipt_bytes,
      action_identity: action.receipt.action_identity,
    },
    producer: {
      worker_id: fixture.request.producer.id,
      finalized_at: action.receipt.timestamps.finalized_at,
    },
    raw: {
      bytes: rawBytes,
      provenance: {
        origin: "accepted-action-lesson",
        source_uri: `ticket://${promotionTicket.ticket_id}`,
        content_type: "article",
        type_metadata: { kind: "reusable_lesson" },
      },
      classification: "reusable_lesson",
    },
    lesson: {
      page_id: pageId,
      title: "Triage root-cause binding lesson",
      type: "concept",
      tags: ["workflow", "triage", "learning"],
      body: "Bind explicit feedback evidence to the daily triage control before disposition. Supported by accepted action evidence.",
      confidence: "high",
      contradictions: [],
      related_page_ids: ["llm-knowledge-bases", "knowledge-ingestion"],
      search_query: "triage root-cause binding",
      evidence_reference_ids: [...action.receipt.provenance.evidence_reference_ids],
    },
  };
  return {
    ...base,
    ...overrides,
    raw: { ...base.raw, ...(overrides.raw ?? {}), provenance: { ...base.raw.provenance, ...(overrides.raw?.provenance ?? {}) } },
    lesson: { ...base.lesson, ...(overrides.lesson ?? {}) },
    worker: { ...base.worker, ...(overrides.worker ?? {}) },
    ticket: { ...base.ticket, ...(overrides.ticket ?? {}) },
    action: { ...base.action, ...(overrides.action ?? {}) },
    producer: { ...base.producer, ...(overrides.producer ?? {}) },
    report: { ...base.report, ...(overrides.report ?? {}) },
  };
}

async function promoteFixture(
  ctx: Awaited<ReturnType<typeof acceptedActionFixture>>,
  request: KnowledgePromotionRequest,
  deps: Parameters<typeof withKnowledgePromotionTestDependencies>[0] = {},
) {
  return withStrategicReviewTestDependencies(
    { installationRoot: async () => ctx.fixture.installationRoot },
    () => withKnowledgePromotionTestDependencies({
      ticket: ctx.tickets,
      now: () => "2026-07-18T18:00:00.000Z",
      ...deps,
    }, () => publicPromote(request)),
  );
}

test("promote requires a live durable promotion ticket linked to accepted action evidence", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const missing = await promoteFixture(ctx, promotionRequest(ctx, {
      ticket: {
        ticket_id: "MISSING",
        linked_action_receipt_id: ctx.action.receipt_id,
        linked_action_identity: ctx.action.receipt.action_identity,
      },
    }));
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.reason, "PROMOTION_TICKET_REQUIRED");

    const unlinked = structuredClone(ctx.promotionTicket);
    unlinked.comments = [];
    unlinked.action_identities = [];
    ctx.tickets.store.set(unlinked.ticket_id, unlinked);
    const badLink = await promoteFixture(ctx, promotionRequest(ctx));
    assert.equal(badLink.ok, false);
    if (!badLink.ok) assert.equal(badLink.reason, "PROMOTION_TICKET_REQUIRED");
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("promote rejects same-worker and earlier-worker promoters", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const same = await promoteFixture(ctx, promotionRequest(ctx, {
      worker: {
        worker_id: ctx.fixture.request.producer.id,
        authenticated_at: "2026-07-18T18:00:00.000Z",
        proof: `knowledge-promotion/v1/${ctx.fixture.request.profile}/${ctx.fixture.request.authority.domain}`,
      },
    }));
    assert.equal(same.ok, false);
    if (!same.ok) assert.equal(same.reason, "LATER_WORKER_REQUIRED");

    const earlier = await promoteFixture(ctx, promotionRequest(ctx, {
      worker: {
        worker_id: "later-worker-promoter",
        authenticated_at: "2026-07-18T17:00:00.000Z",
        proof: `knowledge-promotion/v1/${ctx.fixture.request.profile}/${ctx.fixture.request.authority.domain}`,
      },
    }));
    assert.equal(earlier.ok, false);
    if (!earlier.ok) assert.equal(earlier.reason, "LATER_WORKER_REQUIRED");
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("promote rejects speculative volatile secrets and unsupported content", async () => {
  const ctx = await acceptedActionFixture();
  try {
    for (const [classification, reason] of [
      ["speculative", "LESSON_NOT_VERIFIED"],
      ["volatile_monitor", "PROMOTION_CONTENT_FORBIDDEN"],
      ["credentials", "PROMOTION_CONTENT_FORBIDDEN"],
      ["private_runtime", "PROMOTION_CONTENT_FORBIDDEN"],
      ["temporary_report", "PROMOTION_CONTENT_FORBIDDEN"],
      ["generated_cache", "PROMOTION_CONTENT_FORBIDDEN"],
      ["unsupported", "PROMOTION_CONTENT_FORBIDDEN"],
    ] as const) {
      const result = await promoteFixture(ctx, promotionRequest(ctx, {
        raw: {
          bytes: classification === "credentials"
            ? "api_key=" + "sk-" + "abcdefghijklmnopqrstuvwxyz012345"
            : "lesson text without secrets",
          provenance: {
            origin: "x",
            source_uri: "u",
            content_type: "article",
            type_metadata: { kind: classification },
          },
          classification,
        },
      }));
      assert.equal(result.ok, false, classification);
      if (!result.ok) assert.equal(result.reason, reason, classification);
    }
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("promote rejects missing provenance", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const request = promotionRequest(ctx);
    (request.raw.provenance as { origin: string }).origin = "";
    const result = await promoteFixture(ctx, request);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "PROMOTION_PROVENANCE_REQUIRED");
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("happy path promotes immutable raw curated page index log query lint and receipt", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const request = promotionRequest(ctx);
    const result = await promoteFixture(ctx, request);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, "PROMOTED");
    assert.equal(result.mutation_count, 1);
    const receipt = result.receipt;
    assert.equal(receipt.raw.body_sha256, sha256(request.raw.bytes));
    assert.ok(receipt.curated.content_sha256);
    assert.equal(receipt.curated.page_id, request.lesson.page_id);
    assert.equal(receipt.curated.prior_page_id, null);
    assert.equal(receipt.ticket.ticket_id, request.ticket.ticket_id);
    assert.equal(receipt.evidence.action_receipt_id, request.action.receipt_id);
    assert.equal(receipt.index.updated, true);
    assert.equal(receipt.log.appended, true);
    assert.equal(receipt.log.entry_count_delta, 1);
    assert.equal(receipt.query.ok, true);
    assert.ok(receipt.query.hits.includes(request.lesson.page_id!));
    assert.equal(receipt.lint.ok, true);
    for (const kind of ["metadata", "links", "orphan_policy", "index_coherence", "drift"] as const) {
      assert.ok(receipt.lint.classifications.includes(kind), kind);
    }
    assert.equal(receipt.repository.durable_markdown, true);
    assert.equal(receipt.repository.secret_leakage, false);
    assert.equal(receipt.repository.generated_index_included, false);
    assert.ok(receipt.protected_state_digest);
    assert.equal(receipt.git_mutation.commit, false);
    assert.equal(receipt.git_mutation.push, false);
    assert.equal(receipt.git_mutation.merge, false);
    assert.equal(receipt.git_mutation.history_rewrite, false);
    assert.equal(receipt.global_memory_write, false);

    const vault = path.join(ctx.fixture.cwd, ".ycm-harness", "autonomy", "knowledge-base");
    const rawFiles = await fs.readdir(path.join(vault, "raw", "articles"));
    assert.equal(rawFiles.filter((name) => name.endsWith(".md")).length, 1);
    const page = await fs.readFile(path.join(vault, "concepts", `${request.lesson.page_id}.md`), "utf8");
    assert.match(page, /title: Triage root-cause binding lesson/);
    assert.match(page, /created:/);
    assert.match(page, /updated:/);
    assert.match(page, /type: concept/);
    assert.match(page, /tags:/);
    assert.match(page, /sources:/);
    assert.match(page, /confidence: high/);
    assert.match(page, /contradictions:/);
    assert.match(page, /ticket:/);
    assert.match(page, /evidence:/);
    assert.match(page, /\[\[llm-knowledge-bases\]\]/);
    const index = await fs.readFile(path.join(vault, "index.md"), "utf8");
    assert.match(index, /triage-root-cause-binding-lesson/);
    const log = await fs.readFile(path.join(vault, "log.md"), "utf8");
    assert.equal(log.split("\n").filter((line) => line.includes("promote |")).length, 1);
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("identical re-ingestion is idempotent and returns existing receipt", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const request = promotionRequest(ctx);
    const first = await promoteFixture(ctx, request);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const second = await promoteFixture(ctx, request);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.receipt_id, first.receipt_id);
    assert.equal(second.mutation_count, 0);
    const vault = path.join(ctx.fixture.cwd, ".ycm-harness", "autonomy", "knowledge-base");
    const rawFiles = await fs.readdir(path.join(vault, "raw", "articles"));
    assert.equal(rawFiles.filter((name) => name.endsWith(".md")).length, 1);
    const log = await fs.readFile(path.join(vault, "log.md"), "utf8");
    assert.equal(log.split("\n").filter((line) => line.includes("promote |")).length, 1);
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("changed raw bytes preserve prior raw classify drift and open follow-up", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const firstReq = promotionRequest(ctx);
    const first = await promoteFixture(ctx, firstReq);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const driftedBytes = `${firstReq.raw.bytes} with drift`;
    const secondReq = promotionRequest(ctx, {
      promotion_identity: canonicalKnowledgePromotionIdentity({
        ticket_id: ctx.promotionTicket.ticket_id,
        action_receipt_id: ctx.action.receipt_id,
        page_id: firstReq.lesson.page_id!,
        raw_body_sha256: sha256(driftedBytes),
      }),
      raw: { ...firstReq.raw, bytes: driftedBytes },
    });
    const second = await promoteFixture(ctx, secondReq);
    assert.equal(second.ok, false);
    if (!second.ok) {
      assert.equal(second.reason, "RAW_CONTENT_DRIFT");
      assert.ok(second.follow_up_ticket_id);
    }
    const vault = path.join(ctx.fixture.cwd, ".ycm-harness", "autonomy", "knowledge-base");
    const rawFiles = await fs.readdir(path.join(vault, "raw", "articles"));
    assert.equal(rawFiles.filter((name) => name.endsWith(".md")).length, 1);
    const driftFiles = await fs.readdir(path.join(vault, "raw", "drift"));
    assert.ok(driftFiles.length >= 1);
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("existing curated page is updated rather than duplicated and contradictions stay explicit", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const first = await promoteFixture(ctx, promotionRequest(ctx));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const updateBytes = "Updated verified reusable lesson text for triage binding.";
    const update = promotionRequest(ctx, {
      promotion_identity: canonicalKnowledgePromotionIdentity({
        ticket_id: ctx.promotionTicket.ticket_id,
        action_receipt_id: ctx.action.receipt_id,
        page_id: "triage-root-cause-binding-lesson",
        raw_body_sha256: sha256(updateBytes),
      }),
      raw: {
        bytes: updateBytes,
        provenance: {
          origin: "accepted-action-lesson-update",
          source_uri: `ticket://${ctx.promotionTicket.ticket_id}/update`,
          content_type: "article",
          type_metadata: { kind: "reusable_lesson" },
        },
        classification: "reusable_lesson",
      },
      lesson: {
        page_id: "triage-root-cause-binding-lesson",
        title: "Triage root-cause binding lesson",
        type: "concept",
        tags: ["workflow", "triage", "learning"],
        body: "Updated body with competing claim retained.",
        confidence: "medium",
        contradictions: [{
          claim: "Prior claim preferred auto-disposition",
          source: "accepted-action-lesson",
          date: "2026-07-18",
        }],
        related_page_ids: ["llm-knowledge-bases", "knowledge-ingestion"],
        search_query: "triage root-cause binding",
        evidence_reference_ids: [...ctx.action.receipt.provenance.evidence_reference_ids],
      },
    });
    const second = await promoteFixture(ctx, update);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.receipt.curated.page_id, "triage-root-cause-binding-lesson");
    assert.equal(second.receipt.curated.prior_page_id, "triage-root-cause-binding-lesson");
    const vault = path.join(ctx.fixture.cwd, ".ycm-harness", "autonomy", "knowledge-base");
    const pages = (await fs.readdir(path.join(vault, "concepts"))).filter((name) => name.endsWith(".md"));
    assert.equal(pages.filter((name) => name === "triage-root-cause-binding-lesson.md").length, 1);
    const page = await fs.readFile(path.join(vault, "concepts", "triage-root-cause-binding-lesson.md"), "utf8");
    assert.match(page, /Prior claim preferred auto-disposition/);
    assert.match(page, /source: accepted-action-lesson/);
    assert.match(page, /date: 2026-07-18/);
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("query unavailability is honest PARTIAL while markdown remains authoritative", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const result = await promoteFixture(ctx, promotionRequest(ctx), {
      searchIndex: {
        async query() { return { ok: false as const, reason: "UNAVAILABLE" as const }; },
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.receipt.query.ok, false);
    assert.equal(result.receipt.query.reason, "UNAVAILABLE");
    assert.equal(result.receipt.curated.readback_ok, true);
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("ticket prose is not auto-promoted and actionable work cannot be page-only", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const result = await promoteFixture(ctx, promotionRequest(ctx, {
      raw: {
        bytes: "Please implement the ticket acceptance criteria tomorrow.",
        provenance: {
          origin: "ticket-prose",
          source_uri: `ticket://${ctx.promotionTicket.ticket_id}/prose`,
          content_type: "article",
          type_metadata: { kind: "ticket_prose" },
        },
        classification: "ticket_prose",
      },
      lesson: {
        page_id: "ticket-only-work",
        title: "Do the ticket",
        type: "project",
        tags: ["workflow"],
        body: "Owns the actionable work only in this page.",
        confidence: "high",
        contradictions: [],
        related_page_ids: ["llm-knowledge-bases", "knowledge-ingestion"],
        search_query: "ticket work",
        evidence_reference_ids: [...ctx.action.receipt.provenance.evidence_reference_ids],
        owns_actionable_work: true,
      },
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "PROMOTION_CONTENT_FORBIDDEN");
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("rollback restores prior page pointer refreshes index appends log and retains raw", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const first = await promoteFixture(ctx, promotionRequest(ctx));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const updateBytes = "Second version of the curated lesson.";
    const updateReq = promotionRequest(ctx, {
      promotion_identity: canonicalKnowledgePromotionIdentity({
        ticket_id: ctx.promotionTicket.ticket_id,
        action_receipt_id: ctx.action.receipt_id,
        page_id: "triage-root-cause-binding-lesson",
        raw_body_sha256: sha256(updateBytes),
      }),
      raw: {
        bytes: updateBytes,
        provenance: {
          origin: "accepted-action-lesson-v2",
          source_uri: "ticket://v2",
          content_type: "article",
          type_metadata: { kind: "reusable_lesson" },
        },
        classification: "reusable_lesson",
      },
      lesson: {
        page_id: "triage-root-cause-binding-lesson",
        title: "Triage root-cause binding lesson",
        type: "concept",
        tags: ["workflow", "triage", "learning"],
        body: "Second version body.",
        confidence: "high",
        contradictions: [],
        related_page_ids: ["llm-knowledge-bases", "knowledge-ingestion"],
        search_query: "triage root-cause binding",
        evidence_reference_ids: [...ctx.action.receipt.provenance.evidence_reference_ids],
      },
    });
    const second = await promoteFixture(ctx, updateReq);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const rolled = await promoteFixture(ctx, promotionRequest(ctx, {
      operation: "rollback",
      target_receipt_id: second.receipt_id,
    }));
    assert.equal(rolled.ok, true);
    if (!rolled.ok) return;
    assert.equal(rolled.status, "ROLLED_BACK");
    const vault = path.join(ctx.fixture.cwd, ".ycm-harness", "autonomy", "knowledge-base");
    const page = await fs.readFile(path.join(vault, "concepts", "triage-root-cause-binding-lesson.md"), "utf8");
    assert.match(page, /Bind explicit feedback evidence/);
    assert.doesNotMatch(page, /Second version body/);
    const log = await fs.readFile(path.join(vault, "log.md"), "utf8");
    assert.ok(log.includes("rollback |"));
    const rawFiles = await fs.readdir(path.join(vault, "raw", "articles"));
    assert.ok(rawFiles.filter((name) => name.endsWith(".md")).length >= 2);
    const versions = await fs.readdir(path.join(vault, "versions"));
    assert.ok(versions.length >= 1);
    assert.equal(rolled.receipt.git_mutation.commit, false);
    assert.equal(rolled.receipt.global_memory_write, false);
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});


test("search hit updates existing curated page instead of creating a duplicate", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const first = await promoteFixture(ctx, promotionRequest(ctx));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const existingPageId = "triage-root-cause-binding-lesson";
    const duplicateBytes = "Alternate page id that must update the searched existing page.";
    const duplicateReq = promotionRequest(ctx, {
      promotion_identity: canonicalKnowledgePromotionIdentity({
        ticket_id: ctx.promotionTicket.ticket_id,
        action_receipt_id: ctx.action.receipt_id,
        page_id: "triage-root-cause-binding-lesson-duplicate",
        raw_body_sha256: sha256(duplicateBytes),
      }),
      raw: {
        bytes: duplicateBytes,
        provenance: {
          origin: "accepted-action-lesson-search-dedup",
          source_uri: `ticket://${ctx.promotionTicket.ticket_id}/search-dedup`,
          content_type: "article",
          type_metadata: { kind: "reusable_lesson" },
        },
        classification: "reusable_lesson",
      },
      lesson: {
        page_id: "triage-root-cause-binding-lesson-duplicate",
        title: "Triage root-cause binding lesson duplicate attempt",
        type: "concept",
        tags: ["workflow", "triage", "learning"],
        body: "Body that must land on the existing searched page.",
        confidence: "high",
        contradictions: [],
        related_page_ids: ["llm-knowledge-bases", "knowledge-ingestion"],
        search_query: "triage root-cause binding",
        evidence_reference_ids: [...ctx.action.receipt.provenance.evidence_reference_ids],
      },
    });
    let searchCalls = 0;
    const second = await promoteFixture(ctx, duplicateReq, {
      searchIndex: {
        async query(_vault, query) {
          searchCalls += 1;
          if (searchCalls === 1) {
            assert.match(query, /triage root-cause binding/i);
            return { ok: true as const, hits: [existingPageId, `concepts/${existingPageId}`] };
          }
          return { ok: true as const, hits: [existingPageId] };
        },
      },
    });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.ok(searchCalls >= 1, "pre-create search must run");
    assert.equal(second.receipt.curated.page_id, existingPageId);
    assert.equal(second.receipt.curated.prior_page_id, existingPageId);
    const vault = path.join(ctx.fixture.cwd, ".ycm-harness", "autonomy", "knowledge-base");
    const pages = (await fs.readdir(path.join(vault, "concepts"))).filter((name) => name.endsWith(".md"));
    assert.equal(pages.includes("triage-root-cause-binding-lesson-duplicate.md"), false);
    assert.equal(pages.filter((name) => name === `${existingPageId}.md`).length, 1);
    const page = await fs.readFile(path.join(vault, "concepts", `${existingPageId}.md`), "utf8");
    assert.match(page, /Body that must land on the existing searched page/);
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("rollback reports honest query unavailability instead of fabricating success", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const first = await promoteFixture(ctx, promotionRequest(ctx));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const updateBytes = "Second version before honest rollback query check.";
    const updateReq = promotionRequest(ctx, {
      promotion_identity: canonicalKnowledgePromotionIdentity({
        ticket_id: ctx.promotionTicket.ticket_id,
        action_receipt_id: ctx.action.receipt_id,
        page_id: "triage-root-cause-binding-lesson",
        raw_body_sha256: sha256(updateBytes),
      }),
      raw: {
        bytes: updateBytes,
        provenance: {
          origin: "accepted-action-lesson-v2-query",
          source_uri: "ticket://v2-query",
          content_type: "article",
          type_metadata: { kind: "reusable_lesson" },
        },
        classification: "reusable_lesson",
      },
      lesson: {
        page_id: "triage-root-cause-binding-lesson",
        title: "Triage root-cause binding lesson",
        type: "concept",
        tags: ["workflow", "triage", "learning"],
        body: "Second version body for query honesty.",
        confidence: "high",
        contradictions: [],
        related_page_ids: ["llm-knowledge-bases", "knowledge-ingestion"],
        search_query: "triage root-cause binding",
        evidence_reference_ids: [...ctx.action.receipt.provenance.evidence_reference_ids],
      },
    });
    const second = await promoteFixture(ctx, updateReq);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    const rolled = await promoteFixture(ctx, promotionRequest(ctx, {
      operation: "rollback",
      target_receipt_id: second.receipt_id,
    }), {
      searchIndex: {
        async query() { return { ok: false as const, reason: "UNAVAILABLE" as const }; },
      },
    });
    assert.equal(rolled.ok, true);
    if (!rolled.ok) return;
    assert.equal(rolled.status, "ROLLED_BACK");
    assert.equal(rolled.receipt.query.ok, false);
    assert.equal(rolled.receipt.query.reason, "UNAVAILABLE");
    assert.notDeepEqual(rolled.receipt.query, { ok: true, hits: [rolled.receipt.curated.page_id] });
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("promote rejects ignored-artifact leakage classification", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const result = await promoteFixture(ctx, promotionRequest(ctx, {
      raw: {
        bytes: "lesson text without secrets",
        provenance: {
          origin: "ignored-leak",
          source_uri: "u",
          content_type: "article",
          type_metadata: { kind: "ignored_artifact_leakage" },
        },
        classification: "ignored_artifact_leakage",
      },
    }));
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.reason, "PROMOTION_CONTENT_FORBIDDEN");
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("promote fails closed for unsafe repository classification", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const vault = path.join(ctx.fixture.cwd, ".ycm-harness", "autonomy", "knowledge-base");
    await fs.mkdir(path.join(vault, ".qmd-cache"), { recursive: true });
    await fs.writeFile(path.join(vault, ".qmd-cache", "generated.bin"), "local-index-cache", "utf8");
    const result = await promoteFixture(ctx, promotionRequest(ctx));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.reason, "REPOSITORY_CLASSIFICATION_UNSAFE");
      assert.ok(result.status === "BLOCKED" || result.status === "PARTIAL");
    }
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("conflicting replay fails closed without duplicate artifacts", async () => {
  const ctx = await acceptedActionFixture();
  try {
    const first = await promoteFixture(ctx, promotionRequest(ctx));
    assert.equal(first.ok, true);
    if (!first.ok) return;
    const conflict = promotionRequest(ctx);
    conflict.lesson = { ...conflict.lesson, body: "Conflicting curated body for same identity." };
    const blocked = await promoteFixture(ctx, conflict);
    assert.equal(blocked.ok, false);
    if (!blocked.ok) assert.equal(blocked.reason, "PROMOTION_REPLAY_CONFLICT");
    const vault = path.join(ctx.fixture.cwd, ".ycm-harness", "autonomy", "knowledge-base");
    const log = await fs.readFile(path.join(vault, "log.md"), "utf8");
    assert.equal(log.split("\n").filter((line) => line.includes("promote |")).length, 1);
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

test("CLI autonomy promotion promote routes the public promote seam", async () => {
  const ctx = await acceptedActionFixture();
  const json: unknown[] = [];
  const program = new Command();
  program.exitOverride();
  registerAutonomy(program, createContext(ctx.fixture.cwd), {
    out() {},
    err() {},
    json(value) { json.push(value); },
  });
  const request = promotionRequest(ctx);
  const requestFile = path.join(ctx.fixture.cwd, "promotion-request.json");
  const { cwd: _cwd, operation: _operation, ...body } = request;
  await fs.writeFile(requestFile, JSON.stringify(body), "utf8");
  try {
    await withStrategicReviewTestDependencies(
      { installationRoot: async () => ctx.fixture.installationRoot },
      () => withKnowledgePromotionTestDependencies({
        ticket: ctx.tickets,
        now: () => "2026-07-18T18:00:00.000Z",
      }, async () => {
        await program.parseAsync(
          ["autonomy", "promotion", "promote", "--file", requestFile],
          { from: "user" },
        );
      }),
    );
    assert.equal(json.length, 1);
    const result = json[0] as { ok: boolean; status?: string };
    assert.equal(result.ok, true);
    assert.equal(result.status, "PROMOTED");
  } finally {
    await fs.rm(ctx.fixture.cwd, { recursive: true, force: true });
    await fs.rm(ctx.fixture.installationRoot, { recursive: true, force: true });
  }
});

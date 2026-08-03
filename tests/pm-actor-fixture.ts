import { createHash } from "node:crypto";
import type { CoordinationBinding } from "../src/autonomy/coordination.js";
import type { PmActorOriginSelector, TrustedPmActorOriginReadback } from "../src/autonomy/pm-actor-origin.js";

const sha = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export const actorBinding: CoordinationBinding = {
  schema_version: 1, goal_id: "goal", credential_mode: "profile", profile: "test",
  server_origin: "http://localhost:3000", workspace_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1",
  parent_id: "parent-1", parent_identifier: "AUT-1", project_source: "parent", issue_prefix: "AUT",
  verified_at: "2026-07-15T00:00:00.000Z",
};
export const testWorker = { subject: "worker-1", run_id: "worker-run-1", session_id: "worker-session-1",
  capability: { id: "implementation", rank: 1 } };
export const testReviewer = { subject: "reviewer-1", run_id: "reviewer-run-1", session_id: "reviewer-session-1" };
export const workerSelector = { origin_id: "test-actors", record_id: "worker-record-1" } as const;
export const reviewerSelector = { origin_id: "test-actors", record_id: "reviewer-record-1" } as const;

export function testArtifactManifest(rows: readonly {
  kind: "prompt" | "output" | "exit_status" | "meaningful_log";
  relative_path: string;
  content: string | Buffer;
}[]) {
  return rows.map((row) => {
    const data = typeof row.content === "string" ? Buffer.from(row.content, "utf8") : row.content;
    return { kind: row.kind, relative_path: row.relative_path, size_bytes: data.byteLength,
      sha256: createHash("sha256").update(data).digest("hex") };
  });
}

type Identity = typeof testWorker | typeof testReviewer;

export function actorRegistry(binding: CoordinationBinding = actorBinding) {
  const records = new Map<string, TrustedPmActorOriginReadback>();
  const key = (selector: PmActorOriginSelector) => `${selector.origin_id}\0${selector.record_id}`;
  const add = (input: {
    selector: PmActorOriginSelector;
    role: "worker" | "reviewer";
    identity: Identity;
    ticketId: string;
    prepareReceiptId: string;
    claimId: string;
    payload: unknown;
    goalId?: string;
  }) => {
    const payloadSha = sha(JSON.stringify(input.payload));
    const core = {
      schema_version: 1 as const, ...input.selector, key_id: "test-ed25519-key", assurance: "authenticated_install" as const,
      role: input.role, subject: input.identity.subject, run_id: input.identity.run_id, session_id: input.identity.session_id,
      ...("capability" in input.identity ? { capability: input.identity.capability } : {}),
      goal_id: input.goalId ?? binding.goal_id, parent_id: binding.parent_id, ticket_id: input.ticketId,
      prepare_receipt_id: input.prepareReceiptId, claim_id: input.claimId,
      payload: input.payload, payload_sha256: payloadSha,
    };
    const record = { ...core, record_sha256: sha(JSON.stringify(core)) } satisfies TrustedPmActorOriginReadback;
    records.set(key(input.selector), record);
    return record;
  };
  return {
    records,
    addWorker(input: Omit<Parameters<typeof add>[0], "role" | "identity" | "selector"> & {
      identity?: typeof testWorker; selector?: PmActorOriginSelector }) {
      return add({ ...input, role: "worker", identity: input.identity ?? testWorker, selector: input.selector ?? workerSelector });
    },
    addReviewer(input: Omit<Parameters<typeof add>[0], "role" | "identity" | "selector"> & {
      identity?: typeof testReviewer; selector?: PmActorOriginSelector }) {
      return add({ ...input, role: "reviewer", identity: input.identity ?? testReviewer, selector: input.selector ?? reviewerSelector });
    },
    deps: {
      binding,
      readActorOrigin: async (selector: PmActorOriginSelector) => records.get(key(selector)),
    },
  };
}

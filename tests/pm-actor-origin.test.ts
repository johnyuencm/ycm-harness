import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  readPmActorOriginFromInstallation,
  readProjectedPmActorOrigin,
  type PmActorOriginReadHooks,
} from "../src/autonomy/pm-actor-origin.js";
import { CoordinationError } from "../src/autonomy/coordination.js";
import { cleanup, tempProject, skipUnlessLinux } from "./helpers.js";

const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
const selector = { origin_id: "pm-actors", record_id: "worker-record-1" } as const;

async function fixture() {
  const installationRoot = await tempProject("ch-pm-actor-install-");
  const recordRoot = await tempProject("ch-pm-actor-records-");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const payload = { kind: "pm_worker_handoff", manifest_sha256: "a".repeat(64) };
  const record = {
    schema_version: 1 as const, ...selector, key_id: "actor-key-1",
    assurance: "authenticated_install" as const, role: "worker" as const,
    subject: "worker-1", run_id: "worker-run-1", session_id: "worker-session-1",
    capability: { id: "implementation", rank: 1 },
    goal_id: "goal", parent_id: "parent-1", ticket_id: "ticket-1",
    prepare_receipt_id: `pm-${"1".repeat(32)}`, claim_id: `pmc-${"2".repeat(32)}`,
    payload, payload_sha256: sha(JSON.stringify(payload)),
  };
  await fs.mkdir(path.join(installationRoot, "config"), { recursive: true });
  await fs.writeFile(path.join(installationRoot, "config", "pm-actor-origins.json"), JSON.stringify({
    schema_version: 1,
    origins: [{ origin_id: selector.origin_id, record_root: recordRoot, key_id: record.key_id,
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString() }],
  }), "utf8");
  const writeRecord = async (value: unknown = record, signer: KeyObject = privateKey, pretty = false) => {
    const raw = Buffer.from(JSON.stringify(value, null, pretty ? 2 : undefined), "utf8");
    await fs.writeFile(path.join(recordRoot, `${selector.record_id}.json`), raw);
    await fs.writeFile(path.join(recordRoot, `${selector.record_id}.sig`), sign(null, raw, signer).toString("base64"), "utf8");
    return raw;
  };
  return { installationRoot, recordRoot, privateKey, record, writeRecord };
}

async function closes<T>(value: Awaited<ReturnType<typeof fixture>>, operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  finally { await cleanup(value.installationRoot); await cleanup(value.recordRoot); }
}

function rejectsCode(code: string) {
  return (error: unknown) => error instanceof CoordinationError && error.code === code;
}

test("install-owned actor origin authenticates one canonical Ed25519 worker record", async (t) => {
  if (skipUnlessLinux(t)) return;
  const value = await fixture();
  await closes(value, async () => {
    const raw = await value.writeRecord();
    assert.deepEqual(await readPmActorOriginFromInstallation(value.installationRoot, selector), {
      ...value.record, record_sha256: sha(raw),
    });
  });
});

test("actor origin defaults empty and fails closed for missing config, origin, and record", async (t) => {
  if (skipUnlessLinux(t)) return;
  const installationRoot = await tempProject("ch-pm-actor-empty-");
  try {
    assert.equal(await readPmActorOriginFromInstallation(installationRoot, selector), undefined);
    await fs.mkdir(path.join(installationRoot, "config"), { recursive: true });
    await fs.writeFile(path.join(installationRoot, "config", "pm-actor-origins.json"),
      JSON.stringify({ schema_version: 1, origins: [] }), "utf8");
    assert.equal(await readPmActorOriginFromInstallation(installationRoot, selector), undefined);
    assert.equal(await readProjectedPmActorOrigin(selector), undefined);
  } finally { await cleanup(installationRoot); }
});

test("actor origin rejects selector injection before filesystem lookup", async () => {
  const installationRoot = await tempProject("ch-pm-actor-selector-");
  try {
    await assert.rejects(readPmActorOriginFromInstallation(installationRoot,
      { origin_id: "../escape", record_id: "record" }), rejectsCode("pm_actor_origin_invalid"));
    await assert.rejects(readPmActorOriginFromInstallation(installationRoot,
      { origin_id: "pm-actors", record_id: "record/escape" }), rejectsCode("pm_actor_origin_invalid"));
  } finally { await cleanup(installationRoot); }
});

test("actor origin rejects bad signatures, wrong keys, and key-id substitution", async (t) => {
  if (skipUnlessLinux(t)) return;
  const value = await fixture();
  await closes(value, async () => {
    const other = generateKeyPairSync("ed25519");
    await value.writeRecord(value.record, other.privateKey);
    await assert.rejects(readPmActorOriginFromInstallation(value.installationRoot, selector),
      rejectsCode("pm_actor_origin_tampered"));
    await value.writeRecord({ ...value.record, key_id: "actor-key-2" });
    await assert.rejects(readPmActorOriginFromInstallation(value.installationRoot, selector),
      rejectsCode("pm_actor_origin_mismatch"));
  });
});

test("actor origin rejects signed noncanonical, malformed-role, and payload-digest records", async (t) => {
  if (skipUnlessLinux(t)) return;
  const value = await fixture();
  await closes(value, async () => {
    await value.writeRecord(value.record, value.privateKey, true);
    await assert.rejects(readPmActorOriginFromInstallation(value.installationRoot, selector),
      rejectsCode("pm_actor_origin_tampered"));
    await value.writeRecord({ ...value.record, role: "reviewer" });
    await assert.rejects(readPmActorOriginFromInstallation(value.installationRoot, selector),
      rejectsCode("pm_actor_origin_tampered"));
    await value.writeRecord({ ...value.record, payload_sha256: "b".repeat(64) });
    await assert.rejects(readPmActorOriginFromInstallation(value.installationRoot, selector),
      rejectsCode("pm_actor_origin_tampered"));
  });
});

test("actor origin rejects record changes during read and after signature verification", async (t) => {
  if (skipUnlessLinux(t)) return;
  for (const changeOnRecordRead of [1, 3]) {
    const value = await fixture();
    await closes(value, async () => {
      await value.writeRecord();
      let recordReads = 0;
      const hooks: PmActorOriginReadHooks = { afterPrecheck: async (file) => {
        if (file.endsWith(`${selector.record_id}.json`) && ++recordReads === changeOnRecordRead) {
          await fs.appendFile(path.join(value.recordRoot, `${selector.record_id}.json`), " ", "utf8");
        }
      } };
      await assert.rejects(readPmActorOriginFromInstallation(value.installationRoot, selector, hooks),
        rejectsCode("pm_actor_origin_tampered"));
    });
  }
});

test("actor origin fails closed without required Linux descriptor support", async () => {
  const value = await fixture();
  await closes(value, async () => {
    for (const hooks of [{ forcePlatformUnsupported: true }, { forceNoFollowUnsupported: true },
      { forceDirectoryUnsupported: true }, { forceDescriptorUnsupported: true }] satisfies PmActorOriginReadHooks[]) {
      await assert.rejects(readPmActorOriginFromInstallation(value.installationRoot, selector, hooks),
        rejectsCode("pm_actor_origin_unsupported"));
    }
  });
});

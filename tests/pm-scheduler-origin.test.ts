import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import {
  readPmSchedulerOriginFromInstallation,
  readProjectedPmSchedulerOrigin,
} from "../src/autonomy/pm-scheduler-origin.js";
import { packageRoot, runClientSync } from "../src/cli/install-kit.js";
import { cleanup, tempProject, withTempUserHome, skipUnlessLinux } from "./helpers.js";

const sha = (value: Buffer): string => createHash("sha256").update(value).digest("hex");

test("trusted scheduler origin authenticates one fixed-root detached Ed25519 record", async (t) => {
  if (skipUnlessLinux(t)) return;
  const installationRoot = await tempProject("ch-pm-scheduler-install-");
  const recordRoot = await tempProject("ch-pm-scheduler-records-");
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const manifest = {
      schema_version: 1,
      origins: [{
        origin_id: "daily-pm", record_root: recordRoot, key_id: "daily-pm-key-1",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        timezone: "UTC", prepare_local_time: "09:00", review_local_time: "17:00",
      }],
    };
    await fs.mkdir(path.join(installationRoot, "config"), { recursive: true });
    await fs.writeFile(path.join(installationRoot, "config", "pm-scheduler-origins.json"), JSON.stringify(manifest), "utf8");
    const record = {
      schema_version: 1, origin_id: "daily-pm", record_id: "run-2026-07-15", key_id: "daily-pm-key-1",
      timezone: "UTC", local_date: "2026-07-15", prepare_local_time: "09:00", review_local_time: "17:00",
      artifact: { scheduler_record: "opaque fixture" },
    };
    const raw = Buffer.from(JSON.stringify(record), "utf8");
    await fs.writeFile(path.join(recordRoot, "run-2026-07-15.json"), raw);
    await fs.writeFile(path.join(recordRoot, "run-2026-07-15.sig"), sign(null, raw, privateKey).toString("base64"), "utf8");

    const readback = await readPmSchedulerOriginFromInstallation(
      installationRoot,
      { origin_id: "daily-pm", record_id: "run-2026-07-15" },
    );
    assert.deepEqual(readback, {
      origin: "scheduler_record", origin_id: "daily-pm", record_id: "run-2026-07-15", record_sha256: sha(raw),
      schedule: { timezone: "UTC", local_date: "2026-07-15", prepare_local_time: "09:00", review_local_time: "17:00" },
      artifact: { scheduler_record: "opaque fixture" },
    });
    assert.equal(await readPmSchedulerOriginFromInstallation(
      installationRoot,
      { origin_id: "unconfigured", record_id: "run-2026-07-15" },
    ), undefined);
    assert.equal(await readPmSchedulerOriginFromInstallation(
      installationRoot,
      { origin_id: "daily-pm", record_id: "missing" },
    ), undefined);
  } finally {
    await cleanup(installationRoot);
    await cleanup(recordRoot);
  }
});

test("trusted scheduler origin rejects signed scope drift, invalid signatures, and symlink records", async (t) => {
  if (skipUnlessLinux(t)) return;
  const installationRoot = await tempProject("ch-pm-scheduler-install-adversarial-");
  const recordRoot = await tempProject("ch-pm-scheduler-records-adversarial-");
  const outside = await tempProject("ch-pm-scheduler-outside-");
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await fs.mkdir(path.join(installationRoot, "config"), { recursive: true });
    await fs.writeFile(path.join(installationRoot, "config", "pm-scheduler-origins.json"), JSON.stringify({
      schema_version: 1,
      origins: [{
        origin_id: "daily-pm", record_root: recordRoot, key_id: "daily-pm-key-1",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        timezone: "UTC", prepare_local_time: "09:00", review_local_time: "17:00",
      }],
    }), "utf8");
    const selector = { origin_id: "daily-pm", record_id: "run-2026-07-15" };
    const base = {
      schema_version: 1, ...selector, key_id: "daily-pm-key-1", timezone: "UTC", local_date: "2026-07-15",
      prepare_local_time: "09:00", review_local_time: "17:00", artifact: { scheduler_record: "bounded" },
    };
    const writeSigned = async (record: typeof base): Promise<Buffer> => {
      const raw = Buffer.from(JSON.stringify(record), "utf8");
      await fs.writeFile(path.join(recordRoot, `${selector.record_id}.json`), raw);
      await fs.writeFile(path.join(recordRoot, `${selector.record_id}.sig`), sign(null, raw, privateKey).toString("base64"), "utf8");
      return raw;
    };

    await writeSigned({ ...base, timezone: "Asia/Hong_Kong" });
    await assert.rejects(readPmSchedulerOriginFromInstallation(installationRoot, selector), /pm_status_scheduler_origin_mismatch/);
    const goodRaw = await writeSigned(base);
    await fs.writeFile(path.join(recordRoot, `${selector.record_id}.json`), Buffer.concat([goodRaw, Buffer.from(" ")]));
    await assert.rejects(readPmSchedulerOriginFromInstallation(installationRoot, selector), /pm_status_scheduler_origin_tampered/);

    await fs.rm(path.join(recordRoot, `${selector.record_id}.json`));
    await fs.writeFile(path.join(outside, "captured.json"), goodRaw);
    await fs.symlink(path.join(outside, "captured.json"), path.join(recordRoot, `${selector.record_id}.json`), "file");
    await assert.rejects(readPmSchedulerOriginFromInstallation(installationRoot, selector), /pm_status_scheduler_origin_unsafe/);
    await assert.rejects(readPmSchedulerOriginFromInstallation(
      installationRoot,
      { origin_id: "daily-pm", record_id: "../escape" },
    ), /pm_status_scheduler_origin_invalid/);
  } finally {
    await cleanup(installationRoot);
    await cleanup(recordRoot);
    await cleanup(outside);
  }
});

test("bounded origin reads reject growth and fail before reads without required platform support", async (t) => {
  if (skipUnlessLinux(t)) return;
  const installationRoot = await tempProject("ch-pm-scheduler-install-race-");
  const recordRoot = await tempProject("ch-pm-scheduler-records-race-");
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    await fs.mkdir(path.join(installationRoot, "config"), { recursive: true });
    await fs.writeFile(path.join(installationRoot, "config", "pm-scheduler-origins.json"), JSON.stringify({
      schema_version: 1,
      origins: [{ origin_id: "daily-pm", record_root: recordRoot, key_id: "daily-pm-key-1",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        timezone: "UTC", prepare_local_time: "09:00", review_local_time: "17:00" }],
    }), "utf8");
    const selector = { origin_id: "daily-pm", record_id: "run-race" };
    const raw = Buffer.from(JSON.stringify({ schema_version: 1, ...selector, key_id: "daily-pm-key-1", timezone: "UTC",
      local_date: "2026-07-15", prepare_local_time: "09:00", review_local_time: "17:00",
      artifact: { scheduler_record: "small" } }), "utf8");
    const recordFile = path.join(recordRoot, `${selector.record_id}.json`);
    await fs.writeFile(recordFile, raw);
    await fs.writeFile(path.join(recordRoot, `${selector.record_id}.sig`), sign(null, raw, privateKey).toString("base64"), "utf8");
    let grew = false;
    await assert.rejects(readPmSchedulerOriginFromInstallation(installationRoot, selector, {
      async afterPrecheck(file) {
        if (!grew && file === recordFile) { grew = true; await fs.appendFile(file, " ", "utf8"); }
      },
    }), /pm_status_scheduler_origin_tampered/);
    assert.equal(grew, true); assert.ok((await fs.stat(recordFile)).size < 1024);
    let unsupportedPrechecks = 0;
    const countPrecheck = (): void => { unsupportedPrechecks += 1; };
    for (const forced of [
      { forcePlatformUnsupported: true },
      { forceNoFollowUnsupported: true },
      { forceDirectoryUnsupported: true },
      { forceDescriptorUnsupported: true },
    ]) {
      await assert.rejects(readPmSchedulerOriginFromInstallation(
        installationRoot, selector, { ...forced, afterPrecheck: countPrecheck },
      ), /pm_status_scheduler_origin_unsupported/);
    }
    assert.equal(unsupportedPrechecks, 0);
  } finally {
    await cleanup(installationRoot);
    await cleanup(recordRoot);
  }
});

test("source and installed projections use only their shipped configured manifest", async (t) => {
  if (skipUnlessLinux(t)) return;
  const sourceManifest = path.join(packageRoot(), "plugin", "config", "pm-scheduler-origins.json");
  const raw = await fs.readFile(sourceManifest, "utf8");
  assert.deepEqual(JSON.parse(raw), { schema_version: 1, origins: [] });
  assert.equal(await readProjectedPmSchedulerOrigin({ origin_id: "daily-pm", record_id: "missing" }), undefined);
  const sourceLayout = await tempProject("ch-pm-scheduler-source-layout-");
  const recordRoot = await tempProject("ch-pm-scheduler-projected-records-");
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const selector = { origin_id: "daily-pm", record_id: "projected-record" };
    const artifact = { scheduler_record: "configured projection" };
    const recordRaw = Buffer.from(JSON.stringify({ schema_version: 1, ...selector, key_id: "daily-pm-key-1",
      timezone: "UTC", local_date: "2026-07-15", prepare_local_time: "09:00", review_local_time: "17:00", artifact }), "utf8");
    await fs.writeFile(path.join(recordRoot, `${selector.record_id}.json`), recordRaw);
    await fs.writeFile(path.join(recordRoot, `${selector.record_id}.sig`), sign(null, recordRaw, privateKey).toString("base64"), "utf8");
    const configuredManifest = JSON.stringify({ schema_version: 1, origins: [{ origin_id: selector.origin_id,
      record_root: recordRoot, key_id: "daily-pm-key-1",
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(), timezone: "UTC",
      prepare_local_time: "09:00", review_local_time: "17:00" }] });

    await fs.cp(path.join(packageRoot(), "dist"), path.join(sourceLayout, "dist"), { recursive: true });
    await fs.cp(path.join(packageRoot(), "node_modules", "zod"), path.join(sourceLayout, "node_modules", "zod"), { recursive: true });
    await fs.mkdir(path.join(sourceLayout, "plugin", "config"), { recursive: true });
    await fs.writeFile(path.join(sourceLayout, "package.json"), '{"type":"module"}\n', "utf8");
    await fs.writeFile(path.join(sourceLayout, "plugin", "config", "pm-scheduler-origins.json"), configuredManifest, "utf8");
    const sourceModule = await import(`${pathToFileURL(path.join(
      sourceLayout, "dist", "autonomy", "pm-scheduler-origin.js",
    )).href}?source=${Date.now()}`) as typeof import("../src/autonomy/pm-scheduler-origin.js");
    assert.deepEqual((await sourceModule.readProjectedPmSchedulerOrigin(selector))?.artifact, artifact);

    await withTempUserHome(async (home) => {
      await runClientSync({ cursor: true, codex: false, opencode: false, force: true, sourceRoot: packageRoot() });
      const installedRoot = path.join(home, ".cursor", "plugins", "ycm-harness");
      const projected = path.join(installedRoot, "config", "pm-scheduler-origins.json");
      assert.equal(await fs.readFile(projected, "utf8"), raw);
      await fs.writeFile(projected, configuredManifest, "utf8");
      const installedModule = await import(`${pathToFileURL(path.join(
        installedRoot, "runtime", "dist", "autonomy", "pm-scheduler-origin.js",
      )).href}?projection=${Date.now()}`) as typeof import("../src/autonomy/pm-scheduler-origin.js");
      assert.deepEqual((await installedModule.readProjectedPmSchedulerOrigin(selector))?.artifact, artifact);
    });
  } finally {
    await cleanup(sourceLayout);
    await cleanup(recordRoot);
  }
});

test("a configured record-root replacement cannot redirect reads away from the pinned directory", async (t) => {
  if (skipUnlessLinux(t)) return;
  const installationRoot = await tempProject("ch-pm-scheduler-install-root-swap-");
  const base = await tempProject("ch-pm-scheduler-root-swap-");
  const recordRoot = path.join(base, "records");
  const displacedRoot = path.join(base, "records-pinned");
  const selector = { origin_id: "daily-pm", record_id: "root-swap" };
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const signedRecord = (marker: string): { raw: Buffer; signature: string } => {
    const raw = Buffer.from(JSON.stringify({
      schema_version: 1, ...selector, key_id: "daily-pm-key-1", timezone: "UTC",
      local_date: "2026-07-15", prepare_local_time: "09:00", review_local_time: "17:00",
      artifact: { marker },
    }), "utf8");
    return { raw, signature: sign(null, raw, privateKey).toString("base64") };
  };
  const writeRecord = async (root: string, marker: string): Promise<void> => {
    const record = signedRecord(marker);
    await fs.writeFile(path.join(root, `${selector.record_id}.json`), record.raw);
    await fs.writeFile(path.join(root, `${selector.record_id}.sig`), record.signature, "utf8");
  };
  try {
    await fs.mkdir(path.join(installationRoot, "config"), { recursive: true });
    await fs.mkdir(recordRoot, { recursive: true });
    await fs.writeFile(path.join(installationRoot, "config", "pm-scheduler-origins.json"), JSON.stringify({
      schema_version: 1,
      origins: [{
        origin_id: selector.origin_id, record_root: recordRoot, key_id: "daily-pm-key-1",
        public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(),
        timezone: "UTC", prepare_local_time: "09:00", review_local_time: "17:00",
      }],
    }), "utf8");
    await writeRecord(recordRoot, "pinned-original");

    const originalRecord = path.join(recordRoot, `${selector.record_id}.json`);
    const displacedRecord = path.join(recordRoot, `${selector.record_id}.pinned.json`);
    const originalOpenForRecordSwap = fs.open;
    let recordOpens = 0;
    (fs as unknown as { open: typeof fs.open }).open = (async (
      file: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode?: Parameters<typeof fs.open>[2],
    ) => {
      if (String(file).endsWith(`/${selector.record_id}.json`) && ++recordOpens === 2) {
        await fs.rename(originalRecord, displacedRecord);
        await writeRecord(recordRoot, "between-read-replacement");
      }
      return originalOpenForRecordSwap.call(fs, file, flags, mode);
    }) as typeof fs.open;
    try {
      await assert.rejects(
        readPmSchedulerOriginFromInstallation(installationRoot, selector),
        /pm_status_scheduler_origin_tampered/,
      );
      assert.equal(recordOpens, 2);
    } finally {
      (fs as unknown as { open: typeof fs.open }).open = originalOpenForRecordSwap;
    }
    await fs.rm(originalRecord);
    await fs.rename(displacedRecord, originalRecord);
    await writeRecord(recordRoot, "pinned-original");

    const originalOpen = fs.open;
    let replaced = false;
    (fs as unknown as { open: typeof fs.open }).open = (async (
      file: Parameters<typeof fs.open>[0],
      flags: Parameters<typeof fs.open>[1],
      mode?: Parameters<typeof fs.open>[2],
    ) => {
      const handle = await originalOpen.call(fs, file, flags, mode);
      if (!replaced && String(file) === recordRoot && typeof flags === "number"
        && (flags & fsConstants.O_DIRECTORY) !== 0) {
        replaced = true;
        await fs.rename(recordRoot, displacedRoot);
        await fs.mkdir(recordRoot);
        await writeRecord(recordRoot, "replacement-must-not-be-trusted");
      }
      return handle;
    }) as typeof fs.open;
    try {
      let readback;
      try {
        readback = await readPmSchedulerOriginFromInstallation(installationRoot, selector);
      } catch (error) {
        assert.match(String(error), /pm_status_scheduler_origin_(?:unsafe|tampered)/);
      }
      assert.equal(replaced, true, "the repro must replace the root after its directory handle opens");
      if (readback) {
        assert.deepEqual(readback.artifact, { marker: "pinned-original" });
      }
    } finally {
      (fs as unknown as { open: typeof fs.open }).open = originalOpen;
    }
  } finally {
    await cleanup(installationRoot);
    await cleanup(base);
  }
});

test("a source package named runtime still resolves its own plugin config", async (t) => {
  if (skipUnlessLinux(t)) return;
  const base = await tempProject("ch-pm-scheduler-source-named-runtime-");
  const sourceRoot = path.join(base, "runtime");
  const recordRoot = await tempProject("ch-pm-scheduler-runtime-name-records-");
  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const selector = { origin_id: "daily-pm", record_id: "source-named-runtime" };
    const raw = Buffer.from(JSON.stringify({
      schema_version: 1, ...selector, key_id: "daily-pm-key-1", timezone: "UTC",
      local_date: "2026-07-15", prepare_local_time: "09:00", review_local_time: "17:00",
      artifact: { marker: "source-plugin-config" },
    }), "utf8");
    await fs.writeFile(path.join(recordRoot, `${selector.record_id}.json`), raw);
    await fs.writeFile(path.join(recordRoot, `${selector.record_id}.sig`), sign(null, raw, privateKey).toString("base64"));
    const manifest = JSON.stringify({ schema_version: 1, origins: [{
      origin_id: selector.origin_id, record_root: recordRoot, key_id: "daily-pm-key-1",
      public_key_pem: publicKey.export({ type: "spki", format: "pem" }).toString(), timezone: "UTC",
      prepare_local_time: "09:00", review_local_time: "17:00",
    }] });

    await fs.cp(path.join(packageRoot(), "dist"), path.join(sourceRoot, "dist"), { recursive: true });
    await fs.cp(path.join(packageRoot(), "node_modules", "zod"), path.join(sourceRoot, "node_modules", "zod"), { recursive: true });
    await fs.mkdir(path.join(sourceRoot, "plugin", "config"), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, "package.json"), '{"type":"module"}\n', "utf8");
    await fs.writeFile(path.join(sourceRoot, "plugin", "config", "pm-scheduler-origins.json"), manifest, "utf8");
    const sourceModule = await import(`${pathToFileURL(path.join(
      sourceRoot, "dist", "autonomy", "pm-scheduler-origin.js",
    )).href}?runtime_name=${Date.now()}`) as typeof import("../src/autonomy/pm-scheduler-origin.js");
    assert.deepEqual((await sourceModule.readProjectedPmSchedulerOrigin(selector))?.artifact, {
      marker: "source-plugin-config",
    });
  } finally {
    await cleanup(base);
    await cleanup(recordRoot);
  }
});

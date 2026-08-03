import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  ROLLBACK_SURFACES,
  captureRollbackBaseline,
  disableRollbackSurface,
  isRollbackSurfaceEnabled,
  reEnableRollbackSurface,
  rollbackStatus,
  type RollbackSurface,
} from "../src/autonomy/enforcement-rollback.js";
import { HARNESS_DIR_NAME } from "../src/state/paths.js";
import { cleanup, tempProject } from "./helpers.js";

async function seedPriorEvidence(root: string): Promise<{
  gapFile: string;
  receiptFile: string;
  deedFile: string;
  originFile: string;
  contents: Record<string, string>;
}> {
  const autonomy = path.join(root, HARNESS_DIR_NAME, "autonomy");
  const gapFile = path.join(autonomy, "missed-slot-watchdog", "gaps", "gap-prior.json");
  const receiptFile = path.join(autonomy, "missed-slot-watchdog", "receipts", "rcpt-prior.json");
  const deedFile = path.join(autonomy, "events", "sess", "turn", "Write.json");
  const originFile = path.join(autonomy, "pm-scheduler-origins", "origin-prior.json");
  const contents = {
    gapFile: JSON.stringify({ schema_version: 1, issue_id: "gap-prior", status: "open" }),
    receiptFile: JSON.stringify({ schema_version: 1, receipt_id: "rcpt-prior", status: "ok" }),
    deedFile: JSON.stringify({ schema_version: 1, tool: "Write", retained: true }),
    originFile: JSON.stringify({ schema_version: 1, origin_id: "hk-natural", retained: true }),
  };
  for (const [key, body] of Object.entries(contents)) {
    const file = ({ gapFile, receiptFile, deedFile, originFile } as Record<string, string>)[key]!;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body, "utf8");
  }
  // Package marker used as approved installed version source.
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({ name: "ycm-harness", version: "0.3.0" }, null, 2),
    "utf8",
  );
  return { gapFile, receiptFile, deedFile, originFile, contents };
}

async function readEvidence(files: string[]): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const file of files) {
    out[file] = await fs.readFile(file, "utf8");
  }
  return out;
}

test("baseline snapshot records approved installed version before disable", async () => {
  const root = await tempProject("ch-p7r-baseline-");
  try {
    await seedPriorEvidence(root);
    const baseline = await captureRollbackBaseline(root, { now: () => "2026-07-22T00:00:00.000Z" });
    assert.equal(baseline.schema_version, 1);
    assert.equal(baseline.approved_installed_version.package_name, "ycm-harness");
    assert.equal(baseline.approved_installed_version.package_version, "0.3.0");
    assert.match(baseline.approved_installed_version.source_fingerprint, /^[a-f0-9]{64}$/);
    assert.deepEqual(baseline.surfaces, {
      schedules: true,
      scout: true,
      enforcement: true,
    });
    const status = await rollbackStatus(root);
    assert.equal(status.active_baseline_id, baseline.baseline_id);
    assert.equal(status.approved_installed_version?.package_version, "0.3.0");
    for (const surface of ROLLBACK_SURFACES) {
      assert.equal(await isRollbackSurfaceEnabled(root, surface), true);
    }
  } finally {
    await cleanup(root);
  }
});

test("schedules scout and enforcement disable independently without deleting prior evidence", async () => {
  const root = await tempProject("ch-p7r-disable-");
  try {
    const seeded = await seedPriorEvidence(root);
    const files = [seeded.gapFile, seeded.receiptFile, seeded.deedFile, seeded.originFile];
    const before = await readEvidence(files);

    await captureRollbackBaseline(root, { now: () => "2026-07-22T00:01:00.000Z" });

    const disabledSchedules = await disableRollbackSurface(root, "schedules", {
      now: () => "2026-07-22T00:02:00.000Z",
    });
    assert.equal(disabledSchedules.surfaces.schedules, false);
    assert.equal(disabledSchedules.surfaces.scout, true);
    assert.equal(disabledSchedules.surfaces.enforcement, true);
    assert.equal(await isRollbackSurfaceEnabled(root, "schedules"), false);
    assert.equal(await isRollbackSurfaceEnabled(root, "scout"), true);

    await disableRollbackSurface(root, "scout", { now: () => "2026-07-22T00:03:00.000Z" });
    await disableRollbackSurface(root, "enforcement", { now: () => "2026-07-22T00:04:00.000Z" });

    const status = await rollbackStatus(root);
    assert.deepEqual(status.surfaces, {
      schedules: false,
      scout: false,
      enforcement: false,
    });
    assert.equal(status.evidence_retained, true);

    const after = await readEvidence(files);
    assert.deepEqual(after, before);
  } finally {
    await cleanup(root);
  }
});

test("disable auto-captures baseline when none exists", async () => {
  const root = await tempProject("ch-p7r-auto-baseline-");
  try {
    await seedPriorEvidence(root);
    const result = await disableRollbackSurface(root, "enforcement", {
      now: () => "2026-07-22T00:05:00.000Z",
    });
    assert.ok(result.active_baseline_id);
    assert.equal(result.approved_installed_version?.package_version, "0.3.0");
    assert.equal(result.surfaces.enforcement, false);
    assert.equal(result.surfaces.schedules, true);
  } finally {
    await cleanup(root);
  }
});

test("re-enable restores approved installed version and surface enablement", async () => {
  const root = await tempProject("ch-p7r-reenable-");
  try {
    const seeded = await seedPriorEvidence(root);
    const files = [seeded.gapFile, seeded.receiptFile, seeded.deedFile, seeded.originFile];
    const before = await readEvidence(files);

    const baseline = await captureRollbackBaseline(root, { now: () => "2026-07-22T00:06:00.000Z" });
    for (const surface of ROLLBACK_SURFACES) {
      await disableRollbackSurface(root, surface as RollbackSurface, {
        now: () => "2026-07-22T00:07:00.000Z",
      });
    }
    assert.deepEqual((await rollbackStatus(root)).surfaces, {
      schedules: false,
      scout: false,
      enforcement: false,
    });

    // Mutate package.json after disable; re-enable must restore baseline approved version identity.
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ name: "ycm-harness", version: "9.9.9-broken" }, null, 2),
      "utf8",
    );

    const restored = await reEnableRollbackSurface(root, "schedules", {
      now: () => "2026-07-22T00:08:00.000Z",
    });
    assert.equal(restored.surfaces.schedules, true);
    assert.equal(restored.surfaces.scout, false);
    assert.equal(restored.approved_installed_version?.package_version, "0.3.0");
    assert.equal(
      restored.approved_installed_version?.source_fingerprint,
      baseline.approved_installed_version.source_fingerprint,
    );

    await reEnableRollbackSurface(root, "scout", { now: () => "2026-07-22T00:09:00.000Z" });
    await reEnableRollbackSurface(root, "enforcement", { now: () => "2026-07-22T00:10:00.000Z" });

    const status = await rollbackStatus(root);
    assert.deepEqual(status.surfaces, {
      schedules: true,
      scout: true,
      enforcement: true,
    });
    assert.equal(status.approved_installed_version?.package_version, "0.3.0");
    assert.equal(status.evidence_retained, true);
    assert.deepEqual(await readEvidence(files), before);

    const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
      version: string;
    };
    assert.equal(packageJson.version, "0.3.0");
  } finally {
    await cleanup(root);
  }
});

test("unknown surface is rejected", async () => {
  const root = await tempProject("ch-p7r-bad-surface-");
  try {
    await seedPriorEvidence(root);
    await assert.rejects(
      () => disableRollbackSurface(root, "watchdog" as RollbackSurface),
      /rollback_surface_invalid/,
    );
  } finally {
    await cleanup(root);
  }
});

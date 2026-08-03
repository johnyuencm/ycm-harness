import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  HK_NATURAL_SLOTS,
  HK_NATURAL_TIMEZONE,
  gradeNaturalCycle,
  installHkNaturalSchedules,
  labelManualCanaryRun,
  monitorHkNaturalReceipts,
  runNaturalSlot,
  scheduleStatus,
  writeSignedHkSchedulerOrigin,
} from "../src/autonomy/hk-natural-schedules.js";
import {
  createFileReceiptStore,
  writeSlotReceipt,
  type SlotReceipt,
} from "../src/autonomy/missed-slot-watchdog.js";
import { readPmSchedulerOriginFromInstallation } from "../src/autonomy/pm-scheduler-origin.js";
import { cleanup, tempProject, skipUnlessLinux } from "./helpers.js";

test("HK natural schedule install projects 09:00/17:00/23:00 Asia/Hong_Kong with local_no_delivery", async () => {
  const root = await tempProject("ch-hk-sched-install-");
  try {
    const first = await installHkNaturalSchedules(root, { apply_schtasks: false });
    assert.equal(first.timezone, HK_NATURAL_TIMEZONE);
    assert.equal(HK_NATURAL_TIMEZONE, "Asia/Hong_Kong");
    assert.deepEqual(
      first.schedules.map((s) => ({ local_time: s.local_time, delivery: s.delivery, role: s.role })),
      [
        { local_time: "09:00", delivery: "local_no_delivery", role: "pm_prepare" },
        { local_time: "17:00", delivery: "local_no_delivery", role: "pm_review_worker" },
        { local_time: "23:00", delivery: "local_no_delivery", role: "strategic_nightly" },
      ],
    );
    assert.deepEqual([...HK_NATURAL_SLOTS], ["09:00", "17:00", "23:00"]);
    assert.equal(first.schtasks_registered, false);
    assert.ok(first.projection.manifest_path.endsWith("schedules.json"));
    assert.ok(await fs.stat(first.projection.manifest_path));
    assert.ok(await fs.stat(first.projection.windows_script_path));
    assert.ok(await fs.stat(first.projection.codex_automations_path));

    const status = await scheduleStatus(root);
    assert.equal(status.installed, true);
    assert.equal(status.schedules.length, 3);
    assert.equal(status.schtasks_registered, false);
  } finally {
    await cleanup(root);
  }
});

test("overlapping HK schedule installs are idempotent and do not duplicate schedules or origins", async () => {
  const root = await tempProject("ch-hk-sched-idem-");
  try {
    const first = await installHkNaturalSchedules(root, { apply_schtasks: false });
    const second = await installHkNaturalSchedules(root, { apply_schtasks: false });
    assert.equal(second.created, false);
    assert.equal(second.schedules.length, 3);
    assert.deepEqual(second.schedules, first.schedules);
    assert.equal(second.origin.origin_id, first.origin.origin_id);
    assert.equal(second.origin.key_id, first.origin.key_id);

    const manifest = JSON.parse(await fs.readFile(first.projection.manifest_path, "utf8")) as {
      schedules: unknown[];
    };
    assert.equal(manifest.schedules.length, 3);

    const originManifest = JSON.parse(
      await fs.readFile(path.join(first.installation_root, "config", "pm-scheduler-origins.json"), "utf8"),
    ) as { origins: unknown[] };
    assert.equal(originManifest.origins.length, 1);
  } finally {
    await cleanup(root);
  }
});

test("signed scheduler-origin records write and read back for natural gate proof", async (t) => {
  if (skipUnlessLinux(t)) return;
  const root = await tempProject("ch-hk-origin-");
  try {
    const installed = await installHkNaturalSchedules(root, { apply_schtasks: false });
    const written = await writeSignedHkSchedulerOrigin(root, {
      local_date: "2026-07-21",
      artifact: {
        evidence_class: "natural_scheduler",
        delivery: "local_no_delivery",
        trigger: "scheduled",
        manual_trigger: false,
        slots: ["09:00", "17:00", "23:00"],
      },
    });
    assert.equal(written.origin_id, installed.origin.origin_id);
    assert.ok(written.record_path.endsWith(".json"));
    assert.ok(written.signature_path.endsWith(".sig"));

    const readback = await readPmSchedulerOriginFromInstallation(installed.installation_root, {
      origin_id: written.origin_id,
      record_id: written.record_id,
    });
    assert.ok(readback);
    assert.equal(readback!.origin, "scheduler_record");
    assert.equal(readback!.schedule.timezone, "Asia/Hong_Kong");
    assert.equal(readback!.schedule.local_date, "2026-07-21");
    assert.equal(readback!.schedule.prepare_local_time, "09:00");
    assert.equal(readback!.schedule.review_local_time, "17:00");
    assert.deepEqual(readback!.artifact, {
      evidence_class: "natural_scheduler",
      delivery: "local_no_delivery",
      trigger: "scheduled",
      manual_trigger: false,
      slots: ["09:00", "17:00", "23:00"],
    });
  } finally {
    await cleanup(root);
  }
});

test("watchdog slot-receipt writer persists receipts the file store can observe", async () => {
  const root = await tempProject("ch-hk-receipt-write-");
  try {
    const receipt: SlotReceipt = {
      schema_version: 1,
      slot: "09:00",
      local_date: "2026-07-21",
      receipt_id: "rcpt-2026-07-21-0900",
      observed_at: "2026-07-21T09:00:00+08:00",
      status: "ok",
      evidence_class: "natural_scheduler",
    };
    const written = await writeSlotReceipt(root, receipt);
    assert.equal(written.receipt_id, receipt.receipt_id);
    const store = createFileReceiptStore(root);
    const listed = await store.listForDate("2026-07-21");
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], receipt);
    assert.deepEqual(await store.read(receipt.receipt_id), receipt);
  } finally {
    await cleanup(root);
  }
});

test("receipt monitor reports miss and hit honestly without fabricating PASS", async () => {
  const root = await tempProject("ch-hk-monitor-");
  try {
    await installHkNaturalSchedules(root, { apply_schtasks: false });
    const miss = await monitorHkNaturalReceipts(root, { local_date: "2026-07-21" });
    assert.equal(miss.timezone, "Asia/Hong_Kong");
    assert.deepEqual(
      miss.slots.map((s) => ({ slot: s.slot, status: s.status })),
      [
        { slot: "09:00", status: "miss" },
        { slot: "17:00", status: "miss" },
        { slot: "23:00", status: "miss" },
      ],
    );
    assert.equal(miss.outcome, "all_miss");
    assert.equal(miss.natural_grade_eligible, false);
    assert.equal(miss.fabricated_pass, false);
    assert.notEqual(miss.outcome as string, "PASS");

    await writeSlotReceipt(root, {
      schema_version: 1,
      slot: "09:00",
      local_date: "2026-07-21",
      receipt_id: "rcpt-hit-0900",
      observed_at: "2026-07-21T09:00:00+08:00",
      status: "ok",
      evidence_class: "natural_scheduler",
    });
    await writeSlotReceipt(root, {
      schema_version: 1,
      slot: "17:00",
      local_date: "2026-07-21",
      receipt_id: "rcpt-hit-1700",
      observed_at: "2026-07-21T17:00:00+08:00",
      status: "ok",
      evidence_class: "natural_scheduler",
    });
    const partial = await monitorHkNaturalReceipts(root, { local_date: "2026-07-21" });
    assert.equal(partial.outcome, "partial");
    assert.equal(partial.natural_grade_eligible, false);
    assert.equal(partial.fabricated_pass, false);
    assert.deepEqual(
      partial.slots.map((s) => `${s.slot}:${s.status}`),
      ["09:00:hit", "17:00:hit", "23:00:miss"],
    );

    await writeSlotReceipt(root, {
      schema_version: 1,
      slot: "23:00",
      local_date: "2026-07-21",
      receipt_id: "rcpt-hit-2300",
      observed_at: "2026-07-21T23:00:00+08:00",
      status: "ok",
      evidence_class: "natural_scheduler",
    });
    const allHit = await monitorHkNaturalReceipts(root, { local_date: "2026-07-21" });
    assert.equal(allHit.outcome, "all_hit");
    assert.equal(allHit.natural_grade_eligible, true);
    assert.equal(allHit.fabricated_pass, false);
    assert.equal(Object.prototype.hasOwnProperty.call(allHit, "PASS"), false);
  } finally {
    await cleanup(root);
  }
});

test("manual and local canary runs are labeled non-natural and do not satisfy natural grading", async () => {
  const root = await tempProject("ch-hk-non-natural-");
  try {
    await installHkNaturalSchedules(root, { apply_schtasks: false });
    const labeled = labelManualCanaryRun({
      schema_version: 1,
      slot: "09:00",
      local_date: "2026-07-21",
      receipt_id: "rcpt-manual-0900",
      observed_at: "2026-07-21T09:05:00+08:00",
      status: "ok",
    });
    assert.equal(labeled.evidence_class, "manual");
    assert.equal(labeled.natural, false);

    for (const slot of HK_NATURAL_SLOTS) {
      await writeSlotReceipt(root, labelManualCanaryRun({
        schema_version: 1,
        slot,
        local_date: "2026-07-21",
        receipt_id: `rcpt-manual-${slot.replace(":", "")}`,
        observed_at: `2026-07-21T${slot}:00+08:00`,
        status: "ok",
      }));
    }
    const report = await monitorHkNaturalReceipts(root, { local_date: "2026-07-21" });
    assert.equal(report.outcome, "all_hit");
    assert.equal(report.natural_grade_eligible, false);
    assert.equal(report.fabricated_pass, false);
    assert.ok(report.slots.every((s) => s.evidence_class === "manual"));
  } finally {
    await cleanup(root);
  }
});

test("apply_schtasks=true registers when schtasks.exe is available and status reflects it", async () => {
  const root = await tempProject("ch-hk-sched-apply-");
  try {
    const calls: Array<{ scriptPath: string; schtasksExe: string }> = [];
    const first = await installHkNaturalSchedules(root, { apply_schtasks: true }, {
      resolveSchtasksExe: () => "/mnt/c/Windows/System32/schtasks.exe",
      runProjectedScript: async (input) => {
        calls.push(input);
      },
    });
    assert.equal(first.schtasks_registered, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.schtasksExe, "/mnt/c/Windows/System32/schtasks.exe");
    assert.ok(calls[0]!.scriptPath.endsWith("windows-schtasks.ps1"));
    assert.ok(await fs.stat(calls[0]!.scriptPath));

    const status = await scheduleStatus(root);
    assert.equal(status.installed, true);
    assert.equal(status.schtasks_registered, true);

    const second = await installHkNaturalSchedules(root, { apply_schtasks: true }, {
      resolveSchtasksExe: () => "/mnt/c/Windows/System32/schtasks.exe",
      runProjectedScript: async (input) => {
        calls.push(input);
      },
    });
    assert.equal(second.created, false);
    assert.equal(second.schtasks_registered, true);
    assert.equal(calls.length, 2);
  } finally {
    await cleanup(root);
  }
});

test("apply_schtasks=true skips registration when schtasks.exe is unavailable", async () => {
  const root = await tempProject("ch-hk-sched-skip-");
  try {
    let ran = false;
    const result = await installHkNaturalSchedules(root, { apply_schtasks: true }, {
      resolveSchtasksExe: () => null,
      runProjectedScript: async () => {
        ran = true;
      },
    });
    assert.equal(result.schtasks_registered, false);
    assert.equal(ran, false);
    const status = await scheduleStatus(root);
    assert.equal(status.schtasks_registered, false);
  } finally {
    await cleanup(root);
  }
});

test("runNaturalSlot writes natural workflow + slot receipts and never manual", async () => {
  const root = await tempProject("ch-hk-run-slot-");
  try {
    await installHkNaturalSchedules(root, { apply_schtasks: false });
    const prepared = await runNaturalSlot(root, { slot: "09:00", local_date: "2026-07-22", natural: true });
    assert.equal(prepared.role, "pm_prepare");
    assert.equal(prepared.delivery, "local_no_delivery");
    assert.equal(prepared.workflow.evidence_class, "natural_scheduler");
    assert.equal(prepared.workflow.natural, true);
    assert.equal(prepared.workflow.manual_trigger, false);
    assert.equal(prepared.slot_receipt.evidence_class, "natural_scheduler");
    assert.equal(prepared.slot_receipt.natural, true);
    assert.equal(prepared.scout_pointer?.evidence_class, "natural_scheduler");

    const reviewed = await runNaturalSlot(root, { slot: "17:00", local_date: "2026-07-22", natural: true });
    assert.equal(reviewed.role, "pm_review_worker");
    assert.equal(reviewed.workflow.evidence_class, "natural_scheduler");

    const nightly = await runNaturalSlot(root, { slot: "23:00", local_date: "2026-07-22", natural: true });
    assert.equal(nightly.role, "strategic_nightly");
    assert.equal(nightly.workflow.evidence_class, "natural_scheduler");

    await assert.rejects(
      () => runNaturalSlot(root, { slot: "09:00", local_date: "2026-07-22", natural: false }),
      /natural/,
    );

    const script = await fs.readFile(
      path.join(root, ".ycm-harness", "autonomy", "hk-natural-schedules", "projection", "windows-schtasks.ps1"),
      "utf8",
    );
    assert.match(script, /--cwd .+ autonomy schedule run-slot --slot 09:00 --natural/);
    assert.match(script, /--cwd .+ autonomy schedule run-slot --slot 17:00 --natural/);
    assert.match(script, /--cwd .+ autonomy schedule run-slot --slot 23:00 --natural/);
    assert.doesNotMatch(script, /-Execute 'ycm-harness'/);
    assert.doesNotMatch(script, /receipt record --slot/);
    assert.match(script, /Register-ScheduledTask[\s\S]*-Force/);
  } finally {
    await cleanup(root);
  }
});

test("windows schtasks projection uses abs node CLI entry with --cwd, not bare ycm-harness", async () => {
  const root = await tempProject("ch-hk-schtasks-cwd-");
  try {
    await installHkNaturalSchedules(root, { apply_schtasks: false });
    const script = await fs.readFile(
      path.join(root, ".ycm-harness", "autonomy", "hk-natural-schedules", "projection", "windows-schtasks.ps1"),
      "utf8",
    );
    assert.doesNotMatch(script, /-Execute 'ycm-harness'/);
    assert.match(script, /New-ScheduledTaskAction -Execute '.+' -Argument '.*dist[\\/\\]cli[\\/\\]index\.js.*--cwd /);
    assert.match(script, /--cwd .+ autonomy schedule run-slot --slot 09:00 --natural/);
    assert.match(script, /--cwd .+ autonomy schedule run-slot --slot 17:00 --natural/);
    assert.match(script, /--cwd .+ autonomy schedule run-slot --slot 23:00 --natural/);
    // Absolute CLI entry (Windows or POSIX) must appear in the action argument.
    assert.match(script, /(?:[A-Za-z]:\\|\\\\|\/).+dist[\\/\\]cli[\\/\\]index\.js/);
  } finally {
    await cleanup(root);
  }
});

test("gradeNaturalCycle PASS only with natural PM+review+nightly+scout/pointer+watchdog; incomplete/manual to PARTIAL with gap reuse", async () => {
  const root = await tempProject("ch-hk-grade-cycle-");
  try {
    await installHkNaturalSchedules(root, { apply_schtasks: false });

    const empty = await gradeNaturalCycle(root, { local_date: "2026-07-22" });
    assert.equal(empty.verdict, "PARTIAL");
    assert.ok(empty.gap_issue_id);
    assert.ok(empty.missing.length > 0);
    assert.equal(empty.fabricated_pass, false);

    const again = await gradeNaturalCycle(root, { local_date: "2026-07-22" });
    assert.equal(again.verdict, "PARTIAL");
    assert.equal(again.gap_issue_id, empty.gap_issue_id);

    for (const slot of HK_NATURAL_SLOTS) {
      await writeSlotReceipt(root, labelManualCanaryRun({
        schema_version: 1,
        slot,
        local_date: "2026-07-22",
        receipt_id: `rcpt-manual-grade-${slot.replace(":", "")}`,
        observed_at: `2026-07-22T${slot}:00+08:00`,
        status: "ok",
      }));
    }
    const manual = await gradeNaturalCycle(root, { local_date: "2026-07-22" });
    assert.equal(manual.verdict, "PARTIAL");
    assert.ok(manual.missing.length > 0);
    assert.equal(manual.gap_issue_id, empty.gap_issue_id);

    await runNaturalSlot(root, { slot: "09:00", local_date: "2026-07-22", natural: true });
    await runNaturalSlot(root, { slot: "17:00", local_date: "2026-07-22", natural: true });
    const mid = await gradeNaturalCycle(root, { local_date: "2026-07-22" });
    assert.equal(mid.verdict, "PARTIAL");
    assert.ok(mid.missing.includes("strategic_nightly"));
    assert.ok(!mid.missing.includes("watchdog"));
    assert.ok(mid.components.watchdog);

    await runNaturalSlot(root, { slot: "23:00", local_date: "2026-07-22", natural: true });
    const pass = await gradeNaturalCycle(root, { local_date: "2026-07-22" });
    assert.equal(pass.verdict, "PASS");
    assert.deepEqual(pass.missing, []);
    assert.equal(pass.fabricated_pass, false);
    assert.ok(pass.components.pm_prepare);
    assert.ok(pass.components.pm_review_worker);
    assert.ok(pass.components.strategic_nightly);
    assert.ok(pass.components.scout_pointer);
    assert.ok(pass.components.watchdog);
  } finally {
    await cleanup(root);
  }
});

test("gradeNaturalCycle treats natural slot receipt as watchdog hit without requiring all slots", async () => {
  const root = await tempProject("ch-hk-grade-watchdog-receipt-");
  try {
    await installHkNaturalSchedules(root, { apply_schtasks: false });
    const ran = await runNaturalSlot(root, { slot: "09:00", local_date: "2026-07-22", natural: true });
    assert.equal(ran.slot_receipt.receipt_id, "rcpt-natural-2026-07-22-0900");

    const graded = await gradeNaturalCycle(root, { local_date: "2026-07-22" });
    assert.equal(graded.verdict, "PARTIAL");
    assert.equal(graded.fabricated_pass, false);
    assert.ok(graded.components.pm_prepare);
    assert.ok(graded.components.scout_pointer);
    assert.ok(graded.components.watchdog, "natural 09:00 slot receipt must satisfy watchdog");
    assert.ok(!graded.missing.includes("watchdog"), `watchdog unexpectedly missing: ${JSON.stringify(graded.missing)}`);
    assert.ok(graded.missing.includes("pm_review_worker"));
    assert.ok(graded.missing.includes("strategic_nightly"));
  } finally {
    await cleanup(root);
  }
});

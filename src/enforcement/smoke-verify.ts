import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import type { SmokeEvidenceT } from "../schema/smoke.js";
import { runShellCommand, readLogSha256 } from "./exec-command.js";
import { strictGatesEnabled } from "./strict-mode.js";

export interface SmokeVerifyResult {
  smoke_id: string;
  ok: boolean;
  reason: string;
}

export function smokeRequiresExecution(ev: SmokeEvidenceT): boolean {
  if (ev.outcome !== "pass") return false;
  return strictGatesEnabled();
}

export function smokeHasExecutionProof(ev: SmokeEvidenceT): boolean {
  return ev.recording_mode === "executed" && Boolean(ev.log_file) && ev.log_sha256 !== undefined;
}

export async function verifySmokeEvidence(
  ev: SmokeEvidenceT,
  projectRoot: string,
): Promise<SmokeVerifyResult> {
  const integrity = await verifySmokeEvidenceIntegrity(ev, projectRoot);
  if (!integrity.ok || !smokeRequiresExecution(ev)) return integrity;
  const rerun = await runShellCommand(ev.command!, projectRoot);
  if (rerun.exitCode !== ev.exit_code) {
    return {
      smoke_id: ev.id,
      ok: false,
      reason: `smoke re-run exit ${rerun.exitCode} != recorded ${ev.exit_code}`,
    };
  }
  return integrity;
}

export async function verifySmokeEvidenceIntegrity(
  ev: SmokeEvidenceT,
  projectRoot: string,
): Promise<SmokeVerifyResult> {
  if (!smokeRequiresExecution(ev)) {
    return { smoke_id: ev.id, ok: true, reason: "not required" };
  }
  if (!smokeHasExecutionProof(ev)) {
    return {
      smoke_id: ev.id,
      ok: false,
      reason:
        "pass smoke must be recorded via 'ycm-harness smoke run' (executed command + log file)",
    };
  }
  if (!ev.command) {
    return { smoke_id: ev.id, ok: false, reason: "executed smoke missing command" };
  }
  const logPath = path.resolve(projectRoot, ev.log_file!);
  try {
    await fs.access(logPath);
  } catch {
    return { smoke_id: ev.id, ok: false, reason: `smoke log missing: ${ev.log_file}` };
  }
  const storedSha = ev.log_sha256 ?? (await readLogSha256(logPath));
  if (!storedSha) {
    return { smoke_id: ev.id, ok: false, reason: "smoke log missing sha256" };
  }
  const onDisk = await fs.readFile(logPath, "utf8");
  const header = onDisk.match(
    /^# smoke log ([^\r\n]+)\r?\n# exit=(-?\d+)\r?\n# sha256=([a-f0-9]{64})\r?\n\r?\n/,
  );
  if (!header) {
    return { smoke_id: ev.id, ok: false, reason: "smoke log missing sha256" };
  }
  const payload = onDisk.slice(header[0].length);
  const payloadSha = createHash("sha256").update(payload).digest("hex");
  if (
    header[1] !== ev.id ||
    Number(header[2]) !== ev.exit_code ||
    header[3] !== storedSha ||
    payloadSha !== storedSha
  ) {
    return { smoke_id: ev.id, ok: false, reason: "smoke log tampered (sha256 mismatch)" };
  }
  return { smoke_id: ev.id, ok: true, reason: "verified" };
}

export async function verifySmokeIntegrityBatch(
  evidence: SmokeEvidenceT[],
  projectRoot: string,
): Promise<SmokeVerifyResult[]> {
  return await Promise.all(
    evidence
      .filter((ev) => ev.outcome === "pass")
      .map((ev) => verifySmokeEvidenceIntegrity(ev, projectRoot)),
  );
}

export async function verifySmokeBatch(
  evidence: SmokeEvidenceT[],
  projectRoot: string,
): Promise<SmokeVerifyResult[]> {
  const results: SmokeVerifyResult[] = [];
  for (const ev of evidence) {
    if (ev.outcome === "pass") {
      results.push(await verifySmokeEvidence(ev, projectRoot));
    }
  }
  return results;
}

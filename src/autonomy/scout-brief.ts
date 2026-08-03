import { createHash } from "node:crypto";
import path from "node:path";
import { assertNoSecrets, withCoordinationLease, resolveHarnessGoal, type ResolvedHarnessGoal } from "./coordination.js";
import { buildSessionDigest } from "../hooks/session-start.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import { HarnessStore } from "../state/store.js";
import { redact } from "../wiki/redact.js";
import {
  runScoutCollection,
  type NativeScoutHandle,
  type NativeScoutLaunchProof,
  type ScoutRunContext,
} from "./scout-runner.js";
import { executeGuardedScoutAdapter, ScoutGuardError } from "./scout-guard.js";
import {
  appendScoutTelemetry,
  buildScoutTelemetry,
  type ScoutTelemetryEmitter,
  type ScoutTelemetryReason,
  type ScoutTerminalStatus,
} from "./scout-telemetry.js";

export const SCOUT_BRIEF_VERSION = "SCOUT_BRIEF_V1";
export const SCOUT_BRIEF_HEADINGS = [
  "RELEVANT PRIOR CONTEXT",
  "USER CORRECTIONS / PREFERENCES",
  "PRIOR DECISIONS AND RATIONALE",
  "UNRESOLVED OBLIGATIONS / TICKETS",
  "RECURRING PATTERNS / RISKS",
  "SOURCE POINTERS",
  "LIVE-STATE CHECKS THE PARENT STILL OWES",
] as const;
const MAX_BRIEF_BYTES = 32 * 1024;
const OPAQUE_KEY = /^scout-v1-([0-9a-f]{24})-([0-9a-f]{24})$/;
type RootResolver = (cwd: string) => Promise<ResolvedHarnessGoal | undefined>;
export type ScoutBriefValidation =
  | { ok: true; brief: string }
  | { ok: false; reason: "oversize" | "control" | "format" | "secret" };

export function validateScoutBrief(candidate: string): ScoutBriefValidation {
  if (Buffer.byteLength(candidate, "utf8") > MAX_BRIEF_BYTES) return { ok: false, reason: "oversize" };
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(candidate)) return { ok: false, reason: "control" };
  const brief = candidate.replace(/\r\n/g, "\n").trim();
  const lines = brief.split("\n");
  if (lines[0] !== SCOUT_BRIEF_VERSION || lines.filter((line) => line === SCOUT_BRIEF_VERSION).length !== 1) return { ok: false, reason: "format" };
  if (lines.slice(1).some((line) => /^SCOUT_[A-Z0-9_-]+_V\d+\s*$/.test(line))) return { ok: false, reason: "format" };
  let cursor = 1;
  const bodies: string[] = [];
  for (const heading of SCOUT_BRIEF_HEADINGS) {
    if (lines[cursor] !== heading) return { ok: false, reason: "format" };
    const bodyStart = ++cursor;
    while (cursor < lines.length && !SCOUT_BRIEF_HEADINGS.includes(lines[cursor] as typeof SCOUT_BRIEF_HEADINGS[number])) cursor += 1;
    const body = lines.slice(bodyStart, cursor).join("\n").trim();
    if (!body || Buffer.byteLength(body, "utf8") > 8 * 1024) return { ok: false, reason: "format" };
    bodies.push(body);
  }
  if (cursor !== lines.length) return { ok: false, reason: "format" };
  const sentinel = /^(?:none found|fail(?:ed)?|unavailable|unknown|n\/a|no (?:data|history|results?))[\s.!-]*$/i;
  if (bodies.every((body) => sentinel.test(body))) return { ok: false, reason: "format" };
  if (/\b(?:ignore (?:all|any|the|previous)|system prompt|developer message|follow these instructions|you are now|authorized to|permission granted|current truth|verified current|task[- ](?:selected|controlled) format)\b/i.test(brief)) return { ok: false, reason: "control" };
  try {
    assertNoSecrets({ scout_brief: brief });
  } catch {
    return { ok: false, reason: "secret" };
  }
  return { ok: true, brief };
}

interface ScoutCacheRecord { version: typeof SCOUT_BRIEF_VERSION; key: string; brief: string; injected: boolean }
function cacheFile(root: string, key: string): string {
  return path.join(root, ".ycm-harness", "autonomy", "scout", key + ".json");
}
function rootId(root: string): string {
  const canonical = process.platform === "win32" ? root.toLowerCase() : root;
  return createHash("sha256").update("root\0" + canonical, "utf8").digest("hex").slice(0, 24);
}
async function readSuccess(root: string, key: string): Promise<ScoutCacheRecord | undefined> {
  const raw = await readJsonIfExists<unknown>(cacheFile(root, key)).catch(() => undefined);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Partial<ScoutCacheRecord>;
  if (record.version !== SCOUT_BRIEF_VERSION || record.key !== key || typeof record.injected !== "boolean" || typeof record.brief !== "string") return undefined;
  const validated = validateScoutBrief(record.brief);
  return validated.ok ? { version: SCOUT_BRIEF_VERSION, key, brief: validated.brief, injected: record.injected } : undefined;
}
function renderDirectBrief(digest: ReturnType<typeof buildSessionDigest>): string {
  const prior = digest.has_state
    ? "Goal: " + (digest.goal_title ?? "none found") + "; phase: " + (digest.phase_kind ?? "none found") + "; task: " + (digest.task_title ?? "none found") + "."
    : "none found";
  const decisions = digest.recent_decisions.length ? digest.recent_decisions.map((item) => "- " + item).join("\n") : "none found";
  const obligations = digest.pending_tasks.length ? digest.pending_tasks.map((item) => "- " + item).join("\n") : "none found";
  return [
    SCOUT_BRIEF_VERSION,
    SCOUT_BRIEF_HEADINGS[0], prior,
    SCOUT_BRIEF_HEADINGS[1], "none found",
    SCOUT_BRIEF_HEADINGS[2], decisions,
    SCOUT_BRIEF_HEADINGS[3], obligations,
    SCOUT_BRIEF_HEADINGS[4], "none found",
    SCOUT_BRIEF_HEADINGS[5], ".ycm-harness/state.json",
    SCOUT_BRIEF_HEADINGS[6], "Memory references, GitHub issues, schedules, installed projection, and Git state still require live checks.",
  ].join("\n");
}
async function collectDirectBrief(root: string): Promise<string> {
  return executeGuardedScoutAdapter(
    { projectRoot: root, cwd: root },
    { adapter: "harness", operation: "read", target: path.join(root, ".ycm-harness", "state.json") },
    async () => {
      const store = new HarnessStore(root);
      return renderDirectBrief(buildSessionDigest(await store.readState()));
    },
  );
}
export interface ScoutFulfillmentDeps {
  resolveRoot?: RootResolver;
  collect?: (root: string, context?: ScoutRunContext) => Promise<string>;
  nativeProof?: NativeScoutLaunchProof;
  launchNative?: (context: ScoutRunContext) => NativeScoutHandle;
  now?: () => number;
  wait?: <T>(result: Promise<T>, remainingMs: number, signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
  emitTelemetry?: ScoutTelemetryEmitter;
}
export async function fulfillScoutObligation(
  cwd: string,
  key: string,
  deps: ScoutFulfillmentDeps = {},
): Promise<{ status: "accepted"; source: "native" | "direct" | "cache"; key: string }> {
  const match = OPAQUE_KEY.exec(key);
  if (!match) throw new Error("invalid_scout_obligation");
  const resolved = await (deps.resolveRoot ?? resolveHarnessGoal)(cwd);
  if (!resolved || match[1] !== rootId(resolved.root)) throw new Error("scout_obligation_root_mismatch");
  return withCoordinationLease(resolved.root, "scout-" + key, async () => {
    const clock = deps.now ?? (() => performance.now());
    const started = clock();
    let nativeAttempts = 0;
    let directAttempts = 0;
    let guardDenied = false;
    let guardAllowed = false;
    let briefSize = 0;
    const emit = async (
      status: ScoutTerminalStatus,
      reason: ScoutTelemetryReason,
      tier: "native" | "direct" | "cache" | "none" = directAttempts ? "direct" : nativeAttempts ? "native" : "none",
    ): Promise<void> => {
      const event = buildScoutTelemetry({
        generationHash: match[2]!, rootId: match[1]!, tier, status, reason,
        elapsedMs: clock() - started,
        toolCount: nativeAttempts + directAttempts,
        briefSize, cacheHit: status === "cache", fallback: directAttempts > 0,
        guardResult: guardDenied ? "denied" : guardAllowed ? "allowed" : "not_observed",
      });
      const emitter = deps.emitTelemetry ?? ((value) => appendScoutTelemetry(resolved.root, value));
      await Promise.resolve(emitter(event)).catch(() => undefined);
    };
    try {
      const cached = await readSuccess(resolved.root, key);
      if (cached) {
        briefSize = Buffer.byteLength(cached.brief, "utf8");
        await emit("cache", "cache_hit", "cache");
        return { status: "accepted", source: "cache", key };
      }
      const result = await runScoutCollection(resolved.root, {
        collectDirect: async (context) => {
          directAttempts += 1;
          try {
            const candidate = await (deps.collect ?? collectDirectBrief)(resolved.root, context);
            if (!deps.collect) guardAllowed = true;
            return candidate;
          } catch (error) {
            if (error instanceof ScoutGuardError) guardDenied = true;
            throw error;
          }
        },
        validate: (candidate) => {
          const validated = validateScoutBrief(candidate);
          if (validated.ok) briefSize = Buffer.byteLength(validated.brief, "utf8");
          return validated;
        },
        finalize: async (brief) => writeJsonAtomic(cacheFile(resolved.root, key), {
          version: SCOUT_BRIEF_VERSION, key, brief, injected: false,
        } satisfies ScoutCacheRecord),
        nativeProof: deps.nativeProof,
        launchNative: deps.launchNative ? (context) => {
          nativeAttempts += 1;
          return deps.launchNative!(context);
        } : undefined,
        now: deps.now,
        wait: deps.wait,
        signal: deps.signal,
      });
      await emit(result.source === "direct" ? "fallback" : "success",
        result.source === "direct" ? "direct_fallback" : "validated", result.source);
      return { status: "accepted", source: result.source, key };
    } catch (error) {
      const cancelled = deps.signal?.aborted === true || String(error).includes("scout_cancelled");
      const timedOut = String(error).includes("scout_timeout");
      await emit(guardDenied ? "denial" : cancelled ? "cancel" : timedOut ? "timeout" : "failure",
        guardDenied ? "guard_denied" : cancelled ? "cancelled" : timedOut ? "deadline_exhausted" : "collector_failed");
      throw error;
    }
  });
}
export async function consumeScoutBrief(root: string, key: string): Promise<string | undefined> {
  return withCoordinationLease(root, "scout-" + key, async () => {
    const record = await readSuccess(root, key);
    if (!record || record.injected) return undefined;
    await writeJsonAtomic(cacheFile(root, key), { ...record, injected: true });
    return record.brief;
  }).catch(() => undefined);
}

import { createHash } from "node:crypto";
import path from "node:path";
import { appendJsonl } from "../state/io.js";
import { SCOUT_BUDGET_MS } from "./scout-runner.js";
import type { ScoutGuardResult } from "./scout-guard.js";

export const SCOUT_TELEMETRY_VERSION = "SCOUT_TELEMETRY_V1";
export type ScoutTerminalStatus = "success" | "cache" | "fallback" | "timeout" | "denial" | "cancel" | "failure";
export type ScoutTelemetryReason = "validated" | "cache_hit" | "direct_fallback" | "deadline_exhausted"
  | "guard_denied" | "cancelled" | "collector_failed";
export interface ScoutTelemetryInput {
  generationHash: string;
  rootId: string;
  tier: "native" | "direct" | "cache" | "none";
  status: ScoutTerminalStatus;
  reason: ScoutTelemetryReason;
  elapsedMs: number;
  toolCount: number;
  briefSize: number;
  cacheHit: boolean;
  fallback: boolean;
  guardResult: ScoutGuardResult;
}
export interface ScoutTelemetryEvent {
  contract_version: typeof SCOUT_TELEMETRY_VERSION;
  session_generation_hash: string;
  root_id: string;
  tier: ScoutTelemetryInput["tier"];
  status: ScoutTerminalStatus;
  reason: ScoutTelemetryReason;
  budget_ms: typeof SCOUT_BUDGET_MS;
  elapsed_ms: number;
  tool_count: number;
  brief_size: number;
  cache_hit: boolean;
  fallback: boolean;
  guard_result: ScoutGuardResult;
}

const TIERS = ["native", "direct", "cache", "none"] as const;
const STATUSES = ["success", "cache", "fallback", "timeout", "denial", "cancel", "failure"] as const;
const REASONS = ["validated", "cache_hit", "direct_fallback", "deadline_exhausted", "guard_denied", "cancelled", "collector_failed"] as const;
const GUARD_RESULTS = ["allowed", "denied", "not_observed"] as const;
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}
function boundedInteger(value: unknown, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0;
}
function hashOrKeep(value: unknown, domain: string, length: 24 | 64): string {
  const text = typeof value === "string" ? value : "";
  if (new RegExp(`^[0-9a-f]{${length}}$`).test(text)) return text;
  return createHash("sha256").update(domain + "\0" + text, "utf8").digest("hex").slice(0, length);
}

/** Reprojects unknown runtime input so only fixed derived fields can cross persistence. */
function projectScoutTelemetry(value: unknown): ScoutTelemetryEvent {
  const input = object(value);
  return {
    contract_version: SCOUT_TELEMETRY_VERSION,
    session_generation_hash: hashOrKeep(input.generationHash ?? input.session_generation_hash, "generation", 64),
    root_id: hashOrKeep(input.rootId ?? input.root_id, "root", 24),
    tier: oneOf(input.tier, TIERS, "none"),
    status: oneOf(input.status, STATUSES, "failure"),
    reason: oneOf(input.reason, REASONS, "collector_failed"),
    budget_ms: SCOUT_BUDGET_MS,
    elapsed_ms: boundedInteger(input.elapsedMs ?? input.elapsed_ms, SCOUT_BUDGET_MS),
    tool_count: boundedInteger(input.toolCount ?? input.tool_count, 1_000),
    brief_size: boundedInteger(input.briefSize ?? input.brief_size, 32 * 1024),
    cache_hit: (input.cacheHit ?? input.cache_hit) === true,
    fallback: input.fallback === true,
    guard_result: oneOf(input.guardResult ?? input.guard_result, GUARD_RESULTS, "not_observed"),
  };
}

/** Projects only the fixed derived allowlist; caller extras cannot enter the event. */
export function buildScoutTelemetry(input: ScoutTelemetryInput): ScoutTelemetryEvent {
  return projectScoutTelemetry(input);
}
export type ScoutTelemetryEmitter = (event: ScoutTelemetryEvent) => void | Promise<void>;
export async function appendScoutTelemetry(root: string, event: unknown): Promise<void> {
  await appendJsonl(path.join(root, ".ycm-harness", "autonomy", "scout", "telemetry.jsonl"), projectScoutTelemetry(event));
}

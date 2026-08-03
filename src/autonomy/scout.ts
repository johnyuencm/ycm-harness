import { createHash } from "node:crypto";
import { resolveHarnessGoal, type ResolvedHarnessGoal } from "./coordination.js";
import { consumeScoutBrief } from "./scout-brief.js";

export const SCOUT_OBLIGATION_VERSION = "SCOUT_OBLIGATION_V1";

type ScoutUnavailableReason = "identity_unproven" | "payload_invalid" | "root_unavailable";

export type ScoutStartupIntent =
  | { kind: "none" }
  | { kind: "unavailable"; reason: ScoutUnavailableReason }
  | { kind: "resume"; cwd: string; generation: string }
  | { kind: "pending"; cwd: string; generation: string };

type HarnessRootResolver = (cwd: string) => Promise<ResolvedHarnessGoal | undefined>;

const SAFE_GENERATION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Operator kill switch. Only an explicit 0 disables fresh-parent scout work. */
export function scoutObligationEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YCM_HARNESS_SCOUT_ENABLED !== "0";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Pure host-payload classifier. Unknown identity never gains parent authority. */
export function classifyScoutStartup(payload: unknown): ScoutStartupIntent {
  const input = object(payload);
  if (!input) return { kind: "none" };
  const event = text(input.hook_event_name ?? input.hookEventName);
  if (!event || !/^session[-_]?start$/i.test(event)) return { kind: "none" };

  const source = text(input.source)?.toLowerCase();
  if (!source || !["startup", "clear", "resume", "later", "compact"].includes(source)) {
    return { kind: "none" };
  }
  if (source !== "startup" && source !== "clear" && source !== "resume") return { kind: "none" };

  const agentType = text(input.agent_type)?.toLowerCase();
  const provenChild = input.is_subagent === true
    || input.scout_child === true
    || text(input.parent_agent_id) !== undefined
    || (agentType !== undefined && agentType !== "parent");
  if (provenChild) return { kind: "none" };
  const provenParent = input.is_subagent === false || agentType === "parent";
  if (!provenParent) return { kind: "unavailable", reason: "identity_unproven" };

  const cwd = text(input.cwd);
  const generation = text(input.session_id ?? input.sessionId);
  if (!cwd || cwd.length > 4096 || !generation || !SAFE_GENERATION.test(generation)) {
    return { kind: "unavailable", reason: "payload_invalid" };
  }
  return { kind: source === "resume" ? "resume" : "pending", cwd, generation };
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function scoutKey(canonicalRoot: string, generation: string): string {
  return renderScoutObligation(canonicalRoot, generation).match(/key=(scout-v1-[0-9a-f-]+)/)?.[1] ?? "";
}

/** Render an opaque version/root/generation key without exposing either raw identifier. */
export function renderScoutObligation(canonicalRoot: string, generation: string): string {
  const root = process.platform === "win32" ? canonicalRoot.toLowerCase() : canonicalRoot;
  const rootId = sha(`root\0${root}`).slice(0, 24);
  const generationId = sha(`generation\0${generation}`).slice(0, 24);
  const key = `scout-v1-${rootId}-${generationId}`;
  return `Scout obligation: ${SCOUT_OBLIGATION_VERSION} key=${key}; dispatch at most one read-only native explore scout before task work. Direct history checks remain owed until a validated brief is accepted.`;
}

export function renderScoutUnavailable(reason: ScoutUnavailableReason): string {
  return `Scout: scout_unavailable reason=${reason}; direct history checks remain owed before task work.`;
}

/** Resolve only a proven fresh parent. All failures preserve a usable SessionStart result. */
export async function buildScoutStartupContext(
  payload: unknown,
  resolveRoot: HarnessRootResolver = resolveHarnessGoal,
): Promise<string | undefined> {
  const intent = classifyScoutStartup(payload);
  if (intent.kind === "none") return undefined;
  if (intent.kind === "unavailable") return renderScoutUnavailable(intent.reason);
  try {
    const resolved = await resolveRoot(intent.cwd);
    if (intent.kind === "resume") {
      return resolved ? await consumeScoutBrief(resolved.root, scoutKey(resolved.root, intent.generation)) : undefined;
    }
    return resolved
      ? renderScoutObligation(resolved.root, intent.generation)
      : renderScoutUnavailable("root_unavailable");
  } catch {
    return renderScoutUnavailable("root_unavailable");
  }
}

import path from "node:path";
import type { SessionClaimT, StateV3T } from "../schema/v3.js";

/** Fresh claims block reclaim by another session. */
export const SESSION_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

export interface SessionScopeContext {
  session_id?: string;
  cwd?: string;
  /** Project root that owns `.ycm-harness` (resolves relative worktree paths). */
  root?: string;
}

type RecordLike = Record<string, unknown>;

function record(value: unknown): RecordLike | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function claimsOf(state: RecordLike): Record<string, SessionClaimT> {
  const raw = record(state.session_claims) ?? {};
  const out: Record<string, SessionClaimT> = {};
  for (const [sessionId, value] of Object.entries(raw)) {
    const claim = record(value);
    const goalId = text(claim?.goal_id);
    const claimedAt = text(claim?.claimed_at);
    const lastSeen = text(claim?.last_seen_at);
    if (!sessionId || !goalId || !claimedAt || !lastSeen) continue;
    out[sessionId] = { goal_id: goalId, claimed_at: claimedAt, last_seen_at: lastSeen };
  }
  return out;
}

export function isClaimStale(claim: SessionClaimT, nowMs = Date.now(), ttlMs = SESSION_CLAIM_TTL_MS): boolean {
  const lastSeen = Date.parse(claim.last_seen_at);
  if (Number.isNaN(lastSeen)) return true;
  return nowMs - lastSeen > ttlMs;
}

export function findClaimForGoal(
  state: StateV3T | RecordLike,
  goalId: string,
): { session_id: string; claim: SessionClaimT } | undefined {
  const raw = record(state) ?? {};
  for (const [sessionId, claim] of Object.entries(claimsOf(raw))) {
    if (claim.goal_id === goalId) return { session_id: sessionId, claim };
  }
  return undefined;
}

/**
 * Exclusive claim: one fresh session per goal. Same session refreshes.
 * Stale holders may be reclaimed.
 */
export function claimSession(
  state: StateV3T,
  sessionId: string,
  goalId: string,
  nowIso: string,
  nowMs = Date.now(),
): StateV3T {
  const id = sessionId.trim();
  if (!id) throw new Error("session id is required");
  if (!state.goals[goalId]) throw new Error(`Unknown goal: ${goalId}`);

  const claims = { ...(state.session_claims ?? {}) };
  const existing = findClaimForGoal(state, goalId);
  if (existing && existing.session_id !== id && !isClaimStale(existing.claim, nowMs)) {
    throw new Error(
      `Goal ${goalId} is claimed by session '${existing.session_id}'. Pass that session or wait for the claim to go stale.`,
    );
  }
  if (existing && existing.session_id !== id) delete claims[existing.session_id];

  const prior = claims[id];
  claims[id] = {
    goal_id: goalId,
    claimed_at: prior?.goal_id === goalId ? prior.claimed_at : nowIso,
    last_seen_at: nowIso,
  };
  return { ...state, session_claims: claims };
}

export function refreshSessionClaim(
  state: StateV3T,
  sessionId: string,
  nowIso: string,
): StateV3T {
  const claims = { ...(state.session_claims ?? {}) };
  const prior = claims[sessionId];
  if (!prior) return state;
  claims[sessionId] = { ...prior, last_seen_at: nowIso };
  return { ...state, session_claims: claims };
}

export function releaseClaimsForGoal(state: StateV3T, goalId: string): StateV3T {
  const claims = { ...(state.session_claims ?? {}) };
  let changed = false;
  for (const [sessionId, claim] of Object.entries(claims)) {
    if (claim.goal_id === goalId) {
      delete claims[sessionId];
      changed = true;
    }
  }
  return changed ? { ...state, session_claims: claims } : state;
}

export function cwdInsideWorktree(cwd: string, root: string, worktreePath: string): boolean {
  const absWorktree = path.resolve(root, worktreePath);
  const absCwd = path.resolve(cwd);
  const rel = path.relative(absWorktree, absCwd);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function goalByWorktree(state: RecordLike, cwd: string, root: string): RecordLike | undefined {
  const goals = record(state.goals) ?? {};
  for (const goal of Object.values(goals)) {
    const item = record(goal);
    const worktreePath = text(item?.worktree_path);
    if (!item || !worktreePath) continue;
    if (cwdInsideWorktree(cwd, root, worktreePath)) return item;
  }
  return undefined;
}

/**
 * Resolve the goal that owns Stop / SessionStart for this host session.
 * Never falls back to bare `active_goal_id` (that caused cross-session bleed).
 *
 * Order: session claim → cwd inside a goal worktree → undefined.
 */
export function resolveScopedGoal(
  state: unknown,
  ctx: SessionScopeContext = {},
): RecordLike | undefined {
  const raw = record(state);
  if (!raw) return undefined;
  const goals = record(raw.goals) ?? {};

  const sessionId = text(ctx.session_id);
  if (sessionId) {
    const claim = claimsOf(raw)[sessionId];
    if (claim) {
      const goal = record(goals[claim.goal_id]);
      if (goal) return goal;
    }
  }

  const cwd = text(ctx.cwd);
  if (cwd) {
    const root = text(ctx.root) ?? cwd;
    const fromWorktree = goalByWorktree(raw, cwd, root);
    if (fromWorktree) return fromWorktree;
  }

  return undefined;
}

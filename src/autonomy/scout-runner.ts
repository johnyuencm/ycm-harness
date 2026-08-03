/** Total monotonic envelope shared by primary + fallback (Hermes shell-hook clamp). */
export const SCOUT_BUDGET_MS = 300_000;
/** Nightly/strategic primary attempt cap inside the shared envelope. */
export const SCOUT_PRIMARY_BUDGET_MS = 220_000;
/** Fallback attempt cap inside the shared envelope (220+90 exceeds 300; envelope wins). */
export const SCOUT_FALLBACK_BUDGET_MS = 90_000;
const CLEANUP_RESERVE_MS = 1_000;

export interface ScoutRunContext {
  root: string;
  remainingMs: number;
  signal: AbortSignal;
}

export interface NativeScoutLaunchProof {
  readOnlyToolsOmitted: true;
  credentialsOmitted: true;
  sandboxed: true;
  boundedDescendantCleanup: true;
}

export interface NativeScoutHandle {
  result: Promise<string>;
  cleanup: (context: ScoutRunContext) => Promise<void>;
}

export interface ScoutRunnerDeps {
  collectDirect: (context: ScoutRunContext) => Promise<string>;
  validate: (candidate: string) => { ok: true; brief: string } | { ok: false };
  finalize: (brief: string, source: "native" | "direct", context: ScoutRunContext) => Promise<void>;
  nativeProof?: unknown;
  launchNative?: (context: ScoutRunContext) => NativeScoutHandle;
  now?: () => number;
  wait?: <T>(result: Promise<T>, remainingMs: number, signal: AbortSignal) => Promise<T>;
  signal?: AbortSignal;
}

function provenNativeBoundary(value: unknown): value is NativeScoutLaunchProof {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proof = value as Partial<NativeScoutLaunchProof>;
  return proof.readOnlyToolsOmitted === true
    && proof.credentialsOmitted === true
    && proof.sandboxed === true
    && proof.boundedDescendantCleanup === true;
}

function defaultWait<T>(result: Promise<T>, remainingMs: number, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("scout_cancelled"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", cancel);
    };
    const succeed = (value: T) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const cancel = () => fail(new Error("scout_cancelled"));
    timer = setTimeout(() => fail(new Error("scout_timeout")), remainingMs);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) cancel();
    void result.then(succeed, fail);
  });
}

/** Runs at most one native attempt and one direct fallback under one monotonic budget. */
export async function runScoutCollection(
  root: string,
  deps: ScoutRunnerDeps,
): Promise<{ source: "native" | "direct" }> {
  const now = deps.now ?? (() => performance.now());
  const wait = deps.wait ?? defaultWait;
  const signal = deps.signal ?? new AbortController().signal;
  const cleanupSignal = new AbortController().signal;
  const deadline = now() + SCOUT_BUDGET_MS;
  const context = (cleanup = false): ScoutRunContext => {
    if (!cleanup && signal.aborted) throw new Error("scout_cancelled");
    const remainingMs = Math.max(0, deadline - now());
    if (remainingMs <= 0) throw new Error("scout_timeout");
    return { root, remainingMs, signal: cleanup ? cleanupSignal : signal };
  };
  const settle = async <T>(result: Promise<T>, capMs?: number, cleanup = false): Promise<T> => {
    const current = context(cleanup);
    const allowance = Math.min(current.remainingMs, capMs ?? current.remainingMs);
    const value = await wait(result, allowance, current.signal);
    context(cleanup);
    return value;
  };
  const accept = async (candidate: string, source: "native" | "direct"): Promise<boolean> => {
    context();
    const validated = deps.validate(candidate);
    context();
    if (!validated.ok) return false;
    await settle(deps.finalize(validated.brief, source, context()));
    return true;
  };

  if (provenNativeBoundary(deps.nativeProof) && deps.launchNative) {
    let handle: NativeScoutHandle | undefined;
    try {
      handle = deps.launchNative(context());
      context();
      const primaryAllowance = Math.min(
        Math.max(0, context().remainingMs - CLEANUP_RESERVE_MS),
        SCOUT_PRIMARY_BUDGET_MS,
      );
      const candidate = await settle(handle.result, primaryAllowance);
      const completed = handle;
      handle = undefined;
      try {
        await settle(completed.cleanup(context(true)), undefined, true);
      } catch (cleanupError) {
        throw new Error("scout_cleanup_failed", { cause: cleanupError });
      }
      if (await accept(candidate, "native")) return { source: "native" };
    } catch (error) {
      if (handle) {
        try {
          await settle(handle.cleanup(context(true)), undefined, true);
          handle = undefined;
        } catch (cleanupError) {
          throw new Error("scout_cleanup_failed", { cause: cleanupError });
        }
      }
      if (signal.aborted || now() >= deadline || String(error).includes("scout_cleanup_failed")) throw error;
    }
  }

  const direct = await settle(deps.collectDirect(context()), SCOUT_FALLBACK_BUDGET_MS);
  if (!await accept(direct, "direct")) throw new Error("invalid_scout_brief");
  return { source: "direct" };
}

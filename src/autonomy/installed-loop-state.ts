import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  assertSafeContinuationStoragePath,
} from "../continuation/storage-safety.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { withCoordinationLease, type CoordinationDeps } from "./coordination.js";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ACTION_ID = /^action-[a-f0-9]{64}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const PM_INSTALLED_LOOP_PROFILE = "pm-17:00";
export const PM_INSTALLED_LOOP_ID = "pm-17-00-loop";

export interface InstalledLoopAuthority {
  installation_id: string;
  profile: string;
  loop_id: string;
}

export interface InstalledLoopState {
  kind: "installed_loop";
  loop_id: string;
  profile: string;
  paused: boolean;
  state_version: string;
  protected_state_digest: string;
  read_at: string;
}

export interface InstalledLoopPauseRead {
  profile: string;
  loop_id: string;
  paused: boolean;
}

export type InstalledLoopPauseReader = (
  root: string,
  selector: { profile: string; loop_id: string },
) => Promise<InstalledLoopPauseRead>;

export interface InstalledLoopStateDeps extends CoordinationDeps {
  now?: () => string;
}

export interface InstalledLoopAdapter {
  read(loopId: string): Promise<InstalledLoopState | undefined>;
  setPaused(
    loopId: string,
    paused: boolean,
    actionIdentity: string,
    restoreTarget?: InstalledLoopState,
  ): Promise<void>;
}

const AuthoritySchema = z.object({
  installation_id: z.string().min(1).max(4096),
  profile: z.string().regex(SAFE_REF),
  loop_id: z.string().regex(SAFE_REF),
}).strict();

const DurableStateSchema = z.object({
  schema_version: z.literal(1),
  installation_id: z.string().min(1).max(4096),
  profile: z.string().regex(SAFE_REF),
  loop_id: z.string().regex(SAFE_REF),
  paused: z.boolean(),
  state_version: z.string().regex(SAFE_REF),
  protected_state_digest: z.string().regex(SHA256),
  updated_at: z.string().datetime(),
}).strict();
type DurableState = z.infer<typeof DurableStateSchema>;

const IntentSchema = z.object({
  schema_version: z.literal(1),
  action_identity: z.string().regex(ACTION_ID),
  installation_id: z.string().min(1).max(4096),
  profile: z.string().regex(SAFE_REF),
  loop_id: z.string().regex(SAFE_REF),
  state: z.enum(["pending", "finalized"]),
  mutation_attempted: z.boolean(),
  before: DurableStateSchema,
  intended_after: DurableStateSchema,
  intended_at: z.string().datetime(),
  finalized_at: z.string().datetime().optional(),
  history_id: z.string().regex(SHA256).optional(),
}).strict();
type LoopIntent = z.infer<typeof IntentSchema>;

const HistorySchema = z.object({
  schema_version: z.literal(1),
  history_id: z.string().regex(SHA256),
  action_identity: z.string().regex(ACTION_ID),
  installation_id: z.string().min(1).max(4096),
  profile: z.string().regex(SAFE_REF),
  loop_id: z.string().regex(SAFE_REF),
  before: DurableStateSchema,
  after: DurableStateSchema,
  recorded_at: z.string().datetime(),
}).strict();
type LoopHistory = z.infer<typeof HistorySchema>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value), "utf8").digest("hex");
}

function protectedDigest(authority: InstalledLoopAuthority, state: Pick<DurableState, "paused" | "state_version">): string {
  return sha256({
    schema_version: 1,
    installation_id: authority.installation_id,
    profile: authority.profile,
    loop_id: authority.loop_id,
    paused: state.paused,
    state_version: state.state_version,
  });
}

function paths(root: string, loopId: string, actionIdentity?: string): {
  harness: string;
  autonomy: string;
  root: string;
  state: string;
  intents: string;
  intent?: string;
  history: string;
  loopHistory: string;
} {
  const harness = path.join(root, HARNESS_DIR_NAME);
  const autonomy = path.join(harness, "autonomy");
  const storageRoot = path.join(autonomy, "installed-loops");
  const intents = path.join(storageRoot, "intents");
  const history = path.join(storageRoot, "history");
  return {
    harness,
    autonomy,
    root: storageRoot,
    state: path.join(storageRoot, `${loopId}.json`),
    intents,
    ...(actionIdentity ? { intent: path.join(intents, `${actionIdentity}.json`) } : {}),
    history,
    loopHistory: path.join(history, loopId),
  };
}

async function ensureStorage(root: string, loopId: string): Promise<void> {
  const storage = paths(root, loopId);
  for (const directory of [storage.harness, storage.autonomy, storage.root, storage.intents, storage.history, storage.loopHistory]) {
    await assertSafeContinuationStoragePath(root, directory, "directory", "INSTALLED_LOOP_STATE_UNAVAILABLE");
  }
  await fs.mkdir(storage.intents, { recursive: true });
  await fs.mkdir(storage.loopHistory, { recursive: true });
  for (const directory of [storage.harness, storage.autonomy, storage.root, storage.intents, storage.history, storage.loopHistory]) {
    await assertSafeContinuationStoragePath(root, directory, "directory", "INSTALLED_LOOP_STATE_UNAVAILABLE");
  }
}

function initialState(authority: InstalledLoopAuthority, at: string): DurableState {
  const base = { paused: false, state_version: "initial" };
  return {
    schema_version: 1,
    installation_id: authority.installation_id,
    profile: authority.profile,
    loop_id: authority.loop_id,
    ...base,
    protected_state_digest: protectedDigest(authority, base),
    updated_at: at,
  };
}

function assertAuthority(state: DurableState, authority: InstalledLoopAuthority): DurableState {
  if (state.installation_id !== authority.installation_id
    || state.profile !== authority.profile
    || state.loop_id !== authority.loop_id
    || state.protected_state_digest !== protectedDigest(authority, state)) {
    throw new Error("INSTALLED_LOOP_AUTHORITY_MISMATCH");
  }
  return state;
}

async function readDurableState(
  root: string,
  authority: InstalledLoopAuthority,
  at: string,
): Promise<DurableState> {
  const file = paths(root, authority.loop_id).state;
  await assertSafeContinuationStoragePath(root, file, "file", "INSTALLED_LOOP_STATE_UNAVAILABLE");
  const raw = await readJsonIfExists<unknown>(file);
  if (raw === undefined) return initialState(authority, at);
  const parsed = DurableStateSchema.safeParse(raw);
  if (!parsed.success) throw new Error("INSTALLED_LOOP_STATE_UNAVAILABLE");
  return assertAuthority(parsed.data, authority);
}

function publicState(state: DurableState, readAt: string): InstalledLoopState {
  return {
    kind: "installed_loop",
    loop_id: state.loop_id,
    profile: state.profile,
    paused: state.paused,
    state_version: state.state_version,
    protected_state_digest: state.protected_state_digest,
    read_at: readAt,
  };
}

function sameProtectedState(left: DurableState, right: DurableState): boolean {
  return left.installation_id === right.installation_id
    && left.profile === right.profile
    && left.loop_id === right.loop_id
    && left.paused === right.paused
    && left.state_version === right.state_version
    && left.protected_state_digest === right.protected_state_digest;
}

function durableRestoreTarget(
  authority: InstalledLoopAuthority,
  target: InstalledLoopState,
  at: string,
): DurableState {
  if (target.kind !== "installed_loop" || target.loop_id !== authority.loop_id || target.profile !== authority.profile) {
    throw new Error("INSTALLED_LOOP_AUTHORITY_MISMATCH");
  }
  const durable: DurableState = {
    schema_version: 1,
    installation_id: authority.installation_id,
    profile: authority.profile,
    loop_id: authority.loop_id,
    paused: target.paused,
    state_version: target.state_version,
    protected_state_digest: target.protected_state_digest,
    updated_at: at,
  };
  return assertAuthority(durable, authority);
}

async function readIntent(root: string, authority: InstalledLoopAuthority, actionIdentity: string): Promise<LoopIntent | undefined> {
  const file = paths(root, authority.loop_id, actionIdentity).intent!;
  await assertSafeContinuationStoragePath(root, file, "file", "INSTALLED_LOOP_STATE_UNAVAILABLE");
  const raw = await readJsonIfExists<unknown>(file);
  if (raw === undefined) return undefined;
  const parsed = IntentSchema.safeParse(raw);
  if (!parsed.success || parsed.data.action_identity !== actionIdentity
    || parsed.data.installation_id !== authority.installation_id
    || parsed.data.profile !== authority.profile
    || parsed.data.loop_id !== authority.loop_id) {
    throw new Error("INSTALLED_LOOP_AUTHORITY_MISMATCH");
  }
  assertAuthority(parsed.data.before, authority);
  assertAuthority(parsed.data.intended_after, authority);
  return parsed.data;
}

async function writeIntent(root: string, authority: InstalledLoopAuthority, intent: LoopIntent): Promise<LoopIntent> {
  const file = paths(root, authority.loop_id, intent.action_identity).intent!;
  await assertSafeContinuationStoragePath(root, file, "file", "INSTALLED_LOOP_STATE_UNAVAILABLE");
  await writeJsonAtomic(file, IntentSchema.parse(intent));
  const readback = await readIntent(root, authority, intent.action_identity);
  if (!readback || canonicalJson(readback) !== canonicalJson(intent)) throw new Error("INSTALLED_LOOP_STATE_UNAVAILABLE");
  return readback;
}

async function writeDurableState(root: string, authority: InstalledLoopAuthority, state: DurableState): Promise<DurableState> {
  const file = paths(root, authority.loop_id).state;
  await assertSafeContinuationStoragePath(root, file, "file", "INSTALLED_LOOP_STATE_UNAVAILABLE");
  await writeJsonAtomic(file, DurableStateSchema.parse(state));
  const readback = await readDurableState(root, authority, state.updated_at);
  if (!sameProtectedState(readback, state)) throw new Error("INSTALLED_LOOP_STATE_UNAVAILABLE");
  return readback;
}

async function writeHistory(root: string, authority: InstalledLoopAuthority, history: LoopHistory): Promise<void> {
  const file = path.join(paths(root, authority.loop_id).loopHistory, `${history.history_id}.json`);
  await assertSafeContinuationStoragePath(root, file, "file", "INSTALLED_LOOP_STATE_UNAVAILABLE");
  const bytes = `${canonicalJson(HistorySchema.parse(history))}\n`;
  let existing: string | undefined;
  try {
    existing = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (existing !== undefined) {
    if (existing !== bytes) throw new Error("INSTALLED_LOOP_HISTORY_CONFLICT");
    return;
  }
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await assertSafeContinuationStoragePath(root, temporary, "file", "INSTALLED_LOOP_STATE_UNAVAILABLE");
  await fs.writeFile(temporary, bytes, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
  if (await fs.readFile(file, "utf8") !== bytes) throw new Error("INSTALLED_LOOP_STATE_UNAVAILABLE");
}

async function finalizeIntent(
  root: string,
  authority: InstalledLoopAuthority,
  intent: LoopIntent,
  at: string,
): Promise<void> {
  const historyBody = {
    schema_version: 1 as const,
    action_identity: intent.action_identity,
    installation_id: authority.installation_id,
    profile: authority.profile,
    loop_id: authority.loop_id,
    before: intent.before,
    after: intent.intended_after,
    recorded_at: intent.intended_at,
  };
  const historyId = sha256(historyBody);
  await writeHistory(root, authority, { ...historyBody, history_id: historyId });
  await writeIntent(root, authority, {
    ...intent,
    state: "finalized",
    mutation_attempted: true,
    finalized_at: at,
    history_id: historyId,
  });
}

const InstalledLoopPauseSelectorSchema = z.object({
  profile: z.string().regex(SAFE_REF),
  loop_id: z.string().regex(SAFE_REF),
}).strict();

export function installedLoopPauseStatePath(root: string, loopId: string): string {
  return paths(root, z.string().regex(SAFE_REF).parse(loopId)).state;
}

export function installedLoopPauseFromValue(
  raw: unknown,
  rawSelector: { profile: string; loop_id: string },
): InstalledLoopPauseRead {
  const selector = InstalledLoopPauseSelectorSchema.parse(rawSelector);
  if (raw === undefined) return { ...selector, paused: false };
  const parsed = DurableStateSchema.safeParse(raw);
  if (!parsed.success || parsed.data.profile !== selector.profile || parsed.data.loop_id !== selector.loop_id) {
    throw new Error("INSTALLED_LOOP_AUTHORITY_MISMATCH");
  }
  assertAuthority(parsed.data, {
    installation_id: parsed.data.installation_id,
    profile: selector.profile,
    loop_id: selector.loop_id,
  });
  return { ...selector, paused: parsed.data.paused };
}

export const readInstalledLoopPause: InstalledLoopPauseReader = async (root, rawSelector) => {
  const selector = InstalledLoopPauseSelectorSchema.parse(rawSelector);
  const file = installedLoopPauseStatePath(root, selector.loop_id);
  await assertSafeContinuationStoragePath(root, file, "file", "INSTALLED_LOOP_STATE_UNAVAILABLE");
  return installedLoopPauseFromValue(await readJsonIfExists<unknown>(file), selector);
};

export async function readInstalledLoopState(
  root: string,
  rawAuthority: InstalledLoopAuthority,
  deps: InstalledLoopStateDeps = {},
): Promise<InstalledLoopState> {
  const authority = AuthoritySchema.parse(rawAuthority);
  const at = (deps.now ?? (() => new Date().toISOString()))();
  return publicState(await readDurableState(root, authority, at), at);
}

export function installedLoopAdapter(
  root: string,
  rawAuthority: InstalledLoopAuthority,
  deps: InstalledLoopStateDeps = {},
): InstalledLoopAdapter {
  const authority = AuthoritySchema.parse(rawAuthority);
  const clock = deps.now ?? (() => new Date().toISOString());
  return {
    async read(loopId) {
      if (loopId !== authority.loop_id) return undefined;
      return readInstalledLoopState(root, authority, deps);
    },
    async setPaused(loopId, paused, actionIdentity, restoreTarget) {
      if (loopId !== authority.loop_id || !ACTION_ID.test(actionIdentity)) {
        throw new Error("INSTALLED_LOOP_AUTHORITY_MISMATCH");
      }
      const leaseKey = `installed-loop-${sha256(`${authority.profile}:${authority.loop_id}`).slice(0, 40)}`;
      await withCoordinationLease(root, leaseKey, async () => {
        await ensureStorage(root, authority.loop_id);
        const at = clock();
        const existing = await readIntent(root, authority, actionIdentity);
        if (existing) {
          if (existing.intended_after.paused !== paused
            || (restoreTarget && (existing.intended_after.state_version !== restoreTarget.state_version
              || existing.intended_after.protected_state_digest !== restoreTarget.protected_state_digest))) {
            throw new Error("INSTALLED_LOOP_ACTION_CONFLICT");
          }
          const live = await readDurableState(root, authority, at);
          if (sameProtectedState(live, existing.intended_after)) {
            if (existing.state !== "finalized") await finalizeIntent(root, authority, existing, at);
            return;
          }
          if (!sameProtectedState(live, existing.before)) throw new Error("INSTALLED_LOOP_STATE_MISMATCH");
        }

        const before = existing?.before ?? await readDurableState(root, authority, at);
        if (!existing && before.paused === paused && !restoreTarget) return;
        const intendedAfter = existing?.intended_after ?? (restoreTarget
          ? durableRestoreTarget(authority, restoreTarget, at)
          : (() => {
              const stateVersion = `state-${sha256({
                previous_state_version: before.state_version,
                paused,
                action_identity: actionIdentity,
              }).slice(0, 48)}`;
              return {
                schema_version: 1 as const,
                installation_id: authority.installation_id,
                profile: authority.profile,
                loop_id: authority.loop_id,
                paused,
                state_version: stateVersion,
                protected_state_digest: protectedDigest(authority, { paused, state_version: stateVersion }),
                updated_at: at,
              };
            })());
        let intent = existing ?? await writeIntent(root, authority, {
          schema_version: 1,
          action_identity: actionIdentity,
          installation_id: authority.installation_id,
          profile: authority.profile,
          loop_id: authority.loop_id,
          state: "pending",
          mutation_attempted: false,
          before,
          intended_after: intendedAfter,
          intended_at: at,
        });
        intent = await writeIntent(root, authority, { ...intent, mutation_attempted: true });
        const readback = await writeDurableState(root, authority, intendedAfter);
        if (!sameProtectedState(readback, intendedAfter)) throw new Error("INSTALLED_LOOP_STATE_UNAVAILABLE");
        await finalizeIntent(root, authority, intent, clock());
      }, deps);
    },
  };
}

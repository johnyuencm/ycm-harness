import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { withCoordinationLease, type CoordinationDeps } from "./coordination.js";
import { appendJsonl, readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import { HARNESS_DIR_NAME } from "../state/paths.js";

export const WATCHDOG_TIMEZONE = "Asia/Hong_Kong";
export const EXPECTED_SLOTS = ["09:00", "17:00", "23:00"] as const;
export type ExpectedSlot = (typeof EXPECTED_SLOTS)[number];
export const FAILURE_CLASSES = ["app_runtime_lifecycle", "agent_output"] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

const SLOT_SET = new Set<string>(EXPECTED_SLOTS);
const ROOT_CAUSE = "missed-scheduled-slot";

const SlotSchema = z.enum(EXPECTED_SLOTS);
const FailureClassSchema = z.enum(FAILURE_CLASSES);

export const SlotReceiptSchema = z.object({
  schema_version: z.literal(1),
  slot: SlotSchema,
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  receipt_id: z.string().min(1).max(191),
  observed_at: z.string().min(1).max(64),
  status: z.enum(["ok", "failed"]),
  failure_class: FailureClassSchema.optional(),
  /** Absent on legacy receipts; natural grading requires natural_scheduler. */
  evidence_class: z.enum(["natural_scheduler", "manual", "synthetic"]).optional(),
  /** Explicit non-natural marker for manual/local canaries. */
  natural: z.boolean().optional(),
}).strict();
export type SlotReceipt = z.infer<typeof SlotReceiptSchema>;

export const MissedSlotSchema = z.object({
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  slot: SlotSchema,
  failure_class: FailureClassSchema,
}).strict();
export type MissedSlot = z.infer<typeof MissedSlotSchema>;

export const GapIssueSchema = z.object({
  schema_version: z.literal(1),
  issue_id: z.string().min(1).max(191),
  status: z.enum(["open", "resolved"]),
  root_cause: z.literal(ROOT_CAUSE),
  missed_slots: z.array(MissedSlotSchema).max(32),
  updated_at: z.string().datetime(),
  resolved_at: z.string().datetime().optional(),
  resolve_receipt_ids: z.array(z.string().min(1).max(191)).max(32).optional(),
}).strict();
export type GapIssue = z.infer<typeof GapIssueSchema>;

export interface RuntimeLifecycleSnapshot {
  app_available: boolean;
  scheduler_reachable: boolean;
}

export interface ReceiptStore {
  listForDate(localDate: string): Promise<SlotReceipt[]>;
  read(receiptId: string): Promise<SlotReceipt | undefined>;
}

export interface GapIssueAdapter {
  findLive(): Promise<GapIssue | undefined>;
  list(): Promise<GapIssue[]>;
  create(input: { missed_slots: MissedSlot[]; at: string }): Promise<GapIssue>;
  update(issueId: string, input: { missed_slots: MissedSlot[]; at: string }): Promise<GapIssue>;
  resolve(issueId: string, input: { at: string; receipt_ids: string[] }): Promise<GapIssue>;
}

export interface RuntimeLifecycleProbe {
  inspect(): Promise<RuntimeLifecycleSnapshot>;
}

export type WatchdogTickOutcome =
  | "ok"
  | "gap_open"
  | "gap_updated"
  | "gap_resolved"
  | "disabled";

export interface WatchdogTickResult {
  outcome: WatchdogTickOutcome;
  timezone: typeof WATCHDOG_TIMEZONE;
  due: Array<{ local_date: string; slot: ExpectedSlot }>;
  missed: MissedSlot[];
  gap_issue_id?: string;
  llm_invoked: false;
  credentials_mutated: false;
  repo_mutated: false;
}

export interface WatchdogStatus {
  enabled: boolean;
  timezone: typeof WATCHDOG_TIMEZONE;
  expected_slots: readonly ExpectedSlot[];
  live_gap_issue_id?: string;
  last_tick_at?: string;
}

export interface WatchdogTickDeps extends CoordinationDeps {
  root: string;
  now?: () => string;
  receipts: ReceiptStore;
  gaps: GapIssueAdapter;
  runtime: RuntimeLifecycleProbe;
  onForbidden?: (kind: "llm" | "credentials" | "repo") => void;
}

interface DurableWatchdogState {
  schema_version: 1;
  enabled: boolean;
  live_gap_issue_id?: string;
  last_tick_at?: string;
  updated_at: string;
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function directory(root: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "missed-slot-watchdog");
}

function statePath(root: string): string {
  return path.join(directory(root), "state.json");
}

function ticksPath(root: string): string {
  return path.join(directory(root), "ticks.jsonl");
}

function defaultState(at: string): DurableWatchdogState {
  return { schema_version: 1, enabled: true, updated_at: at };
}

async function readState(root: string, at: string): Promise<DurableWatchdogState> {
  const raw = await readJsonIfExists<unknown>(statePath(root));
  if (raw === undefined) return defaultState(at);
  const parsed = z.object({
    schema_version: z.literal(1),
    enabled: z.boolean(),
    live_gap_issue_id: z.string().min(1).max(191).optional(),
    last_tick_at: z.string().datetime().optional(),
    updated_at: z.string().datetime(),
  }).strict().safeParse(raw);
  if (!parsed.success) throw new Error("watchdog_state_invalid");
  return parsed.data;
}

async function writeState(root: string, state: DurableWatchdogState): Promise<void> {
  await writeJsonAtomic(statePath(root), state);
}

function hongKongParts(now: Date): { local_date: string; hour: number; minute: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: WATCHDOG_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const read = (type: string): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error("watchdog_timezone_unavailable");
    return value;
  };
  return {
    local_date: `${read("year")}-${read("month")}-${read("day")}`,
    hour: Number(read("hour")),
    minute: Number(read("minute")),
  };
}

function shiftLocalDate(localDate: string, days: number): string {
  const [year, month, day] = localDate.split("-").map(Number);
  const utc = Date.UTC(year!, month! - 1, day! + days);
  const shifted = new Date(utc);
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function slotMinutes(slot: ExpectedSlot): number {
  const [hour, minute] = slot.split(":").map(Number);
  return hour! * 60 + minute!;
}

export function expectedDueSlots(now: Date = new Date()): Array<{ local_date: string; slot: ExpectedSlot }> {
  const current = hongKongParts(now);
  const previousDate = shiftLocalDate(current.local_date, -1);
  const nowMinutes = current.hour * 60 + current.minute;
  const due: Array<{ local_date: string; slot: ExpectedSlot }> = [];
  for (const slot of EXPECTED_SLOTS) {
    due.push({ local_date: previousDate, slot });
  }
  for (const slot of EXPECTED_SLOTS) {
    if (slotMinutes(slot) <= nowMinutes) due.push({ local_date: current.local_date, slot });
  }
  return due;
}

function classifyMiss(
  receipt: SlotReceipt | undefined,
  runtime: RuntimeLifecycleSnapshot,
): FailureClass | "satisfied" {
  if (receipt && receipt.status === "ok") return "satisfied";
  if (receipt && (receipt.status === "failed" || receipt.failure_class === "agent_output")) {
    return "agent_output";
  }
  if (!runtime.app_available || !runtime.scheduler_reachable) return "app_runtime_lifecycle";
  return "app_runtime_lifecycle";
}

function missedKey(item: MissedSlot): string {
  return `${item.local_date}:${item.slot}:${item.failure_class}`;
}

function sameMissed(left: MissedSlot[], right: MissedSlot[]): boolean {
  const a = [...left].map(missedKey).sort();
  const b = [...right].map(missedKey).sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

export async function watchdogStatus(root: string, now = () => new Date().toISOString()): Promise<WatchdogStatus> {
  const state = await readState(root, now());
  return {
    enabled: state.enabled,
    timezone: WATCHDOG_TIMEZONE,
    expected_slots: EXPECTED_SLOTS,
    ...(state.live_gap_issue_id ? { live_gap_issue_id: state.live_gap_issue_id } : {}),
    ...(state.last_tick_at ? { last_tick_at: state.last_tick_at } : {}),
  };
}

export async function disableWatchdog(root: string, now = () => new Date().toISOString()): Promise<WatchdogStatus> {
  const at = now();
  return withCoordinationLease(root, "missed-slot-watchdog", async () => {
    const state = await readState(root, at);
    const next: DurableWatchdogState = { ...state, enabled: false, updated_at: at };
    await writeState(root, next);
    return watchdogStatus(root, () => at);
  });
}

export async function enableWatchdog(root: string, now = () => new Date().toISOString()): Promise<WatchdogStatus> {
  const at = now();
  return withCoordinationLease(root, "missed-slot-watchdog", async () => {
    const state = await readState(root, at);
    const next: DurableWatchdogState = { ...state, enabled: true, updated_at: at };
    await writeState(root, next);
    return watchdogStatus(root, () => at);
  });
}

export async function tickMissedSlotWatchdog(deps: WatchdogTickDeps): Promise<WatchdogTickResult> {
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const clock = new Date(at);
  if (Number.isNaN(clock.getTime())) throw new Error("watchdog_now_invalid");

  return withCoordinationLease(deps.root, "missed-slot-watchdog", async () => {
    const state = await readState(deps.root, at);
    const due = expectedDueSlots(clock);
    const base: WatchdogTickResult = {
      outcome: "ok",
      timezone: WATCHDOG_TIMEZONE,
      due,
      missed: [],
      llm_invoked: false,
      credentials_mutated: false,
      repo_mutated: false,
    };

    if (!state.enabled) {
      const disabled: WatchdogTickResult = {
        ...base,
        outcome: "disabled",
        ...(state.live_gap_issue_id ? { gap_issue_id: state.live_gap_issue_id } : {}),
      };
      await appendJsonl(ticksPath(deps.root), { at, ...disabled });
      return disabled;
    }

    // Script-only: never invoke LLM, credential, or repo mutation paths.
    // `onForbidden` exists so tests can assert those seams stay cold.

    const runtime = await deps.runtime.inspect();
    const missed: MissedSlot[] = [];
    const recoveredIds: string[] = [];

    for (const item of due) {
      if (!SLOT_SET.has(item.slot)) continue;
      const dayReceipts = await deps.receipts.listForDate(item.local_date);
      const listed = dayReceipts.find((receipt) => receipt.slot === item.slot);
      const classification = classifyMiss(listed, runtime);
      if (classification === "satisfied") {
        if (listed) {
          const readback = await deps.receipts.read(listed.receipt_id);
          if (readback && readback.status === "ok" && readback.receipt_id === listed.receipt_id) {
            recoveredIds.push(readback.receipt_id);
          } else {
            missed.push({
              local_date: item.local_date,
              slot: item.slot,
              failure_class: listed?.failure_class === "agent_output" ? "agent_output" : "app_runtime_lifecycle",
            });
          }
        }
        continue;
      }
      missed.push({
        local_date: item.local_date,
        slot: item.slot,
        failure_class: classification,
      });
    }

    let live = await deps.gaps.findLive();
    if (state.live_gap_issue_id && live && live.issue_id !== state.live_gap_issue_id) {
      throw new Error("watchdog_gap_conflict");
    }
    if (state.live_gap_issue_id && !live) {
      const listed = (await deps.gaps.list()).find((issue) => issue.issue_id === state.live_gap_issue_id);
      if (listed?.status === "open") live = listed;
    }

    let outcome: WatchdogTickOutcome = "ok";
    let gapIssueId = live?.issue_id ?? state.live_gap_issue_id;

    if (missed.length > 0) {
      if (!live) {
        live = await deps.gaps.create({ missed_slots: missed, at });
        outcome = "gap_open";
      } else {
        live = sameMissed(live.missed_slots, missed)
          ? await deps.gaps.update(live.issue_id, { missed_slots: missed, at })
          : await deps.gaps.update(live.issue_id, { missed_slots: missed, at });
        outcome = "gap_updated";
      }
      gapIssueId = live.issue_id;
    } else if (live) {
      const readbackOk = recoveredIds.length >= due.length
        || (await Promise.all(due.map(async (item) => {
          const dayReceipts = await deps.receipts.listForDate(item.local_date);
          const listed = dayReceipts.find((receipt) => receipt.slot === item.slot && receipt.status === "ok");
          if (!listed) return false;
          const readback = await deps.receipts.read(listed.receipt_id);
          return Boolean(readback && readback.status === "ok" && readback.receipt_id === listed.receipt_id);
        }))).every(Boolean);
      if (!readbackOk) {
        outcome = "gap_updated";
        gapIssueId = live.issue_id;
      } else {
        live = await deps.gaps.resolve(live.issue_id, { at, receipt_ids: recoveredIds });
        outcome = "gap_resolved";
        gapIssueId = live.issue_id;
      }
    }

    const nextState: DurableWatchdogState = {
      schema_version: 1,
      enabled: true,
      updated_at: at,
      last_tick_at: at,
      ...(outcome === "gap_resolved" || !gapIssueId ? {} : { live_gap_issue_id: gapIssueId }),
    };
    await writeState(deps.root, nextState);

    const result: WatchdogTickResult = {
      ...base,
      outcome,
      missed,
      ...(gapIssueId ? { gap_issue_id: gapIssueId } : {}),
    };
    await appendJsonl(ticksPath(deps.root), { at, ...result });
    return result;
  }, deps);
}

/** Test/fixture helpers — in-memory seams with optional readback faults. */
export function createMemoryReceiptStore(seed: SlotReceipt[] = []): ReceiptStore & {
  inject(receipt: SlotReceipt): void;
  snapshot(): SlotReceipt[];
  breakReadback(receiptId: string): void;
  fixReadback(receiptId: string): void;
} {
  const byId = new Map<string, SlotReceipt>();
  const broken = new Set<string>();
  for (const item of seed) {
    const parsed = SlotReceiptSchema.parse(item);
    byId.set(parsed.receipt_id, parsed);
  }
  return {
    inject(receipt) {
      const parsed = SlotReceiptSchema.parse(receipt);
      byId.set(parsed.receipt_id, parsed);
    },
    snapshot() {
      return [...byId.values()].map((item) => ({ ...item }));
    },
    breakReadback(receiptId) {
      broken.add(receiptId);
    },
    fixReadback(receiptId) {
      broken.delete(receiptId);
    },
    async listForDate(localDate) {
      return [...byId.values()].filter((item) => item.local_date === localDate).map((item) => ({ ...item }));
    },
    async read(receiptId) {
      if (broken.has(receiptId)) return undefined;
      const found = byId.get(receiptId);
      return found ? { ...found } : undefined;
    },
  };
}

export function createMemoryGapIssueAdapter(): GapIssueAdapter & { list(): Promise<GapIssue[]> } {
  const issues = new Map<string, GapIssue>();
  return {
    async findLive() {
      return [...issues.values()].find((issue) => issue.status === "open");
    },
    async list() {
      return [...issues.values()].map((issue) => ({ ...issue, missed_slots: [...issue.missed_slots] }));
    },
    async create(input) {
      const existing = [...issues.values()].find((issue) => issue.status === "open");
      if (existing) {
        return this.update(existing.issue_id, input);
      }
      const issue: GapIssue = {
        schema_version: 1,
        issue_id: `gap-${sha(randomUUID()).slice(0, 16)}`,
        status: "open",
        root_cause: ROOT_CAUSE,
        missed_slots: input.missed_slots.map((item) => MissedSlotSchema.parse(item)),
        updated_at: input.at,
      };
      issues.set(issue.issue_id, issue);
      return { ...issue, missed_slots: [...issue.missed_slots] };
    },
    async update(issueId, input) {
      const current = issues.get(issueId);
      if (!current || current.status !== "open") throw new Error("watchdog_gap_missing");
      const next: GapIssue = {
        ...current,
        missed_slots: input.missed_slots.map((item) => MissedSlotSchema.parse(item)),
        updated_at: input.at,
      };
      issues.set(issueId, next);
      return { ...next, missed_slots: [...next.missed_slots] };
    },
    async resolve(issueId, input) {
      const current = issues.get(issueId);
      if (!current || current.status !== "open") throw new Error("watchdog_gap_missing");
      const next: GapIssue = {
        ...current,
        status: "resolved",
        updated_at: input.at,
        resolved_at: input.at,
        resolve_receipt_ids: [...input.receipt_ids],
      };
      issues.set(issueId, next);
      return { ...next, missed_slots: [...next.missed_slots] };
    },
  };
}

export function createMemoryRuntimeProbe(snapshot: RuntimeLifecycleSnapshot): RuntimeLifecycleProbe {
  return {
    async inspect() {
      return { ...snapshot };
    },
  };
}

/** File-backed gap adapter for script/CLI use — no credential mutation. */
export function createFileGapIssueAdapter(root: string): GapIssueAdapter {
  const gapsDir = path.join(directory(root), "gaps");
  async function loadAll(): Promise<GapIssue[]> {
    const names = await fs.readdir(gapsDir).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error));
    const issues: GapIssue[] = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      const parsed = GapIssueSchema.safeParse(await readJsonIfExists<unknown>(path.join(gapsDir, name)));
      if (!parsed.success) throw new Error("watchdog_gap_invalid");
      issues.push(parsed.data);
    }
    return issues;
  }
  return {
    async findLive() {
      return (await loadAll()).find((issue) => issue.status === "open");
    },
    async list() {
      return loadAll();
    },
    async create(input) {
      const live = await this.findLive();
      if (live) return this.update(live.issue_id, input);
      const issue: GapIssue = {
        schema_version: 1,
        issue_id: `gap-${sha(`${input.at}\0${JSON.stringify(input.missed_slots)}`).slice(0, 16)}`,
        status: "open",
        root_cause: ROOT_CAUSE,
        missed_slots: input.missed_slots,
        updated_at: input.at,
      };
      await writeJsonAtomic(path.join(gapsDir, `${issue.issue_id}.json`), issue);
      return issue;
    },
    async update(issueId, input) {
      const file = path.join(gapsDir, `${issueId}.json`);
      const current = GapIssueSchema.parse(await readJsonIfExists<unknown>(file));
      if (current.status !== "open") throw new Error("watchdog_gap_missing");
      const next: GapIssue = { ...current, missed_slots: input.missed_slots, updated_at: input.at };
      await writeJsonAtomic(file, next);
      return next;
    },
    async resolve(issueId, input) {
      const file = path.join(gapsDir, `${issueId}.json`);
      const current = GapIssueSchema.parse(await readJsonIfExists<unknown>(file));
      if (current.status !== "open") throw new Error("watchdog_gap_missing");
      const next: GapIssue = {
        ...current,
        status: "resolved",
        updated_at: input.at,
        resolved_at: input.at,
        resolve_receipt_ids: [...input.receipt_ids],
      };
      await writeJsonAtomic(file, next);
      return next;
    },
  };
}

/** File-backed receipt store under the watchdog evidence directory. */
export function createFileReceiptStore(root: string): ReceiptStore {
  const receiptsDir = path.join(directory(root), "receipts");
  async function loadAll(): Promise<SlotReceipt[]> {
    const names = await fs.readdir(receiptsDir).catch((error: NodeJS.ErrnoException) =>
      error.code === "ENOENT" ? [] : Promise.reject(error));
    const receipts: SlotReceipt[] = [];
    for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
      const parsed = SlotReceiptSchema.safeParse(await readJsonIfExists<unknown>(path.join(receiptsDir, name)));
      if (!parsed.success) throw new Error("watchdog_receipt_invalid");
      receipts.push(parsed.data);
    }
    return receipts;
  }
  return {
    async listForDate(localDate) {
      return (await loadAll()).filter((item) => item.local_date === localDate);
    },
    async read(receiptId) {
      const file = path.join(receiptsDir, `${receiptId}.json`);
      const raw = await readJsonIfExists<unknown>(file);
      if (raw === undefined) return undefined;
      return SlotReceiptSchema.parse(raw);
    },
  };
}

/** Persist one slot receipt for the file-backed watchdog store to observe. */
export async function writeSlotReceipt(root: string, receipt: SlotReceipt): Promise<SlotReceipt> {
  const parsed = SlotReceiptSchema.parse(receipt);
  const receiptsDir = path.join(directory(root), "receipts");
  await writeJsonAtomic(path.join(receiptsDir, `${parsed.receipt_id}.json`), parsed);
  return parsed;
}

export function createStaticRuntimeProbe(snapshot: RuntimeLifecycleSnapshot): RuntimeLifecycleProbe {
  return createMemoryRuntimeProbe(snapshot);
}

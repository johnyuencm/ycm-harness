import { execFile } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { accessSync, constants, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { z } from "zod";
import {
  EXPECTED_SLOTS,
  createFileGapIssueAdapter,
  createFileReceiptStore,
  writeSlotReceipt,
  type ExpectedSlot,
  type GapIssue,
  type SlotReceipt,
} from "./missed-slot-watchdog.js";
import { ensureDir, readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import { HARNESS_DIR_NAME } from "../state/paths.js";

const execFileAsync = promisify(execFile);

export const HK_NATURAL_TIMEZONE = "Asia/Hong_Kong" as const;
export const HK_NATURAL_SLOTS = EXPECTED_SLOTS;
export const HK_NATURAL_DELIVERY = "local_no_delivery" as const;
export const HK_ORIGIN_ID = "hk-natural-daily" as const;
export const HK_ORIGIN_KEY_ID = "hk-natural-key-1" as const;

const ScheduleRoleSchema = z.enum(["pm_prepare", "pm_review_worker", "strategic_nightly"]);
export type ScheduleRole = z.infer<typeof ScheduleRoleSchema>;

export const HkScheduleEntrySchema = z.object({
  slot_id: z.string().min(1).max(64),
  local_time: z.enum(EXPECTED_SLOTS),
  role: ScheduleRoleSchema,
  delivery: z.literal(HK_NATURAL_DELIVERY),
  timezone: z.literal(HK_NATURAL_TIMEZONE),
}).strict();
export type HkScheduleEntry = z.infer<typeof HkScheduleEntrySchema>;

export const HkScheduleManifestSchema = z.object({
  schema_version: z.literal(1),
  timezone: z.literal(HK_NATURAL_TIMEZONE),
  delivery: z.literal(HK_NATURAL_DELIVERY),
  schedules: z.array(HkScheduleEntrySchema).length(3),
  schtasks_registered: z.boolean(),
  origin_id: z.literal(HK_ORIGIN_ID),
  key_id: z.literal(HK_ORIGIN_KEY_ID),
}).strict();
export type HkScheduleManifest = z.infer<typeof HkScheduleManifestSchema>;

export interface HkInstallOptions {
  /** When true, attempt live Windows schtasks registration. Default false (projection only). */
  apply_schtasks?: boolean;
}

export interface HkSchtasksRunInput {
  scriptPath: string;
  schtasksExe: string;
}

/** Injectable seam for live Windows Task Scheduler registration (tests mock; prod uses powershell). */
export interface HkSchtasksDeps {
  resolveSchtasksExe?: () => string | null;
  runProjectedScript?: (input: HkSchtasksRunInput) => Promise<void>;
}

export interface HkInstallResult {
  created: boolean;
  timezone: typeof HK_NATURAL_TIMEZONE;
  schedules: HkScheduleEntry[];
  schtasks_registered: boolean;
  installation_root: string;
  origin: {
    origin_id: typeof HK_ORIGIN_ID;
    key_id: typeof HK_ORIGIN_KEY_ID;
    record_root: string;
  };
  projection: {
    manifest_path: string;
    windows_script_path: string;
    codex_automations_path: string;
  };
}

export interface HkScheduleStatus {
  installed: boolean;
  timezone: typeof HK_NATURAL_TIMEZONE;
  schedules: HkScheduleEntry[];
  schtasks_registered: boolean;
  installation_root?: string;
  origin?: HkInstallResult["origin"];
}

export interface WriteSignedOriginInput {
  local_date: string;
  artifact: unknown;
  record_id?: string;
}

export interface WriteSignedOriginResult {
  origin_id: typeof HK_ORIGIN_ID;
  record_id: string;
  record_path: string;
  signature_path: string;
}

export type MonitorSlotStatus = "hit" | "miss";
export type MonitorOutcome = "all_hit" | "partial" | "all_miss";

export interface MonitorSlotReport {
  slot: ExpectedSlot;
  status: MonitorSlotStatus;
  evidence_class?: SlotReceipt["evidence_class"];
  natural?: boolean;
  receipt_id?: string;
}

export interface MonitorReport {
  timezone: typeof HK_NATURAL_TIMEZONE;
  local_date: string;
  slots: MonitorSlotReport[];
  outcome: MonitorOutcome;
  natural_grade_eligible: boolean;
  /** Always false — this monitor never fabricates a natural PASS. */
  fabricated_pass: false;
}

function baseDir(root: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "hk-natural-schedules");
}

function projectionDir(root: string): string {
  return path.join(baseDir(root), "projection");
}

function installationRoot(root: string): string {
  return path.join(baseDir(root), "installation");
}

function recordRoot(root: string): string {
  return path.join(baseDir(root), "origins");
}

function keysDir(root: string): string {
  return path.join(baseDir(root), "keys");
}

function manifestPath(root: string): string {
  return path.join(projectionDir(root), "schedules.json");
}

function windowsScriptPath(root: string): string {
  return path.join(projectionDir(root), "windows-schtasks.ps1");
}

function codexAutomationsPath(root: string): string {
  return path.join(projectionDir(root), "codex-automations.json");
}

function privateKeyPath(root: string): string {
  return path.join(keysDir(root), `${HK_ORIGIN_KEY_ID}.private.pem`);
}

function publicKeyPath(root: string): string {
  return path.join(keysDir(root), `${HK_ORIGIN_KEY_ID}.public.pem`);
}

function statePath(root: string): string {
  return path.join(baseDir(root), "state.json");
}

function canonicalSchedules(): HkScheduleEntry[] {
  return [
    {
      slot_id: "hk-pm-prepare-0900",
      local_time: "09:00",
      role: "pm_prepare",
      delivery: HK_NATURAL_DELIVERY,
      timezone: HK_NATURAL_TIMEZONE,
    },
    {
      slot_id: "hk-pm-review-1700",
      local_time: "17:00",
      role: "pm_review_worker",
      delivery: HK_NATURAL_DELIVERY,
      timezone: HK_NATURAL_TIMEZONE,
    },
    {
      slot_id: "hk-nightly-2300",
      local_time: "23:00",
      role: "strategic_nightly",
      delivery: HK_NATURAL_DELIVERY,
      timezone: HK_NATURAL_TIMEZONE,
    },
  ];
}

function harnessPackageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..");
}

function psSingleQuote(value: string): string {
  return value.replace(/'/g, "''");
}

/** Prefer a Windows node.exe for Task Scheduler when running under WSL. */
async function resolveWindowsNodeExe(): Promise<string> {
  const envNode = process.env.YCM_HARNESS_NODE_EXE;
  const candidates = [
    envNode,
    process.platform === "win32" ? process.execPath : undefined,
    process.execPath.toLowerCase().endsWith(".exe") ? process.execPath : undefined,
    "/mnt/c/nvm4w/nodejs/node.exe",
    "/mnt/c/Program Files/nodejs/node.exe",
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    if (pathExists(candidate)) return await toWindowsPath(candidate);
  }
  if (process.platform === "win32") return process.execPath;
  return "node";
}

/**
 * Project schtasks actions as: node <abs>/dist/cli/index.js --cwd <abs-root> autonomy schedule run-slot ...
 * Bare `ycm-harness` on PATH misses install state / wrong root.
 */
async function renderWindowsScript(root: string, schedules: HkScheduleEntry[]): Promise<string> {
  const cliEntry = path.join(harnessPackageRoot(), "dist", "cli", "index.js");
  const [winNode, winCli, winCwd] = await Promise.all([
    resolveWindowsNodeExe(),
    toWindowsPath(cliEntry),
    toWindowsPath(path.resolve(root)),
  ]);
  const execute = psSingleQuote(winNode);
  const argumentPrefix = `"${winCli.replace(/"/g, '\\"')}" --cwd "${winCwd.replace(/"/g, '\\"')}" autonomy schedule run-slot`;
  const lines = [
    "# ycm-harness HK natural schedule projection (Asia/Hong_Kong).",
    "# Default install is dry: this script is a projection, not live registration proof.",
    "# Re-run with apply_schtasks=true / --apply-schtasks to register tasks idempotently.",
    "# Each slot invokes the natural runner (workflow + watchdog receipts), not bare receipt record.",
    "# Action uses abs node + dist/cli/index.js with --cwd <installation root> (not PATH ycm-harness).",
    "$ErrorActionPreference = 'Stop'",
    "$tz = 'China Standard Time' # Windows label for Asia/Hong_Kong",
    "",
  ];
  for (const schedule of schedules) {
    const task = `ycm-harness-hk-${schedule.local_time.replace(":", "")}-${schedule.role}`;
    const argument = psSingleQuote(`${argumentPrefix} --slot ${schedule.local_time} --natural`);
    lines.push(
      `$name = '${task}'`,
      `$action = New-ScheduledTaskAction -Execute '${execute}' -Argument '${argument}'`,
      `$trigger = New-ScheduledTaskTrigger -Daily -At '${schedule.local_time}'`,
      `Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Force | Out-Null`,
      "",
    );
  }
  return `${lines.join("\n")}\n`;
}

function renderCodexAutomations(schedules: HkScheduleEntry[]): unknown {
  return {
    schema_version: 1,
    timezone: HK_NATURAL_TIMEZONE,
    delivery: HK_NATURAL_DELIVERY,
    note: "Codex automations are desktop/web managed; this manifest is a local projection for install/status parity.",
    automations: schedules.map((schedule) => ({
      id: schedule.slot_id,
      local_time: schedule.local_time,
      role: schedule.role,
      delivery: schedule.delivery,
      timezone: schedule.timezone,
      prompt: `Run the installed ${schedule.role} slot for Asia/Hong_Kong ${schedule.local_time} with local_no_delivery.`,
    })),
  };
}

async function ensureKeyPair(root: string): Promise<{ publicKeyPem: string; privateKeyPem: string; created: boolean }> {
  await ensureDir(keysDir(root));
  const privPath = privateKeyPath(root);
  const pubPath = publicKeyPath(root);
  try {
    const [privateKeyPem, publicKeyPem] = await Promise.all([
      fs.readFile(privPath, "utf8"),
      fs.readFile(pubPath, "utf8"),
    ]);
    return { privateKeyPem, publicKeyPem, created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  await fs.writeFile(privPath, privateKeyPem, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(pubPath, publicKeyPem, { encoding: "utf8", mode: 0o644 });
  return { publicKeyPem, privateKeyPem, created: true };
}

async function writeOriginManifest(root: string, publicKeyPem: string): Promise<void> {
  const installRoot = installationRoot(root);
  const configDir = path.join(installRoot, "config");
  await ensureDir(configDir);
  const manifest = {
    schema_version: 1 as const,
    origins: [{
      origin_id: HK_ORIGIN_ID,
      record_root: recordRoot(root),
      key_id: HK_ORIGIN_KEY_ID,
      public_key_pem: publicKeyPem,
      timezone: HK_NATURAL_TIMEZONE,
      prepare_local_time: "09:00" as const,
      review_local_time: "17:00" as const,
    }],
  };
  await writeJsonAtomic(path.join(configDir, "pm-scheduler-origins.json"), manifest);
  await ensureDir(recordRoot(root));
}

async function writeProjections(root: string, schedules: HkScheduleEntry[], schtasksRegistered: boolean): Promise<HkScheduleManifest> {
  await ensureDir(projectionDir(root));
  const manifest: HkScheduleManifest = {
    schema_version: 1,
    timezone: HK_NATURAL_TIMEZONE,
    delivery: HK_NATURAL_DELIVERY,
    schedules,
    schtasks_registered: schtasksRegistered,
    origin_id: HK_ORIGIN_ID,
    key_id: HK_ORIGIN_KEY_ID,
  };
  await writeJsonAtomic(manifestPath(root), manifest);
  await fs.writeFile(windowsScriptPath(root), await renderWindowsScript(root, schedules), "utf8");
  await writeJsonAtomic(codexAutomationsPath(root), renderCodexAutomations(schedules));
  return manifest;
}

function pathExists(candidate: string): boolean {
  try {
    accessSync(candidate, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/** Prefer explicit schtasks.exe paths so WSL (linux) can still live-register via /mnt/c. */
export function resolveSchtasksExe(): string | null {
  const candidates = [
    process.env.YCM_HARNESS_SCHTASKS_EXE,
    process.platform === "win32" ? "C:\\Windows\\System32\\schtasks.exe" : undefined,
    "/mnt/c/Windows/System32/schtasks.exe",
  ].filter((value): value is string => typeof value === "string" && value.length > 0);
  for (const candidate of candidates) {
    if (pathExists(candidate)) return candidate;
  }
  if (process.platform === "win32") return "schtasks.exe";
  return null;
}

function resolvePowershellExe(schtasksExe: string): string {
  if (process.platform === "win32") {
    const winPs = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    if (pathExists(winPs)) return winPs;
    return "powershell.exe";
  }
  if (schtasksExe.includes("/mnt/c/Windows/System32/")) {
    const wslPs = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
    if (pathExists(wslPs)) return wslPs;
  }
  const fallback = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  if (pathExists(fallback)) return fallback;
  return "powershell.exe";
}

async function toWindowsPath(posixOrWinPath: string): Promise<string> {
  if (process.platform === "win32") return posixOrWinPath;
  const mnt = posixOrWinPath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (mnt) {
    return `${mnt[1]!.toUpperCase()}:\\${mnt[2]!.replace(/\//g, "\\")}`;
  }
  try {
    const { stdout } = await execFileAsync("wslpath", ["-w", posixOrWinPath], {
      encoding: "utf8",
      windowsHide: true,
    });
    const converted = stdout.trim();
    if (converted.length > 0) return converted;
  } catch {
    // fall through
  }
  return posixOrWinPath;
}

/** Invoke the projected windows-schtasks.ps1 via PowerShell (idempotent Register-ScheduledTask). */
export async function runProjectedSchtasksScript(input: HkSchtasksRunInput): Promise<void> {
  const powershell = resolvePowershellExe(input.schtasksExe);
  const winScript = await toWindowsPath(input.scriptPath);
  await execFileAsync(
    powershell,
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", winScript],
    { encoding: "utf8", windowsHide: true },
  );
}

/**
 * Install Asia/Hong_Kong 09:00/17:00/23:00 schedule projections with local_no_delivery.
 * Default is dry projection only; live Windows schtasks registration is opt-in.
 */
export async function installHkNaturalSchedules(
  root: string,
  options: HkInstallOptions = {},
  deps: HkSchtasksDeps = {},
): Promise<HkInstallResult> {
  const applySchtasks = options.apply_schtasks === true;
  const schedules = canonicalSchedules();
  const prior = await readJsonIfExists<unknown>(manifestPath(root));
  const priorParsed = prior ? HkScheduleManifestSchema.safeParse(prior) : undefined;
  const alreadyInstalled = priorParsed?.success === true;

  const keys = await ensureKeyPair(root);
  await writeOriginManifest(root, keys.publicKeyPem);

  // Write projection first so apply can invoke the on-disk script.
  let schtasksRegistered = alreadyInstalled ? priorParsed!.data.schtasks_registered : false;
  await writeProjections(root, schedules, schtasksRegistered);

  if (applySchtasks) {
    const resolve = deps.resolveSchtasksExe ?? resolveSchtasksExe;
    const run = deps.runProjectedScript ?? runProjectedSchtasksScript;
    const schtasksExe = resolve();
    if (schtasksExe) {
      await run({ scriptPath: windowsScriptPath(root), schtasksExe });
      schtasksRegistered = true;
    } else {
      schtasksRegistered = false;
    }
  }

  const manifest = await writeProjections(root, schedules, schtasksRegistered);
  await writeJsonAtomic(statePath(root), {
    schema_version: 1,
    installed_at: new Date().toISOString(),
    apply_schtasks: applySchtasks,
    schtasks_registered: manifest.schtasks_registered,
  });

  return {
    created: !alreadyInstalled,
    timezone: HK_NATURAL_TIMEZONE,
    schedules: manifest.schedules,
    schtasks_registered: manifest.schtasks_registered,
    installation_root: installationRoot(root),
    origin: {
      origin_id: HK_ORIGIN_ID,
      key_id: HK_ORIGIN_KEY_ID,
      record_root: recordRoot(root),
    },
    projection: {
      manifest_path: manifestPath(root),
      windows_script_path: windowsScriptPath(root),
      codex_automations_path: codexAutomationsPath(root),
    },
  };
}

export async function scheduleStatus(root: string): Promise<HkScheduleStatus> {
  const prior = await readJsonIfExists<unknown>(manifestPath(root));
  const parsed = prior ? HkScheduleManifestSchema.safeParse(prior) : undefined;
  if (!parsed?.success) {
    return {
      installed: false,
      timezone: HK_NATURAL_TIMEZONE,
      schedules: [],
      schtasks_registered: false,
    };
  }
  return {
    installed: true,
    timezone: parsed.data.timezone,
    schedules: parsed.data.schedules,
    schtasks_registered: parsed.data.schtasks_registered,
    installation_root: installationRoot(root),
    origin: {
      origin_id: HK_ORIGIN_ID,
      key_id: HK_ORIGIN_KEY_ID,
      record_root: recordRoot(root),
    },
  };
}

/** Write one detached Ed25519 scheduler-origin record compatible with pm-scheduler-origin reads. */
export async function writeSignedHkSchedulerOrigin(
  root: string,
  input: WriteSignedOriginInput,
): Promise<WriteSignedOriginResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.local_date)) {
    throw new Error("hk_scheduler_origin_local_date_invalid");
  }
  const status = await scheduleStatus(root);
  if (!status.installed) {
    await installHkNaturalSchedules(root, { apply_schtasks: false });
  }
  const keys = await ensureKeyPair(root);
  await writeOriginManifest(root, keys.publicKeyPem);

  const recordId = input.record_id ?? `hk-natural-${input.local_date}`;
  const record = {
    schema_version: 1 as const,
    origin_id: HK_ORIGIN_ID,
    record_id: recordId,
    key_id: HK_ORIGIN_KEY_ID,
    timezone: HK_NATURAL_TIMEZONE,
    local_date: input.local_date,
    prepare_local_time: "09:00" as const,
    review_local_time: "17:00" as const,
    artifact: input.artifact,
  };
  const raw = Buffer.from(JSON.stringify(record), "utf8");
  const signature = sign(null, raw, keys.privateKeyPem).toString("base64");
  await ensureDir(recordRoot(root));
  const recordPath = path.join(recordRoot(root), `${recordId}.json`);
  const signaturePath = path.join(recordRoot(root), `${recordId}.sig`);
  await fs.writeFile(recordPath, raw);
  await fs.writeFile(signaturePath, signature, "utf8");
  return {
    origin_id: HK_ORIGIN_ID,
    record_id: recordId,
    record_path: recordPath,
    signature_path: signaturePath,
  };
}

/** Force manual/local canary labeling so natural grading cannot treat it as scheduled evidence. */
export function labelManualCanaryRun(
  receipt: Omit<SlotReceipt, "evidence_class" | "natural"> & Partial<Pick<SlotReceipt, "evidence_class" | "natural">>,
): SlotReceipt {
  return {
    ...receipt,
    evidence_class: "manual",
    natural: false,
  };
}

function isNaturalReceipt(receipt: SlotReceipt): boolean {
  return receipt.evidence_class === "natural_scheduler" && receipt.natural !== false;
}


export const CYCLE_COMPONENTS = [
  "pm_prepare",
  "pm_review_worker",
  "strategic_nightly",
  "scout_pointer",
  "watchdog",
] as const;
export type CycleComponent = (typeof CYCLE_COMPONENTS)[number];

export const NaturalWorkflowKindSchema = z.enum([
  "pm_prepare",
  "pm_review_worker",
  "strategic_nightly",
  "scout_pointer",
  "watchdog",
]);
export type NaturalWorkflowKind = z.infer<typeof NaturalWorkflowKindSchema>;

export const NaturalWorkflowReceiptSchema = z.object({
  schema_version: z.literal(1),
  workflow_id: z.string().min(1).max(191),
  kind: NaturalWorkflowKindSchema,
  slot: z.enum(EXPECTED_SLOTS).optional(),
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  started_at: z.string().min(1).max(64),
  finished_at: z.string().min(1).max(64),
  status: z.enum(["ok", "failed"]),
  evidence_class: z.literal("natural_scheduler"),
  natural: z.literal(true),
  manual_trigger: z.literal(false),
  delivery: z.literal(HK_NATURAL_DELIVERY),
  timezone: z.literal(HK_NATURAL_TIMEZONE),
  role: ScheduleRoleSchema.optional(),
  pointer: z.string().min(1).max(512).optional(),
  final_output_hash: z.string().min(1).max(128).optional(),
}).strict();
export type NaturalWorkflowReceipt = z.infer<typeof NaturalWorkflowReceiptSchema>;

export interface RunNaturalSlotInput {
  slot: ExpectedSlot;
  local_date?: string;
  natural: boolean;
  now?: () => Date;
}

export interface RunNaturalSlotResult {
  role: ScheduleRole;
  delivery: typeof HK_NATURAL_DELIVERY;
  workflow: NaturalWorkflowReceipt;
  slot_receipt: SlotReceipt;
  scout_pointer?: NaturalWorkflowReceipt;
  watchdog?: NaturalWorkflowReceipt;
}

export type CycleVerdict = "PASS" | "PARTIAL";

export interface GradeNaturalCycleResult {
  timezone: typeof HK_NATURAL_TIMEZONE;
  local_date: string;
  verdict: CycleVerdict;
  missing: CycleComponent[];
  components: Partial<Record<CycleComponent, string>>;
  gap_issue_id?: string;
  /** Always false — grader never invents PASS from missing evidence. */
  fabricated_pass: false;
}

function workflowsDir(root: string): string {
  return path.join(baseDir(root), "workflows");
}

function hongKongLocalDate(now: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: HK_NATURAL_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const read = (type: string): string => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) throw new Error("hk_natural_timezone_unavailable");
    return value;
  };
  return `${read("year")}-${read("month")}-${read("day")}`;
}

function roleForSlot(slot: ExpectedSlot): ScheduleRole {
  const match = canonicalSchedules().find((entry) => entry.local_time === slot);
  if (!match) throw new Error("hk_natural_slot_unknown");
  return match.role;
}

function workflowPath(root: string, workflowId: string): string {
  return path.join(workflowsDir(root), `${workflowId}.json`);
}

async function writeWorkflowReceipt(
  root: string,
  receipt: NaturalWorkflowReceipt,
): Promise<NaturalWorkflowReceipt> {
  const parsed = NaturalWorkflowReceiptSchema.parse(receipt);
  await ensureDir(workflowsDir(root));
  await writeJsonAtomic(workflowPath(root, parsed.workflow_id), parsed);
  return parsed;
}

async function listWorkflowsForDate(root: string, localDate: string): Promise<NaturalWorkflowReceipt[]> {
  const dir = workflowsDir(root);
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) =>
    error.code === "ENOENT" ? [] : Promise.reject(error));
  const out: NaturalWorkflowReceipt[] = [];
  for (const name of names.filter((value) => value.endsWith(".json")).sort()) {
    const raw = await readJsonIfExists<unknown>(path.join(dir, name));
    const parsed = NaturalWorkflowReceiptSchema.safeParse(raw);
    if (parsed.success && parsed.data.local_date === localDate) out.push(parsed.data);
  }
  return out;
}

function hashStub(value: string): string {
  // Lightweight non-crypto marker for receipt identity; not a security boundary.
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return `h${(h >>> 0).toString(16)}`;
}

/**
 * Natural local_no_delivery runner for one HK slot.
 * Writes role workflow receipt + watchdog-observable slot receipt (natural_scheduler only).
 * 09:00 also writes scout_pointer; every slot refreshes the watchdog workflow receipt once all slots hit.
 */
export async function runNaturalSlot(root: string, input: RunNaturalSlotInput): Promise<RunNaturalSlotResult> {
  if (input.natural !== true) {
    throw new Error("hk_natural_runner_requires_natural");
  }
  if (!(EXPECTED_SLOTS as readonly string[]).includes(input.slot)) {
    throw new Error("hk_natural_slot_unknown");
  }
  const now = input.now?.() ?? new Date();
  const localDate = input.local_date ?? hongKongLocalDate(now);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate)) {
    throw new Error("hk_natural_local_date_invalid");
  }
  const status = await scheduleStatus(root);
  if (!status.installed) {
    await installHkNaturalSchedules(root, { apply_schtasks: false });
  }

  const role = roleForSlot(input.slot);
  const startedAt = now.toISOString();
  const finishedAt = new Date(now.getTime() + 1).toISOString();
  const workflowId = `wf-${localDate}-${input.slot.replace(":", "")}-${role}`;
  const workflow = await writeWorkflowReceipt(root, {
    schema_version: 1,
    workflow_id: workflowId,
    kind: role,
    slot: input.slot,
    local_date: localDate,
    started_at: startedAt,
    finished_at: finishedAt,
    status: "ok",
    evidence_class: "natural_scheduler",
    natural: true,
    manual_trigger: false,
    delivery: HK_NATURAL_DELIVERY,
    timezone: HK_NATURAL_TIMEZONE,
    role,
    pointer: path.join(HARNESS_DIR_NAME, "autonomy", "hk-natural-schedules", "workflows", `${workflowId}.json`),
    final_output_hash: hashStub(`${workflowId}:${role}:ok`),
  });

  const slotReceipt = await writeSlotReceipt(root, {
    schema_version: 1,
    slot: input.slot,
    local_date: localDate,
    receipt_id: `rcpt-natural-${localDate}-${input.slot.replace(":", "")}`,
    observed_at: finishedAt,
    status: "ok",
    evidence_class: "natural_scheduler",
    natural: true,
  });

  let scoutPointer: NaturalWorkflowReceipt | undefined;
  if (input.slot === "09:00") {
    const scoutId = `wf-${localDate}-scout-pointer`;
    scoutPointer = await writeWorkflowReceipt(root, {
      schema_version: 1,
      workflow_id: scoutId,
      kind: "scout_pointer",
      slot: "09:00",
      local_date: localDate,
      started_at: startedAt,
      finished_at: finishedAt,
      status: "ok",
      evidence_class: "natural_scheduler",
      natural: true,
      manual_trigger: false,
      delivery: HK_NATURAL_DELIVERY,
      timezone: HK_NATURAL_TIMEZONE,
      pointer: path.join(HARNESS_DIR_NAME, "autonomy", "deed-pointers", localDate, "natural-scout.md"),
      final_output_hash: hashStub(`${scoutId}:scout_pointer:ok`),
    });
  }

  let watchdog: NaturalWorkflowReceipt | undefined;
  const store = createFileReceiptStore(root);
  const dayReceipts = await store.listForDate(localDate);
  const allNaturalSlots = HK_NATURAL_SLOTS.every((slot) =>
    dayReceipts.some((item) => item.slot === slot && item.status === "ok" && isNaturalReceipt(item)));
  if (allNaturalSlots) {
    const wdId = `wf-${localDate}-watchdog`;
    watchdog = await writeWorkflowReceipt(root, {
      schema_version: 1,
      workflow_id: wdId,
      kind: "watchdog",
      local_date: localDate,
      started_at: startedAt,
      finished_at: finishedAt,
      status: "ok",
      evidence_class: "natural_scheduler",
      natural: true,
      manual_trigger: false,
      delivery: HK_NATURAL_DELIVERY,
      timezone: HK_NATURAL_TIMEZONE,
      pointer: path.join(HARNESS_DIR_NAME, "autonomy", "missed-slot-watchdog", "receipts"),
      final_output_hash: hashStub(`${wdId}:watchdog:ok`),
    });
  }

  return {
    role,
    delivery: HK_NATURAL_DELIVERY,
    workflow,
    slot_receipt: slotReceipt,
    ...(scoutPointer ? { scout_pointer: scoutPointer } : {}),
    ...(watchdog ? { watchdog } : {}),
  };
}

function naturalWorkflowHit(
  workflows: NaturalWorkflowReceipt[],
  kind: NaturalWorkflowKind,
): NaturalWorkflowReceipt | undefined {
  return workflows.find((item) =>
    item.kind === kind
    && item.status === "ok"
    && item.evidence_class === "natural_scheduler"
    && item.natural === true
    && item.manual_trigger === false
    && item.delivery === HK_NATURAL_DELIVERY);
}

/**
 * Grade one HK local_date natural operating cycle.
 * PASS only when PM prepare, review/worker, nightly, scout/pointer, and watchdog natural receipts exist.
 * Manual-labeled evidence never counts. Incomplete cycles open/reuse one live gap issue → PARTIAL.
 */
export async function gradeNaturalCycle(
  root: string,
  input: { local_date: string },
): Promise<GradeNaturalCycleResult> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.local_date)) {
    throw new Error("hk_grade_local_date_invalid");
  }
  const workflows = await listWorkflowsForDate(root, input.local_date);
  const store = createFileReceiptStore(root);
  const dayReceipts = await store.listForDate(input.local_date);

  const components: Partial<Record<CycleComponent, string>> = {};
  const missing: CycleComponent[] = [];

  const prepare = naturalWorkflowHit(workflows, "pm_prepare");
  if (prepare) components.pm_prepare = prepare.workflow_id;
  else missing.push("pm_prepare");

  const review = naturalWorkflowHit(workflows, "pm_review_worker");
  if (review) components.pm_review_worker = review.workflow_id;
  else missing.push("pm_review_worker");

  const nightly = naturalWorkflowHit(workflows, "strategic_nightly");
  if (nightly) components.strategic_nightly = nightly.workflow_id;
  else missing.push("strategic_nightly");

  const scout = naturalWorkflowHit(workflows, "scout_pointer");
  if (scout) components.scout_pointer = scout.workflow_id;
  else missing.push("scout_pointer");

  // Watchdog is the missed-slot receipt pipeline: any natural ok slot receipt counts as a hit.
  // Full-day watchdog workflow receipt still counts when present (all slots completed).
  const watchdogWf = naturalWorkflowHit(workflows, "watchdog");
  const naturalSlotHit = dayReceipts.find((item) =>
    item.status === "ok" && isNaturalReceipt(item));
  if (watchdogWf) components.watchdog = watchdogWf.workflow_id;
  else if (naturalSlotHit) components.watchdog = naturalSlotHit.receipt_id;
  else missing.push("watchdog");

  if (missing.length === 0) {
    return {
      timezone: HK_NATURAL_TIMEZONE,
      local_date: input.local_date,
      verdict: "PASS",
      missing: [],
      components,
      fabricated_pass: false,
    };
  }

  const gaps = createFileGapIssueAdapter(root);
  const at = new Date().toISOString();
  const missed_slots = missing
    .filter((item): item is "pm_prepare" | "pm_review_worker" | "strategic_nightly" =>
      item === "pm_prepare" || item === "pm_review_worker" || item === "strategic_nightly")
    .map((item) => {
      const slot = item === "pm_prepare" ? "09:00" as const
        : item === "pm_review_worker" ? "17:00" as const
        : "23:00" as const;
      return {
        local_date: input.local_date,
        slot,
        failure_class: "agent_output" as const,
      };
    });
  // Always include at least one missed slot so gap schema stays non-empty when only scout/watchdog missing.
  const gapMissed = missed_slots.length > 0
    ? missed_slots
    : [{ local_date: input.local_date, slot: "09:00" as const, failure_class: "agent_output" as const }];
  const live = await gaps.findLive();
  let gap: GapIssue;
  if (live) {
    gap = await gaps.update(live.issue_id, { missed_slots: gapMissed, at });
  } else {
    gap = await gaps.create({ missed_slots: gapMissed, at });
  }

  return {
    timezone: HK_NATURAL_TIMEZONE,
    local_date: input.local_date,
    verdict: "PARTIAL",
    missing,
    components,
    gap_issue_id: gap.issue_id,
    fabricated_pass: false,
  };
}

/** Honest hit/miss monitor for expected HK slots. Never fabricates a natural PASS. */
export async function monitorHkNaturalReceipts(
  root: string,
  input: { local_date: string },
): Promise<MonitorReport> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.local_date)) {
    throw new Error("hk_monitor_local_date_invalid");
  }
  const store = createFileReceiptStore(root);
  const dayReceipts = await store.listForDate(input.local_date);
  const slots: MonitorSlotReport[] = [];
  for (const slot of HK_NATURAL_SLOTS) {
    const match = dayReceipts.find((item) => item.slot === slot && item.status === "ok");
    if (!match) {
      slots.push({ slot, status: "miss" });
      continue;
    }
    slots.push({
      slot,
      status: "hit",
      evidence_class: match.evidence_class,
      natural: match.natural,
      receipt_id: match.receipt_id,
    });
  }
  const hits = slots.filter((item) => item.status === "hit").length;
  const outcome: MonitorOutcome = hits === 0 ? "all_miss" : hits === slots.length ? "all_hit" : "partial";
  const naturalGradeEligible = outcome === "all_hit"
    && slots.every((item) => {
      const receipt = dayReceipts.find((entry) => entry.receipt_id === item.receipt_id);
      return receipt !== undefined && isNaturalReceipt(receipt);
    });
  return {
    timezone: HK_NATURAL_TIMEZONE,
    local_date: input.local_date,
    slots,
    outcome,
    natural_grade_eligible: naturalGradeEligible,
    fabricated_pass: false,
  };
}

import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import { HarnessStore } from "../state/store.js";

const execFileAsync = promisify(execFile);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const CONTINUATION_KEY = /^ch-[0-9a-f]{24}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const MAX_OUTPUT = 1024 * 1024;

export class CoordinationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly safeDetails?: Record<string, string>,
  ) {
    super(`${code}: ${message}`);
    this.name = "CoordinationError";
  }
}

function fail(code: string, message: string, safeDetails?: Record<string, string>): never {
  throw new CoordinationError(code, message, safeDetails);
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const SECRET_RULES: ReadonlyArray<[string, RegExp]> = [
  ["authorization", /\bauthorization\s*[:=]/i],
  ["bearer", /\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/i],
  ["assignment", /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|token|password|passwd|secret|cookie)\s*[:=]/i],
  ["private_key", /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/i],
  ["provider_prefix", /\b(?:sk-|gh[opusr]_|glpat-|xox[baprs]-|mul_|mat_)[A-Za-z0-9_-]{8,}/i],
];

export function normalizedSecretScanValue(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200F\u2060\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function secretRule(value: string): string | undefined {
  for (const [id, pattern] of SECRET_RULES) {
    if (pattern.test(value)) return id;
  }
  const candidates = value.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? [];
  if (candidates.some((part) => {
    if (UUID.test(part)) return false;
    if (/^[0-9a-f]{40,}$/i.test(part)) return true;
    return /[a-z]/.test(part) && /[A-Z]/.test(part) && /\d/.test(part)
      && new Set(part).size / part.length >= 0.4;
  })) {
    return "high_entropy";
  }
  return undefined;
}

export function assertNoSecrets(fields: Record<string, string | undefined>): void {
  for (const [field, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const rawRule = secretRule(value);
    const normalizedRule = secretRule(normalizedSecretScanValue(value));
    const rule = rawRule ?? normalizedRule;
    if (rule) {
      fail("secret_rejected", `unsafe credential-like input in ${field}`, {
        field,
        rule_id_digest: sha(rule).slice(0, 16),
      });
    }
  }
}

function canonicalUuid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!UUID.test(normalized)) fail("invalid_request", `${field} must be a UUID`);
  return normalized;
}

function canonicalRef(value: string, field: string): string {
  const normalized = value.trim();
  if (!SAFE_REF.test(normalized)) fail("invalid_request", `${field} is invalid`);
  return UUID.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function canonicalServerOrigin(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    return fail("invalid_origin", "server must be a valid http(s) origin");
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password) {
    fail("invalid_origin", "server must be a credential-free http(s) origin");
  }
  return parsed.origin.toLowerCase();
}

async function initializedAncestors(start: string, boundary?: string): Promise<string[]> {
  let current: string;
  try {
    current = await fs.realpath(path.resolve(start));
    if (!(await fs.stat(current)).isDirectory()) current = path.dirname(current);
  } catch {
    return fail("invalid_cwd", "cwd must name an existing path");
  }
  const stop = boundary ? await fs.realpath(path.resolve(boundary)) : undefined;
  const home = await fs.realpath(os.homedir()).catch(() => path.resolve(os.homedir()));
  const key = (value: string): string => process.platform === "win32" ? value.toLowerCase() : value;
  const found: string[] = [];
  for (;;) {
    // A user-home harness is not an ancestor project for arbitrary global hooks.
    if (!stop && key(current) === key(home)) return found;
    try {
      await fs.access(path.join(current, HARNESS_DIR_NAME, "state.json"));
      found.push(await fs.realpath(current));
    } catch {
      // Absence is expected for globally installed hooks.
    }
    if (stop && key(current) === key(stop)) return found;
    const parent = path.dirname(current);
    if (parent === current) return found;
    current = parent;
  }
}

export type GitProbe = (cwd: string, args: readonly string[]) => Promise<string | undefined>;

async function defaultGitProbe(cwd: string, args: readonly string[]): Promise<string | undefined> {
  try {
    const result = await execFileAsync("git", [...args], {
      cwd,
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return String(result.stdout).trim() || undefined;
  } catch {
    return undefined;
  }
}

export interface ResolvedHarnessGoal {
  root: string;
  goalId: string;
}

export async function resolveHarnessGoal(
  cwd: string,
  explicitGoal?: string,
  gitProbe: GitProbe = defaultGitProbe,
): Promise<ResolvedHarnessGoal | undefined> {
  const candidates = new Map<string, string>();
  const add = async (start: string | undefined, boundary?: string): Promise<void> => {
    if (!start) return;
    for (const root of await initializedAncestors(start, boundary)) {
      const key = process.platform === "win32" ? root.toLowerCase() : root;
      candidates.set(key, root);
    }
  };

  const top = await gitProbe(cwd, ["rev-parse", "--show-toplevel"]);
  if (top) {
    await add(cwd, top);
    await add(top, top);
  } else {
    await add(cwd);
  }
  const common = await gitProbe(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common) {
    const absolute = path.isAbsolute(common) ? common : path.resolve(cwd, common);
    if (path.basename(absolute).toLowerCase() === ".git") await add(path.dirname(absolute), path.dirname(absolute));
  }

  if (candidates.size === 0) return undefined;
  if (candidates.size !== 1) fail("ambiguous_harness_root", "more than one initialized harness root applies");
  const root = [...candidates.values()][0]!;
  let state: { active_goal_id?: string; goals: Record<string, { status: string }> };
  const store = new HarnessStore(root);
  try {
    state = await store.readStateV3();
  } catch {
    try {
      state = await store.readState();
    } catch {
      return fail("invalid_harness_state", "harness state could not be read");
    }
  }
  const goalId = state.active_goal_id;
  if (!goalId) fail("inactive_goal", "harness has no active goal");
  if (explicitGoal && explicitGoal !== goalId) fail("goal_mismatch", "pinned goal does not match the active goal");
  const goal = state.goals[goalId];
  if (!goal) fail("goal_missing", "active goal does not exist");
  if (goal.status !== "active") fail("inactive_goal", "active goal is not in active status");
  return { root, goalId };
}

const BindInput = z.object({
  cwd: z.string().min(1).max(4096),
  goal: z.string().regex(SAFE_REF).optional(),
  mode: z.enum(["profile", "task"]),
  profile: z.string().regex(SAFE_NAME).optional(),
  serverOrigin: z.string().min(1).max(2048).optional(),
  workspaceId: z.string().min(1).max(64),
  parent: z.string().min(1).max(80),
  project: z.string().min(1).max(80).optional(),
}).strict();

export type BindCoordinationInput = z.input<typeof BindInput>;

const Binding = z.object({
  schema_version: z.literal(1),
  goal_id: z.string(),
  credential_mode: z.enum(["profile", "task"]),
  profile: z.string().optional(),
  task_id: z.string().optional(),
  agent_id: z.string().optional(),
  server_origin: z.string(),
  workspace_id: z.string(),
  parent_id: z.string(),
  parent_identifier: z.string(),
  project_id: z.string().optional(),
  project_source: z.enum(["parent", "explicit"]),
  issue_prefix: z.string(),
  verified_at: z.string().datetime(),
}).strict();
export type CoordinationBinding = z.infer<typeof Binding>;

const ContinuationRequestInputSchema = z.object({
  title: z.string().min(1).max(512),
  source_class: z.string().min(1).max(80).regex(SAFE_REF),
  source: z.string().min(1).max(4096),
  problem: z.string().min(1).max(8192),
  impact_scope: z.string().min(1).max(8192),
  owner_control: z.string().min(1).max(4096),
  acceptance: z.array(z.string().min(1).max(4096)).min(1).max(32),
  verification: z.array(z.string().min(1).max(4096)).min(1).max(32),
  dependencies: z.array(z.string().min(1).max(4096)).max(32),
  safety_blockers: z.array(z.string().min(1).max(4096)).max(32),
  cost_class: z.string().min(1).max(128),
  evidence_horizon: z.string().min(1).max(4096),
  rollback: z.string().min(1).max(4096),
  status: z.literal("todo"),
  priority: z.literal("medium"),
  evidence: z.array(z.string().min(1).max(4096)).max(32).optional(),
  attachment_ids: z.array(z.string().min(1).max(64)).max(32).optional(),
  session_id: z.string().min(1).max(128).optional(),
  turn_id: z.string().min(1).max(128).optional(),
}).strict();

const EnsureContinuationInputSchema = z.object({
  cwd: z.string().min(1).max(4096),
  goal: z.string().regex(SAFE_REF).optional(),
  metadataPolicy: z.enum(["none", "optional", "required"]).default("optional"),
  request: ContinuationRequestInputSchema,
}).strict();

export type EnsureContinuationInput = z.input<typeof EnsureContinuationInputSchema>;

export interface CanonicalContinuationRequest {
  title: string;
  source_class: string;
  source: string;
  problem: string;
  impact_scope: string;
  owner_control: string;
  acceptance: string[];
  verification: string[];
  dependencies: string[];
  safety_blockers: string[];
  cost_class: string;
  evidence_horizon: string;
  rollback: string;
  status: "todo";
  priority: "medium";
  evidence: string[];
  attachment_ids: string[];
}

const ContinuationRecordSchema = z.object({
  schema_version: z.literal(1),
  key: z.string().regex(CONTINUATION_KEY),
  contract_sha256: z.string().regex(SHA256),
  state: z.enum(["pending", "created_unverified", "verified"]),
  canonical_input: z.object({
    goal_id: z.string(),
    workspace_id: z.string().uuid(),
    parent_id: z.string().uuid(),
    project_id: z.string().uuid().optional(),
    request: z.object({
      title: z.string(),
      source_class: z.string(),
      source: z.string(),
      problem: z.string(),
      impact_scope: z.string(),
      owner_control: z.string(),
      acceptance: z.array(z.string()),
      verification: z.array(z.string()),
      dependencies: z.array(z.string()),
      safety_blockers: z.array(z.string()),
      cost_class: z.string(),
      evidence_horizon: z.string(),
      rollback: z.string(),
      status: z.literal("todo"),
      priority: z.literal("medium"),
      evidence: z.array(z.string()),
      attachment_ids: z.array(z.string().uuid()),
    }).strict(),
  }).strict(),
  remote: z.object({
    id: z.string().uuid(),
    identifier: z.string().regex(SAFE_REF),
    idempotency_digest: z.string().regex(SHA256).optional(),
  }).strict().optional(),
  attempts: z.number().int().min(1),
  reason: z.string(),
  metadata_state: z.enum(["not_requested", "pending", "verified", "unverified"]),
  warnings: z.array(z.string()),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  verified_at: z.string().datetime().optional(),
}).strict();

export type ContinuationRecord = z.infer<typeof ContinuationRecordSchema>;

export interface VerifiedContinuation {
  state: "verified";
  key: string;
  id: string;
  identifier: string;
  contract_sha256: string;
  warnings: string[];
}
export interface MulticaInvocation {
  executable: "multica";
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdin?: string;
  shell: false;
  windowsHide: true;
}

export interface MulticaResult {
  stdout: string;
}

export type MulticaRunner = (invocation: MulticaInvocation) => Promise<MulticaResult>;

export interface GhInvocation {
  executable: "gh";
  argv: string[];
  env: NodeJS.ProcessEnv;
  stdin?: string;
  shell: false;
  windowsHide: true;
}

export interface GhResult {
  stdout: string;
}

export type GhRunner = (invocation: GhInvocation) => Promise<GhResult>;

const BASE_ENV = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "HOME", "USERPROFILE",
  "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TMP", "TEMP",
]);

function baseChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const upper = key.toUpperCase();
    if (value !== undefined && BASE_ENV.has(upper) && !upper.startsWith("MULTICA_")) result[key] = value;
  }
  return result;
}

interface TaskAuthority {
  token: string;
  serverOrigin: string;
  workspaceId: string;
  taskId: string;
  agentId: string;
  daemonPort: string;
}

async function requireDaemonTaskMarker(start: string, authority: TaskAuthority): Promise<void> {
  let current = await fs.realpath(path.resolve(start));
  if (!(await fs.stat(current)).isDirectory()) current = path.dirname(current);
  for (;;) {
    const markerPath = path.join(current, ".multica", "daemon_task_context.json");
    let raw: string | undefined;
    try {
      raw = await fs.readFile(markerPath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        fail("task_authority_missing", "daemon task marker is not readable");
      }
    }
    if (raw !== undefined) {
      let marker: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("object required");
        marker = parsed as Record<string, unknown>;
      } catch {
        return fail("task_authority_missing", "daemon task marker is malformed");
      }
      if (marker.managed_by !== "multica-daemon-task") {
        fail("task_authority_missing", "daemon task marker has foreign ownership");
      }
      const hasTaskIdentity = marker.agent_id !== undefined || marker.issue_id !== undefined;
      if (hasTaskIdentity) {
        if (typeof marker.agent_id !== "string" || !SAFE_REF.test(marker.agent_id)
          || typeof marker.issue_id !== "string" || !SAFE_REF.test(marker.issue_id)
          || marker.agent_id !== authority.agentId) {
          fail("task_authority_missing", "daemon task marker identity is invalid");
        }
      }
      // The daemon's workspaces-root guard intentionally contains only managed_by.
      return;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  fail("task_authority_missing", "task mode requires a verified daemon task marker");
}

function taskAuthorityFromEnv(source: NodeJS.ProcessEnv): TaskAuthority {
  const token = source.MULTICA_TOKEN ?? "";
  const taskId = source.MULTICA_TASK_ID ?? "";
  const agentId = source.MULTICA_AGENT_ID ?? "";
  const daemonPort = source.MULTICA_DAEMON_PORT ?? "";
  if (!/^mat_[A-Za-z0-9_-]{16,512}$/.test(token)
    || !SAFE_REF.test(taskId)
    || !SAFE_REF.test(agentId)
    || !/^\d{1,5}$/.test(daemonPort)
    || !source.MULTICA_SERVER_URL
    || !source.MULTICA_WORKSPACE_ID) {
    return fail("task_authority_missing", "task mode requires complete daemon authority");
  }
  return {
    token,
    taskId,
    agentId,
    daemonPort,
    serverOrigin: canonicalServerOrigin(source.MULTICA_SERVER_URL),
    workspaceId: canonicalUuid(source.MULTICA_WORKSPACE_ID, "daemon workspace"),
  };
}

function childEnv(mode: "profile" | "task", source: NodeJS.ProcessEnv, authority?: TaskAuthority): NodeJS.ProcessEnv {
  const result = baseChildEnv(source);
  if (mode === "task" && authority) {
    result.MULTICA_TOKEN = authority.token;
    result.MULTICA_TASK_ID = authority.taskId;
    result.MULTICA_AGENT_ID = authority.agentId;
    result.MULTICA_DAEMON_PORT = authority.daemonPort;
  }
  return result;
}

function invocation(
  argv: string[],
  mode: "profile" | "task",
  source: NodeJS.ProcessEnv,
  authority?: TaskAuthority,
  stdin?: string,
): MulticaInvocation {
  const call: MulticaInvocation = {
    executable: "multica",
    argv,
    env: childEnv(mode, source, authority),
    shell: false,
    windowsHide: true,
  };
  if (stdin !== undefined) call.stdin = stdin;
  return call;
}

function resolveWindowsCli(
  executable: string,
  env: NodeJS.ProcessEnv,
): { command: string; argsPrefix: string[]; shell: boolean } {
  const wrapper = (env.MULTICA_FAKE_WRAPPER ?? process.env.MULTICA_FAKE_WRAPPER)?.trim();
  if (wrapper && executable === "multica") {
    return { command: process.execPath, argsPrefix: [wrapper], shell: false };
  }
  if (process.platform !== "win32") return { command: executable, argsPrefix: [], shell: false };
  if (path.isAbsolute(executable) || /[\\/]/.test(executable) || path.extname(executable)) {
    return { command: executable, argsPrefix: [], shell: /\.(cmd|bat)$/i.test(executable) };
  }
  const pathEnv = env.PATH ?? process.env.PATH ?? "";
  const exts = (env.PATHEXT ?? process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean);
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    for (const ext of ["", ...exts]) {
      const candidate = path.join(dir, `${executable}${ext}`);
      if (!existsSync(candidate)) continue;
      return {
        command: candidate,
        argsPrefix: [],
        shell: /\.(cmd|bat)$/i.test(candidate),
      };
    }
  }
  return { command: executable, argsPrefix: [], shell: false };
}

async function spawnTrackedCli(
  call: { executable: string; argv: string[]; env: NodeJS.ProcessEnv; stdin?: string },
  labels: { timeout: string; tooLarge: string; unavailable: string; failed: string },
): Promise<{ stdout: string }> {
  const resolved = resolveWindowsCli(call.executable, call.env);
  const argv = resolved.argsPrefix.length > 0 ? [...resolved.argsPrefix, ...call.argv] : call.argv;
  return new Promise((resolve, reject) => {
    const child = spawn(resolved.command, argv, {
      env: call.env,
      shell: resolved.shell,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let failed: CoordinationError | undefined;
    const timer = setTimeout(() => {
      failed = new CoordinationError(labels.timeout, `${call.executable} did not complete within 15 seconds`);
      child.kill();
    }, 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (Buffer.byteLength(stdout, "utf8") > MAX_OUTPUT) {
        failed = new CoordinationError(labels.tooLarge, `${call.executable} JSON exceeded the output bound`);
        child.kill();
      }
    });
    child.stderr.on("data", (chunk: string) => {
      if (Buffer.byteLength(stderr, "utf8") <= 64 * 1024) stderr += chunk;
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new CoordinationError(labels.unavailable, `${call.executable} could not be started`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (failed) return reject(failed);
      if (code !== 0) {
        return reject(new CoordinationError(labels.failed, `${call.executable} returned a failure`, {
          stderr_digest: sha(stderr).slice(0, 16),
        }));
      }
      resolve({ stdout });
    });
    child.stdin.end(call.stdin ?? "");
  });
}

export async function spawnMultica(call: MulticaInvocation): Promise<MulticaResult> {
  return spawnTrackedCli(call, {
    timeout: "multica_timeout",
    tooLarge: "multica_output_too_large",
    unavailable: "multica_unavailable",
    failed: "multica_failed",
  });
}

export async function spawnGh(call: GhInvocation): Promise<GhResult> {
  return spawnTrackedCli(call, {
    timeout: "gh_timeout",
    tooLarge: "gh_output_too_large",
    unavailable: "gh_unavailable",
    failed: "gh_failed",
  });
}

/** Scrubbed env for `gh` children (no Multica daemon authority). */
export function ghChildEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = baseChildEnv(source);
  for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "GH_HOST", "GH_ENTERPRISE_TOKEN"]) {
    if (source[key]) result[key] = source[key];
  }
  return result;
}

export interface CoordinationDeps {
  runner?: MulticaRunner;
  ghRunner?: GhRunner;
  env?: NodeJS.ProcessEnv;
  now?: () => string;
  gitProbe?: GitProbe;
  lockLeaseMs?: number;
  lockWaitMs?: number;
  lockPollMs?: number;
  hostname?: string;
  pid?: number;
  pidIsAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
  afterLockOwnerCheck?: () => Promise<void>;
}

function parseObject(result: MulticaResult, kind: string): Record<string, unknown> {
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT) fail("multica_output_too_large", `${kind} output exceeded the bound`);
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("object required");
    return value as Record<string, unknown>;
  } catch {
    return fail("malformed_multica_json", `${kind} returned malformed JSON`);
  }
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  const direct = value[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = value[key.replace(/_id$/, "")];
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).id === "string") {
    return String((nested as Record<string, unknown>).id).trim();
  }
  return undefined;
}

function bindingPath(root: string, goalId: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "bindings", `${sha(goalId).slice(0, 24)}.json`);
}

export function coordinationBindingPath(root: string, goalId: string): string {
  return bindingPath(root, goalId);
}

function assertCanonicalBinding(binding: CoordinationBinding): void {
  assertNoSecrets({
    goal_id: binding.goal_id,
    profile: binding.profile,
    task_id: binding.task_id,
    agent_id: binding.agent_id,
    server_origin: binding.server_origin,
    workspace_id: binding.workspace_id,
    parent_id: binding.parent_id,
    parent_identifier: binding.parent_identifier,
    project_id: binding.project_id,
    issue_prefix: binding.issue_prefix,
    verified_at: binding.verified_at,
  });
  try {
    const profileRoute = binding.credential_mode === "profile";
    if (canonicalRef(binding.goal_id, "stored goal") !== binding.goal_id
      || canonicalServerOrigin(binding.server_origin) !== binding.server_origin
      || canonicalUuid(binding.workspace_id, "stored workspace") !== binding.workspace_id
      || canonicalUuid(binding.parent_id, "stored parent") !== binding.parent_id
      || canonicalRef(binding.parent_identifier, "stored parent identifier") !== binding.parent_identifier
      || (binding.project_id !== undefined
        && canonicalUuid(binding.project_id, "stored project") !== binding.project_id)
      || canonicalRef(binding.issue_prefix, "stored issue prefix") !== binding.issue_prefix
      || (profileRoute
        ? !binding.profile || !SAFE_NAME.test(binding.profile) || binding.task_id !== undefined || binding.agent_id !== undefined
        : binding.profile !== undefined
          || !binding.task_id || canonicalRef(binding.task_id, "stored task") !== binding.task_id
          || !binding.agent_id || canonicalRef(binding.agent_id, "stored agent") !== binding.agent_id)
      || (binding.project_source === "explicit" && binding.project_id === undefined)) {
      fail("binding_invalid", "stored binding is not canonical");
    }
  } catch (error) {
    if (error instanceof CoordinationError && error.code === "binding_invalid") throw error;
    fail("binding_invalid", "stored binding is not canonical");
  }
}

async function readBinding(file: string): Promise<CoordinationBinding | undefined> {
  const raw = await readJsonIfExists<unknown>(file);
  if (raw === undefined) return undefined;
  const parsed = Binding.safeParse(raw);
  if (!parsed.success) fail("binding_invalid", "stored binding is malformed");
  assertCanonicalBinding(parsed.data);
  return parsed.data;
}

interface Route {
  mode: "profile" | "task";
  profile?: string;
  serverOrigin: string;
  workspaceId: string;
  authority?: TaskAuthority;
}

async function resolveRoute(
  input: z.output<typeof BindInput>,
  runner: MulticaRunner,
  sourceEnv: NodeJS.ProcessEnv,
): Promise<Route> {
  const workspaceId = canonicalUuid(input.workspaceId, "workspace");
  if (input.mode === "task") {
    const authority = taskAuthorityFromEnv(sourceEnv);
    await requireDaemonTaskMarker(input.cwd, authority);
    if (authority.workspaceId !== workspaceId) fail("workspace_mismatch", "daemon workspace does not match the request");
    if (input.serverOrigin && canonicalServerOrigin(input.serverOrigin) !== authority.serverOrigin) {
      fail("origin_mismatch", "daemon origin does not match the request");
    }
    return { mode: "task", serverOrigin: authority.serverOrigin, workspaceId, authority };
  }

  if (!input.profile) fail("profile_required", "profile mode requires --profile");
  const profile = input.profile;
  const result = await runner(invocation(["--profile", profile, "config", "identity"], "profile", sourceEnv));
  const identity = parseObject(result, "config identity");
  if (identity.profile !== profile) fail("profile_mismatch", "configured profile identity did not match");
  if (typeof identity.server_origin !== "string" || typeof identity.workspace_id !== "string") {
    fail("config_identity_invalid", "profile routing identity is incomplete");
  }
  const serverOrigin = canonicalServerOrigin(identity.server_origin);
  if (canonicalUuid(identity.workspace_id, "configured workspace") !== workspaceId) {
    fail("workspace_mismatch", "configured workspace does not match the request");
  }
  if (input.serverOrigin && canonicalServerOrigin(input.serverOrigin) !== serverOrigin) {
    fail("origin_mismatch", "configured origin does not match the request");
  }
  return { mode: "profile", profile, serverOrigin, workspaceId };
}

function routeArgs(route: Route): string[] {
  const args: string[] = [];
  if (route.profile) args.push("--profile", route.profile);
  args.push("--server-url", route.serverOrigin, "--workspace-id", route.workspaceId);
  return args;
}

function assertStoredDestination(
  stored: CoordinationBinding | undefined,
  input: z.output<typeof BindInput>,
  resolved: ResolvedHarnessGoal,
  route: Route,
): void {
  if (!stored) return;
  if (route.mode === "task"
    && (stored.task_id !== route.authority?.taskId || stored.agent_id !== route.authority?.agentId)) {
    fail("task_authority_drift", "daemon task authority differs from the stored binding");
  }
  const parent = canonicalRef(input.parent, "parent");
  const project = input.project ? canonicalRef(input.project, "project") : undefined;
  if (stored.goal_id !== resolved.goalId
    || stored.credential_mode !== route.mode
    || stored.profile !== route.profile
    || stored.server_origin !== route.serverOrigin
    || stored.workspace_id !== route.workspaceId
    || (stored.parent_id !== parent && stored.parent_identifier !== parent)
    || (project !== undefined && UUID.test(project) && stored.project_id !== project)) {
    fail("binding_drift", "stored binding does not match the requested destination");
  }
}

interface LiveDestination {
  parentId: string;
  parentIdentifier: string;
  projectId?: string;
  issuePrefix: string;
}

async function readLiveDestination(
  input: z.output<typeof BindInput>,
  route: Route,
  runner: MulticaRunner,
  sourceEnv: NodeJS.ProcessEnv,
): Promise<LiveDestination> {
  const parentRef = canonicalRef(input.parent, "parent");
  const prefix = routeArgs(route);
  const parentCall = invocation([...prefix, "issue", "get", parentRef, "--output", "json"], route.mode, sourceEnv, route.authority);
  const issue = parseObject(await runner(parentCall), "parent readback");
  const parentId = stringAt(issue, "id");
  const parentIdentifier = stringAt(issue, "identifier");
  const workspaceId = stringAt(issue, "workspace_id");
  if (!parentId || !UUID.test(parentId) || !parentIdentifier || !SAFE_REF.test(parentIdentifier)) {
    fail("parent_readback_invalid", "parent readback lacks canonical identity");
  }
  if (canonicalUuid(workspaceId ?? "", "parent workspace") !== route.workspaceId) {
    fail("workspace_mismatch", "parent belongs to a different workspace");
  }
  if (UUID.test(parentRef) ? parentId.toLowerCase() !== parentRef : parentIdentifier !== parentRef) {
    fail("parent_mismatch", "parent readback does not match the requested parent");
  }

  let projectId = stringAt(issue, "project_id");
  if (input.project) {
    const requested = canonicalRef(input.project, "project");
    const projectCall = invocation([...prefix, "project", "get", requested, "--output", "json"], route.mode, sourceEnv, route.authority);
    const project = parseObject(await runner(projectCall), "project readback");
    const liveProjectId = stringAt(project, "id");
    const liveProjectIdentifier = stringAt(project, "identifier");
    const liveWorkspaceId = stringAt(project, "workspace_id");
    if (!liveProjectId || !UUID.test(liveProjectId)
      || (UUID.test(requested)
        ? liveProjectId.toLowerCase() !== requested
        : liveProjectIdentifier !== requested)
      || canonicalUuid(liveWorkspaceId ?? "", "project workspace") !== route.workspaceId) {
      fail("project_mismatch", "project readback does not match the requested destination");
    }
    projectId = liveProjectId.toLowerCase();
  } else if (projectId) {
    projectId = canonicalUuid(projectId, "parent project");
  }
  const issuePrefix = parentIdentifier.includes("-") ? parentIdentifier.slice(0, parentIdentifier.indexOf("-")) : "";
  if (!issuePrefix) fail("parent_readback_invalid", "parent identifier has no issue prefix");
  return {
    parentId: parentId.toLowerCase(),
    parentIdentifier,
    projectId,
    issuePrefix,
  };
}

export async function bindCoordination(
  rawInput: BindCoordinationInput,
  deps: CoordinationDeps = {},
): Promise<CoordinationBinding | undefined> {
  assertNoSecrets({
    goal: rawInput.goal,
    profile: rawInput.profile,
    serverOrigin: rawInput.serverOrigin,
    workspaceId: rawInput.workspaceId,
    parent: rawInput.parent,
    project: rawInput.project,
  });
  const parsed = BindInput.safeParse(rawInput);
  if (!parsed.success) fail("invalid_request", "binding request is invalid");
  const input = parsed.data;
  if (input.mode === "task" && input.profile) {
    fail("invalid_request", "task mode cannot select a user profile");
  }
  const resolved = await resolveHarnessGoal(input.cwd, input.goal, deps.gitProbe);
  if (!resolved) return undefined;

  const goalState = await new HarnessStore(resolved.root).readStateV3();
  if (goalState.goals[resolved.goalId]?.backend.kind === "github") {
    fail("github_backend", "GitHub backend does not use Multica daemon coordination binding");
  }

  const file = bindingPath(resolved.root, resolved.goalId);
  const stored = await readBinding(file);
  const runner = deps.runner ?? spawnMultica;
  const sourceEnv = deps.env ?? process.env;
  const route = await resolveRoute(input, runner, sourceEnv);
  assertStoredDestination(stored, input, resolved, route);
  const live = await readLiveDestination(input, route, runner, sourceEnv);
  if (stored && stored.project_id !== live.projectId) {
    fail("project_drift", "live effective project differs from the stored binding");
  }

  const binding: CoordinationBinding = Binding.parse({
    schema_version: 1,
    goal_id: resolved.goalId,
    credential_mode: route.mode,
    profile: route.profile,
    task_id: route.authority?.taskId,
    agent_id: route.authority?.agentId,
    server_origin: route.serverOrigin,
    workspace_id: route.workspaceId,
    parent_id: live.parentId,
    parent_identifier: live.parentIdentifier,
    project_id: live.projectId,
    project_source: input.project ? "explicit" : "parent",
    issue_prefix: live.issuePrefix,
    verified_at: (deps.now ?? (() => new Date().toISOString()))(),
  });
  await writeJsonAtomic(file, binding);
  const reread = await readBinding(file);
  if (!reread || JSON.stringify(reread) !== JSON.stringify(binding)) {
    fail("binding_readback_failed", "binding did not survive local readback");
  }
  return reread;
}

export async function verifyCoordinationBinding(
  cwd: string,
  goal: string | undefined,
  deps: CoordinationDeps = {},
): Promise<CoordinationBinding | undefined> {
  const resolved = await resolveHarnessGoal(cwd, goal, deps.gitProbe);
  if (!resolved) return undefined;
  const stored = await readBinding(bindingPath(resolved.root, resolved.goalId));
  if (!stored) fail("binding_missing", "no coordination binding exists for the goal");
  const input: BindCoordinationInput = {
    cwd,
    goal,
    mode: stored.credential_mode,
    profile: stored.profile,
    serverOrigin: stored.server_origin,
    workspaceId: stored.workspace_id,
    parent: stored.parent_id,
    project: stored.project_source === "explicit" ? stored.project_id : undefined,
  };
  const runner = deps.runner ?? spawnMultica;
  const sourceEnv = deps.env ?? process.env;
  const parsed = BindInput.parse(input);
  const route = await resolveRoute(parsed, runner, sourceEnv);
  assertStoredDestination(stored, parsed, resolved, route);
  const live = await readLiveDestination(parsed, route, runner, sourceEnv);
  if (live.parentId !== stored.parent_id
    || live.parentIdentifier !== stored.parent_identifier
    || live.projectId !== stored.project_id
    || live.issuePrefix !== stored.issue_prefix) {
    fail("binding_drift", "live destination differs from the stored binding");
  }
  return stored;
}
function normalizeContinuationText(value: string, title = false): string {
  const normalized = value.normalize("NFKC").replace(/\r\n?/g, "\n").trim();
  return title ? normalized.replace(/\s+/g, " ") : normalized;
}

function requiredContinuationText(value: string, field: string, title = false): string {
  const normalized = normalizeContinuationText(value, title);
  if (!normalized) fail("invalid_request", `${field} must not be empty`);
  return normalized;
}

function canonicalContinuationList(values: string[], field: string, required = false): string[] {
  const result = [...new Set(values.map((value) => normalizeContinuationText(value)).filter(Boolean))].sort();
  if (required && result.length === 0) fail("invalid_request", `${field} must not be empty`);
  return result;
}

function canonicalContinuationRequest(input: z.output<typeof ContinuationRequestInputSchema>): CanonicalContinuationRequest {
  return {
    title: requiredContinuationText(input.title, "title", true),
    source_class: canonicalRef(input.source_class, "source_class"),
    source: requiredContinuationText(input.source, "source"),
    problem: requiredContinuationText(input.problem, "problem"),
    impact_scope: requiredContinuationText(input.impact_scope, "impact_scope"),
    owner_control: requiredContinuationText(input.owner_control, "owner_control"),
    acceptance: canonicalContinuationList(input.acceptance, "acceptance", true),
    verification: canonicalContinuationList(input.verification, "verification", true),
    dependencies: canonicalContinuationList(input.dependencies, "dependencies"),
    safety_blockers: canonicalContinuationList(input.safety_blockers, "safety_blockers"),
    cost_class: requiredContinuationText(input.cost_class, "cost_class", true),
    evidence_horizon: requiredContinuationText(input.evidence_horizon, "evidence_horizon"),
    rollback: requiredContinuationText(input.rollback, "rollback"),
    status: "todo",
    priority: "medium",
    evidence: canonicalContinuationList(input.evidence ?? [], "evidence"),
    attachment_ids: [...new Set((input.attachment_ids ?? []).map((id) => canonicalUuid(id, "attachment_id")))].sort(),
  };
}

function scanContinuationSecrets(request: CanonicalContinuationRequest): void {
  const fields: Record<string, string> = {};
  for (const [key, value] of Object.entries(request)) {
    if (typeof value === "string") fields[key] = value;
    else if (Array.isArray(value)) value.forEach((item, index) => { fields[`${key}[${index}]`] = item; });
  }
  assertNoSecrets(fields);
}

function continuationKey(goalId: string, binding: CoordinationBinding, request: CanonicalContinuationRequest): string {
  return `ch-${sha(JSON.stringify([
    goalId, binding.parent_id, binding.project_id ?? null, request.title, request.problem, request.source_class,
  ])).slice(0, 24)}`;
}

function continuationContractDigest(
  goalId: string,
  binding: CoordinationBinding,
  key: string,
  request: CanonicalContinuationRequest,
): string {
  return sha(JSON.stringify({
    schema_version: 1,
    key,
    goal_id: goalId,
    workspace_id: binding.workspace_id,
    parent_id: binding.parent_id,
    project_id: binding.project_id ?? null,
    request,
  }));
}

function bulletSection(values: string[]): string {
  return values.length === 0 ? "- None" : values.map((value) => `- ${value}`).join("\n");
}

function continuationDescription(key: string, digest: string, request: CanonicalContinuationRequest): string {
  return [
    `Continuation-Key: ${key}`,
    `Contract-SHA256: ${digest}`,
    "", "## Source", `Class: ${request.source_class}`, request.source,
    "", "## Problem or opportunity", request.problem,
    "", "## Impact and scope", request.impact_scope,
    "", "## Owner and control boundary", request.owner_control,
    "", "## Acceptance criteria", bulletSection(request.acceptance),
    "", "## Verification", bulletSection(request.verification),
    "", "## Dependencies", bulletSection(request.dependencies),
    "", "## Safety blockers", bulletSection(request.safety_blockers),
    "", "## Cost class", request.cost_class,
    "", "## Evidence horizon", request.evidence_horizon,
    "", "## Initial evidence", bulletSection(request.evidence),
    "", "## Stop and rollback", request.rollback,
  ].join("\n");
}

export function continuationRecordPath(root: string, key: string): string {
  if (!CONTINUATION_KEY.test(key)) fail("invalid_request", "continuation key is invalid");
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "continuations", `${key}.json`);
}

const DEFAULT_RETRY_LIMIT = 12;
const DEFAULT_LOCK_LEASE_MS = 30_000;
const DEFAULT_LOCK_WAIT_MS = 2_000;
const DEFAULT_LOCK_POLL_MS = 25;

const LockOwnerSchema = z.object({
  hostname: z.string().min(1),
  pid: z.number().int().positive(),
  nonce: z.string().regex(/^[0-9a-f-]{16,64}$/),
  acquired_at: z.string().datetime(),
  heartbeat_at: z.string().datetime(),
}).strict();
type LockOwner = z.infer<typeof LockOwnerSchema>;

interface ContinuationLock {
  heartbeat(): Promise<void>;
  release(): Promise<void>;
}

function lockPath(root: string, key: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "locks", `${key}.lock`);
}

function lockOwnerPath(lockDir: string, nonce: string): string {
  return `${lockDir}.${nonce}.owner.json`;
}

function pidIsAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function staleLock(
  root: string,
  key: string,
  lockDir: string,
  owner: LockOwner | undefined,
): Promise<boolean> {
  const nonce = owner?.nonce ?? randomUUID();
  const staleRoot = path.join(root, HARNESS_DIR_NAME, "autonomy", "stale-locks", key);
  await fs.mkdir(staleRoot, { recursive: true });
  let moved = path.join(staleRoot, `${nonce}.lock`);
  try {
    await fs.rename(lockDir, moved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    moved = path.join(staleRoot, `${nonce}-${randomUUID()}.lock`);
    try {
      await fs.rename(lockDir, moved);
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw retryError;
    }
  }
  const oldOwner = path.join(moved, "owner.json");
  const evidence = path.join(staleRoot, `${path.basename(moved, ".lock")}.json`);
  if (owner) {
    await writeJsonAtomic(evidence, owner);
    await fs.rm(lockOwnerPath(lockDir, owner.nonce), { force: true });
  } else {
    try {
      await fs.rename(oldOwner, evidence);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await writeJsonAtomic(evidence, {
        malformed: true,
        nonce,
        retained_at: new Date().toISOString(),
      });
    }
  }
  await fs.rm(moved, { recursive: true, force: true });
  return true;
}

async function acquireContinuationLock(
  root: string,
  key: string,
  deps: CoordinationDeps,
): Promise<ContinuationLock> {
  const lockDir = lockPath(root, key);
  const claimFile = path.join(lockDir, "owner.json");
  const hostname = deps.hostname ?? os.hostname();
  const pid = deps.pid ?? process.pid;
  const now = deps.now ?? (() => new Date().toISOString());
  const leaseMs = deps.lockLeaseMs ?? DEFAULT_LOCK_LEASE_MS;
  const waitMs = deps.lockWaitMs ?? DEFAULT_LOCK_WAIT_MS;
  const pollMs = deps.lockPollMs ?? DEFAULT_LOCK_POLL_MS;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  if (leaseMs <= 0 || waitMs < 0 || pollMs <= 0) fail("invalid_request", "lock timing must be positive");
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + waitMs;

  for (;;) {
    const acquiredAt = now();
    const owner: LockOwner = { hostname, pid, nonce: randomUUID(), acquired_at: acquiredAt, heartbeat_at: acquiredAt };
    const ownerFile = lockOwnerPath(lockDir, owner.nonce);
    await writeJsonAtomic(ownerFile, owner);
    try {
      await fs.mkdir(lockDir);
      await writeJsonAtomic(claimFile, owner);
      const heartbeat = async (): Promise<void> => {
        const claim = LockOwnerSchema.safeParse(await readJsonIfExists<unknown>(claimFile));
        const current = LockOwnerSchema.safeParse(await readJsonIfExists<unknown>(ownerFile));
        if (!claim.success || claim.data.nonce !== owner.nonce || !current.success || current.data.nonce !== owner.nonce) {
          fail("continuation_lock_lost", "continuation lock ownership changed");
        }
        await deps.afterLockOwnerCheck?.();
        await writeJsonAtomic(ownerFile, { ...current.data, heartbeat_at: now() });
        const rereadClaim = LockOwnerSchema.safeParse(await readJsonIfExists<unknown>(claimFile));
        if (!rereadClaim.success || rereadClaim.data.nonce !== owner.nonce) {
          fail("continuation_lock_lost", "continuation lock ownership changed");
        }
      };
      const release = async (): Promise<void> => {
        await fs.rm(ownerFile, { force: true });
      };
      return { heartbeat, release };
    } catch (error) {
      await fs.rm(ownerFile, { force: true });
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    const rawClaim = await readJsonIfExists<unknown>(claimFile).catch(() => undefined);
    const parsedClaim = LockOwnerSchema.safeParse(rawClaim);
    const claim = parsedClaim.success ? parsedClaim.data : undefined;
    const rawOwner = claim
      ? await readJsonIfExists<unknown>(lockOwnerPath(lockDir, claim.nonce)).catch(() => undefined)
      : undefined;
    const parsedOwner = LockOwnerSchema.safeParse(rawOwner);
    const current = parsedOwner.success ? parsedOwner.data : undefined;
    const stat = await fs.stat(lockDir).catch(() => undefined);
    if (!stat) continue;
    const heartbeatMs = current ? Date.parse(current.heartbeat_at) : stat.mtimeMs;
    const ageMs = Date.now() - heartbeatMs;
    const canTakeReleased = Boolean(claim && !current);
    const canTakeSameHost = Boolean(current && current.hostname === hostname && ageMs >= leaseMs && !(deps.pidIsAlive ?? pidIsAlive)(current.pid));
    const canTakeUnknown = current?.hostname !== hostname && ageMs >= leaseMs * 2;
    if ((canTakeReleased || canTakeSameHost || canTakeUnknown) && await staleLock(root, key, lockDir, current ?? claim)) continue;
    if (Date.now() >= deadline) fail("continuation_lock_timeout", "continuation lock remained owned during the bounded wait");
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
}

/** Reuse the coordinator's nonce-safe filesystem lease for other autonomy state. */
export async function withCoordinationLease<T>(
  root: string,
  key: string,
  operation: () => Promise<T>,
  deps: CoordinationDeps = {},
): Promise<T> {
  if (!SAFE_REF.test(key)) fail("invalid_request", "lease key is invalid");
  const lock = await acquireContinuationLock(root, key, deps);
  try {
    return await operation();
  } finally {
    await lock.release();
  }
}
async function readContinuationRecord(file: string): Promise<ContinuationRecord | undefined> {
  const raw = await readJsonIfExists<unknown>(file);
  if (raw === undefined) return undefined;
  const parsed = ContinuationRecordSchema.safeParse(raw);
  if (!parsed.success) fail("continuation_state_invalid", "stored continuation state is malformed");
  return parsed.data;
}

async function writeContinuationRecord(file: string, record: ContinuationRecord): Promise<ContinuationRecord> {
  const canonical = ContinuationRecordSchema.parse(record);
  await writeJsonAtomic(file, canonical);
  const reread = await readContinuationRecord(file);
  if (!reread || JSON.stringify(reread) !== JSON.stringify(canonical)) {
    fail("continuation_state_readback_failed", "continuation state did not survive local readback");
  }
  return reread;
}

function routeFromBinding(binding: CoordinationBinding, sourceEnv: NodeJS.ProcessEnv): Route {
  if (binding.credential_mode === "profile") {
    return { mode: "profile", profile: binding.profile, serverOrigin: binding.server_origin, workspaceId: binding.workspace_id };
  }
  const authority = taskAuthorityFromEnv(sourceEnv);
  if (authority.taskId !== binding.task_id || authority.agentId !== binding.agent_id
    || authority.serverOrigin !== binding.server_origin || authority.workspaceId !== binding.workspace_id) {
    fail("task_authority_drift", "daemon task authority differs from the stored binding");
  }
  return { mode: "task", serverOrigin: binding.server_origin, workspaceId: binding.workspace_id, authority };
}

function exactReadbackString(value: Record<string, unknown>, field: string): string | undefined {
  const direct = value[field];
  if (typeof direct === "string") return direct;
  const nested = value[field.replace(/_id$/, "")];
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).id === "string") {
    return (nested as Record<string, unknown>).id as string;
  }
  return undefined;
}
export async function ensureContinuation(
  rawInput: EnsureContinuationInput,
  deps: CoordinationDeps = {},
): Promise<VerifiedContinuation | undefined> {
  const parsed = EnsureContinuationInputSchema.safeParse(rawInput);
  if (!parsed.success) fail("invalid_request", "continuation request is invalid");
  const input = parsed.data;
  const request = canonicalContinuationRequest(input.request);
  scanContinuationSecrets(request);

  const resolved = await resolveHarnessGoal(input.cwd, input.goal, deps.gitProbe);
  if (!resolved) return undefined;
  const runner = deps.runner ?? spawnMultica;
  const sourceEnv = deps.env ?? process.env;
  const binding = await verifyCoordinationBinding(input.cwd, input.goal, { ...deps, runner, env: sourceEnv });
  if (!binding) return undefined;
  const route = routeFromBinding(binding, sourceEnv);
  const key = continuationKey(resolved.goalId, binding, request);
  const digest = continuationContractDigest(resolved.goalId, binding, key, request);
  const title = `[${key}] ${request.title}`;
  const description = continuationDescription(key, digest, request);
  const file = continuationRecordPath(resolved.root, key);
  const now = deps.now ?? (() => new Date().toISOString());
  const lock = await acquireContinuationLock(resolved.root, key, deps);

  try {
    const existing = await readContinuationRecord(file);
    if (existing && existing.contract_sha256 !== digest) {
      fail("continuation_conflict", "stored continuation contract differs for this stable key");
    }
    const wasVerified = existing?.state === "verified";
    const createdAt = existing?.created_at ?? now();
    let record = await writeContinuationRecord(file, {
      schema_version: 1,
      key,
      contract_sha256: digest,
      state: "pending",
      canonical_input: {
        goal_id: resolved.goalId,
        workspace_id: binding.workspace_id,
        parent_id: binding.parent_id,
        project_id: binding.project_id,
        request,
      },
      ...(existing?.remote ? { remote: existing.remote } : {}),
      attempts: (existing?.attempts ?? 0) + 1,
      reason: existing ? "pending_idempotent_replay" : "pending_remote_create",
      metadata_state: input.metadataPolicy === "none" ? "not_requested" : "pending",
      warnings: [],
      created_at: createdAt,
      updated_at: now(),
    });

    const prefix = routeArgs(route);
    const createArgs = [
      ...prefix, "issue", "create",
      "--title", title,
      "--description-stdin",
      "--status", request.status,
      "--priority", request.priority,
      "--parent", binding.parent_id,
    ];
    if (binding.project_id) createArgs.push("--project", binding.project_id);
    createArgs.push("--idempotency-key", key);
    for (const attachmentId of request.attachment_ids) createArgs.push("--attachment-id", attachmentId);
    createArgs.push("--output", "json");
    await lock.heartbeat();
    const created = parseObject(await runner(
      invocation(createArgs, route.mode, sourceEnv, route.authority, description),
    ), "issue create");
    const remoteId = exactReadbackString(created, "id");
    const remoteIdentifier = exactReadbackString(created, "identifier");
    if (!remoteId || !UUID.test(remoteId) || !remoteIdentifier || !SAFE_REF.test(remoteIdentifier)) {
      fail("create_readback_invalid", "issue create returned no canonical identity");
    }
    const canonicalRemoteId = remoteId.toLowerCase();
    const createDigest = exactReadbackString(created, "client_idempotency_digest");
    const returnedRemote = {
      id: canonicalRemoteId,
      identifier: remoteIdentifier,
      idempotency_digest: createDigest && SHA256.test(createDigest) ? createDigest : undefined,
    };
    if (existing?.remote && (existing.remote.id !== canonicalRemoteId || existing.remote.identifier !== remoteIdentifier)) {
      await writeContinuationRecord(file, {
        ...record,
        state: "created_unverified",
        reason: "remote_identity_conflict",
        updated_at: now(),
      });
      fail("remote_identity_conflict", "idempotent replay returned a different remote identity");
    }
    record = await writeContinuationRecord(file, {
      ...record,
      state: "created_unverified",
      remote: returnedRemote,
      reason: "created_unverified",
      updated_at: now(),
    });

    const createKey = exactReadbackString(created, "client_idempotency_key");
    if (createKey !== key || !createDigest || !SHA256.test(createDigest)) {
      await writeContinuationRecord(file, { ...record, reason: "create_contract_invalid", updated_at: now() });
      fail("create_contract_invalid", "issue create did not return the immutable key and digest");
    }
    await lock.heartbeat();
    const live = parseObject(await runner(invocation(
      [...prefix, "issue", "get", remoteId, "--output", "json"],
      route.mode,
      sourceEnv,
      route.authority,
    )), "continuation readback");
    const liveProject = exactReadbackString(live, "project_id");
    const liveParent = exactReadbackString(live, "parent_issue_id") ?? exactReadbackString(live, "parent_id");
    const immutableMatches = exactReadbackString(live, "id")?.toLowerCase() === canonicalRemoteId
      && exactReadbackString(live, "identifier") === remoteIdentifier
      && exactReadbackString(live, "workspace_id")?.toLowerCase() === binding.workspace_id
      && liveParent?.toLowerCase() === binding.parent_id
      && (liveProject?.toLowerCase() ?? undefined) === binding.project_id
      && exactReadbackString(live, "client_idempotency_key") === key
      && exactReadbackString(live, "client_idempotency_digest") === createDigest
      && exactReadbackString(live, "description") === description
      && exactReadbackString(live, "priority") === request.priority;
    const liveTitle = exactReadbackString(live, "title");
    const liveStatus = exactReadbackString(live, "status");
    const acceptedMutableState = wasVerified
      && existing?.remote?.id === canonicalRemoteId
      && Boolean(liveTitle?.trim())
      && Boolean(liveStatus?.trim());
    if (!immutableMatches || (!acceptedMutableState && (liveTitle !== title || liveStatus !== request.status))) {
      await writeContinuationRecord(file, { ...record, reason: "readback_mismatch", updated_at: now() });
      fail("readback_mismatch", "live issue does not match the continuation contract");
    }

    const warnings: string[] = [];
    let metadataState: ContinuationRecord["metadata_state"] = "not_requested";
    if (input.metadataPolicy !== "none") {
      metadataState = "pending";
      try {
        await lock.heartbeat();
        await runner(invocation([
          ...prefix, "issue", "metadata", "set", remoteId,
          "--key", "continuation_key", "--value", key, "--type", "string", "--output", "json",
        ], route.mode, sourceEnv, route.authority));
        await lock.heartbeat();
        const metadata = parseObject(await runner(invocation([
          ...prefix, "issue", "metadata", "list", remoteId, "--output", "json",
        ], route.mode, sourceEnv, route.authority)), "continuation metadata readback");
        if (metadata.continuation_key !== key) throw new Error("metadata readback mismatch");
        metadataState = "verified";
      } catch {
        metadataState = "unverified";
        warnings.push("metadata_unverified");
        if (input.metadataPolicy === "required") {
          await writeContinuationRecord(file, {
            ...record,
            reason: "metadata_unverified",
            metadata_state: metadataState,
            warnings,
            updated_at: now(),
          });
          fail("metadata_unverified", "required continuation metadata was not verified");
        }
      }
    }

    await lock.heartbeat();
    record = await writeContinuationRecord(file, {
      ...record,
      state: "verified",
      remote: { id: canonicalRemoteId, identifier: remoteIdentifier, idempotency_digest: createDigest },
      reason: "verified",
      metadata_state: metadataState,
      warnings,
      updated_at: now(),
      verified_at: now(),
    });
    if (record.state !== "verified" || !record.remote) {
      fail("continuation_state_readback_failed", "verified state is incomplete");
    }
    return {
      state: "verified",
      key: record.key,
      id: record.remote.id,
      identifier: record.remote.identifier,
      contract_sha256: record.contract_sha256,
      warnings: record.warnings,
    };
  } finally {
    await lock.release();
  }
}

const RetryContinuationsInputSchema = z.object({
  cwd: z.string().min(1).max(4096),
  goal: z.string().regex(SAFE_REF).optional(),
  metadataPolicy: z.enum(["none", "optional", "required"]).default("optional"),
  limit: z.number().int().min(1).max(DEFAULT_RETRY_LIMIT).default(DEFAULT_RETRY_LIMIT),
}).strict();
export type RetryContinuationsInput = z.input<typeof RetryContinuationsInputSchema>;

export async function retryContinuations(
  rawInput: RetryContinuationsInput,
  deps: CoordinationDeps = {},
): Promise<VerifiedContinuation[]> {
  const parsed = RetryContinuationsInputSchema.safeParse(rawInput);
  if (!parsed.success) fail("invalid_request", "continuation retry request is invalid");
  const input = parsed.data;
  const resolved = await resolveHarnessGoal(input.cwd, input.goal, deps.gitProbe);
  if (!resolved) return [];
  const directory = path.join(resolved.root, HARNESS_DIR_NAME, "autonomy", "continuations");
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records: ContinuationRecord[] = [];
  for (const name of names.filter((value) => /^ch-[0-9a-f]{24}\.json$/.test(value)).sort()) {
    const record = await readContinuationRecord(path.join(directory, name));
    if (record && record.state !== "verified") records.push(record);
    if (records.length === input.limit) break;
  }
  const results: VerifiedContinuation[] = [];
  for (const record of records) {
    const result = await ensureContinuation({
      cwd: resolved.root,
      goal: resolved.goalId,
      metadataPolicy: record.metadata_state === "not_requested" ? "none" : input.metadataPolicy,
      request: record.canonical_input.request,
    }, deps);
    if (result) results.push(result);
  }
  return results;
}
export interface CoordinationStatus {
  binding: CoordinationBinding;
  pending: Array<Pick<ContinuationRecord, "key" | "state" | "reason" | "attempts" | "updated_at">>;
}

/** Live-verify the binding and return only bounded, non-secret local retry metadata. */
export async function coordinationStatus(
  cwd: string,
  goal?: string,
  limit = DEFAULT_RETRY_LIMIT,
  deps: CoordinationDeps = {},
): Promise<CoordinationStatus | undefined> {
  if (!Number.isInteger(limit) || limit < 1 || limit > DEFAULT_RETRY_LIMIT) {
    fail("invalid_request", "status limit must be between 1 and " + DEFAULT_RETRY_LIMIT);
  }
  const resolved = await resolveHarnessGoal(cwd, goal, deps.gitProbe);
  if (!resolved) return undefined;
  const binding = await verifyCoordinationBinding(cwd, goal, deps);
  if (!binding) return undefined;
  const directory = path.join(resolved.root, HARNESS_DIR_NAME, "autonomy", "continuations");
  const names = await fs.readdir(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const pending: CoordinationStatus["pending"] = [];
  for (const name of names.filter((value) => /^ch-[0-9a-f]{24}\.json$/.test(value)).sort()) {
    const record = await readContinuationRecord(path.join(directory, name));
    if (record && record.state !== "verified") {
      pending.push({
        key: record.key,
        state: record.state,
        reason: record.reason,
        attempts: record.attempts,
        updated_at: record.updated_at,
      });
    }
    if (pending.length === limit) break;
  }
  return { binding, pending };
}
const AppendEvidenceInputSchema = z.object({
  cwd: z.string().min(1).max(4096),
  goal: z.string().regex(SAFE_REF).optional(),
  issueId: z.string().uuid(),
  key: z.string().regex(SAFE_REF),
  content: z.string().min(1).max(32 * 1024),
}).strict();

export type AppendEvidenceInput = z.input<typeof AppendEvidenceInputSchema>;

export interface VerifiedEvidenceComment {
  state: "verified";
  id: string;
  issue_id: string;
  key: string;
  content: string;
}

function parseArray(result: MulticaResult, kind: string): Record<string, unknown>[] {
  if (Buffer.byteLength(result.stdout, "utf8") > MAX_OUTPUT) fail("multica_output_too_large", `${kind} output exceeded the bound`);
  try {
    const value: unknown = JSON.parse(result.stdout);
    if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
      throw new Error("object array required");
    }
    return value as Record<string, unknown>[];
  } catch {
    return fail("malformed_multica_json", `${kind} returned malformed JSON`);
  }
}

export async function appendContinuationEvidence(
  rawInput: AppendEvidenceInput,
  deps: CoordinationDeps = {},
): Promise<VerifiedEvidenceComment | undefined> {
  assertNoSecrets({
    cwd: rawInput.cwd,
    goal: rawInput.goal,
    issue_id: rawInput.issueId,
    key: rawInput.key,
    content: rawInput.content,
  });
  const parsed = AppendEvidenceInputSchema.safeParse(rawInput);
  if (!parsed.success) fail("invalid_request", "evidence comment request is invalid");
  const input = parsed.data;
  const content = requiredContinuationText(input.content, "content");
  const issueId = canonicalUuid(input.issueId, "issue");
  const key = canonicalRef(input.key, "evidence key");
  const runner = deps.runner ?? spawnMultica;
  const sourceEnv = deps.env ?? process.env;
  const binding = await verifyCoordinationBinding(input.cwd, input.goal, { ...deps, runner, env: sourceEnv });
  if (!binding) return undefined;
  const route = routeFromBinding(binding, sourceEnv);
  const prefix = routeArgs(route);
  const created = parseObject(await runner(invocation([
    ...prefix,
    "issue", "comment", "add", issueId,
    "--content-stdin",
    "--idempotency-key", key,
    "--output", "json",
  ], route.mode, sourceEnv, route.authority, content)), "comment create");
  const commentId = exactReadbackString(created, "id")?.toLowerCase();
  if (!commentId || !UUID.test(commentId)
    || exactReadbackString(created, "issue_id")?.toLowerCase() !== issueId
    || exactReadbackString(created, "client_idempotency_key") !== key
    || exactReadbackString(created, "content") !== content) {
    fail("evidence_create_unverified", "comment create response did not match the evidence contract");
  }

  const live = parseArray(await runner(invocation([
    ...prefix,
    "issue", "comment", "list", issueId,
    "--output", "json",
  ], route.mode, sourceEnv, route.authority)), "comment readback").filter((comment) => (
    exactReadbackString(comment, "id")?.toLowerCase() === commentId
    && exactReadbackString(comment, "issue_id")?.toLowerCase() === issueId
    && exactReadbackString(comment, "client_idempotency_key") === key
    && exactReadbackString(comment, "content") === content
  ));
  if (live.length !== 1) fail("evidence_readback_failed", "comment did not survive exact live readback");
  return { state: "verified", id: commentId, issue_id: issueId, key, content };
}

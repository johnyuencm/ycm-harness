import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizedSecretScanValue } from "./coordination.js";

export const SCOUT_GUARD_ASSURANCE =
  "Structural guard only; native/MCP/OS actions and reparse TOCTOU remain residual risk.";

const PATH_ADAPTERS = new Set(["project", "harness", "pointer", "memory"]);
const SAFE_FILE_OPERATIONS = new Set(["read"]);
const SAFE_MULTICA_OPERATIONS = new Set(["get", "list", "search", "comments", "runs"]);
const SAFE_GITHUB_OPERATIONS = new Set(["view", "list", "search", "comments"]);
const SAFE_SCHEDULE_OPERATIONS = new Set(["list", "query"]);
const SAFE_GIT_OPERATIONS = new Set(["status", "log"]);
const SENSITIVE_SEGMENT = /^(?:\.env(?:\..*)?|\.git|credentials?|secrets?|tokens?|private[-_. ]?keys?|id_(?:rsa|dsa|ecdsa|ed25519))(?:\..*)?$/i;
const CONTROL_OR_SHELL = /[\u0000-\u001f\u007f\r\n;&|`$<>]/;
const SENSITIVE_QUERY = /\b(?:authorization|bearer|api[_-]?key|access[_-]?token|password|passwd|secret|cookie)\b/i;
const WINDOWS_RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

export type ScoutGuardResult = "allowed" | "denied" | "not_observed";
export type ScoutGuardReason =
  | "allowed" | "unknown_request" | "operation_denied" | "target_missing"
  | "target_ambiguous" | "outside_root" | "sensitive_target" | "reparse_denied"
  | "cwd_denied" | "workspace_denied" | "option_denied" | "composition_denied" | "guard_disabled";

export interface ScoutGuardScope {
  projectRoot: string;
  cwd: string;
  harnessRoot?: string;
  pointerRoots?: readonly string[];
  memoryReferences?: readonly string[];
  multicaWorkspaceId?: string;
  githubRepo?: string;
  gitRoot?: string;
}
export interface ScoutGuardDecision { allowed: boolean; reason: ScoutGuardReason }
interface ObjectRequest {
  adapter: string; operation: string; target?: string; workspaceId?: string;
  query?: string; limit?: number; argv?: string[];
}

export class ScoutGuardError extends Error {
  constructor(readonly reason: ScoutGuardReason) {
    super(`scout_guard_${reason}`);
    this.name = "ScoutGuardError";
  }
}

/** Operator kill switch. Disabled guard means adapters stay unavailable, never unguarded. */
export function scoutGuardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.YCM_HARNESS_SCOUT_GUARD_ENABLED !== "0";
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
function parseRequest(value: unknown): ObjectRequest | undefined {
  const input = object(value);
  if (!input || typeof input.adapter !== "string" || typeof input.operation !== "string") return undefined;
  const allowedKeys = new Set(["adapter", "operation", "target", "workspaceId", "query", "limit", "argv"]);
  if (Object.keys(input).some((key) => !allowedKeys.has(key))) return undefined;
  if (input.target !== undefined && typeof input.target !== "string") return undefined;
  if (input.workspaceId !== undefined && typeof input.workspaceId !== "string") return undefined;
  if (input.query !== undefined && typeof input.query !== "string") return undefined;
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || Number(input.limit) < 1 || Number(input.limit) > 100)) return undefined;
  if (input.argv !== undefined && (!Array.isArray(input.argv) || input.argv.some((arg) => typeof arg !== "string"))) return undefined;
  return input as unknown as ObjectRequest;
}
function deny(reason: ScoutGuardReason): ScoutGuardDecision { return { allowed: false, reason }; }
function key(value: string): string { return process.platform === "win32" ? value.toLowerCase() : value; }
function contains(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
function unsafePathText(value: string): ScoutGuardReason | undefined {
  if (!value || CONTROL_OR_SHELL.test(value)) return "target_ambiguous";
  const normalizedValue = normalizedSecretScanValue(value);
  const normalized = normalizedValue.replace(/\\/g, "/");
  if (normalizedValue.includes("/") && normalizedValue.includes("\\")) return "target_ambiguous";
  if (/^(?:\/\/|\\\\|\\[?.]\\|\/\/[?.]\/)/.test(normalizedValue)) return "target_ambiguous";
  if (process.platform === "win32" ? /^\/(?!\/)/.test(normalizedValue) : /^[A-Za-z]:[\\/]/.test(normalizedValue)) return "target_ambiguous";
  if (normalized.replace(/^[A-Za-z]:/, "").includes(":")) return "target_ambiguous";
  const segments = normalized.split("/").filter(Boolean);
  const rawSegments = value.replace(/\\/g, "/").split("/").filter(Boolean);
  if (segments.some((segment) => segment === ".." || /[ .]$/.test(segment) || WINDOWS_RESERVED.test(segment))
    || rawSegments.some((segment) => /[ .]$/.test(segment))) return "target_ambiguous";
  if (segments.some((segment) => SENSITIVE_SEGMENT.test(segment))) return "sensitive_target";
  return undefined;
}
async function realExisting(value: string): Promise<string | undefined> {
  try { return await fs.realpath(path.resolve(value)); } catch { return undefined; }
}
async function hasReparseComponent(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, path.resolve(target));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return false;
  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try { if ((await fs.lstat(current)).isSymbolicLink()) return true; } catch { return false; }
  }
  return false;
}
function validQuery(request: ObjectRequest): boolean {
  return request.query === undefined
    || (request.query.length <= 512 && !CONTROL_OR_SHELL.test(request.query) && !SENSITIVE_QUERY.test(request.query));
}
function validGitArgv(operation: string, argv: readonly string[]): boolean {
  if (argv.some((arg) => !arg || CONTROL_OR_SHELL.test(arg) || !arg.startsWith("-"))) return false;
  if (operation === "status") {
    return argv.every((arg) => ["--short", "--branch", "--porcelain=v1", "--untracked-files=no"].includes(arg));
  }
  const countOptions = argv.filter((arg) => /^--max-count=(?:[1-9]|1\d|20)$/.test(arg));
  return countOptions.length === 1 && argv.every((arg) => arg === "--no-decorate" || arg === "--format=%h%x09%s"
    || /^--max-count=(?:[1-9]|1\d|20)$/.test(arg));
}

async function authorizePath(scope: ScoutGuardScope, request: ObjectRequest): Promise<ScoutGuardDecision> {
  if (!request.target || request.workspaceId !== undefined || request.query !== undefined || request.limit !== undefined || request.argv !== undefined) return deny("unknown_request");
  if (!SAFE_FILE_OPERATIONS.has(request.operation)) return deny("operation_denied");
  if ((request.adapter === "pointer" || request.adapter === "memory") && request.operation !== "read") return deny("operation_denied");
  const pathReason = unsafePathText(request.target);
  if (pathReason) return deny(pathReason);
  const project = await realExisting(scope.projectRoot);
  const cwd = await realExisting(scope.cwd);
  if (!project || !cwd || !contains(key(project), key(cwd))) return deny("cwd_denied");
  const target = await realExisting(request.target);
  if (!target) return deny("target_missing");
  const configuredRoots = request.adapter === "project" ? [scope.projectRoot]
    : request.adapter === "harness" ? [scope.harnessRoot ?? path.join(scope.projectRoot, ".ycm-harness")]
      : request.adapter === "pointer" ? [...(scope.pointerRoots ?? [path.join(scope.projectRoot, ".ycm-harness", "autonomy")])]
        : [...(scope.memoryReferences ?? [])];
  if (configuredRoots.length === 0) return deny("outside_root");
  for (const configuredRoot of configuredRoots) {
    const root = await realExisting(configuredRoot);
    if (!root) continue;
    if (request.adapter === "memory" ? key(root) === key(target) : contains(key(root), key(target))) {
      if (await hasReparseComponent(root, request.target)) return deny("reparse_denied");
      return { allowed: true, reason: "allowed" };
    }
  }
  return deny("outside_root");
}

/** Authorizes one structured read/list/status request; unknown fields never widen authority. */
export async function authorizeScoutAdapterRequest(scope: ScoutGuardScope, value: unknown): Promise<ScoutGuardDecision> {
  const request = parseRequest(value);
  if (!request) return deny("unknown_request");
  if (PATH_ADAPTERS.has(request.adapter)) return authorizePath(scope, request);
  if (request.target !== undefined) return deny("unknown_request");
  if (!validQuery(request)) return deny("composition_denied");
  if (request.adapter === "multica") {
    if (!SAFE_MULTICA_OPERATIONS.has(request.operation)) return deny("operation_denied");
    if (!scope.multicaWorkspaceId || request.workspaceId !== scope.multicaWorkspaceId) return deny("workspace_denied");
    if (request.argv !== undefined) return deny("option_denied");
    return { allowed: true, reason: "allowed" };
  }
  if (request.adapter === "github") {
    if (!SAFE_GITHUB_OPERATIONS.has(request.operation)) return deny("operation_denied");
    if (!scope.githubRepo || request.workspaceId !== scope.githubRepo) return deny("workspace_denied");
    if (request.argv !== undefined) return deny("option_denied");
    return { allowed: true, reason: "allowed" };
  }
  if (request.adapter === "schedule") {
    if (!SAFE_SCHEDULE_OPERATIONS.has(request.operation)) return deny("operation_denied");
    if (request.workspaceId !== undefined || request.argv !== undefined) return deny("option_denied");
    return { allowed: true, reason: "allowed" };
  }
  if (request.adapter === "git") {
    if (!SAFE_GIT_OPERATIONS.has(request.operation)) return deny("operation_denied");
    if (request.workspaceId !== undefined || request.query !== undefined || request.limit !== undefined) return deny("option_denied");
    const root = await realExisting(scope.gitRoot ?? scope.projectRoot);
    const cwd = await realExisting(scope.cwd);
    if (!root || !cwd || key(root) !== key(cwd)) return deny("cwd_denied");
    if (!validGitArgv(request.operation, request.argv ?? [])) return deny("option_denied");
    return { allowed: true, reason: "allowed" };
  }
  return deny("operation_denied");
}

/** The executor cannot run until the structural decision is allowed. */
export async function executeGuardedScoutAdapter<T>(
  scope: ScoutGuardScope,
  request: unknown,
  execute: () => Promise<T>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  if (!scoutGuardEnabled(env)) throw new ScoutGuardError("guard_disabled");
  const decision = await authorizeScoutAdapterRequest(scope, request);
  if (!decision.allowed) throw new ScoutGuardError(decision.reason);
  return execute();
}

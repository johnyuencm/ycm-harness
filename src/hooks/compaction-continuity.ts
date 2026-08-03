import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSessionDigest, renderSessionContext } from "./session-start.js";
import { writeTextAtomic } from "../state/io.js";
import { redact } from "../wiki/redact.js";

export const MAX_CONTINUITY_INPUT_BYTES = 128 * 1024;
export const MAX_CONTINUITY_FILE_BYTES = 32 * 1024;
export const MAX_CONTINUITY_CONTEXT_BYTES = 2 * 1024;
export const DEFAULT_CONTINUITY_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const CONTINUITY_SCHEMA = "ycm-harness-compaction-continuity/v1";

const MAX_DIRTY_PATHS = 20;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SUMMARY_HEADING = "## Compaction recovery summary";

type RecordLike = Record<string, unknown>;

export interface PreCompactPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  trigger: "manual" | "auto";
}

export interface PostCompactPayload extends PreCompactPayload {
  compact_summary: string;
}

export interface CompactSessionStartPayload {
  session_id: string;
  transcript_path: string;
  cwd: string;
  source: "compact";
}

export interface GitOperationalState {
  root: string;
  branch?: string;
  dirty_paths: string[];
  dirty_truncated: boolean;
  dirty_unavailable?: boolean;
}

export interface ContinuitySnapshotMetadata {
  schema: typeof CONTINUITY_SCHEMA;
  root_hash: string;
  session_hash: string;
  captured_at: string;
  trigger: "manual" | "auto";
  mode: "harness" | "generic";
  summary_present: boolean;
}

export interface ContinuitySnapshot {
  path: string;
  pointer: string;
  metadata: ContinuitySnapshotMetadata;
  markdown: string;
}

export interface ContinuityOptions {
  configDir?: string;
  now?: () => Date;
  maxAgeMs?: number;
  gitProbe?: (cwd: string) => Promise<GitOperationalState>;
}

function object(value: unknown): RecordLike | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as RecordLike
    : undefined;
}

function requiredText(value: unknown, maxLength: number): string | undefined {
  return typeof value === "string" && value.trim() && value.length <= maxLength
    ? value.trim()
    : undefined;
}

function eventIs(input: RecordLike, expected: string): boolean {
  return input.hook_event_name === expected || input.hookEventName === expected;
}

function validCommonPayload(value: unknown, event: string): { input: RecordLike; session_id: string; transcript_path: string; cwd: string } | undefined {
  const input = object(value);
  if (!input || !eventIs(input, event)) return undefined;
  const session_id = requiredText(input.session_id ?? input.sessionId, 512);
  const transcript_path = requiredText(input.transcript_path ?? input.transcriptPath, 4096);
  const cwd = requiredText(input.cwd, 4096);
  if (!session_id || !transcript_path || !cwd || !path.isAbsolute(transcript_path) || !path.isAbsolute(cwd)) return undefined;
  return { input, session_id, transcript_path: path.resolve(transcript_path), cwd: path.resolve(cwd) };
}

export function validatePreCompactPayload(value: unknown): PreCompactPayload | undefined {
  const common = validCommonPayload(value, "PreCompact");
  if (!common) return undefined;
  const trigger = common.input.trigger;
  if (trigger !== "manual" && trigger !== "auto") return undefined;
  return { session_id: common.session_id, transcript_path: common.transcript_path, cwd: common.cwd, trigger };
}

export function validatePostCompactPayload(value: unknown): PostCompactPayload | undefined {
  const common = validCommonPayload(value, "PostCompact");
  if (!common) return undefined;
  const trigger = common.input.trigger;
  if (trigger !== "manual" && trigger !== "auto") return undefined;
  if (typeof common.input.compact_summary !== "string") return undefined;
  return {
    session_id: common.session_id,
    transcript_path: common.transcript_path,
    cwd: common.cwd,
    trigger,
    compact_summary: common.input.compact_summary,
  };
}

export function validateCompactSessionStartPayload(value: unknown): CompactSessionStartPayload | undefined {
  const common = validCommonPayload(value, "SessionStart");
  if (!common || common.input.source !== "compact") return undefined;
  return { session_id: common.session_id, transcript_path: common.transcript_path, cwd: common.cwd, source: "compact" };
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizedRoot(root: string): string {
  const resolved = path.resolve(root);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function rootHash(root: string): string {
  return sha(`root\0${normalizedRoot(root)}`).slice(0, 32);
}

function sessionHash(sessionId: string): string {
  return sha(`session\0${sessionId}`).slice(0, 32);
}

function configDir(options: ContinuityOptions): string {
  const configured = options.configDir ?? process.env.CLAUDE_CONFIG_DIR;
  return path.resolve(configured || path.join(os.homedir(), ".claude"));
}

export function continuitySnapshotLocation(root: string, sessionId: string, options: ContinuityOptions = {}): { path: string; pointer: string; root_hash: string; session_hash: string } {
  const root_hash = rootHash(root);
  const session_hash = sessionHash(sessionId);
  const relative = path.join("ycm-harness", "compaction-continuity", root_hash, session_hash, "continuity.md");
  return {
    path: path.join(configDir(options), "cache", relative),
    pointer: `claude-cache://${relative.replaceAll(path.sep, "/")}`,
    root_hash,
    session_hash,
  };
}

export function truncateUtf8(input: string, maxBytes: number, suffix = "\n…[truncated]"): string {
  if (maxBytes <= 0) return "";
  if (Buffer.byteLength(input, "utf8") <= maxBytes) return input;
  const fittedSuffix = Buffer.byteLength(suffix, "utf8") <= maxBytes ? suffix : "";
  const limit = maxBytes - Buffer.byteLength(fittedSuffix, "utf8");
  let used = 0;
  let output = "";
  for (const char of input) {
    const bytes = Buffer.byteLength(char, "utf8");
    if (used + bytes > limit) break;
    output += char;
    used += bytes;
  }
  return output + fittedSuffix;
}

interface GitCommandResult {
  output?: string;
  unavailable: boolean;
}

function runGit(cwd: string, args: string[]): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd,
      encoding: "utf8",
      timeout: 1_200,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
    }, (error, stdout) => {
      if (!error) resolve({ output: String(stdout).trim(), unavailable: false });
      else resolve({ unavailable: typeof error.code !== "number" });
    });
  });
}

export async function collectGitOperationalState(cwd: string): Promise<GitOperationalState> {
  let canonicalCwd: string;
  try { canonicalCwd = await fs.realpath(cwd); } catch { canonicalCwd = path.resolve(cwd); }
  const rootProbe = await runGit(canonicalCwd, ["rev-parse", "--show-toplevel"]);
  if (rootProbe.unavailable) {
    return { root: canonicalCwd, branch: "unavailable", dirty_paths: [], dirty_truncated: false, dirty_unavailable: true };
  }
  const root = rootProbe.output ? path.resolve(rootProbe.output) : canonicalCwd;
  if (!rootProbe.output) return { root, dirty_paths: [], dirty_truncated: false };

  const [branchProbe, detachedProbe, statusProbe] = await Promise.all([
    runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(root, ["rev-parse", "--short", "HEAD"]),
    runGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"]),
  ]);
  if (branchProbe.unavailable || detachedProbe.unavailable || statusProbe.unavailable || statusProbe.output === undefined) {
    return {
      root,
      branch: branchProbe.output || (detachedProbe.output ? `(detached ${detachedProbe.output})` : "unknown"),
      dirty_paths: [],
      dirty_truncated: false,
      dirty_unavailable: true,
    };
  }
  const allDirty = statusProbe.output
    .split(/\r?\n/u)
    .filter(Boolean)
    .map((line) => line.length > 3 ? line.slice(3).trim() : line.trim())
    .filter(Boolean)
    .map((item) => truncateUtf8(item, 512, "…"));
  return {
    root,
    branch: truncateUtf8(branchProbe.output || (detachedProbe.output ? `(detached ${detachedProbe.output})` : "unknown"), 256, "…"),
    dirty_paths: allDirty.slice(0, MAX_DIRTY_PATHS),
    dirty_truncated: allDirty.length > MAX_DIRTY_PATHS,
  };
}

async function operationalState(cwd: string, options: ContinuityOptions): Promise<GitOperationalState> {
  return (options.gitProbe ?? collectGitOperationalState)(cwd);
}

function metadataLine(metadata: ContinuitySnapshotMetadata): string {
  return `<!-- ${CONTINUITY_SCHEMA} ${JSON.stringify(metadata)} -->`;
}

function parseMetadata(markdown: string): ContinuitySnapshotMetadata | undefined {
  const firstLine = markdown.split(/\r?\n/u, 1)[0];
  const prefix = `<!-- ${CONTINUITY_SCHEMA} `;
  if (!firstLine?.startsWith(prefix) || !firstLine.endsWith(" -->")) return undefined;
  try {
    const parsed = object(JSON.parse(firstLine.slice(prefix.length, -4)));
    if (!parsed || parsed.schema !== CONTINUITY_SCHEMA) return undefined;
    if (typeof parsed.root_hash !== "string" || !/^[0-9a-f]{32}$/u.test(parsed.root_hash)) return undefined;
    if (typeof parsed.session_hash !== "string" || !/^[0-9a-f]{32}$/u.test(parsed.session_hash)) return undefined;
    if (typeof parsed.captured_at !== "string" || !Number.isFinite(Date.parse(parsed.captured_at))) return undefined;
    if (parsed.trigger !== "manual" && parsed.trigger !== "auto") return undefined;
    if (parsed.mode !== "harness" && parsed.mode !== "generic") return undefined;
    if (typeof parsed.summary_present !== "boolean") return undefined;
    return parsed as unknown as ContinuitySnapshotMetadata;
  } catch {
    return undefined;
  }
}

function gitLines(git: GitOperationalState): string[] {
  const dirty = git.dirty_unavailable ? "unavailable" : `${git.dirty_paths.length}${git.dirty_truncated ? "+" : ""}`;
  const lines = [`- Branch: ${git.branch ?? "not a Git repository"}`, `- Dirty paths: ${dirty}`];
  for (const dirty of git.dirty_paths) lines.push(`  - ${dirty}`);
  return lines;
}

function baseMarkdown(metadata: ContinuitySnapshotMetadata, git: GitOperationalState, state: unknown): string {
  const digest = buildSessionDigest(state);
  const digestText = digest.active
    ? truncateUtf8(renderSessionContext(digest), 8 * 1024)
    : "No active YCM Harness workflow. This snapshot is generic operational recovery state only.";
  const markdown = [
    metadataLine(metadata),
    "# Claude compaction continuity",
    "",
    "Generated private recovery state. YCM Harness canonical state remains authoritative.",
    "",
    `- Captured: ${metadata.captured_at}`,
    `- Trigger: ${metadata.trigger}`,
    `- Mode: ${metadata.mode}`,
    "",
    "## Bounded Git state",
    ...gitLines(git),
    "",
    "## Operational state at capture",
    digestText,
    "",
    "## Recovery policy",
    "SessionStart recomputes active YCM Harness state from canonical state.json. Cached fields never override live goal, ticket, blocker, decisions, or next action.",
    "",
  ].join("\n");
  return redact(markdown).redacted;
}

function withSummary(base: string, summary: string): string {
  const withoutOld = base.includes(`\n${SUMMARY_HEADING}\n`)
    ? base.slice(0, base.indexOf(`\n${SUMMARY_HEADING}\n`)).trimEnd() + "\n"
    : base.trimEnd() + "\n";
  const heading = `\n${SUMMARY_HEADING}\nStored privately for recovery. This summary is never reinjected verbatim.\n\n`;
  const allowance = Math.max(0, MAX_CONTINUITY_FILE_BYTES - Buffer.byteLength(withoutOld + heading + "\n", "utf8"));
  return withoutOld + heading + truncateUtf8(redact(summary).redacted.trim(), allowance) + "\n";
}

async function renderNewSnapshot(payload: PreCompactPayload, state: unknown, options: ContinuityOptions): Promise<ContinuitySnapshot> {
  const git = await operationalState(payload.cwd, options);
  const location = continuitySnapshotLocation(git.root, payload.session_id, options);
  const metadata: ContinuitySnapshotMetadata = {
    schema: CONTINUITY_SCHEMA,
    root_hash: location.root_hash,
    session_hash: location.session_hash,
    captured_at: (options.now ?? (() => new Date()))().toISOString(),
    trigger: payload.trigger,
    mode: buildSessionDigest(state).active ? "harness" : "generic",
    summary_present: false,
  };
  const markdown = truncateUtf8(baseMarkdown(metadata, git, state), MAX_CONTINUITY_FILE_BYTES);
  return { path: location.path, pointer: location.pointer, metadata, markdown };
}

export async function capturePreCompact(payloadValue: unknown, state: unknown, options: ContinuityOptions = {}): Promise<ContinuitySnapshot | undefined> {
  const payload = validatePreCompactPayload(payloadValue);
  if (!payload) return undefined;
  const snapshot = await renderNewSnapshot(payload, state, options);
  await writeTextAtomic(snapshot.path, snapshot.markdown, 0o600);
  return snapshot;
}

async function readSnapshot(root: string, sessionId: string, options: ContinuityOptions): Promise<ContinuitySnapshot | undefined> {
  const location = continuitySnapshotLocation(root, sessionId, options);
  try {
    const stat = await fs.stat(location.path);
    if (!stat.isFile() || stat.size > MAX_CONTINUITY_FILE_BYTES) return undefined;
    const markdown = await fs.readFile(location.path, "utf8");
    const metadata = parseMetadata(markdown);
    if (!metadata || metadata.root_hash !== location.root_hash || metadata.session_hash !== location.session_hash) return undefined;
    const captured = Date.parse(metadata.captured_at);
    const now = (options.now ?? (() => new Date()))().getTime();
    const maxAge = options.maxAgeMs ?? DEFAULT_CONTINUITY_MAX_AGE_MS;
    if (captured > now + MAX_CLOCK_SKEW_MS || now - captured > maxAge) return undefined;
    return { path: location.path, pointer: location.pointer, metadata, markdown };
  } catch {
    return undefined;
  }
}

export async function persistPostCompact(payloadValue: unknown, state: unknown, options: ContinuityOptions = {}): Promise<ContinuitySnapshot | undefined> {
  const payload = validatePostCompactPayload(payloadValue);
  if (!payload) return undefined;
  const git = await operationalState(payload.cwd, options);
  let snapshot = await readSnapshot(git.root, payload.session_id, options);
  if (!snapshot) snapshot = await renderNewSnapshot(payload, state, { ...options, gitProbe: async () => git });
  const metadata = { ...snapshot.metadata, summary_present: true };
  const base = snapshot.markdown.replace(/^.*?(?:\r?\n)/u, `${metadataLine(metadata)}\n`);
  const markdown = withSummary(base, payload.compact_summary);
  if (Buffer.byteLength(markdown, "utf8") > MAX_CONTINUITY_FILE_BYTES) return undefined;
  await writeTextAtomic(snapshot.path, markdown, 0o600);
  return { ...snapshot, metadata, markdown };
}

function compactGitSummary(git: GitOperationalState): string {
  const branch = truncateUtf8(git.branch ?? "not a repository", 96, "…");
  const dirty = git.dirty_unavailable ? "unavailable" : `${git.dirty_paths.length}${git.dirty_truncated ? "+" : ""}`;
  return `Git: ${branch}; dirty paths ${dirty}.`;
}

function compactDirtyDetail(git: GitOperationalState): string | undefined {
  if (!git.dirty_paths.length) return undefined;
  const detail = `${git.dirty_paths.slice(0, 6).join(", ")}${git.dirty_paths.length > 6 || git.dirty_truncated ? ", …" : ""}`;
  return `Dirty: ${truncateUtf8(detail, 256, "…")}`;
}

function boundedRedactedLine(line: string, maxBytes = 128): string {
  return truncateUtf8(redact(line).redacted, maxBytes, "…");
}

function boundedLiveContext(state: unknown): { active: boolean; required: string[]; optional: string[] } {
  const digest = buildSessionDigest(state);
  if (!digest.active) return { active: false, required: [], optional: [] };
  const requiredPrefixes = ["# ycm-harness", "Goal:", "Ticket:", "Blocker:", "Next:"];
  const required: string[] = [];
  const optional: string[] = [];
  for (const line of renderSessionContext(digest).split("\n")) {
    const bounded = boundedRedactedLine(line);
    (requiredPrefixes.some((prefix) => line.startsWith(prefix)) ? required : optional).push(bounded);
  }
  return { active: true, required, optional };
}

function fits(lines: string[]): boolean {
  return Buffer.byteLength(lines.join("\n"), "utf8") <= MAX_CONTINUITY_CONTEXT_BYTES;
}

export async function buildCompactSessionContext(state: unknown, payloadValue: unknown, options: ContinuityOptions = {}): Promise<string> {
  const payload = validateCompactSessionStartPayload(payloadValue);
  if (!payload) return "";
  const git = await operationalState(payload.cwd, options);
  const snapshot = await readSnapshot(git.root, payload.session_id, options);
  const live = boundedLiveContext(state);
  const gitLine = boundedRedactedLine(compactGitSummary(git), 192);
  const snapshotLine = boundedRedactedLine(snapshot ? `Snapshot: ${snapshot.pointer}` : "Snapshot: unavailable or stale.", 256);
  const lines = live.active
    ? [...live.required, "", "# Compaction continuity", gitLine, snapshotLine]
    : ["# Compaction continuity", "Mode: generic; no active YCM Harness workflow. Do not create a parallel workflow from this card.", gitLine, snapshotLine, "Next: continue the user's current task using the conversation and repository as authority."];
  for (const line of live.optional) {
    const insertion = lines.indexOf("");
    const candidate = [...lines];
    candidate.splice(insertion, 0, line);
    if (fits(candidate)) lines.splice(insertion, 0, line);
  }
  const optional = [
    snapshot?.metadata.summary_present ? "Recovery summary: stored privately; not reinjected." : undefined,
    compactDirtyDetail(git),
  ].filter((line): line is string => !!line).map((line) => boundedRedactedLine(line, 256));
  for (const line of optional) if (fits([...lines, line])) lines.push(line);
  return lines.join("\n");
}

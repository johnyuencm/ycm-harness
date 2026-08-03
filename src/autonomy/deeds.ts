import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import {
  assertNoSecrets,
  type CoordinationDeps,
  resolveHarnessGoal,
  withCoordinationLease,
} from "./coordination.js";

const SAFE_ID = z.string().min(1).max(256);
const PostToolUsePayloadSchema = z.object({
  session_id: SAFE_ID,
  turn_id: SAFE_ID,
  cwd: z.string().min(1).max(4096),
  hook_event_name: z.literal("PostToolUse"),
  model: z.string().min(1).max(256),
  tool_name: z.string().min(1).max(128),
  tool_input: z.record(z.unknown()),
  tool_response: z.unknown(),
  tool_use_id: SAFE_ID,
}).strict();

function safeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function safeObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function normalizeToolName(toolName: string): string {
  const normalized = toolName.trim();
  if (normalized === "Bash") return "shell_command";
  if (normalized === "exec" || normalized === "Exec") return "exec_command";
  return normalized;
}

/** Map Codex/Cursor host payloads onto the strict internal deed schema. */
export function normalizePostToolUsePayload(raw: unknown): PostToolUsePayload | undefined {
  const obj = safeObject(raw);
  if (!obj) return undefined;
  const hookEvent = safeString(obj.hook_event_name ?? obj.hookEventName);
  if (hookEvent && hookEvent !== "PostToolUse") return undefined;
  const sessionId = safeString(obj.session_id ?? obj.sessionId);
  const turnId = safeString(obj.turn_id ?? obj.turnId ?? obj.thread_id ?? obj.threadId);
  const toolUseId = safeString(obj.tool_use_id ?? obj.toolUseId);
  const toolName = normalizeToolName(safeString(obj.tool_name ?? obj.toolName));
  const cwd = safeString(obj.cwd) || process.cwd();
  if (!sessionId || !turnId || !toolUseId || !toolName) return undefined;
  const candidate = {
    session_id: sessionId,
    turn_id: turnId,
    cwd,
    hook_event_name: "PostToolUse" as const,
    model: safeString(obj.model) || "unknown",
    tool_name: toolName,
    tool_input: safeObject(obj.tool_input ?? obj.toolInput) ?? {},
    tool_response: obj.tool_response ?? obj.tool_output ?? obj.toolOutput,
    tool_use_id: toolUseId,
  };
  const parsed = PostToolUsePayloadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : undefined;
}

export type PostToolUsePayload = z.infer<typeof PostToolUsePayloadSchema>;
export interface DeedHandlerDeps extends CoordinationDeps {
  now?: () => string;
  afterEventWrite?: () => Promise<void>;
}

const DeedEventSchema = z.object({
  schema_version: z.literal(1),
  session_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  turn_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  tool_use_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  payload_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  occurred_at: z.string().datetime(),
  tool_name: z.enum(["apply_patch", "edit_file", "write_file", "delete_file", "move_file", "shell_command", "exec_command", "continuation"]),
  kind: z.enum(["mutation", "verification", "continuation"]),
  outcome: z.literal("success"),
  reason: z.enum(["allowlisted_success", "explicit_follow_up", "verified_continuation"]),
  verified_refs: z.array(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/)).max(12),
}).strict();
type DeedEvent = z.infer<typeof DeedEventSchema>;

export interface DeedWriteResult {
  status: "ignored" | "written" | "replayed" | "quarantined";
  pointer?: string;
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function successful(response: unknown): boolean {
  if (response && typeof response === "object") {
    const value = response as Record<string, unknown>;
    if (value.success === true) return true;
    if (value.exit_code === 0 || value.exitCode === 0) return true;
    return typeof value.status === "string" && /^(?:success|succeeded|complete|completed)$/i.test(value.status);
  }
  return typeof response === "string" && (
    /\b(?:exit code|status)\s*[:=]\s*0\b/i.test(response)
    || /^(?:success|done|completed)\b/i.test(response.trim())
  );
}

function classify(payload: PostToolUsePayload): DeedEvent["kind"] | undefined {
  if (!successful(payload.tool_response)) return undefined;
  if (["apply_patch", "edit_file", "write_file", "delete_file", "move_file"].includes(payload.tool_name)) return "mutation";
  if (!["shell_command", "exec_command"].includes(payload.tool_name)) return undefined;
  const command = typeof payload.tool_input.command === "string" ? payload.tool_input.command.trim() : "";
  if (/^(?:(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|lint|build|smoke|check)\b|node\s+--test\b|npx\s+(?:tsc|eslint)\b|(?:pytest|cargo\s+test|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|git\s+diff\s+--check)\b)/i.test(command)) return "verification";
  if (/^(?:git\s+(?:add|commit|mv|rm)\b|(?:npm|pnpm|yarn)\s+(?:install|uninstall|add|remove)\b|(?:mkdir|new-item|set-content|add-content|remove-item|move-item|copy-item)\b)/i.test(command)) return "mutation";
  return undefined;
}

function locations(root: string, sessionId: string, turnId: string, toolUseId: string, date: string) {
  const session = sha(sessionId);
  const turn = sha(turnId);
  const tool = sha(toolUseId);
  const base = path.join(root, HARNESS_DIR_NAME, "autonomy");
  return {
    session,
    turn,
    tool,
    eventDir: path.join(base, "events", session, turn),
    event: path.join(base, "events", session, turn, `${tool}.json`),
    quarantineDir: path.join(base, "quarantine", session, turn),
    pointer: path.join(base, "deed-pointers", date, `${session.slice(0, 16)}--${turn.slice(0, 16)}.md`),
    leaseKey: `deed-${session.slice(0, 16)}-${turn.slice(0, 16)}`,
  };
}

async function writeTextAtomic(file: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  await fs.writeFile(temporary, content, "utf8");
  await fs.rename(temporary, file);
}

async function rebuildPointer(eventDir: string, pointer: string, session: string, turn: string): Promise<void> {
  const names = await fs.readdir(eventDir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const events: DeedEvent[] = [];
  for (const name of names.filter((name) => /^[0-9a-f]{64}\.json$/.test(name)).sort()) {
    const parsed = DeedEventSchema.safeParse(await readJsonIfExists<unknown>(path.join(eventDir, name)));
    if (parsed.success) events.push(parsed.data);
  }
  if (!events.length) return;
  const kinds = [...new Set(events.map((event) => event.kind))].sort();
  const refs = [...new Set(events.flatMap((event) => event.verified_refs))].sort();
  const evidence = events.map((event) => `- ${event.tool_use_sha256.slice(0, 16)} ${event.kind} ${event.payload_sha256.slice(0, 16)}`);
  const body = [
    "# Deed pointer",
    "",
    `- **Session:** ${session.slice(0, 16)}`,
    `- **Turn:** ${turn.slice(0, 16)}`,
    `- **Deed:** ${kinds.join(", ")}`,
    "- **Evidence:**",
    ...evidence,
    `- **Verified continuations:** ${refs.length ? refs.join(", ") : "none"}`,
    "- **Review focus:** verify the indexed event digests and durable continuation readbacks",
    "- **Risks/notes:** pointer contains allowlisted derived facts only",
    "",
  ].join("\n");
  await writeTextAtomic(pointer, body);
}

export async function handlePostToolUse(
  rawPayload: unknown,
  deps: DeedHandlerDeps = {},
): Promise<DeedWriteResult> {
  const payload = normalizePostToolUsePayload(rawPayload);
  if (!payload) return { status: "ignored" };
  const kind = classify(payload);
  if (!kind) return { status: "ignored" };
  const resolved = await resolveHarnessGoal(payload.cwd, undefined, deps.gitProbe);
  if (!resolved) return { status: "ignored" };
  const occurredAt = (deps.now ?? (() => new Date().toISOString()))();
  const date = occurredAt.slice(0, 10);
  const loc = locations(resolved.root, payload.session_id, payload.turn_id, payload.tool_use_id, date);
  const payloadDigest = sha(stable({ tool_name: payload.tool_name, tool_input: payload.tool_input, tool_response: payload.tool_response }));
  const event = DeedEventSchema.parse({
    schema_version: 1,
    session_sha256: loc.session,
    turn_sha256: loc.turn,
    tool_use_sha256: loc.tool,
    payload_sha256: payloadDigest,
    occurred_at: occurredAt,
    tool_name: payload.tool_name,
    kind,
    outcome: "success",
    reason: "allowlisted_success",
    verified_refs: [],
  });
  return withCoordinationLease(resolved.root, loc.leaseKey, async () => {
    const existingRaw = await readJsonIfExists<unknown>(loc.event);
    if (existingRaw !== undefined) {
      const existing = DeedEventSchema.safeParse(existingRaw);
      if (existing.success && existing.data.payload_sha256 === event.payload_sha256) {
        await rebuildPointer(loc.eventDir, loc.pointer, loc.session, loc.turn);
        return { status: "replayed", pointer: loc.pointer };
      }
      const quarantine = path.join(loc.quarantineDir, `${loc.tool}-${event.payload_sha256}.json`);
      if (await readJsonIfExists<unknown>(quarantine) === undefined) {
        await writeJsonAtomic(quarantine, {
          schema_version: 1,
          session_sha256: loc.session,
          turn_sha256: loc.turn,
          tool_use_sha256: loc.tool,
          rejected_payload_sha256: event.payload_sha256,
          reason: "event_replay_conflict",
        });
      }
      return { status: "quarantined", pointer: loc.pointer };
    }
    await writeJsonAtomic(loc.event, event);
    await deps.afterEventWrite?.();
    await rebuildPointer(loc.eventDir, loc.pointer, loc.session, loc.turn);
    return { status: "written", pointer: loc.pointer };
  }, deps);
}

export async function recordVerifiedContinuations(
  input: { cwd: string; sessionId: string; turnId: string; references: string[] },
  deps: DeedHandlerDeps = {},
): Promise<string | undefined> {
  if (!input.references.length) return undefined;
  const resolved = await resolveHarnessGoal(input.cwd, undefined, deps.gitProbe);
  if (!resolved) return undefined;
  const occurredAt = (deps.now ?? (() => new Date().toISOString()))();
  const refs = [...new Set(input.references)].sort().slice(0, 12);
  if (refs.some((ref) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/.test(ref))) throw new Error("invalid_continuation_reference");
  refs.forEach((ref, index) => assertNoSecrets({ [`verified_ref_${index}`]: ref }));
  const syntheticId = `continuation:${sha(refs.join("\n"))}`;
  const loc = locations(resolved.root, input.sessionId, input.turnId, syntheticId, occurredAt.slice(0, 10));
  const event = DeedEventSchema.parse({
    schema_version: 1,
    session_sha256: loc.session,
    turn_sha256: loc.turn,
    tool_use_sha256: loc.tool,
    payload_sha256: sha(stable(refs)),
    occurred_at: occurredAt,
    tool_name: "continuation",
    kind: "continuation",
    outcome: "success",
    reason: "verified_continuation",
    verified_refs: refs,
  });
  return withCoordinationLease(resolved.root, loc.leaseKey, async () => {
    const existing = await readJsonIfExists<unknown>(loc.event);
    if (existing === undefined) await writeJsonAtomic(loc.event, event);
    await rebuildPointer(loc.eventDir, loc.pointer, loc.session, loc.turn);
    return loc.pointer;
  }, deps);
}
const FOLLOW_UP_HEADINGS = "Follow-ups|Next steps|Action items|Open items|TODO|To do|Remaining work";
const SENTINEL = /^(?:none|n\/?a|nothing|tbd|no(?: concrete)? follow-?ups?|no follow up needed|not needed)[.!]?$/i;

function normalizeFollowUp(value: string): string | undefined {
  const normalized = value
    .replace(/^\s*(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s*)/, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.;]+$/, "")
    .trim();
  if (!normalized || SENTINEL.test(normalized)) return undefined;
  return normalized.slice(0, 512);
}

/** Parse only explicit approved headings with a heading tail or list items. */
export function parseExplicitFollowUps(message: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  let inSection = false;
  const heading = new RegExp(`^\\s*(?:#{1,6}\\s*)?(?:\\*\\*)?(${FOLLOW_UP_HEADINGS})(?:\\*\\*)?\\s*(?::\\s*(.*))?$`, "i");
  const bullet = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.+)$/;
  for (const line of message.slice(0, 64 * 1024).split(/\r?\n/)) {
    const match = line.match(heading);
    if (match) {
      inSection = true;
      const tail = normalizeFollowUp(match[2] ?? "");
      if (tail && !seen.has(tail.toLowerCase())) {
        seen.add(tail.toLowerCase());
        found.push(tail);
      }
      if (found.length === 12) break;
      continue;
    }
    if (/^\s*#{1,6}\s+/.test(line)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const item = line.match(bullet);
    if (!item) {
      if (line.trim()) inSection = false;
      continue;
    }
    const value = normalizeFollowUp(item[1]!);
    if (value && !seen.has(value.toLowerCase())) {
      seen.add(value.toLowerCase());
      found.push(value);
    }
    if (found.length === 12) break;
  }
  return found;
}

export function buildFollowUpRequest(item: string) {
  const title = normalizeFollowUp(item);
  if (!title) throw new Error("invalid_follow_up");
  return {
    title,
    source_class: "stop_follow_up",
    source: "Explicit final-response follow-up",
    problem: title,
    impact_scope: "The follow-up may be lost if it is not tracked durably.",
    owner_control: "Unassigned; the durable parent remains the coordination authority.",
    acceptance: [`Complete the requested follow-up: ${title}`],
    verification: ["Attach concrete evidence and live-read the durable child before closure."],
    dependencies: [],
    safety_blockers: [],
    cost_class: "bounded-unknown",
    evidence_horizon: "Before the active goal is finished.",
    rollback: "Stop before destructive or irreversible work and leave the child open with the blocker.",
    status: "todo" as const,
    priority: "medium" as const,
  };
}
export async function persistStopFollowUps(
  input: { cwd: string; sessionId: string; turnId: string; items: string[] },
  deps: DeedHandlerDeps = {},
): Promise<string | undefined> {
  if (!input.items.length) return undefined;
  input.items.forEach((item, index) => assertNoSecrets({ [`follow_up_${index}`]: item }));
  const resolved = await resolveHarnessGoal(input.cwd, undefined, deps.gitProbe);
  if (!resolved) return undefined;
  const occurredAt = (deps.now ?? (() => new Date().toISOString()))();
  const digest = sha(stable(input.items));
  const loc = locations(resolved.root, input.sessionId, input.turnId, `follow-ups:${digest}`, occurredAt.slice(0, 10));
  const event = DeedEventSchema.parse({
    schema_version: 1,
    session_sha256: loc.session,
    turn_sha256: loc.turn,
    tool_use_sha256: loc.tool,
    payload_sha256: digest,
    occurred_at: occurredAt,
    tool_name: "continuation",
    kind: "continuation",
    outcome: "success",
    reason: "explicit_follow_up",
    verified_refs: [],
  });
  return withCoordinationLease(resolved.root, loc.leaseKey, async () => {
    const safeFile = path.join(resolved.root, HARNESS_DIR_NAME, "autonomy", "follow-ups", loc.session, `${loc.turn}.json`);
    const existing = await readJsonIfExists<unknown>(safeFile);
    if (existing === undefined) {
      await writeJsonAtomic(safeFile, { schema_version: 1, session_sha256: loc.session, turn_sha256: loc.turn, items: input.items, contract_sha256: digest });
    } else if ((existing as Record<string, unknown>).contract_sha256 !== digest) {
      throw new Error("follow_up_replay_conflict");
    }
    if (await readJsonIfExists<unknown>(loc.event) === undefined) await writeJsonAtomic(loc.event, event);
    await rebuildPointer(loc.eventDir, loc.pointer, loc.session, loc.turn);
    return loc.pointer;
  }, deps);
}
import { createHash } from "node:crypto";
import { spawnMultica, spawnGh, ghChildEnv, type MulticaRunner, type GhRunner } from "../autonomy/coordination.js";
import type { LiveTicketProof } from "../continuation/finalizer.js";
import { StateV3, type StateV3T, type TicketBackendT, type TicketStatusT, type TicketT } from "../schema/v3.js";
import {
  ISSUE_MARKER_BRAND,
  ISSUE_MARKER_BRAND_RE,
} from "../branding.js";

export interface TicketCreateInput {
  title: string;
  brief?: string;
  acceptance?: string[];
  blocked_by?: string[];
  code_changed?: boolean;
}

export const STRATEGIC_TICKET_PRIORITIES = ["urgent", "high", "medium", "low"] as const;
export type StrategicTicketPriority = typeof STRATEGIC_TICKET_PRIORITIES[number];

export interface StrategicTicketCommentRead {
  id: string;
  content: string;
  action_identity: string | null;
}

export interface StrategicTicketRead {
  kind: "ticket";
  ticket_id: string;
  identifier?: string | null;
  title: string;
  description?: string;
  root_cause: string;
  action_identities: string[];
  owner: string | null;
  priority: StrategicTicketPriority;
  status?: TicketStatusT;
  comments: StrategicTicketCommentRead[];
  provider_proof: {
    source: string;
    digest: string;
    read_at: string;
  };
}

export interface StrategicTicketCapability {
  search(query: { root_cause: string; action_identity: string; owner: null }): Promise<StrategicTicketRead[]>;
  read(id: string): Promise<StrategicTicketRead | undefined>;
  create(input: {
    title: string;
    brief: string;
    acceptance: string[];
    root_cause: string;
    action_identity: string;
    owner: null;
  }): Promise<StrategicTicketRead>;
  comment(id: string, content: string, actionIdentity: string): Promise<StrategicTicketRead>;
  setPriority(id: string, priority: StrategicTicketPriority, actionIdentity?: string): Promise<StrategicTicketRead>;
}

export interface TicketProvider {
  readonly backend: TicketBackendT;
  readonly strategic?: StrategicTicketCapability;
  list(goalId: string): Promise<TicketT[]>;
  get(id: string): Promise<TicketT | undefined>;
  create(goalId: string, input: TicketCreateInput): Promise<TicketT>;
  setStatus(id: string, status: TicketStatusT): Promise<TicketT>;
  addEvidence(id: string, content: string, key: string): Promise<string | undefined>;
  readProof(id: string): Promise<TicketProofRead>;
}

export type TicketProofRead = { kind: "missing" } | { kind: "found"; proof: LiveTicketProof };

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function now(): string {
  return new Date().toISOString();
}
export function markTrackerLive(state: StateV3T, goalId: string, at = now()): void {
  const goal = state.goals[goalId];
  if (!goal || goal.backend.kind === "local") return;
  state.goals[goalId] = {
    ...goal,
    backend: { ...goal.backend, last_verified_at: at, available: true, stale: false, outage: false },
    updated_at: at,
  };
  state.tracker_cache = { ...state.tracker_cache, last_verified_at: at, available: true, stale: false, outage: false };
}

export function isLiveRemoteBackend(backend: TicketBackendT): boolean {
  return backend.kind === "github" || backend.kind === "multica";
}

function localTickets(state: StateV3T, goalId: string): TicketT[] {
  return Object.values(state.local_tickets)
    .filter((ticket) => ticket.goal_id === goalId)
    .sort((a, b) => a.order - b.order || a.created_at.localeCompare(b.created_at));
}

export function nextLocalTicket(state: StateV3T, goalId: string): TicketT | undefined {
  const tickets = localTickets(state, goalId);
  const active = tickets.find((ticket) => ticket.status === "in_progress");
  if (active) return active;
  return tickets.find((ticket) => ticket.status === "todo" && ticket.blocked_by.every((id) => state.local_tickets[id]?.status === "done"));
}

export function localTicketProvider(state: StateV3T): TicketProvider {
  return {
    backend: { kind: "local" },
    async list(goalId) {
      return localTickets(state, goalId);
    },
    async get(id) {
      return state.local_tickets[id];
    },
    async create(goalId, input) {
      const id = `ticket-${input.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 56) || "untitled"}-${digest(`${goalId}:${input.title}:${now()}`).slice(0, 8)}`;
      const at = now();
      const ticket = {
        id,
        goal_id: goalId,
        title: input.title,
        brief: input.brief,
        acceptance: input.acceptance ?? [],
        blocked_by: input.blocked_by ?? [],
        status: "todo" as const,
        code_changed: input.code_changed ?? false,
        order: localTickets(state, goalId).length,
        created_at: at,
        updated_at: at,
      };
      state.local_tickets[id] = ticket;
      return ticket;
    },
    async setStatus(id, status) {
      const current = state.local_tickets[id];
      if (!current) throw new Error(`Unknown ticket: ${id}`);
      if (status === "done" && current.blocked_by.some((dependency) => state.local_tickets[dependency]?.status !== "done")) {
        throw new Error(`Ticket ${id} is blocked by an unfinished dependency.`);
      }
      const next = { ...current, status, updated_at: now() };
      state.local_tickets[id] = next;
      return next;
    },
    async addEvidence() {
      return undefined;
    },
    async readProof(id) {
      const ticket = state.local_tickets[id];
      if (!ticket) return { kind: "missing" };
      const evidenceReferenceIds = Object.values(state.evidence)
        .filter((evidence) => evidence.ticket_id === id)
        .flatMap((evidence) => [evidence.id, evidence.remote_comment_id])
        .filter((reference): reference is string => Boolean(reference))
        .sort();
      return {
        kind: "found",
        proof: {
          ticket_id: ticket.id,
          configured_parent_id: ticket.goal_id,
          parent_id: ticket.goal_id,
          status: ticket.status,
          content_strings: [ticket.title, ticket.brief, ...ticket.acceptance].filter((value): value is string => Boolean(value)),
          evidence_reference_ids: [...new Set(evidenceReferenceIds)],
          readback_at: now(),
        },
      };
    },
  };
}

interface MulticaProviderDeps {
  runner?: MulticaRunner;
  env?: NodeJS.ProcessEnv;
  profile?: string;
  goalId?: string;
  now?: () => string;
}

function multicaArgs(backend: Extract<TicketBackendT, { kind: "multica" }>, profile?: string): string[] {
  const args: string[] = [];
  if (profile) args.push("--profile", profile);
  args.push("--server-url", backend.origin, "--workspace-id", backend.workspace_id);
  return args;
}

function objectResult(stdout: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(`Multica ${label} returned malformed JSON.`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Multica ${label} returned an object list.`);
  return value as Record<string, unknown>;
}

function arrayResult(stdout: string, label: string, field?: string): Record<string, unknown>[] {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(`Multica ${label} returned malformed JSON.`); }
  const rows = Array.isArray(value)
    ? value
    : field && value && typeof value === "object" && Array.isArray((value as Record<string, unknown>)[field])
      ? (value as Record<string, unknown>)[field] as unknown[]
      : undefined;
  if (!rows || rows.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`Multica ${label} returned an object array.`);
  }
  return rows as Record<string, unknown>[];
}

function stringValue(value: Record<string, unknown>, key: string): string | undefined {
  const direct = value[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = value[key.replace(/_id$/, "")];
  if (nested && typeof nested === "object" && typeof (nested as Record<string, unknown>).id === "string") {
    return String((nested as Record<string, unknown>).id).trim();
  }
  return undefined;
}

function remoteContent(value: Record<string, unknown>): string[] {
  const title = stringValue(value, "title");
  const description = stringValue(value, "description");
  return [...new Set([
    title,
    description,
    ...description?.split(/\r?\n/).map((line) => line.trim().replace(/^[-*]\s+/, "")).filter(Boolean) ?? [],
  ].filter((item): item is string => Boolean(item)))];
}

/** Read accepts write brand and legacy marker brands. */
const STRATEGIC_ACTION_MARKER = new RegExp(
  `<!-- ${ISSUE_MARKER_BRAND_RE}:strategic-action:v1 action_identity=(action-[a-f0-9]{64}) root_cause=([A-Za-z0-9_-]+) -->`,
  "g",
);
const STRATEGIC_COMMENT_MARKER = new RegExp(
  `<!-- ${ISSUE_MARKER_BRAND_RE}:strategic-comment:v1 action_identity=(action-[a-f0-9]{64}) -->`,
  "g",
);

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

function strategicActionMarker(actionIdentity: string, rootCause: string): string {
  return `<!-- ${ISSUE_MARKER_BRAND}:strategic-action:v1 action_identity=${actionIdentity} root_cause=${Buffer.from(rootCause, "utf8").toString("base64url")} -->`;
}

function strategicCommentMarker(actionIdentity: string): string {
  return `<!-- ${ISSUE_MARKER_BRAND}:strategic-comment:v1 action_identity=${actionIdentity} -->`;
}

function parseStrategicDescription(description: string): { rootCause: string; actionIdentities: string[] } {
  const matches = [...description.matchAll(STRATEGIC_ACTION_MARKER)];
  const actionIdentities = [...new Set(matches.map((match) => match[1]!).filter(Boolean))].sort();
  if (matches[0]?.[2]) {
    let rootCause: string;
    try {
      rootCause = Buffer.from(matches[0][2], "base64url").toString("utf8");
    } catch {
      throw new Error("Multica strategic action marker was malformed.");
    }
    if (!rootCause) throw new Error("Multica strategic action marker had no root cause.");
    return { rootCause, actionIdentities };
  }
  const acceptanceMatch = description.match(/(?:^|\r?\n)## Acceptance\r?\n/);
  const acceptanceAt = acceptanceMatch?.index ?? -1;
  return {
    rootCause: (acceptanceAt >= 0 ? description.slice(0, acceptanceAt) : description).trim(),
    actionIdentities,
  };
}

function parseStrategicComments(value: Record<string, unknown>): StrategicTicketCommentRead[] {
  const raw = value.comments ?? [];
  if (!Array.isArray(raw)) throw new Error("Multica strategic comments were malformed.");
  return raw.map((comment) => {
    if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
      throw new Error("Multica strategic comment was malformed.");
    }
    const row = comment as Record<string, unknown>;
    const id = stringValue(row, "id");
    const rawContent = stringValue(row, "content");
    if (!id || !rawContent) throw new Error("Multica strategic comment was incomplete.");
    const identities = [...rawContent.matchAll(STRATEGIC_COMMENT_MARKER)].map((match) => match[1]!).filter(Boolean);
    if (new Set(identities).size > 1) throw new Error("Multica strategic comment identity was ambiguous.");
    return {
      id,
      content: rawContent.replace(STRATEGIC_COMMENT_MARKER, "").trimEnd(),
      action_identity: identities[0] ?? null,
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
}

function strategicDescription(input: {
  brief: string;
  acceptance: string[];
  root_cause: string;
  action_identity: string;
}): string {
  return [
    input.brief,
    "",
    strategicActionMarker(input.action_identity, input.root_cause),
    "",
    "## Acceptance",
    ...input.acceptance.map((item) => `- ${item}`),
  ].join("\n");
}

export function explicitIssueNotFound(error: unknown, requestedId: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const match = /^resolve issue: GET \/api\/issues\/([^/?#\s]+) returned 404: ([\s\S]+)$/.exec(message);
  if (!match) return false;
  const encodedPathId = match[1];
  const bodyText = match[2];
  if (!encodedPathId || !bodyText) return false;
  let pathId: string;
  try {
    pathId = decodeURIComponent(encodedPathId);
  } catch {
    return false;
  }
  if (pathId !== requestedId) return false;
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    return false;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return false;
  return Object.keys(body).length === 1
    && (body as Record<string, unknown>).error === "issue not found";
}

function normalizeRemote(value: Record<string, unknown>, goalId: string, expectedParent?: string): TicketT | undefined {
  const id = stringValue(value, "id") ?? stringValue(value, "identifier");
  const title = stringValue(value, "title");
  const status = stringValue(value, "status");
  if (!id || !title || !status || !["todo", "in_progress", "in_review", "done", "blocked", "cancelled"].includes(status)) return undefined;
  const at = stringValue(value, "updated_at") ?? now();
  const parentId = stringValue(value, "parent_issue_id") ?? stringValue(value, "parent_id");
  if (expectedParent && parentId !== expectedParent) return undefined;
  const description = stringValue(value, "description");
  const acceptanceMatch = description?.match(/(?:^|\r?\n)## Acceptance\r?\n/);
  const acceptanceAt = acceptanceMatch?.index ?? -1;
  const brief = acceptanceAt >= 0 ? description?.slice(0, acceptanceAt).trim() || undefined : description;
  const acceptance = acceptanceAt >= 0
    ? description!.slice(acceptanceAt + acceptanceMatch![0].length).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("- ")).map((line) => line.slice(2))
    : [];
  return {
    id,
    goal_id: goalId,
    title,
    brief,
    acceptance,
    blocked_by: [],
    status: status as TicketStatusT,
    code_changed: true,
    order: typeof value.position === "number" ? Math.max(0, value.position) : 0,
    created_at: stringValue(value, "created_at") ?? at,
    updated_at: at,
  };
}

export function multicaTicketProvider(
  backend: Extract<TicketBackendT, { kind: "multica" }>,
  deps: MulticaProviderDeps = {},
): TicketProvider {
  const runner = deps.runner ?? spawnMultica;
  const env = deps.env ?? process.env;
  const goalId = deps.goalId ?? backend.parent_issue_id;
  const clock = deps.now ?? now;
  const base = multicaArgs(backend, deps.profile ?? env.MULTICA_PROFILE);
  const run = async (args: string[], stdin?: string): Promise<string> => {
    const result = await runner({
      executable: "multica",
      argv: [...base, ...args],
      env,
      stdin,
      shell: false,
      windowsHide: true,
    });
    return result.stdout;
  };
  const readParent = async (): Promise<Record<string, unknown>> => {
    const parent = objectResult(await run(["issue", "get", backend.parent_issue_id, "--output", "json"]), "parent readback");
    const id = stringValue(parent, "id");
    const workspace = stringValue(parent, "workspace_id");
    if (!id || id.toLowerCase() !== backend.parent_issue_id.toLowerCase() || workspace?.toLowerCase() !== backend.workspace_id.toLowerCase()) {
      throw new Error("Multica parent binding failed live readback.");
    }
    return parent;
  };
  const strategicRow = (row: Record<string, unknown>): StrategicTicketRead => {
    const id = stringValue(row, "id");
    const identifier = stringValue(row, "identifier") ?? null;
    const title = stringValue(row, "title");
    const description = stringValue(row, "description") ?? "";
    const parentId = stringValue(row, "parent_issue_id") ?? stringValue(row, "parent_id");
    const status = stringValue(row, "status");
    const priority = stringValue(row, "priority");
    if (!id || !title || !description || parentId !== backend.parent_issue_id
      || !status || !["todo", "in_progress", "in_review", "done", "blocked", "cancelled"].includes(status)
      || !priority || !STRATEGIC_TICKET_PRIORITIES.includes(priority as StrategicTicketPriority)) {
      throw new Error("Multica strategic issue readback was not canonical.");
    }
    const assigneeId = stringValue(row, "assignee_id");
    const assigneeType = stringValue(row, "assignee_type");
    if (Boolean(assigneeId) !== Boolean(assigneeType)) {
      throw new Error("Multica strategic owner readback was not canonical.");
    }
    const parsedDescription = parseStrategicDescription(description);
    const comments = parseStrategicComments(row);
    const protectedState = {
      identity: { id, identifier },
      title,
      description,
      root_cause: parsedDescription.rootCause,
      action_identities: parsedDescription.actionIdentities,
      owner: assigneeId && assigneeType ? `${assigneeType}:${assigneeId}` : null,
      priority,
      status,
      comments,
    };
    return {
      kind: "ticket",
      ticket_id: id,
      identifier,
      title,
      description,
      root_cause: parsedDescription.rootCause,
      action_identities: parsedDescription.actionIdentities,
      owner: protectedState.owner,
      priority: priority as StrategicTicketPriority,
      status: status as TicketStatusT,
      comments,
      provider_proof: {
        source: `${backend.origin}/workspaces/${backend.workspace_id}/issues/${id}`,
        digest: digest(JSON.stringify(canonicalValue(protectedState))),
        read_at: clock(),
      },
    };
  };
  const readStrategic = async (id: string): Promise<StrategicTicketRead | undefined> => {
    await readParent();
    let row: Record<string, unknown>;
    try {
      row = objectResult(await run(["issue", "get", id, "--output", "json"]), "strategic issue readback");
    } catch (error) {
      if (explicitIssueNotFound(error, id)) return undefined;
      throw error;
    }
    return strategicRow(row);
  };
  const searchStrategic = async (query: {
    root_cause: string;
    action_identity: string;
    owner: null;
  }): Promise<StrategicTicketRead[]> => {
    await readParent();
    const rows = arrayResult(
      await run(["issue", "search", query.root_cause, "--output", "json", "--limit", "200"]),
      "strategic issue search",
      "issues",
    );
    const reads: StrategicTicketRead[] = [];
    for (const row of rows) {
      const id = stringValue(row, "id") ?? stringValue(row, "identifier");
      if (!id) throw new Error("Multica strategic search result had no identity.");
      const exact = await readStrategic(id);
      if (exact && exact.root_cause === query.root_cause && exact.owner === query.owner
        && (exact.action_identities.length === 0 || exact.action_identities.includes(query.action_identity))) {
        reads.push(exact);
      }
    }
    return reads.sort((left, right) => left.ticket_id.localeCompare(right.ticket_id));
  };
  const strategic: StrategicTicketCapability = {
    search: searchStrategic,
    read: readStrategic,
    async create(input) {
      const marker = strategicActionMarker(input.action_identity, input.root_cause);
      await readParent();
      const rows = arrayResult(
        await run(["issue", "search", marker, "--output", "json", "--limit", "200"]),
        "strategic create search",
        "issues",
      );
      for (const row of rows) {
        const id = stringValue(row, "id") ?? stringValue(row, "identifier");
        if (!id) continue;
        const existing = await readStrategic(id);
        if (existing?.root_cause === input.root_cause
          && existing.action_identities.includes(input.action_identity)
          && existing.owner === null) return existing;
      }
      const description = strategicDescription(input);
      const created = objectResult(await run([
        "issue", "create", "--title", input.title, "--description-stdin", "--status", "todo",
        "--parent", backend.parent_issue_id, "--output", "json",
      ], description), "strategic issue create");
      const id = stringValue(created, "id") ?? stringValue(created, "identifier");
      if (!id) throw new Error("Multica strategic issue create returned no identity.");
      const readback = await readStrategic(id);
      if (!readback || readback.title !== input.title || readback.root_cause !== input.root_cause
        || !readback.action_identities.includes(input.action_identity) || readback.owner !== null) {
        throw new Error("Multica strategic issue create did not survive exact live readback.");
      }
      return readback;
    },
    async comment(id, content, actionIdentity) {
      const before = await readStrategic(id);
      if (!before) throw new Error(`Unknown strategic ticket: ${id}`);
      if (before.comments.some((comment) => comment.content === content && comment.action_identity === actionIdentity)) {
        return before;
      }
      const payload = `${content}\n\n${strategicCommentMarker(actionIdentity)}`;
      const created = objectResult(
        await run(["issue", "comment", "add", id, "--content-stdin", "--output", "json"], payload),
        "strategic comment create",
      );
      if (stringValue(created, "content") !== payload) {
        throw new Error("Multica strategic comment response was not canonical.");
      }
      const readback = await readStrategic(id);
      if (!readback || readback.comments.filter((comment) =>
        comment.content === content && comment.action_identity === actionIdentity).length !== 1) {
        throw new Error("Multica strategic comment did not survive exact live readback.");
      }
      return readback;
    },
    async setPriority(id, priority) {
      const before = await readStrategic(id);
      if (!before) throw new Error(`Unknown strategic ticket: ${id}`);
      if (before.priority === priority) return before;
      await run(["issue", "update", id, "--priority", priority, "--output", "json"]);
      const readback = await readStrategic(id);
      if (!readback || readback.priority !== priority) {
        throw new Error("Multica strategic priority did not survive exact live readback.");
      }
      return readback;
    },
  };
  return {
    backend,
    strategic,
    async list(goalId) {
      await readParent();
      const rows = arrayResult(await run(["issue", "list", "--output", "json", "--limit", "200"]), "issue list", "issues");
      return rows.map((row) => normalizeRemote(row, goalId, backend.parent_issue_id)).filter((ticket): ticket is TicketT => ticket !== undefined);
    },
    async get(id) {
      await readParent();
      return normalizeRemote(objectResult(await run(["issue", "get", id, "--output", "json"]), "issue readback"), goalId, backend.parent_issue_id);
    },
    async create(goalId, input) {
      await readParent();
      const listed = arrayResult(await run(["issue", "list", "--output", "json", "--limit", "200"]), "issue list", "issues");
      const existing = listed
        .map((row) => normalizeRemote(row, goalId, backend.parent_issue_id))
        .find((ticket) => ticket?.title === input.title);
      if (existing) return { ...existing, acceptance: input.acceptance ?? [], blocked_by: input.blocked_by ?? [], code_changed: input.code_changed ?? true };
      const description = [input.brief ?? "", "", "## Acceptance", ...(input.acceptance ?? []).map((item) => `- ${item}`)].join("\n");
      const row = objectResult(await run([
        "issue", "create", "--title", input.title, "--description-stdin", "--status", "todo",
        "--parent", backend.parent_issue_id, "--output", "json",
      ], description), "issue create");
      const ticket = normalizeRemote(row, goalId, backend.parent_issue_id);
      if (!ticket) throw new Error("Multica issue create did not return a canonical ticket.");
      return { ...ticket, goal_id: goalId, acceptance: input.acceptance ?? [], blocked_by: input.blocked_by ?? [], code_changed: input.code_changed ?? true };
    },
    async setStatus(id, status) {
      await readParent();
      const row = objectResult(await run(["issue", "status", id, status, "--output", "json"]), "issue status");
      const ticket = normalizeRemote(row, goalId, backend.parent_issue_id) ?? await this.get(id);
      if (!ticket || ticket.status !== status) throw new Error("Multica status mutation did not survive live readback.");
      return ticket;
    },
    async addEvidence(id, content, _key) {
      await readParent();
      const before = arrayResult(await run(["issue", "comment", "list", id, "--output", "json"]), "evidence list");
      const priorId = before.map((item) => stringValue(item, "content") === content ? stringValue(item, "id") : undefined).find(Boolean);
      if (priorId) return priorId;
      const row = objectResult(await run(["issue", "comment", "add", id, "--content-stdin", "--output", "json"], content), "evidence create");
      const commentId = stringValue(row, "id");
      if (!commentId || stringValue(row, "content") !== content) throw new Error("Multica evidence create was not verified.");
      const comments = arrayResult(await run(["issue", "comment", "list", id, "--output", "json"]), "evidence readback");
      if (comments.filter((item) => stringValue(item, "id") === commentId && stringValue(item, "content") === content).length !== 1) {
        throw new Error("Multica evidence did not survive exact live readback.");
      }
      return commentId;
    },
    async readProof(id) {
      await readParent();
      let row: Record<string, unknown>;
      try {
        row = objectResult(await run(["issue", "get", id, "--output", "json"]), "issue proof readback");
      } catch (error) {
        if (explicitIssueNotFound(error, id)) return { kind: "missing" };
        throw error;
      }
      const ticketId = stringValue(row, "id");
      const identifier = stringValue(row, "identifier");
      const parentId = stringValue(row, "parent_issue_id") ?? stringValue(row, "parent_id");
      const status = stringValue(row, "status");
      const requested = id.toLowerCase();
      if (!ticketId || ![ticketId, identifier].some((reference) => reference?.toLowerCase() === requested)
        || !parentId || !status || !["todo", "in_progress", "in_review", "done", "blocked", "cancelled"].includes(status)) {
        throw new Error("Multica issue proof was not canonical.");
      }
      const comments = arrayResult(await run(["issue", "comment", "list", id, "--output", "json"]), "evidence list");
      return {
        kind: "found",
        proof: {
          ticket_id: id,
          configured_parent_id: backend.parent_issue_id,
          parent_id: parentId,
          status: status as TicketStatusT,
          content_strings: remoteContent(row),
          evidence_reference_ids: comments.map((comment) => stringValue(comment, "id")).filter((value): value is string => Boolean(value)).sort(),
          readback_at: now(),
        },
      };
    },
  };
}

export function providerForState(
  state: StateV3T,
  goalId: string,
  deps: {
    env?: NodeJS.ProcessEnv;
    goalId?: string;
    now?: () => string;
    profile?: string;
    /** Backend-specific runner; typed loosely so callers need not discriminate. */
    runner?: MulticaRunner | GhRunner;
  } = {},
): TicketProvider {
  const goal = state.goals[goalId];
  if (!goal) throw new Error(`Unknown goal: ${goalId}`);
  if (goal.backend.kind === "local") return localTicketProvider(state);
  if (goal.backend.kind === "github") {
    return githubTicketProvider(goal.backend, {
      env: deps.env,
      goalId: deps.goalId,
      now: deps.now,
      runner: deps.runner as GhRunner | undefined,
    });
  }
  return multicaTicketProvider(goal.backend, {
    env: deps.env,
    profile: deps.profile,
    goalId: deps.goalId,
    now: deps.now,
    runner: deps.runner as MulticaRunner | undefined,
  });
}

/** Read accepts write brand and legacy marker brands. */
const TICKET_MARKER = new RegExp(
  `<!--\\s*${ISSUE_MARKER_BRAND_RE}:ticket:v1\\s+([^>]+?)-->`,
);
const PRIORITY_MARKER = new RegExp(
  `<!--\\s*${ISSUE_MARKER_BRAND_RE}:priority:v1\\s+priority=([a-z]+)\\s*-->`,
);

export const GITHUB_STATUS_TO_PROJECT: Record<TicketStatusT, string> = {
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

interface GithubProviderDeps {
  runner?: GhRunner;
  env?: NodeJS.ProcessEnv;
  goalId?: string;
  now?: () => string;
}

function parseMarkerAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([a-z_]+)=([^\s]+)/g)) {
    attrs[match[1]!] = match[2]!;
  }
  return attrs;
}

function ticketMarker(parent: number, status: TicketStatusT, goalId: string): string {
  return `<!-- ${ISSUE_MARKER_BRAND}:ticket:v1 parent=${parent} status=${status} goal=${goalId} -->`;
}

function priorityMarker(priority: StrategicTicketPriority): string {
  return `<!-- ${ISSUE_MARKER_BRAND}:priority:v1 priority=${priority} -->`;
}

function githubBody(input: {
  brief?: string;
  acceptance?: string[];
  parent: number;
  status: TicketStatusT;
  goalId: string;
  priority?: StrategicTicketPriority;
  extra?: string;
}): string {
  return [
    `Parent: #${input.parent}`,
    "",
    ticketMarker(input.parent, input.status, input.goalId),
    input.priority ? priorityMarker(input.priority) : "",
    input.extra ?? "",
    input.brief ?? "",
    "",
    "## Acceptance",
    ...(input.acceptance ?? []).map((item) => `- ${item}`),
  ].filter((line, index, rows) => !(line === "" && rows[index - 1] === "")).join("\n").trim() + "\n";
}

function parseGithubStatus(body: string, state?: string): TicketStatusT | undefined {
  const match = body.match(TICKET_MARKER);
  if (match?.[1]) {
    const status = parseMarkerAttrs(match[1]).status;
    if (status && ["todo", "in_progress", "in_review", "done", "blocked", "cancelled"].includes(status)) {
      return status as TicketStatusT;
    }
  }
  if (state === "CLOSED") return "done";
  if (state === "OPEN") return "todo";
  return undefined;
}

function parseGithubParent(body: string): number | undefined {
  const match = body.match(TICKET_MARKER);
  if (match?.[1]) {
    const parent = Number(parseMarkerAttrs(match[1]).parent);
    if (Number.isInteger(parent) && parent > 0) return parent;
  }
  const link = body.match(/Parent:\s*#(\d+)/);
  if (link?.[1]) return Number(link[1]);
  return undefined;
}

function parseGithubPriority(body: string): StrategicTicketPriority {
  const match = body.match(PRIORITY_MARKER);
  const priority = match?.[1];
  if (priority && STRATEGIC_TICKET_PRIORITIES.includes(priority as StrategicTicketPriority)) {
    return priority as StrategicTicketPriority;
  }
  return "medium";
}

function rewriteStatus(body: string, parent: number, status: TicketStatusT, goalId: string): string {
  if (TICKET_MARKER.test(body)) {
    return body.replace(TICKET_MARKER, ticketMarker(parent, status, goalId));
  }
  return `${ticketMarker(parent, status, goalId)}\n\n${body}`;
}

function rewritePriority(body: string, priority: StrategicTicketPriority): string {
  if (PRIORITY_MARKER.test(body)) return body.replace(PRIORITY_MARKER, priorityMarker(priority));
  return `${priorityMarker(priority)}\n${body}`;
}

function githubObjectResult(stdout: string, label: string): Record<string, unknown> {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(`GitHub ${label} returned malformed JSON.`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`GitHub ${label} returned an object list.`);
  return value as Record<string, unknown>;
}

function githubArrayResult(stdout: string, label: string): Record<string, unknown>[] {
  let value: unknown;
  try { value = JSON.parse(stdout); } catch { throw new Error(`GitHub ${label} returned malformed JSON.`); }
  if (!Array.isArray(value) || value.some((item) => !item || typeof item !== "object" || Array.isArray(item))) {
    throw new Error(`GitHub ${label} returned an object array.`);
  }
  return value as Record<string, unknown>[];
}

function explicitGithubIssueNotFound(error: unknown, requestedId: string): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /could not resolve|not found|HTTP 404/i.test(message) && message.includes(String(requestedId));
}

function normalizeGithubIssue(
  value: Record<string, unknown>,
  goalId: string,
  expectedParent: number,
): TicketT | undefined {
  const number = typeof value.number === "number" ? value.number : Number(stringValue(value, "number"));
  const title = stringValue(value, "title");
  const body = stringValue(value, "body") ?? "";
  const state = stringValue(value, "state")?.toUpperCase();
  const status = parseGithubStatus(body, state);
  const parent = parseGithubParent(body);
  if (!Number.isInteger(number) || number <= 0 || !title || !status || parent !== expectedParent) return undefined;
  const acceptanceMatch = body.match(/(?:^|\r?\n)## Acceptance\r?\n/);
  const acceptanceAt = acceptanceMatch?.index ?? -1;
  const beforeAcceptance = acceptanceAt >= 0 ? body.slice(0, acceptanceAt) : body;
  const brief = beforeAcceptance
    .replace(TICKET_MARKER, "")
    .replace(PRIORITY_MARKER, "")
    .replace(/Parent:\s*#\d+\s*/g, "")
    .replace(STRATEGIC_ACTION_MARKER, "")
    .trim() || undefined;
  const acceptance = acceptanceAt >= 0
    ? body.slice(acceptanceAt + acceptanceMatch![0].length).split(/\r?\n/).map((line) => line.trim()).filter((line) => line.startsWith("- ")).map((line) => line.slice(2))
    : [];
  const at = stringValue(value, "updatedAt") ?? stringValue(value, "updated_at") ?? now();
  return {
    id: String(number),
    goal_id: goalId,
    title,
    brief,
    acceptance,
    blocked_by: [],
    status,
    code_changed: true,
    order: number,
    created_at: stringValue(value, "createdAt") ?? stringValue(value, "created_at") ?? at,
    updated_at: at,
  };
}

export function githubTicketProvider(
  backend: Extract<TicketBackendT, { kind: "github" }>,
  deps: GithubProviderDeps = {},
): TicketProvider {
  const runner = deps.runner ?? spawnGh;
  const env = deps.env ?? process.env;
  const goalId = deps.goalId ?? `goal-${backend.parent_issue_number}`;
  const clock = deps.now ?? now;
  const repo = `${backend.owner}/${backend.repo}`;
  const run = async (args: string[], stdin?: string): Promise<string> => {
    const result = await runner({
      executable: "gh",
      argv: args,
      env: ghChildEnv(env),
      stdin,
      shell: false,
      windowsHide: true,
    });
    return result.stdout;
  };
  const readParent = async (): Promise<Record<string, unknown>> => {
    const parent = githubObjectResult(
      await run(["issue", "view", String(backend.parent_issue_number), "--repo", repo, "--json", "number,title,state,body,url"]),
      "parent readback",
    );
    const number = typeof parent.number === "number" ? parent.number : Number(stringValue(parent, "number"));
    if (number !== backend.parent_issue_number) throw new Error("GitHub parent binding failed live readback.");
    return parent;
  };
  const viewIssue = async (id: string): Promise<Record<string, unknown>> => githubObjectResult(
    await run(["issue", "view", id, "--repo", repo, "--json", "number,title,state,body,url,createdAt,updatedAt,comments"]),
    "issue readback",
  );
  const listChildren = async (): Promise<Record<string, unknown>[]> => {
    const rows = githubArrayResult(
      await run([
        "issue", "list", "--repo", repo, "--state", "all", "--limit", "200",
        "--search", `Parent:\\#${backend.parent_issue_number} in:body`,
        "--json", "number,title,state,body,url,createdAt,updatedAt",
      ]),
      "issue list",
    );
    return rows.filter((row) => parseGithubParent(stringValue(row, "body") ?? "") === backend.parent_issue_number);
  };
  const boardIssue = async (url: string): Promise<void> => {
    try {
      await run([
        "project", "item-add", String(backend.project_number),
        "--owner", backend.project_owner,
        "--url", url,
      ]);
    } catch {
      // Project boarding is best-effort; issue body status remains canonical.
    }
  };
  const parseComments = (row: Record<string, unknown>): StrategicTicketCommentRead[] => {
    const comments = row.comments;
    const nodes = Array.isArray(comments)
      ? comments
      : comments && typeof comments === "object" && Array.isArray((comments as Record<string, unknown>).nodes)
        ? (comments as Record<string, unknown>).nodes as unknown[]
        : [];
    return nodes.map((comment) => {
      if (!comment || typeof comment !== "object" || Array.isArray(comment)) {
        throw new Error("GitHub strategic comment was malformed.");
      }
      const item = comment as Record<string, unknown>;
      const id = stringValue(item, "id") ?? stringValue(item, "databaseId") ?? stringValue(item, "url");
      const rawContent = stringValue(item, "body") ?? stringValue(item, "content");
      if (!id || !rawContent) throw new Error("GitHub strategic comment was incomplete.");
      const identities = [...rawContent.matchAll(STRATEGIC_COMMENT_MARKER)].map((match) => match[1]!).filter(Boolean);
      if (new Set(identities).size > 1) throw new Error("GitHub strategic comment identity was ambiguous.");
      return {
        id,
        content: rawContent.replace(STRATEGIC_COMMENT_MARKER, "").trimEnd(),
        action_identity: identities[0] ?? null,
      };
    }).sort((left, right) => left.id.localeCompare(right.id));
  };
  const strategicRow = (row: Record<string, unknown>): StrategicTicketRead => {
    const number = typeof row.number === "number" ? row.number : Number(stringValue(row, "number"));
    const title = stringValue(row, "title");
    const body = stringValue(row, "body") ?? "";
    const state = stringValue(row, "state")?.toUpperCase();
    const status = parseGithubStatus(body, state);
    const parent = parseGithubParent(body);
    const priority = parseGithubPriority(body);
    if (!Number.isInteger(number) || !title || !body || parent !== backend.parent_issue_number || !status) {
      throw new Error("GitHub strategic issue readback was not canonical.");
    }
    const parsedDescription = parseStrategicDescription(body);
    const comments = parseComments(row);
    const protectedState = {
      identity: { id: String(number), identifier: String(number) },
      title,
      description: body,
      root_cause: parsedDescription.rootCause,
      action_identities: parsedDescription.actionIdentities,
      owner: null,
      priority,
      status,
      comments,
    };
    return {
      kind: "ticket",
      ticket_id: String(number),
      identifier: String(number),
      title,
      description: body,
      root_cause: parsedDescription.rootCause,
      action_identities: parsedDescription.actionIdentities,
      owner: null,
      priority,
      status,
      comments,
      provider_proof: {
        source: stringValue(row, "url") ?? `https://github.com/${repo}/issues/${number}`,
        digest: digest(JSON.stringify(canonicalValue(protectedState))),
        read_at: clock(),
      },
    };
  };
  const readStrategic = async (id: string): Promise<StrategicTicketRead | undefined> => {
    await readParent();
    let row: Record<string, unknown>;
    try {
      row = await viewIssue(id);
    } catch (error) {
      if (explicitGithubIssueNotFound(error, id)) return undefined;
      throw error;
    }
    return strategicRow(row);
  };
  const strategic: StrategicTicketCapability = {
    async search(query) {
      await readParent();
      const rows = await listChildren();
      const reads: StrategicTicketRead[] = [];
      for (const row of rows) {
        const id = String(typeof row.number === "number" ? row.number : stringValue(row, "number") ?? "");
        if (!id) continue;
        const exact = await readStrategic(id);
        if (exact && exact.root_cause === query.root_cause && exact.owner === query.owner
          && (exact.action_identities.length === 0 || exact.action_identities.includes(query.action_identity))) {
          reads.push(exact);
        }
      }
      return reads.sort((left, right) => left.ticket_id.localeCompare(right.ticket_id));
    },
    read: readStrategic,
    async create(input) {
      await readParent();
      const marker = strategicActionMarker(input.action_identity, input.root_cause);
      for (const row of await listChildren()) {
        const body = stringValue(row, "body") ?? "";
        if (!body.includes(marker)) continue;
        const id = String(typeof row.number === "number" ? row.number : stringValue(row, "number") ?? "");
        const existing = id ? await readStrategic(id) : undefined;
        if (existing?.root_cause === input.root_cause
          && existing.action_identities.includes(input.action_identity)
          && existing.owner === null) return existing;
      }
      const body = githubBody({
        brief: input.brief,
        acceptance: input.acceptance,
        parent: backend.parent_issue_number,
        status: "todo",
        goalId,
        priority: "medium",
        extra: strategicActionMarker(input.action_identity, input.root_cause),
      });
      const created = githubObjectResult(
        await run(["issue", "create", "--repo", repo, "--title", input.title, "--body-file", "-", "--json", "number,url"], body),
        "strategic issue create",
      );
      const number = typeof created.number === "number" ? created.number : Number(stringValue(created, "number"));
      const url = stringValue(created, "url");
      if (!Number.isInteger(number) || number <= 0) throw new Error("GitHub strategic issue create returned no identity.");
      if (url) await boardIssue(url);
      const readback = await readStrategic(String(number));
      if (!readback || readback.title !== input.title || readback.root_cause !== input.root_cause
        || !readback.action_identities.includes(input.action_identity) || readback.owner !== null) {
        throw new Error("GitHub strategic issue create did not survive exact live readback.");
      }
      return readback;
    },
    async comment(id, content, actionIdentity) {
      const before = await readStrategic(id);
      if (!before) throw new Error(`Unknown strategic ticket: ${id}`);
      if (before.comments.some((comment) => comment.content === content && comment.action_identity === actionIdentity)) {
        return before;
      }
      const payload = `${content}\n\n${strategicCommentMarker(actionIdentity)}`;
      await run(["issue", "comment", id, "--repo", repo, "--body-file", "-"], payload);
      const readback = await readStrategic(id);
      if (!readback || readback.comments.filter((comment) =>
        comment.content === content && comment.action_identity === actionIdentity).length !== 1) {
        throw new Error("GitHub strategic comment did not survive exact live readback.");
      }
      return readback;
    },
    async setPriority(id, priority) {
      const before = await readStrategic(id);
      if (!before) throw new Error(`Unknown strategic ticket: ${id}`);
      if (before.priority === priority) return before;
      const row = await viewIssue(id);
      const body = rewritePriority(stringValue(row, "body") ?? "", priority);
      await run(["issue", "edit", id, "--repo", repo, "--body-file", "-"], body);
      const readback = await readStrategic(id);
      if (!readback || readback.priority !== priority) {
        throw new Error("GitHub strategic priority did not survive exact live readback.");
      }
      return readback;
    },
  };
  return {
    backend,
    strategic,
    async list(goalIdForList) {
      await readParent();
      return (await listChildren())
        .map((row) => normalizeGithubIssue(row, goalIdForList, backend.parent_issue_number))
        .filter((ticket): ticket is TicketT => ticket !== undefined);
    },
    async get(id) {
      await readParent();
      try {
        return normalizeGithubIssue(await viewIssue(id), goalId, backend.parent_issue_number);
      } catch (error) {
        if (explicitGithubIssueNotFound(error, id)) return undefined;
        throw error;
      }
    },
    async create(goalIdForCreate, input) {
      await readParent();
      const existing = (await listChildren())
        .map((row) => normalizeGithubIssue(row, goalIdForCreate, backend.parent_issue_number))
        .find((ticket) => ticket?.title === input.title);
      if (existing) {
        return {
          ...existing,
          acceptance: input.acceptance ?? [],
          blocked_by: input.blocked_by ?? [],
          code_changed: input.code_changed ?? true,
        };
      }
      const body = githubBody({
        brief: input.brief,
        acceptance: input.acceptance,
        parent: backend.parent_issue_number,
        status: "todo",
        goalId: goalIdForCreate,
      });
      const created = githubObjectResult(
        await run(["issue", "create", "--repo", repo, "--title", input.title, "--body-file", "-", "--json", "number,url,title,body,state"], body),
        "issue create",
      );
      const url = stringValue(created, "url");
      if (url) await boardIssue(url);
      const number = typeof created.number === "number" ? created.number : Number(stringValue(created, "number"));
      const readback = Number.isInteger(number)
        ? normalizeGithubIssue(await viewIssue(String(number)), goalIdForCreate, backend.parent_issue_number)
        : normalizeGithubIssue({ ...created, body }, goalIdForCreate, backend.parent_issue_number);
      if (!readback) throw new Error("GitHub issue create did not return a canonical ticket.");
      return {
        ...readback,
        goal_id: goalIdForCreate,
        acceptance: input.acceptance ?? [],
        blocked_by: input.blocked_by ?? [],
        code_changed: input.code_changed ?? true,
      };
    },
    async setStatus(id, status) {
      await readParent();
      const row = await viewIssue(id);
      const body = rewriteStatus(stringValue(row, "body") ?? "", backend.parent_issue_number, status, goalId);
      await run(["issue", "edit", id, "--repo", repo, "--body-file", "-"], body);
      if (status === "done" || status === "cancelled") {
        await run(["issue", "close", id, "--repo", repo, "--reason", status === "cancelled" ? "not planned" : "completed"]);
      } else {
        try { await run(["issue", "reopen", id, "--repo", repo]); } catch { /* already open */ }
      }
      const ticket = await this.get(id);
      if (!ticket || ticket.status !== status) throw new Error("GitHub status mutation did not survive live readback.");
      return ticket;
    },
    async addEvidence(id, content, _key) {
      await readParent();
      const before = await viewIssue(id);
      const comments = parseComments(before);
      const prior = comments.find((comment) => comment.content === content);
      if (prior) return prior.id;
      const created = githubObjectResult(
        await run(["issue", "comment", id, "--repo", repo, "--body-file", "-", "--json", "id,url,body"], content),
        "evidence create",
      );
      const commentId = stringValue(created, "id") ?? stringValue(created, "url");
      if (!commentId || (stringValue(created, "body") ?? stringValue(created, "content")) !== content) {
        // gh may not echo body; verify via readback
      }
      const after = parseComments(await viewIssue(id));
      const verified = after.find((comment) => comment.content === content);
      if (!verified) throw new Error("GitHub evidence did not survive exact live readback.");
      return verified.id;
    },
    async readProof(id) {
      await readParent();
      let row: Record<string, unknown>;
      try {
        row = await viewIssue(id);
      } catch (error) {
        if (explicitGithubIssueNotFound(error, id)) return { kind: "missing" };
        throw error;
      }
      const ticket = normalizeGithubIssue(row, goalId, backend.parent_issue_number);
      if (!ticket) throw new Error("GitHub issue proof was not canonical.");
      const requested = id.toLowerCase();
      if (ticket.id.toLowerCase() !== requested && String(ticket.order) !== id) {
        throw new Error("GitHub issue proof was not canonical.");
      }
      return {
        kind: "found",
        proof: {
          ticket_id: id,
          configured_parent_id: String(backend.parent_issue_number),
          parent_id: String(backend.parent_issue_number),
          status: ticket.status,
          content_strings: remoteContent({
            title: ticket.title,
            description: stringValue(row, "body") ?? "",
          }),
          evidence_reference_ids: parseComments(row).map((comment) => comment.id).sort(),
          readback_at: now(),
        },
      };
    },
  };
}

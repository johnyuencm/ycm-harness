import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { type TicketStatusT, type TicketT } from "../../schema/v3.js";
import { nowIso, shortId, slugify } from "../../state/ids.js";
import { requireLeanState, activeLeanGoal } from "../lean-state.js";
import { isLiveRemoteBackend, markTrackerLive, nextLocalTicket, providerForState } from "../../tickets/provider.js";
import { evidenceRoot, submissionDigest, freshCompletionEvidence } from "../../tickets/evidence.js";
import { requireContinuationClosure } from "../../continuation/closure.js";

function goalFor(state: Awaited<ReturnType<typeof requireLeanState>>, id?: string) {
  const goal = id ? state.goals[id] : activeLeanGoal(state);
  if (!goal) throw new Error("No active goal.");
  return goal;
}
async function ensureTicket(ctx: CliContext, state: Awaited<ReturnType<typeof requireLeanState>>, id: string): Promise<TicketT> {
  const local = state.local_tickets[id];
  if (local) return local;
  const goal = activeLeanGoal(state);
  if (!goal) throw new Error("No active goal.");
  const fetched = await providerForState(state, goal.id).get(id);
  if (!fetched) throw new Error(`Unknown ticket: ${id}`);
  const ticket = { ...fetched, goal_id: goal.id };
  state.local_tickets[id] = ticket;
  return ticket;
}

async function saveTicket(ctx: CliContext, state: Awaited<ReturnType<typeof requireLeanState>>, ticketId: string, status: TicketStatusT): Promise<void> {
  const ticket = state.local_tickets[ticketId];
  if (!ticket) throw new Error(`Unknown ticket: ${ticketId}`);
  if (status === "done") {
    await requireContinuationClosure({
      root: evidenceRoot(ctx.cwd, state.goals[ticket.goal_id]!),
      surface: "ticket-completion",
    });
  }
  const provider = providerForState(state, ticket.goal_id);
  const updated = await provider.setStatus(ticketId, status);
  if (isLiveRemoteBackend(provider.backend)) markTrackerLive(state, ticket.goal_id);
  state.local_tickets[ticketId] = { ...updated, ...ticket, status: updated.status, updated_at: updated.updated_at };
  state.goals[ticket.goal_id] = { ...state.goals[ticket.goal_id]!, active_ticket_id: status === "in_progress" ? ticketId : state.goals[ticket.goal_id]!.active_ticket_id, updated_at: nowIso() };
  await ctx.store.writeStateV3(state);
}

export function registerTicket(program: Command, ctx: CliContext, out: CliOutput): void {
  const ticket = program.command("ticket").alias("task").description("Manage provider-backed tickets");

  ticket.command("create <title>")
    .option("-b, --brief <text>")
    .option("-a, --acceptance <text...>")
    .option("--blocked-by <id...>")
    .option("--code-changed", "Mark as code-changing", false)
    .option("--goal <id>")
    .action(async (title: string, opts: { brief?: string; acceptance?: string[]; blockedBy?: string[]; codeChanged?: boolean; goal?: string }) => {
      const state = await requireLeanState(ctx);
      const goal = goalFor(state, opts.goal);
      const provider = providerForState(state, goal.id);
      const created = await provider.create(goal.id, { title, brief: opts.brief, acceptance: opts.acceptance, blocked_by: opts.blockedBy, code_changed: opts.codeChanged });
      state.local_tickets[created.id] = created;
      state.goals[goal.id] = { ...goal, active_ticket_id: goal.active_ticket_id ?? created.id, updated_at: nowIso() };
      await ctx.store.writeStateV3(state);
      await ctx.store.recordEvent({ id: shortId("evt"), kind: "ticket.created", at: nowIso(), goal_id: goal.id, ticket_id: created.id });
      out.out(`Created ticket ${created.id}: ${title}`);
    });

  ticket.command("list").option("--goal <id>").option("--json").action(async (opts: { goal?: string; json?: boolean }) => {
    const state = await requireLeanState(ctx);
    const goal = goalFor(state, opts.goal);
    const provider = providerForState(state, goal.id);
    const rows = await provider.list(goal.id);
    if (isLiveRemoteBackend(provider.backend)) markTrackerLive(state, goal.id);
    if (goal.backend.kind !== "local") {
      for (const item of rows) state.local_tickets[item.id] = { ...item, goal_id: goal.id };
      await ctx.store.writeStateV3(state);
    }
    if (opts.json) return out.json(rows);
    for (const item of rows) out.out(`${item.id}\t[${item.status}]\t${item.title}`);
  });

  for (const name of ["claim", "start"] as const) {
    ticket.command(`${name} <id>`).description(`${name} a ticket`).action(async (id: string) => {
      const state = await requireLeanState(ctx);
      const current = await ensureTicket(ctx, state, id);
      const goal = state.goals[current.goal_id];
      if (!goal) throw new Error(`Unknown goal: ${current.goal_id}`);
      if (goal.assurance === "high" && !goal.worktree_path) throw new Error("High-assurance tickets require 'goal worktree init' before execution.");
      await saveTicket(ctx, state, id, "in_progress");
      await ctx.store.recordEvent({ id: shortId("evt"), kind: "ticket.started", at: nowIso(), goal_id: goal.id, ticket_id: id });
      out.out(`Ticket ${id} in progress`);
    });
  }

  ticket.command("block <id>").option("-r, --reason <text>").action(async (id: string, opts: { reason?: string }) => {
    const state = await requireLeanState(ctx);
    const current = await ensureTicket(ctx, state, id);
    await saveTicket(ctx, state, id, "blocked");
    await ctx.store.recordEvent({ id: shortId("evt"), kind: "ticket.blocked", at: nowIso(), ticket_id: id, payload: { reason: opts.reason ?? "" } });
    out.out(`Ticket ${id} blocked${opts.reason ? `: ${opts.reason}` : ""}`);
  });

  ticket.command("submit <id>").description("Submit immutable code state for fresh verification").action(async (id: string) => {
    const state = await requireLeanState(ctx);
    const current = await ensureTicket(ctx, state, id);
    const digest = await submissionDigest(evidenceRoot(ctx.cwd, state.goals[current.goal_id]!), current);
    const provider = providerForState(state, current.goal_id);
    const remoteCommentId = isLiveRemoteBackend(provider.backend)
      ? await provider.addEvidence(id, `ycm-harness submission\n\nSubmission digest: ${digest}`, `submission-${digest}`)
      : undefined;
    const updated = await provider.setStatus(id, "in_review");
    if (isLiveRemoteBackend(provider.backend)) markTrackerLive(state, current.goal_id);
    const evidenceId = `submission-${slugify(id)}-${shortId().slice(0, 6)}`;
    state.evidence[evidenceId] = {
      id: evidenceId,
      goal_id: current.goal_id,
      ticket_id: id,
      kind: "other",
      submission_digest: digest,
      remote_comment_id: remoteCommentId,
      provenance: { state: "submitted", submitted_at: nowIso() },
      recorded_at: nowIso(),
    };
    state.local_tickets[id] = { ...updated, ...current, status: "in_review", updated_at: updated.updated_at };
    await ctx.store.writeStateV3(state);
    await ctx.store.recordEvent({ id: shortId("evt"), kind: "ticket.submitted", at: nowIso(), goal_id: current.goal_id, ticket_id: id });
    out.out(`Submitted ticket ${id} for fresh verification (${digest.slice(0, 16)}).`);
  });

  ticket.command("done <id>").description("Complete a ticket only after a fresh PASS deed").action(async (id: string) => {
    const state = await requireLeanState(ctx);
    const current = await ensureTicket(ctx, state, id);
    const evidence = await freshCompletionEvidence(evidenceRoot(ctx.cwd, state.goals[current.goal_id]!), state, current);
    if (!evidence) throw new Error(`Ticket ${id} has no fresh passing verification evidence.`);
    const implementer = evidence.provenance.implementer_run;
    const verifier = evidence.provenance.verifier_run;
    if (!implementer || !verifier || implementer === verifier) throw new Error("Completion evidence must identify distinct implementer and verifier runs.");
    await saveTicket(ctx, state, id, "done");
    await ctx.store.recordEvent({ id: shortId("evt"), kind: "ticket.done", at: nowIso(), goal_id: current.goal_id, ticket_id: id });
    out.out(`Completed ticket ${id}`);
  });

  ticket.command("next").action(async () => {
    const state = await requireLeanState(ctx);
    const goal = goalFor(state);
    const provider = providerForState(state, goal.id);
    const rows = await provider.list(goal.id);
    if (isLiveRemoteBackend(provider.backend)) { markTrackerLive(state, goal.id); await ctx.store.writeStateV3(state); }
    const next = goal.backend.kind === "local"
      ? nextLocalTicket(state, goal.id)
      : rows.find((item) => item.status === "in_progress") ?? rows.find((item) => item.status === "todo");
    if (!next) return out.out("No actionable ticket.");
    out.out(`${next.id}: ${next.title}`);
  });
}








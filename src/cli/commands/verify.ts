import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { requireLeanState, activeLeanGoal } from "../lean-state.js";
import { evidenceRoot, executeVerification, submissionDigest, validateKnowledge } from "../../tickets/evidence.js";
import { nowIso } from "../../state/ids.js";
import { isLiveRemoteBackend, markTrackerLive, providerForState } from "../../tickets/provider.js";
import { requireContinuationClosure } from "../../continuation/closure.js";
async function ensureTicket(state: Awaited<ReturnType<typeof requireLeanState>>, id: string) {
  const local = state.local_tickets[id];
  if (local) return local;
  const goal = activeLeanGoal(state);
  if (!goal) throw new Error("No active goal.");
  const fetched = await providerForState(state, goal.id).get(id);
  if (!fetched) throw new Error("Unknown ticket: " + id);
  const ticket = { ...fetched, goal_id: goal.id };
  state.local_tickets[id] = ticket;
  return ticket;
}


export function registerVerify(program: Command, ctx: CliContext, out: CliOutput): void {
  const verify = program.command("verify").alias("smoke").description("Execute and inspect fresh ticket verification evidence");
  verify.command("run")
    .requiredOption("--ticket <id>")
    .requiredOption("-c, --command <text>")
    .requiredOption("--implementer-run <id>")
    .requiredOption("--verifier-run <id>")
    .option("--knowledge <value...>", "none or existing project-wiki page IDs", ["none"])
    .action(async (opts: { ticket: string; command: string; implementerRun: string; verifierRun: string; knowledge: string[] }) => {
      const state = await requireLeanState(ctx);
      const ticket = await ensureTicket(state, opts.ticket);
      const knowledge = validateKnowledge(state, opts.knowledge ?? ["none"]);
      const submitted = Object.values(state.evidence)
        .filter((item) => item.ticket_id === ticket.id && item.submission_digest)
        .sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
      if (!submitted?.submission_digest) throw new Error(`Ticket ${ticket.id} must be submitted before verification.`);
      const root = evidenceRoot(ctx.cwd, state.goals[ticket.goal_id]!);
      const currentDigest = await submissionDigest(root, ticket);
      if (currentDigest !== submitted.submission_digest) throw new Error("Submission evidence is stale; submit again after code or acceptance changes.");
      await requireContinuationClosure({ root, surface: "verification-completion" });
      const execution = await executeVerification({ root, ticket, command: opts.command, implementerRun: opts.implementerRun, verifierRun: opts.verifierRun, knowledge });
      execution.pointer.submission_digest = submitted.submission_digest;
      const provider = providerForState(state, ticket.goal_id);
      if (isLiveRemoteBackend(provider.backend)) {
        execution.pointer.remote_comment_id = await provider.addEvidence(ticket.id, [
          "ycm-harness verification",
          "",
          `Outcome: ${execution.pointer.outcome}`,
          `Submission digest: ${execution.pointer.submission_digest}`,
          `Evidence digest: ${execution.pointer.evidence_digest}`,
          `Command: ${execution.pointer.command}`,
          `Implementer run: ${opts.implementerRun}`,
          `Verifier run: ${opts.verifierRun}`,
          `Knowledge: ${knowledge.join(", ")}`,
        ].join("\n"), `verification-${execution.pointer.id}`);
      }
      state.evidence[execution.pointer.id] = execution.pointer;
      const remote = await provider.setStatus(ticket.id, execution.pointer.outcome === "pass" ? "done" : "in_progress");
      if (isLiveRemoteBackend(provider.backend)) markTrackerLive(state, ticket.goal_id);
      state.local_tickets[ticket.id] = { ...remote, ...ticket, status: execution.pointer.outcome === "pass" ? "done" : "in_progress", updated_at: nowIso() };
      await ctx.store.writeStateV3(state);
      out.json({ ticket_id: ticket.id, evidence_id: execution.pointer.id, outcome: execution.pointer.outcome, evidence_digest: execution.pointer.evidence_digest, knowledge });
      if (execution.pointer.outcome !== "pass") throw new Error(`Verification failed with exit ${execution.result.exitCode}.`);
    });

  verify.command("status <ticket>").option("--json").action(async (ticketId: string, opts: { json?: boolean }) => {
    const state = await requireLeanState(ctx);
    const rows = Object.values(state.evidence).filter((item) => item.ticket_id === ticketId).sort((a, b) => b.recorded_at.localeCompare(a.recorded_at));
    if (opts.json) return out.json(rows);
    if (!rows.length) return out.out(`No evidence for ${ticketId}.`);
    for (const row of rows) out.out(`${row.id}\t${row.kind}\t${row.outcome ?? "submitted"}\t${row.recorded_at}`);
  });

  verify.command("verdict <ticket>").option("--json").action(async (ticketId: string, opts: { json?: boolean }) => {
    const state = await requireLeanState(ctx);
    const latest = Object.values(state.evidence).filter((item) => item.ticket_id === ticketId && item.kind === "verification").sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0];
    const result = { ticket_id: ticketId, verdict: latest?.outcome === "pass" ? "PASS" : latest?.outcome === "fail" ? "FAIL" : "PENDING", evidence_id: latest?.id };
    if (opts.json) out.json(result); else out.out(`${result.ticket_id}: ${result.verdict}${result.evidence_id ? ` (${result.evidence_id})` : ""}`);
  });
}




import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { CheckpointV3, type CheckpointV3KindT } from "../../schema/v3.js";
import { nowIso, shortId, slugify } from "../../state/ids.js";
import { requireLeanState, activeLeanGoal } from "../lean-state.js";

const KINDS: CheckpointV3KindT[] = ["phase_transition", "task_complete", "blocker", "decision", "context_compaction", "manual"];
function assertKind(value: string): CheckpointV3KindT {
  if ((KINDS as readonly string[]).includes(value)) return value as CheckpointV3KindT;
  throw new Error(`Unknown checkpoint kind: ${value}. Expected ${KINDS.join(", ")}.`);
}

export function registerCheckpoint(program: Command, ctx: CliContext, out: CliOutput): void {
  program.command("checkpoint <kind> <title>")
    .description("Record a durable goal/ticket checkpoint")
    .option("-n, --notes <text>")
    .option("-d, --decision <text...>")
    .option("--ticket <id>")
    .option("--next <text>")
    .action(async (kindRaw: string, title: string, opts: { notes?: string; decision?: string[]; ticket?: string; next?: string }) => {
      const kind = assertKind(kindRaw);
      const state = await requireLeanState(ctx);
      const goal = activeLeanGoal(state);
      if (!goal) throw new Error("No active goal.");
      if (opts.ticket && !state.local_tickets[opts.ticket]) throw new Error(`Unknown ticket: ${opts.ticket}`);
      const at = nowIso();
      const id = `cp_${kind}_${slugify(title)}_${shortId().slice(0, 4)}`;
      state.checkpoints[id] = CheckpointV3.parse({ id, goal_id: goal.id, ticket_id: opts.ticket, kind, title, notes: opts.notes, decisions: opts.decision ?? [], next_action: opts.next, created_at: at });
      await ctx.store.writeStateV3(state);
      await ctx.store.recordEvent({ id: shortId("evt"), kind: "checkpoint.recorded", at, goal_id: goal.id, ticket_id: opts.ticket, checkpoint_id: id });
      out.out(`Recorded checkpoint ${id} [${kind}]`);
    });
}

import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { requireLeanState, activeLeanGoal } from "../lean-state.js";
import { nextLocalTicket, providerForState } from "../../tickets/provider.js";

export function registerNext(program: Command, ctx: CliContext, out: CliOutput): void {
  program.command("next")
    .description("Print the next provider-neutral ticket or verification action")
    .option("--json", "Emit JSON instead of formatted text", false)
    .action(async (opts: { json?: boolean }) => {
      const state = await requireLeanState(ctx);
      const goal = activeLeanGoal(state);
      if (!goal) { if (opts.json) out.json({ message: "No active goal." }); else out.out("No active goal."); return; }
      const provider = providerForState(state, goal.id);
      const rows = await provider.list(goal.id);
      const next = goal.backend.kind === "local" ? nextLocalTicket(state, goal.id) : rows.find((ticket) => ticket.status === "in_progress") ?? rows.find((ticket) => ticket.status === "todo");
      const payload = next
        ? { message: `Continue '${next.title}'.`, command: next.status === "in_progress" ? `ycm-harness ticket submit ${next.id}` : `ycm-harness ticket start ${next.id}`, goal_id: goal.id, ticket_id: next.id }
        : { message: `Verify and complete '${goal.title}'.`, command: `ycm-harness goal verify ${goal.id}`, goal_id: goal.id };
      if (opts.json) out.json(payload); else { out.out(payload.message); out.out(`> ${payload.command}`); }
    });
}

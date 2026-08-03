import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { buildSessionDigest, renderSessionContext } from "../../hooks/session-start.js";

async function readAnyState(ctx: CliContext): Promise<unknown | undefined> {
  if (!(await ctx.store.exists())) return undefined;
  try { return await ctx.store.readStateV3(); } catch { return await ctx.store.readState(); }
}

export function registerStatus(program: Command, ctx: CliContext, out: CliOutput): void {
  program.command("status")
    .description("Show the compact goal, ticket, blocker, wiki, and next-action card")
    .option("--json", "Emit JSON instead of formatted text", false)
    .action(async (opts: { json?: boolean }) => {
      const digest = buildSessionDigest(await readAnyState(ctx));
      if (opts.json) out.json(digest); else out.out(renderSessionContext(digest));
    });
}

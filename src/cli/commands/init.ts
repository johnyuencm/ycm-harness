import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";

export function registerInit(program: Command, ctx: CliContext, out: CliOutput): void {
  program
    .command("init")
    .description("Initialize ycm-harness state in the current project")
    .option("--force", "Reinitialize even if state already exists", false)
    .action(async (opts: { force?: boolean }) => {
      const state = await ctx.store.init({ force: !!opts.force });
      out.out(`Initialized ycm-harness at ${ctx.store.paths.dir}`);
      out.out(`State version ${state.version}, created ${state.created_at}`);
    });
}

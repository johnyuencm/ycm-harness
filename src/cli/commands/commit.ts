import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { registerDeprecatedCommand } from "../deprecated.js";

export function registerCommit(program: Command, ctx: CliContext, out: CliOutput): void {
  registerDeprecatedCommand(program, "commit", ctx, out, "ticket submit");
}

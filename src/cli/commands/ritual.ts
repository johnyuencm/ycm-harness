import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { registerDeprecatedCommand } from "../deprecated.js";

export function registerRitual(program: Command, ctx: CliContext, out: CliOutput): void {
  registerDeprecatedCommand(program, "ritual", ctx, out, "verify run / verify verdict");
}

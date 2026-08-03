import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { registerDeprecatedCommand } from "../deprecated.js";

export function registerSession(program: Command, ctx: CliContext, out: CliOutput): void {
  registerDeprecatedCommand(program, "session", ctx, out, "status / checkpoint");
}

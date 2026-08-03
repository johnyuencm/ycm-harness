import type { Command } from "commander";
import type { CliOutput } from "./output.js";

/** Exit code used by commands retained only as the 0.3 compatibility bridge. */
export class DeprecatedCommandError extends Error {
  readonly exitCode = 2;

  constructor(command: string, replacement?: string) {
    super(
      replacement
        ? `Command '${command}' is deprecated in ycm-harness 0.3; use '${replacement}'.`
        : `Command '${command}' is deprecated in ycm-harness 0.3 and is not available; see the 0.4 cleanup plan.`,
    );
    this.name = "DeprecatedCommandError";
  }
}

/** Register a catch-all command so old scripts fail clearly, without mutating state. */
export function registerDeprecatedCommand(
  program: Command,
  name: string,
  _ctx: unknown,
  _out: CliOutput,
  replacement?: string,
): void {
  program
    .command(name)
    .description(
      replacement
        ? `Deprecated compatibility alias; use '${replacement}'.`
        : "Deprecated compatibility command; retained through 0.3 only.",
    )
    .allowUnknownOption()
    .allowExcessArguments()
    .action(() => {
      throw new DeprecatedCommandError(name, replacement);
    });
}

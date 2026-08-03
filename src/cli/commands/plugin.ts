import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { DeprecatedCommandError } from "../deprecated.js";

function installCommand(program: Command): Command {
  const install = program.commands.find((command) => command.name() === "install");
  if (!install) throw new DeprecatedCommandError("plugin update", "install --force");
  return install;
}

export function registerPlugin(program: Command, _ctx: CliContext, _out: CliOutput): void {
  const plugin = program
    .command("plugin")
    .description("Deprecated plugin command; use 'install --force'.")
    .allowUnknownOption()
    .allowExcessArguments();

  plugin
    .command("update")
    .description("Deprecated alias for 'install --force'.")
    .allowUnknownOption()
    .allowExcessArguments()
    .action(async () => {
      await installCommand(program).parseAsync(["--force"], { from: "user" });
    });

  plugin.action(() => {
    throw new DeprecatedCommandError("plugin", "install --force");
  });
}

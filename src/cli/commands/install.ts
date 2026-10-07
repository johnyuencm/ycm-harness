import { Option, type Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { fileExists } from "../../state/io.js";
import { packageRoot, runClientSync } from "../install-kit.js";
import path from "node:path";

export function registerInstall(
  program: Command,
  _ctx: CliContext,
  out: CliOutput,
): void {
  program
    .command("install")
    .description(
      "Install user-level design/work skills and plugin assets (skills, agents, rule) under ~/.cursor. Installs are global; install never writes into the current project. Matt Pocock skills come from mattpocock-skills@mattpocock; Ralph from ralph-loop@claude-plugins-official; Caveman from caveman@caveman; Ponytail from ponytail@ponytail — not this install.",
    )
    .option(
      "--user",
      "Install at the user level (the default; kept for compatibility)",
      false,
    )
    // Hidden: old scripts get a clear failure instead of a silent no-op.
    .addOption(new Option("--project").hideHelp())
    .option("--client <cursor|opencode|all>", "Install one client projection or all")
    .option("--force", "Overwrite existing files", false)
    .action(
      async (opts: {
        user?: boolean;
        project?: boolean;
        client?: string;
        force?: boolean;
      }) => {
        if (opts.project) {
          throw new Error(
            "ycm-harness installs globally; per-project install was removed. Run `ycm-harness doctor --repair` to clean old project copies.",
          );
        }
        if (opts.client && !["cursor", "opencode", "all"].includes(opts.client)) {
          throw new Error("client must be cursor, opencode, or all");
        }
        if (opts.client && opts.user) {
          throw new Error("--client cannot be combined with scope options");
        }
        const root = packageRoot();
        const skillSrc = path.join(
          root,
          "plugin",
          "skills",
          "ycm-harness-work",
          "SKILL.md",
        );
        const ruleSrc = path.join(
          root,
          "plugin",
          "rules",
          "ycm-harness.mdc",
        );
        const designSrc = path.join(
          root,
          "plugin",
          "skills",
          "ycm-harness-design",
          "SKILL.md",
        );

        if (!(await fileExists(skillSrc))) {
          throw new Error(`Skill source not found: ${skillSrc}`);
        }
        if (!(await fileExists(designSrc))) {
          throw new Error(`Design skill source not found: ${designSrc}`);
        }
        if (!(await fileExists(ruleSrc))) {
          throw new Error(`Rule source not found: ${ruleSrc}`);
        }

        // Global installs only: the default is the Cursor client projection.
        const client = opts.client ?? "cursor";
        const reports = await runClientSync({
          cursor: client === "cursor" || client === "all",
          codex: client === "all",
          opencode: client === "opencode" || client === "all",
          force: !!opts.force,
          sourceRoot: root,
        });

        for (const line of reports) out.out(line);

        out.out("");
        out.out(
          "Next: open a new Cursor chat and say 'use ycm-harness-design' for planning, then 'use ycm-harness-work' for Ralph execution. For quick tasks or after plan-and-advance, use 'ycm-harness-work-lite'.",
        );
        out.out(
          "Tip: use 'ycm-harness sync' to update both Cursor and Codex CLI plugin installs.",
        );
      },
    );
}

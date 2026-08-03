import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { fileExists } from "../../state/io.js";
import { packageRoot, runClientSync, runInstallScopes } from "../install-kit.js";
import path from "node:path";

export function registerInstall(
  program: Command,
  ctx: CliContext,
  out: CliOutput,
): void {
  program
    .command("install")
    .description(
      "Install Cursor-facing skills, agents, rule, and plugin assets. Defaults to project scope (.cursor/) plus user-level design/work skills and plugin. Matt Pocock skills come from mattpocock-skills@mattpocock; Ralph from ralph-loop@claude-plugins-official; Caveman from caveman@caveman — not this install.",
    )
    .option(
      "--user",
      "Install skill at the user level (~/.cursor/skills/)",
      false,
    )
    .option(
      "--project",
      "Install rule + skill at the project level (.cursor/)",
      false,
    )
    .option("--skill-only", "Install the skill only (skip the rule)", false)
    .option("--rule-only", "Install the rule only (skip the skill)", false)
    .option("--client <cursor|opencode|all>", "Install one client projection or all")
    .option("--force", "Overwrite existing files", false)
    .action(
      async (opts: {
        user?: boolean;
        project?: boolean;
        skillOnly?: boolean;
        ruleOnly?: boolean;
        client?: string;
        force?: boolean;
      }) => {
        if (opts.client && !["cursor", "opencode", "all"].includes(opts.client)) {
          throw new Error("client must be cursor, opencode, or all");
        }
        if (opts.client && (opts.user || opts.project || opts.skillOnly || opts.ruleOnly)) {
          throw new Error("--client cannot be combined with scope options");
        }
        const wantUser = opts.user ?? false;
        const wantProject = opts.project ?? false;
        const userScope = wantUser || (!wantUser && !wantProject);
        const projectScope = wantProject || (!wantUser && !wantProject);

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

        const reports = opts.client
          ? await runClientSync({
              cursor: opts.client === "cursor" || opts.client === "all",
              codex: opts.client === "all",
              opencode: opts.client === "opencode" || opts.client === "all",
              force: !!opts.force,
              sourceRoot: root,
            })
          : await runInstallScopes(ctx, {
              user: userScope,
              project: projectScope,
              force: !!opts.force,
              skillOnly: opts.skillOnly,
              ruleOnly: opts.ruleOnly,
            });

        if (reports.length === 0) {
          reports.push(
            "nothing to install (check --skill-only/--rule-only flags)",
          );
        }

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

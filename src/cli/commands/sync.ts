import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { fileExists } from "../../state/io.js";
import { runClientSync, runInstallScopes } from "../install-kit.js";
import path from "node:path";
import os from "node:os";

export function registerSync(program: Command, ctx: CliContext, out: CliOutput): void {
  program
    .command("sync")
    .description(
      "Sync plugin assets into detected Cursor, Codex, OpenCode, and Claude Code clients (also refreshes Cursor install --force).",
    )
    .option("--cursor", "Sync Cursor only", false)
    .option("--codex", "Sync Codex CLI plugin only", false)
    .option("--opencode", "Sync OpenCode plugin and skills only", false)
    .option("--claude", "Sync Claude Code marketplace + plugin only", false)
    .option(
      "--claude-git",
      "For Claude: register johnyuencm/ycm-harness GitHub marketplace (auto-update from git) instead of local checkout",
      false,
    )
    .option(
      "--claude-ref <ref>",
      "Git branch/tag for --claude-git (default: master)",
      "master",
    )
    .option("--all", "Sync all clients regardless of detection", false)
    .option(
      "--refresh-codex-cache",
      "After syncing Codex marketplace files, reinstall the enabled Codex plugin cache",
      false,
    )
    .option("--json", "Emit machine-readable output", false)
    .action(async (opts: {
      cursor?: boolean;
      codex?: boolean;
      opencode?: boolean;
      claude?: boolean;
      claudeGit?: boolean;
      claudeRef?: string;
      all?: boolean;
      refreshCodexCache?: boolean;
      json?: boolean;
    }) => {
      const home = process.env.YCM_HARNESS_HOME
        ?? process.env.HOME
        ?? process.env.USERPROFILE
        ?? os.homedir();
      const wantAll = !!opts.all;
      const anyExplicit = !!(opts.cursor || opts.codex || opts.opencode || opts.claude);
      const cursor = wantAll || opts.cursor || (!anyExplicit && await fileExists(path.join(home, ".cursor")));
      const codex = wantAll || opts.codex || (!anyExplicit && await fileExists(path.join(home, ".codex")));
      const opencode = wantAll || opts.opencode || (!anyExplicit && await fileExists(path.join(home, ".config", "opencode")));
      const claude = wantAll || opts.claude || (!anyExplicit && await fileExists(path.join(home, ".claude")));

      // Cursor install targets (user + project skills/rule) always when cursor is selected.
      const reports: string[] = [];
      if (cursor) {
        reports.push(...await runInstallScopes(ctx, { user: true, project: true, force: true }));
      }
      reports.push(...await runClientSync({
        cursor,
        codex,
        opencode,
        claude,
        claudeGit: !!opts.claudeGit,
        claudeRef: opts.claudeRef,
        force: true,
        refreshCodexCache: !!opts.refreshCodexCache || !!codex,
      }));

      if (opts.json) {
        out.json({
          targets: { cursor, codex, opencode, claude },
          reports,
        });
        return;
      }
      for (const line of reports) out.out(line);
      out.out("");
      out.out("Next: start a new Codex/Cursor/OpenCode/Claude Code session so it reloads the refreshed plugin skills.");
      if (claude && opts.claudeGit) {
        out.out(
          `Claude auto-update tracks git ref '${opts.claudeRef ?? "master"}' on johnyuencm/ycm-harness — push there, then /plugin marketplace update harness (or wait for autoUpdate).`,
        );
      } else if (claude) {
        out.out(
          "Claude is on a local marketplace. For git auto-update: ycm-harness sync --claude --claude-git [--claude-ref master]",
        );
      }
    });
}

import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import {
  auditInstall,
  mattPocockInstallHint,
  ralphLoopInstallHint,
  cavemanInstallHint,
  ponytailInstallHint,
  runClientSync,
  runInstallScopes,
  repairLegacyAgentDirs,
  packageRoot,
} from "../install-kit.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  CLI_NAME,
  HARNESS_DIR_NAME,
  LEGACY_HARNESS_DIR_NAME,
} from "../../branding.js";
import {
  legacyStateNeedsRename,
  migrateRenameCommandHint,
} from "../../migration/rename.js";

function countBad(items: { status: string }[]): number {
  return items.filter((item) => !["ok", "n/a"].includes(item.status)).length;
}

export function registerDoctor(
  program: Command,
  ctx: CliContext,
  out: CliOutput,
): void {
  program
    .command("doctor")
    .description(
      "Audit Cursor/OpenCode installs against the canonical lean package",
    )
    .option("--json")
    .option("--repair")
    .action(async (opts: { json?: boolean; repair?: boolean }) => {
      const needsRename = await legacyStateNeedsRename(ctx.cwd);
      if (needsRename.project || needsRename.user) {
        const hint = migrateRenameCommandHint(needsRename);
        const scopes = [
          needsRename.project ? "project" : null,
          needsRename.user ? "user" : null,
        ]
          .filter(Boolean)
          .join(" and ");
        const message =
          `Legacy ${LEGACY_HARNESS_DIR_NAME} state dir found (${scopes}) but ${HARNESS_DIR_NAME} is missing. ` +
          `Run: ${hint}`;
        if (opts.json) {
          out.json({
            ok: false,
            error: "legacy_state_dir",
            message,
            migrate_command: hint,
            needs_rename: needsRename,
          });
        } else {
          out.err(message);
        }
        throw Object.assign(new Error(message), { exitCode: 1 });
      }

      const sourceRoot = packageRoot();
      let { audit, needs_sync } = await auditInstall(ctx.cwd);
      let repaired = false;
      const repairReports: string[] = [];
      if (needs_sync && opts.repair) {
        repairReports.push(
          ...(await runInstallScopes(ctx, {
            user: true,
            project: true,
            force: false,
            sourceRoot,
          })),
        );
        repairReports.push(
          ...(await runClientSync({
            cursor: true,
            opencode: audit.opencode_config.status !== "n/a",
            force: true,
            sourceRoot,
          })),
        );
        repairReports.push(...(await repairLegacyAgentDirs(ctx.cwd)));
        repaired = true;
        ({ audit, needs_sync } = await auditInstall(ctx.cwd));
      }
      let version = "unknown";
      try {
        version =
          (
            JSON.parse(
              await readFile(path.join(sourceRoot, "package.json"), "utf8"),
            ) as { version?: string }
          ).version ?? version;
      } catch {
        /* report unknown */
      }
      const payload = {
        cli_version: version,
        project_root: ctx.cwd,
        source_root: sourceRoot,
        needs_sync,
        repaired,
        repair_command: `${CLI_NAME} doctor --repair`,
        user_skill_gaps: countBad(audit.user_skill),
        project_skill_gaps: countBad(audit.project_skill),
        project_rule_status: audit.project_rule?.status ?? "n/a",
        cursor_plugin_gaps: countBad(audit.cursor_plugin),
        opencode_skill_gaps: countBad(audit.opencode_skill),
        opencode_config_status: audit.opencode_config.status,
        mattpocock_skills_status: audit.mattpocock_skills.status,
        ralph_loop_status: audit.ralph_loop.status,
        caveman_status: audit.caveman.status,
        ponytail_status: audit.ponytail.status,
        audit,
      };
      if (opts.json) return out.json(payload);
      out.out(`${CLI_NAME} doctor (CLI ${version})`);
      out.out(`needs_sync: ${needs_sync}`);
      out.out(
        `mattpocock-skills: ${audit.mattpocock_skills.status}` +
          (audit.mattpocock_skills.status === "ok"
            ? ` (${audit.mattpocock_skills.path})`
            : ""),
      );
      if (audit.mattpocock_skills.status === "missing") {
        out.out(mattPocockInstallHint());
      }
      out.out(
        `ralph-loop: ${audit.ralph_loop.status}` +
          (audit.ralph_loop.status === "ok"
            ? ` (${audit.ralph_loop.path})`
            : ""),
      );
      if (audit.ralph_loop.status === "missing") {
        out.out(ralphLoopInstallHint());
      }
      out.out(
        `caveman: ${audit.caveman.status}` +
          (audit.caveman.status === "ok" ? ` (${audit.caveman.path})` : ""),
      );
      if (audit.caveman.status === "missing") {
        out.out(cavemanInstallHint());
      }
      out.out(
        `ponytail: ${audit.ponytail.status}` +
          (audit.ponytail.status === "ok" ? ` (${audit.ponytail.path})` : ""),
      );
      if (audit.ponytail.status === "missing") {
        out.out(ponytailInstallHint());
      }
      if (needs_sync && !repaired) {
        out.out(`Repair: ${CLI_NAME} doctor --repair`);
      }
      for (const line of repairReports) out.out(line);
    });
}

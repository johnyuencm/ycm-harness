import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { migrateOnDisk } from "../../migration/disk.js";
import { renameHarnessDirs } from "../../migration/rename.js";
import { HARNESS_DIR_NAME, LEGACY_HARNESS_DIR_NAME } from "../../branding.js";

export function registerMigrate(program: Command, ctx: CliContext, out: CliOutput): void {
  const migrate = program
    .command("migrate")
    .description("Migrate V2 project state to lean V3, or rename legacy brand state dirs")
    .option("--dry-run", "Preview the V2→V3 migration without writing", false)
    .option("--apply", "Apply the staged V2→V3 migration", false)
    .action(async (opts: { dryRun?: boolean; apply?: boolean }) => {
      if (!opts.dryRun && !opts.apply) {
        throw new Error(
          "choose exactly one of --dry-run or --apply (V2→V3), or use: migrate rename",
        );
      }
      if (!!opts.dryRun === !!opts.apply) {
        throw new Error("choose exactly one of --dry-run or --apply");
      }
      const result = await migrateOnDisk(ctx.cwd, { dryRun: !!opts.dryRun });
      out.json({
        ok: true,
        applied: result.applied,
        already_migrated: result.already_migrated,
        preview: result.preview,
      });
    });

  migrate
    .command("rename")
    .description(
      `Rename legacy ${LEGACY_HARNESS_DIR_NAME} state dirs to ${HARNESS_DIR_NAME} (project and/or user)`,
    )
    .option("--user", "Rename only the user state dir", false)
    .option("--project", "Rename only the project state dir", false)
    .option(
      "--force",
      "When both dirs exist, keep new and leave legacy for manual cleanup",
      false,
    )
    .action(async (opts: { user?: boolean; project?: boolean; force?: boolean }) => {
      const result = await renameHarnessDirs({
        projectRoot: ctx.cwd,
        project: opts.project,
        user: opts.user,
        force: opts.force,
      });
      out.json({
        ok: true,
        results: result.results,
        post_hints: result.postHints,
      });
      for (const row of result.results) out.out(row.message);
      for (const hint of result.postHints) out.out(hint);
    });
}

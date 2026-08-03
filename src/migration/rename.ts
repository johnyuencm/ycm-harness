import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  CLI_NAME,
  ENV_HOME,
  HARNESS_DIR_NAME,
  LEGACY_HARNESS_DIR_NAME,
} from "../branding.js";

export type RenameScope = "project" | "user";

export interface RenameDirsOptions {
  projectRoot?: string;
  home?: string;
  /** Rename project `.cursor-harness` → `.ycm-harness`. */
  project?: boolean;
  /** Rename user `~/.cursor-harness` → `~/.ycm-harness`. */
  user?: boolean;
  /**
   * When both legacy and new dirs exist, leave legacy in place and treat new as
   * authoritative (no error). Without force, both present is an error.
   */
  force?: boolean;
  /** Test seam: skip actual fs.rename. */
  dryRun?: boolean;
}

export interface RenameScopeResult {
  scope: RenameScope;
  legacyPath: string;
  newPath: string;
  action: "renamed" | "already_new" | "noop_missing" | "force_keep_both" | "skipped";
  message: string;
}

export interface RenameDirsResult {
  results: RenameScopeResult[];
  postHints: string[];
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function resolveScopes(opts: RenameDirsOptions): { project: boolean; user: boolean } {
  if (opts.project || opts.user) {
    return { project: !!opts.project, user: !!opts.user };
  }
  return { project: true, user: true };
}

async function renameOne(
  scope: RenameScope,
  legacyPath: string,
  newPath: string,
  force: boolean,
  dryRun: boolean,
): Promise<RenameScopeResult> {
  const hasLegacy = await exists(legacyPath);
  const hasNew = await exists(newPath);

  if (!hasLegacy && hasNew) {
    return {
      scope,
      legacyPath,
      newPath,
      action: "already_new",
      message: `${scope}: already using ${path.basename(newPath)}`,
    };
  }
  if (!hasLegacy && !hasNew) {
    return {
      scope,
      legacyPath,
      newPath,
      action: "noop_missing",
      message: `${scope}: neither ${path.basename(legacyPath)} nor ${path.basename(newPath)} found`,
    };
  }
  if (hasLegacy && hasNew) {
    if (!force) {
      throw new Error(
        `${scope}: both ${path.basename(legacyPath)} and ${path.basename(newPath)} exist. ` +
          `Prefer the new dir; remove or merge the legacy dir manually, or re-run with --force ` +
          `(keeps new, leaves legacy for manual cleanup).`,
      );
    }
    return {
      scope,
      legacyPath,
      newPath,
      action: "force_keep_both",
      message:
        `${scope}: both dirs exist; --force keeps ${path.basename(newPath)} and leaves ` +
        `${path.basename(legacyPath)} for manual cleanup`,
    };
  }

  // hasLegacy && !hasNew
  if (!dryRun) {
    await fs.rename(legacyPath, newPath);
  }
  return {
    scope,
    legacyPath,
    newPath,
    action: "renamed",
    message: `${scope}: renamed ${path.basename(legacyPath)} → ${path.basename(newPath)}`,
  };
}

/**
 * Hard-cut rename of legacy state dirs to the new brand.
 * Does not dual-read; callers should run after install hints are printed.
 */
export async function renameHarnessDirs(
  opts: RenameDirsOptions = {},
): Promise<RenameDirsResult> {
  const scopes = resolveScopes(opts);
  const force = !!opts.force;
  const dryRun = !!opts.dryRun;
  const results: RenameScopeResult[] = [];

  if (scopes.project) {
    const root = path.resolve(opts.projectRoot ?? process.cwd());
    results.push(
      await renameOne(
        "project",
        path.join(root, LEGACY_HARNESS_DIR_NAME),
        path.join(root, HARNESS_DIR_NAME),
        force,
        dryRun,
      ),
    );
  }

  if (scopes.user) {
    const home = opts.home ?? process.env[ENV_HOME] ?? os.homedir();
    results.push(
      await renameOne(
        "user",
        path.join(home, LEGACY_HARNESS_DIR_NAME),
        path.join(home, HARNESS_DIR_NAME),
        force,
        dryRun,
      ),
    );
  }

  const renamed = results.some((r) => r.action === "renamed");
  const postHints = renamed
    ? [
        `Old CLI/plugins named cursor-harness are dead after this rename.`,
        `Next: ${CLI_NAME} install --user --force`,
        `Then sync the project client installs (e.g. ${CLI_NAME} doctor --repair).`,
        `Windows: recreate scheduled tasks (old cursor-harness-hk-* names are obsolete).`,
      ]
    : [];

  return { results, postHints };
}

/** Doctor helper: legacy present and new missing. */
export async function legacyStateNeedsRename(
  projectRoot: string,
  home?: string,
): Promise<{ project: boolean; user: boolean }> {
  const homeRoot = home ?? process.env[ENV_HOME] ?? os.homedir();
  const projectLegacy = await exists(path.join(projectRoot, LEGACY_HARNESS_DIR_NAME));
  const projectNew = await exists(path.join(projectRoot, HARNESS_DIR_NAME));
  const userLegacy = await exists(path.join(homeRoot, LEGACY_HARNESS_DIR_NAME));
  const userNew = await exists(path.join(homeRoot, HARNESS_DIR_NAME));
  return {
    project: projectLegacy && !projectNew,
    user: userLegacy && !userNew,
  };
}

export function migrateRenameCommandHint(needs: { project: boolean; user: boolean }): string {
  const flags: string[] = [];
  if (needs.project && !needs.user) flags.push("--project");
  if (needs.user && !needs.project) flags.push("--user");
  // both or neither flag → default both scopes
  const flagStr = flags.length ? ` ${flags.join(" ")}` : "";
  return `${CLI_NAME} migrate rename${flagStr}`;
}

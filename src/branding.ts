/**
 * Canonical product branding for YCM Harness.
 * Import these instead of hardcoding CLI names, state dirs, or env prefixes.
 */

/** Project/user state directory name (hard cut — not dual-read in normal ops). */
export const HARNESS_DIR_NAME = ".ycm-harness";

/** Legacy state directory — migrate rename + doctor detection only. */
export const LEGACY_HARNESS_DIR_NAME = ".cursor-harness";

export const CLI_NAME = "ycm-harness";

export const PLUGIN_NAME = "ycm-harness";

export const DISPLAY_NAME = "YCM Harness";

/** Env var prefix: YCM_HARNESS_* */
export const ENV_PREFIX = "YCM_HARNESS";

export const ENV_HOME = `${ENV_PREFIX}_HOME`;

/** Build a YCM_HARNESS_* env key from a suffix (e.g. "STRICT_GATES"). */
export function envKey(suffix: string): string {
  return `${ENV_PREFIX}_${suffix}`;
}

/** Issue HTML comment brand written on create/update. */
export const ISSUE_MARKER_BRAND = "ycm-harness";

/** Legacy issue marker brand still accepted on read. */
export const LEGACY_ISSUE_MARKER_BRAND = "cursor-harness";

/** Regex fragment matching either write or legacy read marker brands. */
export const ISSUE_MARKER_BRAND_RE = `(?:${ISSUE_MARKER_BRAND}|${LEGACY_ISSUE_MARKER_BRAND})`;

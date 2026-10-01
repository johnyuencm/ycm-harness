import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function userHome() {
  return (
    process.env.YCM_HARNESS_HOME ||
    process.env.HOME ||
    process.env.USERPROFILE ||
    os.homedir()
  );
}

/**
 * CLI lookup for hooks that run from a SHA-pinned plugin tree (no sibling runtime).
 * Marketplace copies only ship plugin files; the full projection lives under
 * ~/.cursor/plugins/ycm-harness after `ycm-harness sync --cursor`.
 */
export function findHarnessCli(scriptDir) {
  const home = userHome();
  const candidates = [
    process.env.YCM_HARNESS_CLI,
    path.join(scriptDir, "..", "runtime", "dist", "cli", "index.js"),
    path.resolve(scriptDir, "..", "..", "dist", "cli", "index.js"),
  ];
  // Only borrow the Cursor projection when the caller is not the Codex tree. A
  // Codex hook must fail open (report "CLI is not available") rather than
  // silently run another client's runtime, whose env contracts differ. Cursor
  // and Claude both use the ~/.cursor projection: Claude cache installs ship no
  // runtime/ of their own.
  if (!isCodexTree(scriptDir)) {
    candidates.push(
      path.join(home, ".cursor", "plugins", "ycm-harness", "runtime", "dist", "cli", "index.js"),
      path.join(
        home,
        ".cursor",
        "plugins",
        "local",
        "ycm-harness",
        "runtime",
        "dist",
        "cli",
        "index.js",
      ),
    );
  }
  return candidates
    .filter((candidate) => typeof candidate === "string" && candidate.length > 0)
    .find((candidate) => existsSync(candidate));
}

function isCodexTree(scriptDir) {
  const pluginRoot = process.env.PLUGIN_ROOT;
  if (typeof pluginRoot === "string" && /(?:^|[\\/])\.codex[\\/]/i.test(pluginRoot)) return true;
  return /(?:^|[\\/])\.codex[\\/]/i.test(scriptDir);
}

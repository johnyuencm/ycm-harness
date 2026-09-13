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
  ].filter((candidate) => typeof candidate === "string" && candidate.length > 0);
  return candidates.find((candidate) => existsSync(candidate));
}

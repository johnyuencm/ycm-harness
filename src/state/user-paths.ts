import os from "node:os";
import path from "node:path";
import { ENV_HOME, HARNESS_DIR_NAME } from "../branding.js";

export interface UserHarnessPaths {
  root: string;
  dir: string;
  stateFile: string;
  wikiDir: string;
  wikiRawDir: string;
  wikiPagesDir: string;
  wikiIndexFile: string;
  wikiLogFile: string;
  wikiSchemaFile: string;
  promotionsFile: string;
}

export function userHarnessPaths(homeOverride?: string): UserHarnessPaths {
  const root = homeOverride ?? process.env[ENV_HOME] ?? os.homedir();
  const dir = path.join(root, HARNESS_DIR_NAME);
  const wikiDir = path.join(dir, "wiki");
  return {
    root,
    dir,
    stateFile: path.join(dir, "state.json"),
    wikiDir,
    wikiRawDir: path.join(wikiDir, "raw"),
    wikiPagesDir: path.join(wikiDir, "pages"),
    wikiIndexFile: path.join(wikiDir, "index.md"),
    wikiLogFile: path.join(wikiDir, "log.md"),
    wikiSchemaFile: path.join(wikiDir, "schema.md"),
    promotionsFile: path.join(wikiDir, "promotions.jsonl"),
  };
}

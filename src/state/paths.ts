import path from "node:path";
import { HARNESS_DIR_NAME, LEGACY_HARNESS_DIR_NAME } from "../branding.js";

export { HARNESS_DIR_NAME, LEGACY_HARNESS_DIR_NAME };

export interface HarnessPaths {
  root: string;
  dir: string;
  stateFile: string;
  eventsFile: string;
  goalsDir: string;
  phasesDir: string;
  tasksDir: string;
  checkpointsDir: string;
  sessionsDir: string;
  smokeDir: string;
  followupsFile: string;
  wikiDir: string;
  wikiRawDir: string;
  wikiPagesDir: string;
  wikiIndexFile: string;
  wikiLogFile: string;
  wikiSchemaFile: string;
}

export function harnessPaths(root: string): HarnessPaths {
  const dir = path.join(root, HARNESS_DIR_NAME);
  const wikiDir = path.join(dir, "wiki");
  return {
    root,
    dir,
    stateFile: path.join(dir, "state.json"),
    eventsFile: path.join(dir, "events.jsonl"),
    goalsDir: path.join(dir, "goals"),
    phasesDir: path.join(dir, "phases"),
    tasksDir: path.join(dir, "tasks"),
    checkpointsDir: path.join(dir, "checkpoints"),
    sessionsDir: path.join(dir, "sessions"),
    smokeDir: path.join(dir, "smoke"),
    followupsFile: path.join(dir, "followups.md"),
    wikiDir,
    wikiRawDir: path.join(wikiDir, "raw"),
    wikiPagesDir: path.join(wikiDir, "pages"),
    wikiIndexFile: path.join(wikiDir, "index.md"),
    wikiLogFile: path.join(wikiDir, "log.md"),
    wikiSchemaFile: path.join(wikiDir, "schema.md"),
  };
}

export function goalDir(root: string, goalId: string): string {
  return path.join(root, HARNESS_DIR_NAME, "goals", goalId);
}

export function goalArtifactsDir(root: string, goalId: string): string {
  return path.join(goalDir(root, goalId), "artifacts");
}

export function goalWorktreeFile(root: string, goalId: string): string {
  return path.join(goalDir(root, goalId), "worktree.json");
}

import { promises as fs } from "node:fs";
import path from "node:path";
import type { GoalT } from "../schema/goal.js";
import type { PhaseT } from "../schema/phase.js";
import { goalDir } from "./paths.js";
import { ensureDir, fileExists } from "./io.js";

export async function updateProgressMd(
  root: string,
  goal: GoalT,
  phase: PhaseT,
  status: "active" | "complete",
): Promise<string> {
  const dir = goalDir(root, goal.id);
  await ensureDir(dir);
  const file = path.join(dir, "progress.md");
  const at = new Date().toISOString();
  let body = "";
  if (await fileExists(file)) {
    body = await fs.readFile(file, "utf8");
  } else {
    body = [
      "---",
      `goal_id: ${goal.id}`,
      `title: ${goal.title}`,
      `active_phase: ${phase.kind}`,
      `worktree_path: ${goal.worktree_path ?? ""}`,
      `branch: ${goal.branch ?? ""}`,
      "status: active",
      `updated_at: ${at}`,
      "---",
      "",
      "# Progress",
      "",
      "## Phase log",
      "",
      "| Phase | Status | Completed |",
      "|-------|--------|-----------|",
      "",
    ].join("\n");
  }
  const row = `| ${phase.kind} | ${status} | ${at.slice(0, 10)} |`;
  if (!body.includes(row)) {
    const marker = "## Phase log";
    const idx = body.indexOf(marker);
    if (idx >= 0) {
      const after = body.indexOf("\n", idx + marker.length);
      body = body.slice(0, after + 1) + row + "\n" + body.slice(after + 1);
    } else {
      body += `\n${row}\n`;
    }
  }
  body = body.replace(/active_phase: .*/m, `active_phase: ${phase.kind}`);
  body = body.replace(/updated_at: .*/m, `updated_at: ${at}`);
  if (status === "complete" && phase.kind === "finish") {
    body = body.replace(/status: .*/m, "status: complete");
  }
  await fs.writeFile(file, body, "utf8");
  return file;
}

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, fileExists } from "./io.js";
import { goalArtifactsDir, goalDir } from "./paths.js";

export interface ScaffoldResult {
  goal_dir: string;
  artifacts_dir: string;
  files: string[];
}

const TEMPLATE_MAP: Record<string, string> = {
  "user-story.template.md": "user-story.md",
  "prd.template.md": "prd.md",
  "design.template.md": "design.md",
  "implementation-plan.template.md": "implementation-plan.md",
  "test-plan.template.md": "test-plan.md",
  "progress.template.md": "progress.md",
};

function packageRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return path.resolve(path.dirname(here), "..", "..");
}

export async function scaffoldGoalArtifacts(
  root: string,
  goalId: string,
  opts: { title?: string } = {},
): Promise<ScaffoldResult> {
  const dir = goalDir(root, goalId);
  const artifacts = goalArtifactsDir(root, goalId);
  await ensureDir(dir);
  await ensureDir(artifacts);

  const templateDir = path.join(packageRoot(), "templates", "artifacts");
  const created: string[] = [];

  for (const [srcName, destName] of Object.entries(TEMPLATE_MAP)) {
    const src = path.join(templateDir, srcName);
    const dest = path.join(dir, destName);
    if (!(await fileExists(src))) continue;
    if (await fileExists(dest)) continue;
    let content = await fs.readFile(src, "utf8");
    if (destName === "progress.md" && opts.title) {
      content = content.replace('goal_id: ""', `goal_id: ${goalId}`);
      content = content.replace('title: ""', `title: ${opts.title}`);
    }
    await fs.writeFile(dest, content, "utf8");
    created.push(path.relative(root, dest));
  }

  return { goal_dir: dir, artifacts_dir: artifacts, files: created };
}

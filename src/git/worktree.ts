import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export interface GitExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export async function execGit(args: string[], cwd: string, input?: string): Promise<GitExecResult> {
  return await new Promise((resolve) => {
    const child = spawn("git", args, { cwd, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr!.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      resolve({ stdout: "", stderr: err.message, code: -1 });
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? -1 });
    });
    if (input !== undefined) child.stdin!.end(input);
  });
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  const result = await execGit(["rev-parse", "--is-inside-work-tree"], cwd);
  return result.code === 0 && result.stdout.trim() === "true";
}

export interface WorktreeListEntry {
  path: string;
  branch?: string;
  head?: string;
}

export async function listWorktrees(cwd: string): Promise<WorktreeListEntry[]> {
  const result = await execGit(["worktree", "list", "--porcelain"], cwd);
  if (result.code !== 0) return [];
  const entries: WorktreeListEntry[] = [];
  let current: WorktreeListEntry | undefined;
  for (const raw of result.stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ") && current) {
      current.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    } else if (line === "" && current) {
      entries.push(current);
      current = undefined;
    }
  }
  if (current) entries.push(current);
  return entries;
}

export interface AddWorktreeOptions {
  worktreePath: string;
  branch: string;
  baseBranch?: string;
}

export interface AddWorktreeResult {
  reused: boolean;
  worktreePath: string;
  branch: string;
  base_sha?: string;
}

export async function addWorktree(
  cwd: string,
  opts: AddWorktreeOptions,
): Promise<AddWorktreeResult> {
  if (!(await isGitRepo(cwd))) {
    throw new Error(
      `cwd '${cwd}' is not inside a git work tree. Initialize git (or run from the repo root) before creating a goal worktree.`,
    );
  }
  const existing = await listWorktrees(cwd);
  const absTarget = path.resolve(cwd, opts.worktreePath);
  const reused = existing.find((e) => path.resolve(e.path) === absTarget);
  if (reused) {
    return {
      reused: true,
      worktreePath: absTarget,
      branch: reused.branch?.replace(/^refs\/heads\//, "") ?? opts.branch,
      base_sha: reused.head,
    };
  }
  const args = ["worktree", "add", absTarget, "-b", opts.branch];
  if (opts.baseBranch) args.push(opts.baseBranch);
  const add = await execGit(args, cwd);
  if (add.code !== 0) {
    throw new Error(`git worktree add failed: ${add.stderr.trim() || add.stdout.trim()}`);
  }
  const sha = await execGit(["rev-parse", "HEAD"], absTarget);
  return {
    reused: false,
    worktreePath: absTarget,
    branch: opts.branch,
    base_sha: sha.code === 0 ? sha.stdout.trim() : undefined,
  };
}

export interface WorktreeStatusReport {
  path: string;
  branch?: string;
  head?: string;
  dirty: boolean;
}

export async function worktreeStatus(worktreePath: string): Promise<WorktreeStatusReport> {
  const head = await execGit(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath);
  const sha = await execGit(["rev-parse", "HEAD"], worktreePath);
  const dirty = await execGit(["status", "--porcelain"], worktreePath);
  return {
    path: worktreePath,
    branch: head.code === 0 ? head.stdout.trim() : undefined,
    head: sha.code === 0 ? sha.stdout.trim() : undefined,
    dirty: dirty.code === 0 ? dirty.stdout.trim().length > 0 : false,
  };
}

export async function writeWorktreeMetadata(
  metadataPath: string,
  meta: { worktree_path: string; branch: string; base_sha?: string },
): Promise<void> {
  await fs.mkdir(path.dirname(metadataPath), { recursive: true });
  await fs.writeFile(metadataPath, JSON.stringify(meta, null, 2) + "\n", "utf8");
}


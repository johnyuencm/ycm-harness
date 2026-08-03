import { promises as fs } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function readJsonIfExists<T>(file: string): Promise<T | undefined> {
  try {
    const buf = await fs.readFile(file, "utf8");
    return JSON.parse(buf) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const data = JSON.stringify(value, null, 2) + "\n";
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, file);
}

export async function writeTextAtomic(file: string, data: string, mode = 0o600): Promise<void> {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await fs.writeFile(tmp, data, { encoding: "utf8", mode });
    try { await fs.chmod(tmp, mode); } catch { /* Best effort on filesystems without POSIX modes. */ }
    await fs.rename(tmp, file);
    try { await fs.chmod(file, mode); } catch { /* Best effort on filesystems without POSIX modes. */ }
  } catch (error) {
    try { await fs.rm(tmp, { force: true }); } catch { /* Preserve the original write failure. */ }
    throw error;
  }
}

export async function appendJsonl(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const line = JSON.stringify(value) + "\n";
  await fs.appendFile(file, line, "utf8");
}

export async function fileExists(file: string): Promise<boolean> {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

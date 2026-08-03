import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export interface CommandRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  combined: string;
  sha256: string;
}

export async function runShellCommand(
  command: string,
  cwd: string,
  timeoutMs = 120_000,
): Promise<CommandRunResult> {
  return await new Promise((resolve, reject) => {
    const shell = process.platform === "win32" ? "cmd.exe" : "/bin/sh";
    const shellFlag = process.platform === "win32" ? "/c" : "-c";
    const child = spawn(shell, [shellFlag, command], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const combined = [stdout, stderr].filter(Boolean).join("\n--- stderr ---\n");
      const sha256 = createHash("sha256").update(combined).digest("hex");
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        combined,
        sha256,
      });
    });
  });
}

export async function writeCommandLog(
  harnessDir: string,
  smokeId: string,
  result: CommandRunResult,
): Promise<string> {
  const logDir = path.join(harnessDir, "smoke-logs");
  await fs.mkdir(logDir, { recursive: true });
  const logFile = path.join(logDir, `${smokeId}.log`);
  const header = `# smoke log ${smokeId}\n# exit=${result.exitCode}\n# sha256=${result.sha256}\n\n`;
  await fs.writeFile(logFile, header + result.combined, "utf8");
  return logFile;
}

export async function readLogSha256(logFile: string): Promise<string | undefined> {
  try {
    const content = await fs.readFile(logFile, "utf8");
    const match = content.match(/^# sha256=([a-f0-9]{64})/m);
    return match?.[1];
  } catch {
    return undefined;
  }
}

#!/usr/bin/env node
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const rootAt = args.indexOf("--root");
if (rootAt < 0 || !args[rootAt + 1] || args.length !== 2) {
  process.stderr.write(`${JSON.stringify({ ok: false, reason_code: "strategic_canary_root_required" })}\n`);
  process.exit(2);
}

async function installedRuntime() {
  const script = path.resolve(fileURLToPath(import.meta.url));
  const scripts = path.dirname(script);
  const pluginRoot = path.dirname(scripts);
  const runtimeRoot = path.join(pluginRoot, "runtime");
  const distRoot = path.join(runtimeRoot, "dist");
  const runtime = path.join(distRoot, "index.js");
  if (path.basename(scripts) !== "scripts" || path.basename(script) !== "strategic-installed-canary.mjs") {
    throw new Error("strategic_canary_runtime_missing");
  }
  for (const [candidate, kind] of [
    [script, "file"], [pluginRoot, "directory"], [runtimeRoot, "directory"], [distRoot, "directory"], [runtime, "file"],
  ]) {
    const stat = await lstat(candidate).catch(() => undefined);
    if (!stat || stat.isSymbolicLink() || (kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
      throw new Error("strategic_canary_runtime_missing");
    }
    if (await realpath(candidate).catch(() => undefined) !== candidate) throw new Error("strategic_canary_runtime_missing");
  }
  const relative = path.relative(await realpath(pluginRoot), await realpath(runtime));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("strategic_canary_runtime_missing");
  return { runtime, pluginRoot };
}

try {
  const { runtime, pluginRoot } = await installedRuntime();
  const { runStrategicInstalledManualCanaryTrace } = await import(pathToFileURL(runtime).href);
  const trace = await runStrategicInstalledManualCanaryTrace(path.resolve(args[rootAt + 1]), { pluginRoot });
  process.stdout.write(`${JSON.stringify(trace, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${JSON.stringify({ ok: false, reason_code: error instanceof Error ? error.message : String(error) })}\n`);
  process.exit(1);
}

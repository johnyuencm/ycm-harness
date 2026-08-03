#!/usr/bin/env node
/**
 * Installs the cross-harness commander system onto this machine.
 *
 * What it does (idempotent, non-destructive by default):
 *   1. ~/.agents/system/            <- system files (00..50, LESSONS.md) from ../commander-system/system/
 *   2. ~/.agents/reports/, ~/.agents/system/backups/  <- created
 *   3. ~/.cursor/skills/commander/SKILL.md            <- pointer skill
 *   4. ~/.claude/CLAUDE.md          <- created from template if missing; if present without a
 *                                      commander pointer, backed up and the router is PREPENDED
 *                                      (existing content, e.g. other @imports, is kept below it)
 *   5. ~/.codex/AGENTS.md           <- COMMANDER-SYSTEM block inserted at top if missing
 *
 * It never overwrites an existing ~/.agents/system/ file unless --force is passed
 * (LESSONS.md is NEVER overwritten - it holds accumulated machine history).
 *
 * Usage:  node plugin/scripts/install-commander.mjs [--force] [--dry-run]
 *
 * Manual step it cannot do: adding the Cursor *user rule*. The exact text to paste
 * (Cursor Settings -> Rules -> User Rules) is printed at the end, sourced from
 * ../commander-system/entry/cursor-user-rule.txt.
 *
 * Templates use {{HOME}} placeholders and Windows-style backslash paths. On POSIX,
 * path tokens following {{HOME}} are converted to forward slashes (best effort;
 * this system is Windows-first).
 */

import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const FORCE = process.argv.includes("--force");
const DRY = process.argv.includes("--dry-run");

const here = path.dirname(fileURLToPath(import.meta.url));
const templateRoot = path.resolve(here, "..", "commander-system");
const HOME = process.env.YCM_HARNESS_HOME ?? os.homedir();
const IS_WIN = process.platform === "win32";

const systemDir = path.join(HOME, ".agents", "system");
const backupsDir = path.join(systemDir, "backups");
const reportsDir = path.join(HOME, ".agents", "reports");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

const log = [];
function report(line) { log.push(line); console.log(line); }

function render(content) {
  if (!IS_WIN) {
    // Convert backslash path tokens that follow {{HOME}} to forward slashes.
    content = content.replace(/\{\{HOME\}\}((?:\\[\w .$-]+)+)/g, (_m, p) => "{{HOME}}" + p.replace(/\\/g, "/"));
  }
  return content.split("{{HOME}}").join(HOME);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function backupOnce(src) {
  const bak = path.join(backupsDir, `${path.basename(src)}.bak-${stamp}`);
  if (!(await exists(bak))) {
    await fs.mkdir(backupsDir, { recursive: true });
    await fs.copyFile(src, bak);
    report(`  backup -> ${bak}`);
  }
}

async function installFile(templatePath, destPath, { overwritable = true } = {}) {
  const content = render(await fs.readFile(templatePath, "utf8"));
  if (await exists(destPath)) {
    const current = await fs.readFile(destPath, "utf8");
    if (current === content) { report(`ok       ${destPath}`); return; }
    if (!FORCE || !overwritable) { report(`skip     ${destPath} (exists; ${overwritable ? "use --force to overwrite" : "never overwritten"})`); return; }
    if (!DRY) { await backupOnce(destPath); await fs.writeFile(destPath, content, "utf8"); }
    report(`update   ${destPath}`);
    return;
  }
  if (!DRY) {
    await fs.mkdir(path.dirname(destPath), { recursive: true });
    await fs.writeFile(destPath, content, "utf8");
  }
  report(`install  ${destPath}`);
}

async function main() {
  report(`Commander system installer — HOME=${HOME}${DRY ? " (dry-run)" : ""}${FORCE ? " (force)" : ""}`);

  // 1+2. System files and directories
  if (!DRY) {
    await fs.mkdir(systemDir, { recursive: true });
    await fs.mkdir(backupsDir, { recursive: true });
    await fs.mkdir(reportsDir, { recursive: true });
  }
  const sysTemplates = (await fs.readdir(path.join(templateRoot, "system"))).filter((f) => f.endsWith(".md"));
  for (const f of sysTemplates) {
    await installFile(path.join(templateRoot, "system", f), path.join(systemDir, f), {
      overwritable: f !== "LESSONS.md",
    });
  }

  // 3. Cursor pointer skill
  await installFile(
    path.join(templateRoot, "entry", "cursor-commander-SKILL.md"),
    path.join(HOME, ".cursor", "skills", "commander", "SKILL.md"),
  );

  // 4. Claude Code entry file
  const claudeMd = path.join(HOME, ".claude", "CLAUDE.md");
  const routerTemplate = render(await fs.readFile(path.join(templateRoot, "entry", "claude-CLAUDE.md"), "utf8"));
  if (!(await exists(claudeMd))) {
    if (!DRY) {
      await fs.mkdir(path.dirname(claudeMd), { recursive: true });
      await fs.writeFile(claudeMd, routerTemplate, "utf8");
    }
    report(`install  ${claudeMd}`);
  } else {
    const current = await fs.readFile(claudeMd, "utf8");
    const marker = path.join(".agents", "system"); // ".agents\system" or ".agents/system"
    if (current.includes(marker)) {
      report(`ok       ${claudeMd} (commander pointer already present)`);
    } else {
      if (!DRY) { await backupOnce(claudeMd); await fs.writeFile(claudeMd, `${routerTemplate}\n${current}`, "utf8"); }
      report(`update   ${claudeMd} (router prepended; existing content kept below)`);
    }
  }

  // 5. Codex AGENTS.md block
  const codexAgents = path.join(HOME, ".codex", "AGENTS.md");
  const block = render(await fs.readFile(path.join(templateRoot, "entry", "codex-agents-block.md"), "utf8"));
  if (await exists(codexAgents)) {
    const current = await fs.readFile(codexAgents, "utf8");
    if (current.includes("COMMANDER-SYSTEM:START")) {
      report(`ok       ${codexAgents} (commander block already present)`);
    } else {
      if (!DRY) { await backupOnce(codexAgents); await fs.writeFile(codexAgents, `${block}\n${current}`, "utf8"); }
      report(`update   ${codexAgents} (block prepended)`);
    }
  } else if (await exists(path.join(HOME, ".codex"))) {
    if (!DRY) await fs.writeFile(codexAgents, block, "utf8");
    report(`install  ${codexAgents}`);
  } else {
    report(`skip     ${codexAgents} (~/.codex not present - no Codex on this machine)`);
  }

  // Manual step
  const ruleText = render(await fs.readFile(path.join(templateRoot, "entry", "cursor-user-rule.txt"), "utf8"));
  console.log("\n--- MANUAL STEP (cannot be scripted) ------------------------------");
  console.log("Add this as a Cursor User Rule (Cursor Settings -> Rules -> User Rules),");
  console.log("or ask a Cursor agent to add it via the cursor-app-control MCP (cursor_dialog):\n");
  console.log(ruleText);
  console.log("-------------------------------------------------------------------");
  console.log(`\nDone. ${log.filter((l) => l.startsWith("install") || l.startsWith("update")).length} file(s) written, ` +
    `${log.filter((l) => l.startsWith("ok")).length} already current, ${log.filter((l) => l.startsWith("skip")).length} skipped.`);
}

main().catch((err) => { console.error(err); process.exit(1); });

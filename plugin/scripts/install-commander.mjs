#!/usr/bin/env node
/**
 * Migrates this machine onto plugin-sourced commander protocol.
 *
 * Golden source is the ycm-harness plugin (`commander-system/system/` +
 * `skills/commander`). This script does NOT copy protocol files into
 * ~/.agents/system/. Plugin updates are the auto-update path.
 *
 * What it does (idempotent):
 *   1. ~/.agents/reports/           <- created
 *   2. ~/.agents/system/LESSONS.md  <- machine journal stub if missing (never overwritten)
 *   3. ~/.claude/CLAUDE.md          <- thin plugin pointer (existing extra content kept)
 *   4. ~/.codex/AGENTS.md           <- COMMANDER-SYSTEM pointer block
 *   5. Retire local protocol copies under ~/.agents/system/ (except LESSONS.md)
 *   6. Remove duplicate ~/.cursor/skills/commander (plugin skill is the source)
 *
 * Usage:  node plugin/scripts/install-commander.mjs [--force] [--dry-run]
 *
 * Manual step it cannot do: replacing the Cursor *user rule*. The exact text
 * to paste is printed at the end, sourced from
 * ../commander-system/entry/cursor-user-rule.txt.
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

const systemDir = path.join(HOME, ".agents", "system");
const backupsDir = path.join(systemDir, "backups");
const reportsDir = path.join(HOME, ".agents", "reports");
const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, "");

const PROTOCOL_FILES = [
  "00-DIAGNOSIS.md",
  "10-DISPATCH.md",
  "11-INVENTORY-cursor.md",
  "11-INVENTORY-claude.md",
  "11-INVENTORY-codex.md",
  "20-JUDGMENT.md",
  "30-TEMPLATES.md",
  "40-MAINTENANCE.md",
  "50-LETTER.md",
];

const BLOCK_START = "<!-- COMMANDER-SYSTEM:START";
const BLOCK_END = "<!-- COMMANDER-SYSTEM:END -->";

const LESSONS_STUB = `# LESSONS — Machine journal (not protocol)

Protocol lives in the ycm-harness plugin \`commander-system/system/\` and updates with that plugin.
Append hard-won environment facts here per that plugin's \`40-MAINTENANCE.md\`.
`;

const log = [];
function report(line) {
  log.push(line);
  console.log(line);
}

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function backupOnce(src) {
  const bak = path.join(backupsDir, `${path.basename(src)}.bak-${stamp}`);
  if (!(await exists(bak))) {
    if (!DRY) {
      await fs.mkdir(backupsDir, { recursive: true });
      await fs.copyFile(src, bak);
    }
    report(`  backup -> ${bak}`);
  }
}

async function upsertPointerBlock(filePath, block, { createIfMissing }) {
  if (!(await exists(filePath))) {
    if (!createIfMissing) {
      report(`skip     ${filePath} (missing)`);
      return;
    }
    if (!DRY) {
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, `${block}\n`, "utf8");
    }
    report(`install  ${filePath}`);
    return;
  }
  const current = await fs.readFile(filePath, "utf8");
  const start = current.indexOf(BLOCK_START);
  const end = current.indexOf(BLOCK_END);
  if (start !== -1 && end !== -1 && end > start) {
    const next = `${current.slice(0, start)}${block.trim()}${current.slice(end + BLOCK_END.length)}`.replace(/^\uFEFF/, "");
    if (next === current) {
      report(`ok       ${filePath} (plugin pointer already present)`);
      return;
    }
    if (!DRY) {
      await backupOnce(filePath);
      await fs.writeFile(filePath, next, "utf8");
    }
    report(`update   ${filePath} (pointer block replaced)`);
    return;
  }
  const looksLikeOldRouter =
    current.includes("You are the COMMANDER of this session") ||
    (current.includes(".agents") && current.includes("10-DISPATCH.md"));
  const next = looksLikeOldRouter ? `${block}\n` : `${block}\n${current}`;
  if (!DRY) {
    await backupOnce(filePath);
    await fs.writeFile(filePath, next, "utf8");
  }
  report(`update   ${filePath} (${looksLikeOldRouter ? "old router replaced" : "pointer prepended"})`);
}

async function retireLocalProtocol() {
  const destDir = path.join(backupsDir, `retired-protocol-${stamp}`);
  let moved = 0;
  for (const name of PROTOCOL_FILES) {
    const src = path.join(systemDir, name);
    if (!(await exists(src))) continue;
    const dest = path.join(destDir, name);
    if (!DRY) {
      await fs.mkdir(destDir, { recursive: true });
      await fs.rename(src, dest);
    }
    report(`retire   ${src} -> ${dest}`);
    moved += 1;
  }
  if (moved === 0) report(`ok       no local protocol files to retire under ${systemDir}`);
}

async function removeUserCursorSkill() {
  const skillDir = path.join(HOME, ".cursor", "skills", "commander");
  if (!(await exists(skillDir))) {
    report(`ok       ${skillDir} (already absent)`);
    return;
  }
  const bak = path.join(backupsDir, `cursor-skill-commander-${stamp}`);
  if (!DRY) {
    await fs.mkdir(backupsDir, { recursive: true });
    await fs.cp(skillDir, bak, { recursive: true });
    await fs.rm(skillDir, { recursive: true, force: true });
  }
  report(`retire   ${skillDir} -> ${bak}`);
}

async function ensureLessons() {
  const lessons = path.join(systemDir, "LESSONS.md");
  if (await exists(lessons)) {
    report(`ok       ${lessons} (machine journal kept)`);
    return;
  }
  if (!DRY) {
    await fs.mkdir(systemDir, { recursive: true });
    await fs.writeFile(lessons, LESSONS_STUB, "utf8");
  }
  report(`install  ${lessons} (journal stub)`);
}

async function main() {
  report(`Commander plugin migrate — HOME=${HOME}${DRY ? " (dry-run)" : ""}${FORCE ? " (force unused for protocol copies)" : ""}`);
  const pointer = (await fs.readFile(path.join(templateRoot, "entry", "plugin-pointer.md"), "utf8")).trim();

  if (!DRY) {
    await fs.mkdir(systemDir, { recursive: true });
    await fs.mkdir(backupsDir, { recursive: true });
    await fs.mkdir(reportsDir, { recursive: true });
  }
  report(`ok       ${reportsDir}`);

  await ensureLessons();
  await upsertPointerBlock(path.join(HOME, ".claude", "CLAUDE.md"), pointer, { createIfMissing: true });
  const codexHome = path.join(HOME, ".codex");
  if (await exists(codexHome)) {
    await upsertPointerBlock(path.join(codexHome, "AGENTS.md"), pointer, { createIfMissing: true });
  } else {
    report(`skip     ${path.join(codexHome, "AGENTS.md")} (~/.codex not present)`);
  }
  await retireLocalProtocol();
  await removeUserCursorSkill();

  const ruleText = await fs.readFile(path.join(templateRoot, "entry", "cursor-user-rule.txt"), "utf8");
  console.log("\n--- MANUAL STEP (cannot be scripted) ------------------------------");
  console.log("Replace the Cursor User Rule (Cursor Settings -> Rules -> User Rules)");
  console.log("with this plugin pointer (or ask a Cursor agent via cursor_dialog):\n");
  console.log(ruleText.trim());
  console.log("-------------------------------------------------------------------");
  console.log(
    `\nDone. ${log.filter((l) => l.startsWith("install") || l.startsWith("update") || l.startsWith("retire")).length} change(s), ` +
      `${log.filter((l) => l.startsWith("ok")).length} already current, ${log.filter((l) => l.startsWith("skip")).length} skipped.`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

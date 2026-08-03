/**
 * ycm-harness plugin for OpenCode.ai
 *
 * Registers harness skills and injects bootstrap context on the first user turn.
 */

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const extractAndStripFrontmatter = (content) => {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { frontmatter: {}, content };
  return { frontmatter: {}, content: match[2] };
};

const normalizePath = (p, homeDir) => {
  if (!p || typeof p !== "string") return null;
  let normalized = p.trim();
  if (!normalized) return null;
  if (normalized.startsWith("~/")) {
    normalized = path.join(homeDir, normalized.slice(2));
  } else if (normalized === "~") {
    normalized = homeDir;
  }
  return path.resolve(normalized);
};

function managedOrRepoSkill(managedDir, repoDir, expectedName) {
  const skillPath = path.join(managedDir, "SKILL.md");
  if (!fs.existsSync(skillPath)) return repoDir;
  const content = fs.readFileSync(skillPath, "utf8");
  return new RegExp(`^name:\\s*${expectedName}\\s*$`, "m").test(content)
    ? managedDir
    : repoDir;
}

const BUNDLED_SKILL_NAMES = []; // github tickets SOP lives in ycm-harness-work/github-tickets.md (not a separate skill)

/** Matt Pocock skill names resolved from the user's mattpocock-skills Claude plugin. */
const MATTOCK_SKILL_NAMES = [
  "grill-me",
  "grill-with-docs",
  "grilling",
  "domain-modeling",
  "tdd",
  "improve-codebase-architecture",
  "codebase-design",
  "to-spec",
  "to-tickets",
  "wayfinder",
];

function resolveMattPocockRoot(homeDir) {
  const cacheRoot = path.join(
    homeDir,
    ".claude",
    "plugins",
    "cache",
    "mattpocock",
  );
  if (fs.existsSync(cacheRoot)) {
    try {
      for (const plugin of fs.readdirSync(cacheRoot, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const versions = fs
          .readdirSync(path.join(cacheRoot, plugin.name), {
            withFileTypes: true,
          })
          .filter((v) => v.isDirectory())
          .map((v) => v.name)
          .sort()
          .reverse();
        for (const ver of versions) {
          const candidate = path.join(cacheRoot, plugin.name, ver);
          if (fs.existsSync(path.join(candidate, "skills", "engineering"))) {
            return candidate;
          }
        }
      }
    } catch {
      /* fall through */
    }
  }
  const marketplace = path.join(
    homeDir,
    ".claude",
    "plugins",
    "marketplaces",
    "mattpocock",
  );
  if (fs.existsSync(path.join(marketplace, "skills", "engineering"))) {
    return marketplace;
  }
  return null;
}

function resolveMattPocockSkillDir(mattRoot, name) {
  if (!mattRoot) return null;
  for (const category of ["engineering", "productivity"]) {
    const dir = path.join(mattRoot, "skills", category, name);
    if (fs.existsSync(path.join(dir, "SKILL.md"))) return dir;
  }
  const flat = path.join(mattRoot, "skills", name);
  if (fs.existsSync(path.join(flat, "SKILL.md"))) return flat;
  return null;
}

function resolveSkillDirs(homeDir, configDir) {
  const repoRoot = path.resolve(__dirname, "../..");
  const managedHarness = path.join(configDir, "skills", "ycm-harness");
  const managedDesign = path.join(configDir, "skills", "ycm-harness-design");
  const managedLite = path.join(
    configDir,
    "skills",
    "ycm-harness-work-lite",
  );
  const repoHarness = path.join(
    repoRoot,
    "plugin",
    "skills",
    "ycm-harness-work",
  );
  const repoDesign = path.join(
    repoRoot,
    "plugin",
    "skills",
    "ycm-harness-design",
  );
  const repoLite = path.join(
    repoRoot,
    "plugin",
    "skills",
    "ycm-harness-work-lite",
  );

  const bundled = {};
  for (const name of BUNDLED_SKILL_NAMES) {
    const managed = path.join(configDir, "skills", name);
    const repo = path.join(repoRoot, "plugin", "skills", name);
    bundled[name] = managedOrRepoSkill(managed, repo, name);
  }

  const mattRoot = resolveMattPocockRoot(homeDir);
  for (const name of MATTOCK_SKILL_NAMES) {
    const resolved = resolveMattPocockSkillDir(mattRoot, name);
    if (resolved) bundled[name] = resolved;
  }

  return {
    harnessSkillsDir: managedOrRepoSkill(
      managedHarness,
      repoHarness,
      "ycm-harness-work",
    ),
    designSkillsDir: managedOrRepoSkill(
      managedDesign,
      repoDesign,
      "ycm-harness-design",
    ),
    liteSkillsDir: managedOrRepoSkill(
      managedLite,
      repoLite,
      "ycm-harness-work-lite",
    ),
    bundledSkillDirs: bundled,
    mattPocockRoot: mattRoot,
  };
}

export const CursorHarnessPlugin = async () => {
  const homeDir = os.homedir();
  const configDir =
    normalizePath(process.env.OPENCODE_CONFIG_DIR, homeDir) ??
    path.join(homeDir, ".config", "opencode");
  const { harnessSkillsDir, designSkillsDir, liteSkillsDir, bundledSkillDirs } =
    resolveSkillDirs(homeDir, configDir);

  const readSkillContent = (skillDir) => {
    const skillPath = path.join(skillDir, "SKILL.md");
    if (!fs.existsSync(skillPath)) return null;

    const fullContent = fs.readFileSync(skillPath, "utf8");
    const { content } = extractAndStripFrontmatter(fullContent);
    return content;
  };

  const getBootstrapContent = () => {
    const workContent = readSkillContent(harnessSkillsDir);
    const designContent = readSkillContent(designSkillsDir);
    const liteContent = readSkillContent(liteSkillsDir);
    if (!workContent && !designContent && !liteContent) return null;

    const toolMapping = `**Tool Mapping for OpenCode:**
When harness skills reference Cursor-only tools, substitute OpenCode equivalents:
- \`TodoWrite\` → \`todowrite\`
- \`Task\` subagents → OpenCode subagents / @mention
- \`Skill\` tool → OpenCode native \`skill\` tool
- \`AskQuestion\` → ask clarifying questions in chat when Plan-mode AskQuestion is unavailable
- \`ycm-harness\` CLI → run in the project terminal (same command names)

Use OpenCode's native \`skill\` tool to load \`ycm-harness-work\` context files, \`ycm-harness-work-lite\`, or \`ycm-harness-design\` when needed.

**Matt Pocock skills** (to-spec, to-tickets, wayfinder, grill-with-docs, tdd, …) come from the user's \`mattpocock-skills\` Claude Code plugin — not from ycm-harness. If missing: \`claude plugin marketplace add mattpocock/skills && claude plugin install mattpocock-skills@mattpocock\`.`;

    return `<EXTREMELY_IMPORTANT>
You have ycm-harness design/work/lite skills loaded.

**IMPORTANT: The ycm-harness split skill content is included below. It is ALREADY LOADED — do NOT reload \`ycm-harness-design\`, \`ycm-harness-work\`, or \`ycm-harness-work-lite\` via the skill tool unless you need a sibling context file.**

## ycm-harness-design

${designContent ?? "(not installed)"}

## ycm-harness-work

${workContent ?? "(not installed)"}

## ycm-harness-work-lite

${liteContent ?? "(not installed)"}

${toolMapping}
</EXTREMELY_IMPORTANT>`;
  };

  return {
    config: async (config) => {
      config.skills = config.skills || {};
      config.skills.paths = config.skills.paths || [];
      for (const dir of [
        harnessSkillsDir,
        designSkillsDir,
        liteSkillsDir,
        ...Object.values(bundledSkillDirs),
      ]) {
        if (dir && fs.existsSync(dir) && !config.skills.paths.includes(dir)) {
          config.skills.paths.push(dir);
        }
      }
    },

    "experimental.chat.messages.transform": async (_input, output) => {
      const bootstrap = getBootstrapContent();
      if (!bootstrap || !output.messages.length) return;
      const firstUser = output.messages.find((m) => m.info.role === "user");
      if (!firstUser || !firstUser.parts.length) return;
      if (
        firstUser.parts.some(
          (p) => p.type === "text" && p.text.includes("EXTREMELY_IMPORTANT"),
        )
      )
        return;
      const ref = firstUser.parts[0];
      firstUser.parts.unshift({ ...ref, type: "text", text: bootstrap });
    },
  };
};

export default CursorHarnessPlugin;

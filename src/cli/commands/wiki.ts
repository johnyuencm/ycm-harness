import fs from "node:fs/promises";
import path from "node:path";
import type { Command } from "commander";
import type { CliContext } from "../context.js";
import type { CliOutput } from "../output.js";
import { nowIso, shortId, slugify } from "../../state/ids.js";
import {
  appendWikiLog,
  ensureWikiDirs,
  makeWikiLogEntry,
  writeWikiIndex,
  writeWikiSchemaIfMissing,
} from "../../wiki/store.js";
import {
  BUILTIN_RULES,
  compileAllowList,
  compileExtraPatterns,
  redact,
} from "../../wiki/redact.js";
import { resetOnWikiWrite } from "../../session/nudge.js";
import { requireLeanState } from "../lean-state.js";
import { DeprecatedCommandError } from "../deprecated.js";
import { SlugId } from "../../schema/common.js";
import {
  CLI_NAME,
  HARNESS_DIR_NAME,
  ISSUE_MARKER_BRAND,
  ISSUE_MARKER_BRAND_RE,
} from "../../branding.js";

const LIVE_WIKI_COMMANDS = new Set(["durable", "list", "show"]);

function deprecateWiki(command: string): never {
  throw new DeprecatedCommandError(command, "wiki durable");
}

export function registerWiki(program: Command, ctx: CliContext, out: CliOutput): void {
  const wiki = program.command("wiki").description("Project wiki memory");
  // Leaf names collide (`list`/`show`). Gate direct wiki children here; nested
  // `wiki source` / `wiki page` trees have their own always-deprecate hooks.
  wiki.hook("preAction", (_command, actionCommand) => {
    if (actionCommand.parent !== wiki) return;
    if (!LIVE_WIKI_COMMANDS.has(actionCommand.name())) {
      deprecateWiki("wiki " + actionCommand.name());
    }
  });

  wiki
    .command("init")
    .description(`Scaffold ${HARNESS_DIR_NAME}/wiki/ (raw/, pages/, schema.md, index.md, log.md)`)
    .action(async () => {
      const paths = ctx.store.paths;
      await ensureWikiDirs(paths);
      const wroteSchema = await writeWikiSchemaIfMissing(paths);
      const at = nowIso();
      const entry = makeWikiLogEntry("wiki.created", undefined, "wiki initialized");
      await ctx.store.update((state) => {
        if (!state.wiki.initialized) {
          state.wiki.initialized = true;
          state.wiki.initialized_at = at;
        }
        state.wiki.log.push(entry);
        state.session_nudge = resetOnWikiWrite(state.session_nudge, at);
        return state;
      });
      const state = await ctx.store.readState();
      await writeWikiIndex(paths, state);
      await appendWikiLog(paths, entry);
      await ctx.store.recordEvent({
        id: shortId("evt"),
        kind: "wiki.created",
        at,
        payload: { wrote_schema: wroteSchema },
      });
      out.out(`Wiki initialized at ${path.relative(paths.root, paths.wikiDir)}`);
      if (wroteSchema) out.out(`Wrote ${path.relative(paths.root, paths.wikiSchemaFile)}`);
    });

  const source = wiki.command("source").description("Manage wiki sources");
  source.hook("preAction", (_command, actionCommand) => {
    deprecateWiki("wiki source " + actionCommand.name());
  });

  source
    .command("add <path>")
    .description("Register a source file. Copies into wiki/raw/<id>.<ext> and records metadata.")
    .option("-i, --id <id>", "Override generated source id")
    .option("-t, --title <title>", "Override source title (defaults to filename)")
    .option("--origin <text>", "Origin URL or note")
    .action(
      async (
        srcPath: string,
        opts: { id?: string; title?: string; origin?: string },
      ) => {
        const paths = ctx.store.paths;
        const abs = path.isAbsolute(srcPath) ? srcPath : path.resolve(paths.root, srcPath);
        const stat = await fs.stat(abs).catch(() => undefined);
        if (!stat || !stat.isFile()) {
          throw new Error(`Source path not found or not a file: ${srcPath}`);
        }
        const ext = path.extname(abs) || ".md";
        const baseTitle = opts.title ?? path.basename(abs, ext);
        const id = opts.id ?? `src_${slugify(baseTitle)}_${shortId().slice(0, 4)}`;
        const rawRel = `${id}${ext}`;
        const rawAbs = path.join(paths.wikiRawDir, rawRel);
        await ensureWikiDirs(paths);
        await fs.copyFile(abs, rawAbs);
        const at = nowIso();
        const entry = makeWikiLogEntry("source.added", id, `added ${baseTitle}`);
        await ctx.store.update((state) => {
          state.wiki.sources[id] = {
            id,
            title: baseTitle,
            raw_path: rawRel,
            origin: opts.origin,
            added_at: at,
            updated_at: at,
          };
          state.wiki.log.push(entry);
          state.session_nudge = resetOnWikiWrite(state.session_nudge, at);
          return state;
        });
        const state = await ctx.store.readState();
        await writeWikiIndex(paths, state);
        await appendWikiLog(paths, entry);
        await ctx.store.recordEvent({
          id: shortId("evt"),
          kind: "wiki.source.added",
          at,
          payload: { source_id: id, raw: rawRel },
        });
        out.out(`Registered source ${id} (${baseTitle}) -> wiki/raw/${rawRel}`);
      },
    );

  source
    .command("list")
    .description("List registered wiki sources")
    .action(async () => {
      const state = await ctx.store.readState();
      const sources = Object.values(state.wiki.sources).sort((a, b) =>
        a.added_at.localeCompare(b.added_at),
      );
      if (sources.length === 0) {
        out.out(`No sources yet. Run '${CLI_NAME} wiki source add <path>'.`);
        return;
      }
      for (const s of sources) {
        out.out(`${s.id}\t${s.title}\traw/${s.raw_path}${s.origin ? `\t${s.origin}` : ""}`);
      }
    });

  const page = wiki.command("page").description("Manage wiki pages");
  page.hook("preAction", (_command, actionCommand) => {
    deprecateWiki("wiki page " + actionCommand.name());
  });

  page
    .command("upsert")
    .description("Create or update a wiki page")
    .requiredOption("--id <id>", "Stable page id (slug)")
    .requiredOption("--title <title>", "Page title")
    .option("-s, --source <id...>", "Source id(s) the page synthesises", [])
    .option("-t, --tag <tag...>", "Tag(s) for filtering", [])
    .option("--body-file <path>", "Read page body from file")
    .option("--body <text>", "Provide page body inline")
    .action(
      async (opts: {
        id: string;
        title: string;
        source: string[];
        tag: string[];
        bodyFile?: string;
        body?: string;
      }) => {
        if (!opts.bodyFile && !opts.body) {
          throw new Error("Provide --body or --body-file.");
        }
        const paths = ctx.store.paths;
        await ensureWikiDirs(paths);
        const id = opts.id;
        const bodyPathRel = `pages/${id}.md`;
        const bodyAbs = path.join(paths.wikiDir, bodyPathRel);
        let body = opts.body;
        if (opts.bodyFile) {
          const bf = path.isAbsolute(opts.bodyFile)
            ? opts.bodyFile
            : path.resolve(paths.root, opts.bodyFile);
          body = await fs.readFile(bf, "utf8");
        }
        if (!body) throw new Error("Body resolved empty.");
        const header = `# ${opts.title}\n\n<!-- managed by ${ISSUE_MARKER_BRAND} wiki. id: ${id} -->\n\n`;
        await fs.writeFile(bodyAbs, header + body, "utf8");
        const at = nowIso();
        const sources = opts.source ?? [];
        const tags = opts.tag ?? [];
        let action: "created" | "updated" = "created";
        await ctx.store.update((state) => {
          for (const sid of sources) {
            if (!state.wiki.sources[sid]) {
              throw new Error(`Unknown source '${sid}'. Add it with 'wiki source add'.`);
            }
          }
          const existing = state.wiki.pages[id];
          if (existing) action = "updated";
          state.wiki.pages[id] = {
            id,
            title: opts.title,
            source_ids: sources,
            tags,
            body_path: bodyPathRel,
            created_at: existing?.created_at ?? at,
            updated_at: at,
          };
          const entry = makeWikiLogEntry(
            "page.upserted",
            id,
            `${action} ${opts.title}`,
          );
          state.wiki.log.push(entry);
          state.session_nudge = resetOnWikiWrite(state.session_nudge, at);
          return state;
        });
        const state = await ctx.store.readState();
        await writeWikiIndex(paths, state);
        const lastEntry = state.wiki.log[state.wiki.log.length - 1];
        if (lastEntry) await appendWikiLog(paths, lastEntry);
        await ctx.store.recordEvent({
          id: shortId("evt"),
          kind: `wiki.page.${action}`,
          at,
          payload: { page_id: id, sources, tags },
        });
        out.out(`Page ${action}: ${id}`);
      },
    );

  page
    .command("list")
    .description("List wiki pages")
    .action(async () => {
      const state = await ctx.store.readState();
      const pages = Object.values(state.wiki.pages).sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at),
      );
      if (pages.length === 0) {
        out.out(`No pages yet. Run '${CLI_NAME} wiki page upsert'.`);
        return;
      }
      for (const p of pages) {
        out.out(
          `${p.id}\t${p.title}\tsources=${p.source_ids.length}\tupdated=${p.updated_at}`,
        );
      }
    });

  page
    .command("show <id>")
    .description("Print a wiki page body")
    .action(async (id: string) => {
      const state = await ctx.store.readState();
      const p = state.wiki.pages[id];
      if (!p) throw new Error(`Unknown page: ${id}`);
      const abs = path.join(ctx.store.paths.wikiDir, p.body_path);
      const body = await fs.readFile(abs, "utf8");
      out.out(body);
    });

  wiki
    .command("query <text>")
    .description("Naive grep across wiki/pages/*.md returning matches with page id and line.")
    .option("--max <n>", "Maximum matching lines to print", "30")
    .action(async (text: string, opts: { max: string }) => {
      const state = await ctx.store.readState();
      const max = Number.parseInt(opts.max, 10) || 30;
      const needle = text.toLowerCase();
      let printed = 0;
      const pages = Object.values(state.wiki.pages).sort((a, b) =>
        b.updated_at.localeCompare(a.updated_at),
      );
      for (const p of pages) {
        const abs = path.join(ctx.store.paths.wikiDir, p.body_path);
        const body = await fs.readFile(abs, "utf8").catch(() => "");
        const lines = body.split(/\r?\n/);
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i] ?? "";
          if (line.toLowerCase().includes(needle)) {
            out.out(`${p.id}:${i + 1}: ${line}`);
            printed++;
            if (printed >= max) break;
          }
        }
        if (printed >= max) break;
      }
      const at = nowIso();
      const entry = makeWikiLogEntry(
        "wiki.queried",
        undefined,
        `query "${text}" matches=${printed}`,
      );
      await ctx.store.update((state) => {
        state.wiki.log.push(entry);
        return state;
      });
      await appendWikiLog(ctx.store.paths, entry);
      if (printed === 0) out.out(`(no matches for "${text}")`);
    });

  wiki
    .command("lint")
    .description(
      "Report orphan pages (no sources), missing referenced pages ([[id]]), and stale pages (>14 days).",
    )
    .option("--stale-days <n>", "Stale threshold in days", "14")
    .option("--json", "Emit findings as JSON")
    .action(async (opts: { staleDays: string; json?: boolean }) => {
      const state = await ctx.store.readState();
      const paths = ctx.store.paths;
      const staleDays = Number.parseInt(opts.staleDays, 10) || 14;
      const cutoff = Date.now() - staleDays * 24 * 60 * 60 * 1000;
      const findings: string[] = [];
      const pageIds = new Set(Object.keys(state.wiki.pages));
      for (const p of Object.values(state.wiki.pages)) {
        if (p.source_ids.length === 0) {
          findings.push(`orphan: page '${p.id}' has no sources`);
        }
        const abs = path.join(paths.wikiDir, p.body_path);
        const raw = await fs.readFile(abs, "utf8").catch(() => "");
        const stripped = raw
          .replace(/```[\s\S]*?```/g, "")
          .replace(/`[^`\n]*`/g, "");
        const refs = stripped.match(/\[\[([a-z0-9_\-]+)\]\]/gi) ?? [];
        for (const r of refs) {
          const ref = r.slice(2, -2);
          if (!pageIds.has(ref)) {
            findings.push(`missing-ref: page '${p.id}' references '${ref}' which does not exist`);
          }
        }
        const updatedMs = Date.parse(p.updated_at);
        if (Number.isFinite(updatedMs) && updatedMs < cutoff) {
          findings.push(`stale: page '${p.id}' last updated ${p.updated_at}`);
        }
      }
      const entry = makeWikiLogEntry(
        "wiki.linted",
        undefined,
        `findings=${findings.length}`,
      );
      await ctx.store.update((state) => {
        state.wiki.log.push(entry);
        return state;
      });
      await appendWikiLog(paths, entry);
      if (opts.json) {
        out.json({ findings, count: findings.length });
      } else if (findings.length === 0) {
        out.out("Wiki lint clean.");
      } else {
        for (const f of findings) out.out(f);
      }
    });

  wiki
    .command("promote <pageId>")
    .description(
      `Promote a project wiki page to the user wiki at ~/${HARNESS_DIR_NAME}/wiki/. Requires --confirm to write; --dry-run prints the redacted body without writing.`,
    )
    .option("--user-id <id>", "Override id used in the user wiki (defaults to source id)")
    .option("--user-title <title>", "Override page title in the user wiki")
    .option("--allow <regex...>", "Allowlist regexes that prevent redaction matches", [])
    .option(
      "--extra <regex...>",
      "Additional redaction regex patterns (global flag added automatically)",
      [],
    )
    .option("--rules", "Print the active redaction rule ids and exit", false)
    .option("--dry-run", "Print redacted body and findings without writing", false)
    .option("--confirm", "Confirm the promotion and write to user wiki", false)
    .action(
      async (
        pageId: string,
        opts: {
          userId?: string;
          userTitle?: string;
          allow: string[];
          extra: string[];
          rules?: boolean;
          dryRun?: boolean;
          confirm?: boolean;
        },
      ) => {
        if (opts.rules) {
          for (const r of BUILTIN_RULES) {
            out.out(`${r.id}\t${r.description}`);
          }
          return;
        }
        const projectState = await ctx.store.readState();
        const sourcePage = projectState.wiki.pages[pageId];
        if (!sourcePage) {
          throw new Error(`Project wiki page not found: ${pageId}`);
        }
        const projectBody = await fs.readFile(
          path.join(ctx.store.paths.wikiDir, sourcePage.body_path),
          "utf8",
        );
        const allow = compileAllowList(opts.allow ?? []);
        const extra = compileExtraPatterns(opts.extra ?? []);
        const result = redact(projectBody, { allow, extraPatterns: extra });
        out.out(`Promoting '${pageId}' -> user wiki`);
        out.out(
          `Redaction findings: ${result.findings.length}${result.findings.length === 0 ? "" : " (rule_ids: " + result.findings.map((f) => f.rule_id).join(", ") + ")"
          }`,
        );
        if (opts.dryRun || !opts.confirm) {
          out.out("--- redacted body ---");
          out.out(result.redacted);
          out.out("--- end body ---");
          if (!opts.confirm) {
            out.out("Re-run with --confirm to write the redacted body to the user wiki.");
          }
          return;
        }
        const userStore = ctx.userStore;
        await userStore.ensure();
        await ensureWikiDirs(userStore.paths);
        await writeWikiSchemaIfMissing(userStore.paths);
        const userId = opts.userId ?? pageId;
        const userTitle = opts.userTitle ?? sourcePage.title;
        const bodyRel = `pages/${userId}.md`;
        const bodyAbs = path.join(userStore.paths.wikiDir, bodyRel);
        const promotedTs = nowIso();
        const promotionComment = `<!-- promoted from project wiki page '${pageId}' on ${promotedTs} -->`;
        let bodyForUserWiki = result.redacted.replace(
          new RegExp(`<!-- managed by ${ISSUE_MARKER_BRAND_RE} wiki\\. id: [^>]+-->`),
          promotionComment,
        );
        if (!bodyForUserWiki.includes("promoted from project wiki page")) {
          bodyForUserWiki = `# ${userTitle}\n\n${promotionComment}\n\n${result.redacted}`;
        }
        await fs.writeFile(bodyAbs, bodyForUserWiki, "utf8");
        const at = nowIso();
        const entry = makeWikiLogEntry(
          "page.upserted",
          userId,
          `promoted from project page '${pageId}' (redactions=${result.findings.length})`,
        );
        await userStore.update((state) => {
          if (!state.wiki.initialized) {
            state.wiki.initialized = true;
            state.wiki.initialized_at = at;
          }
          const existing = state.wiki.pages[userId];
          state.wiki.pages[userId] = {
            id: userId,
            title: userTitle,
            source_ids: [],
            tags: ["promoted"],
            body_path: bodyRel,
            created_at: existing?.created_at ?? at,
            updated_at: at,
          };
          state.wiki.log.push(entry);
          return state;
        });
        const userState = await userStore.read();
        await writeWikiIndex(userStore.paths, userState);
        await appendWikiLog(userStore.paths, entry);
        await fs.appendFile(
          userStore.paths.promotionsFile,
          JSON.stringify({
            at,
            from_page_id: pageId,
            to_page_id: userId,
            redactions: result.findings.length,
            rule_ids: result.findings.map((f) => f.rule_id),
          }) + "\n",
          "utf8",
        );
        await ctx.store.recordEvent({
          id: shortId("evt"),
          kind: "wiki.page.updated",
          at,
          payload: {
            promoted_to_user_wiki: true,
            from_page_id: pageId,
            to_page_id: userId,
            redactions: result.findings.length,
          },
        });
        out.out(`Promoted to user wiki page '${userId}' (redactions=${result.findings.length}).`);
      },
    );

  wiki
    .command("checkpoint")
    .description(`Append a wiki log checkpoint entry. Use '${CLI_NAME} checkpoint manual' for a harness-level checkpoint.`)
    .requiredOption("-n, --note <text>", "Checkpoint note")
    .action(async (opts: { note: string }) => {
      const at = nowIso();
      const entry = makeWikiLogEntry("wiki.checkpoint", undefined, opts.note);
      await ctx.store.update((state) => {
        state.wiki.log.push(entry);
        return state;
      });
      await appendWikiLog(ctx.store.paths, entry);
      await ctx.store.recordEvent({
        id: shortId("evt"),
        kind: "wiki.checkpoint",
        at,
        payload: { note: opts.note },
      });
      out.out(`Wiki checkpoint recorded: ${entry.id}`);
    });

  wiki.command("list")
    .description("List durable project-wiki pages")
    .action(async () => {
      const state = await requireLeanState(ctx);
      const pages = Object.values(state.wiki.pages).sort((a, b) => b.updated_at.localeCompare(a.updated_at));
      if (!pages.length) return out.out("No project-wiki pages yet.");
      for (const page of pages) out.out(page.id + "\t" + page.title + "\t" + page.tags.join(",") + "\t" + page.updated_at);
    });

  wiki.command("show <id>")
    .description("Show a durable project-wiki page")
    .action(async (id: string) => {
      const state = await requireLeanState(ctx);
      const page = state.wiki.pages[id];
      if (!page) throw new Error("Unknown project-wiki page: " + id);
      const body = await fs.readFile(path.join(ctx.store.paths.wikiDir, page.body_path), "utf8");
      out.out(body);
    });
  wiki.command("durable")
    .description("Record a durable project-wiki fact/contract/decision/root cause for V3 goals")
    .requiredOption("--id <id>")
    .requiredOption("--title <title>")
    .requiredOption("--trigger <contract|decision|environment|root-cause>")
    .option("--body <text>")
    .option("--body-file <path>")
    .action(async (opts: { id: string; title: string; trigger: string; body?: string; bodyFile?: string }) => {
      if (!["contract", "decision", "environment", "root-cause"].includes(opts.trigger)) throw new Error("trigger must be contract, decision, environment, or root-cause");
      if (!opts.body && !opts.bodyFile) throw new Error("Provide --body or --body-file.");
      if (!SlugId.safeParse(opts.id).success) throw new Error("wiki id must be a stable slug");
      const state = await requireLeanState(ctx);
      const body = opts.body ?? await fs.readFile(path.resolve(ctx.cwd, opts.bodyFile!), "utf8");
      await ensureWikiDirs(ctx.store.paths);
      const bodyRel = `pages/${opts.id}.md`;
      const wikiRoot = path.resolve(ctx.store.paths.wikiDir);
      const bodyAbs = path.resolve(wikiRoot, bodyRel);
      if (!bodyAbs.startsWith(wikiRoot + path.sep)) throw new Error("wiki page path escapes the wiki root");
      await fs.writeFile(bodyAbs, `# ${opts.title}\n\n<!-- managed by ${ISSUE_MARKER_BRAND} wiki. id: ${opts.id} -->\n\n${body}\n`, "utf8");
      const at = nowIso();
      const existing = state.wiki.pages[opts.id];
      state.wiki.pages[opts.id] = { id: opts.id, title: opts.title, source_ids: [], tags: [opts.trigger], body_path: bodyRel, created_at: existing?.created_at ?? at, updated_at: at };
      state.wiki.initialized = true;
      state.wiki.initialized_at ??= at;
      const entry = makeWikiLogEntry("page.upserted", opts.id, "durable " + opts.trigger);
      state.wiki.log.push(entry);
      await ctx.store.writeStateV3(state);
      await writeWikiIndex(ctx.store.paths, state);
      await appendWikiLog(ctx.store.paths, entry);
      await ctx.store.recordEvent({ id: shortId("evt"), kind: existing ? "wiki.page.updated" : "wiki.page.created", at, payload: { page_id: opts.id, trigger: opts.trigger } });
      out.out(`Durable wiki page ${opts.id} recorded (${opts.trigger}).`);
    });

}

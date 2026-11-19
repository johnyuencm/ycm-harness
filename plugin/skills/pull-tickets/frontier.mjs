#!/usr/bin/env node
/**
 * pull-tickets PR frontier filter.
 *
 * 1. A "record PR" is a PR whose changed files ALL match record-globs.json.
 *    The test is the file list, never the branch name.
 * 2. Record PRs are never selected for review. They stay listed (`records`)
 *    for merge ordering.
 * 3. A PR whose head SHA already has a record is skipped (`recorded`).
 *
 * Usage:
 *   node frontier.mjs --repo OWNER/REPO [--records-dir DIR] [--no-remote-records] [--json]
 *
 * --records-dir  checkout directory whose record files (*.md) are read for
 *                reviewed head SHAs (merged records). Repeatable.
 * Open record PRs are also read (their record files, via `gh api`), unless
 * --no-remote-records is given.
 *
 * A record names its reviewed head SHA in front matter:
 *   ---
 *   reviewed_head_sha: 62cf9344d1c3...        (7-40 hex)
 *   ---
 * Several SHAs: `reviewed_head_shas: [aaaaaaa, bbbbbbb]`.
 * Legacy records without front matter are read from a heading that holds
 * `(head <sha>)`.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export function loadRecordGlobs(file = path.join(here, "record-globs.json")) {
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  const globs = parsed.recordGlobs;
  if (!Array.isArray(globs) || globs.length === 0 || globs.some((g) => typeof g !== "string" || !g)) {
    throw new Error(`${file}: recordGlobs must be a non-empty array of strings`);
  }
  return globs;
}

export const RECORD_GLOBS = loadRecordGlobs();

/**
 * GitHub path-filter semantics: `*` = any run of non-`/` chars, `**` = any
 * chars including `/`, `**` + `/` = zero or more directories.
 */
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; ) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else {
      re += c.replace(/[\\^$.*+?()[\]{}|/]/g, "\\$&");
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

export function isRecordPath(file, globs = RECORD_GLOBS) {
  return globs.some((g) => globToRegExp(g).test(file));
}

/**
 * `files`: changed paths of the PR. `changedFiles`: GitHub's total count, when
 * known. `gh pr list --json files` caps at 100 paths, so a short list means we
 * cannot prove the PR is all-record: treat it as a work PR (fail closed to
 * "reviewable").
 */
export function isRecordPr(files, { globs = RECORD_GLOBS, changedFiles } = {}) {
  if (!Array.isArray(files) || files.length === 0) return false;
  if (typeof changedFiles === "number" && files.length < changedFiles) return false;
  return files.every((f) => isRecordPath(f, globs));
}

const HEX_SHA = /\b[0-9a-f]{7,40}\b/gi;

/** Reviewed head SHAs named by one record file (lowercase). */
export function parseReviewedHeads(markdown) {
  const text = markdown.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const shas = new Set();
  const fm = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(text);
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = /^reviewed_head_shas?\s*:\s*(.*)$/.exec(line.trim());
      if (m) for (const s of m[1].match(HEX_SHA) ?? []) shas.add(s.toLowerCase());
    }
    if (shas.size) return [...shas];
  }
  // Legacy: "# Phase-1 review — PR #317 (head 62cf934)".
  const body = fm ? text.slice(fm[0].length) : text;
  for (const line of body.split("\n").slice(0, 10)) {
    if (!/^#/.test(line)) continue;
    for (const m of line.matchAll(/\bhead\s+([0-9a-f]{7,40})\b/gi)) shas.add(m[1].toLowerCase());
  }
  return [...shas];
}

export function collectRecordedHeads(markdownTexts) {
  const out = new Set();
  for (const t of markdownTexts) for (const s of parseReviewedHeads(t)) out.add(s);
  return out;
}

/** A record SHA (7-40 hex) covers a head SHA when it is a prefix of it. */
export function isRecorded(headSha, recordedHeads) {
  const head = String(headSha ?? "").toLowerCase();
  if (!head) return false;
  for (const r of recordedHeads) if (r.length >= 7 && head.startsWith(r)) return true;
  return false;
}

/**
 * prs: [{ number, headRefOid, files: [{path}|string], changedFiles? , ...}]
 * Returns { selected, records, recorded }:
 *   selected  PRs eligible for review (work PRs, tip not yet recorded)
 *   records   record PRs: listed for merge ordering, never reviewed
 *   recorded  work PRs skipped because their head SHA already has a record
 */
export function selectReviewTargets(prs, { recordedHeads = new Set(), globs = RECORD_GLOBS } = {}) {
  const selected = [];
  const records = [];
  const recorded = [];
  for (const pr of prs) {
    const files = (pr.files ?? []).map((f) => (typeof f === "string" ? f : f.path));
    if (isRecordPr(files, { globs, changedFiles: pr.changedFiles })) records.push(pr);
    else if (isRecorded(pr.headRefOid, recordedHeads)) recorded.push(pr);
    else selected.push(pr);
  }
  return { selected, records, recorded };
}

function walkMarkdown(dir, out = []) {
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === ".git" || ent.name === "node_modules") continue;
    const p = path.join(dir, ent.name);
    // Dirent does not follow links: a dangling or looping symlink in the
    // checkout must not abort the whole frontier.
    if (ent.isDirectory()) walkMarkdown(p, out);
    else if (ent.isFile() && ent.name.endsWith(".md")) out.push(p);
  }
  return out;
}

const defaultGh = (args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/**
 * Fetch open PRs with changed-file lists. `gh` is injectable for tests.
 * `gh pr list` needs GraphQL. The Claude cloud proxy blocks GraphQL with a 403
 * ("GitHub GraphQL is not available from Claude Code sessions"), so on any
 * `gh pr list` failure use the REST endpoints. If REST also fails, throw.
 */
export function listOpenPrs(repo, gh = defaultGh) {
  const fields = "number,title,headRefName,headRefOid,isDraft,labels,changedFiles,files,createdAt";
  try {
    return JSON.parse(gh(["pr", "list", "-R", repo, "--state", "open", "--limit", "200", "--json", fields]));
  } catch (graphqlErr) {
    console.error("frontier: gh pr list failed; listing PRs through REST");
    try {
      return listOpenPrsRest(repo, gh);
    } catch (restErr) {
      throw new Error(`REST fallback failed: ${restErr.message}`, { cause: graphqlErr });
    }
  }
}

/**
 * REST form of listOpenPrs. The REST list has no files, so read each PR's
 * files endpoint. That list already holds rename sources. A PR whose files
 * cannot be read gets an empty list: it is reviewed, never a record PR.
 * shortcut: the REST files endpoint stops at 3000 files and gives no count, so
 * a >3000-file PR whose first 3000 paths are records looks like a record PR,
 * upgrade to a pulls/N `changed_files` check if PRs that large occur.
 */
export function listOpenPrsRest(repo, gh = defaultGh) {
  const jq =
    ".[] | {number, title, headRefName: .head.ref, headRefOid: .head.sha, isDraft: .draft, labels: [.labels[] | {name}], createdAt: .created_at}";
  const out = gh(["api", "--paginate", `repos/${repo}/pulls?state=open&per_page=100`, "--jq", jq]);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const pr = JSON.parse(line);
      let files = [];
      try {
        files = changedPathsWithRenames(repo, pr.number, gh).map((p) => ({ path: p }));
      } catch {
        // Not provably a record PR: keep it reviewable.
      }
      return { ...pr, files, renamesRead: true };
    });
}

/**
 * Changed paths of one PR including the OLD name of every renamed file.
 * `gh pr list --json files` (GraphQL) lists only the new path of a rename, so
 * a move of `src/x.ts` into a record path would look like a record PR. The
 * REST files endpoint carries `previous_filename`. Throws on any gh failure.
 */
export function changedPathsWithRenames(repo, number, gh = defaultGh) {
  const jq = ".[] | (.filename, (.previous_filename // empty))";
  const out = gh(["api", "--paginate", `repos/${repo}/pulls/${number}/files?per_page=100`, "--jq", jq]);
  return out.split("\n").filter(Boolean);
}

/**
 * A PR that looks like a record PR by new paths gets a second look at the old
 * paths. If they cannot be read, the PR is not provably a record: fail closed
 * to "reviewable" (empty file list).
 */
export function withRenameSources(repo, pr, { globs = RECORD_GLOBS, gh = defaultGh } = {}) {
  const files = (pr.files ?? []).map((f) => (typeof f === "string" ? f : f.path));
  if (pr.renamesRead || !isRecordPr(files, { globs, changedFiles: pr.changedFiles })) return pr;
  try {
    return { ...pr, files: changedPathsWithRenames(repo, pr.number, gh).map((p) => ({ path: p })) };
  } catch {
    return { ...pr, files: [] };
  }
}

/** Record files of open record PRs (read at each PR's head SHA). */
export function readRemoteRecordTexts(repo, recordPrs, gh = defaultGh) {
  const texts = [];
  for (const pr of recordPrs) {
    for (const f of pr.files) {
      const p = typeof f === "string" ? f : f.path;
      if (!p.endsWith(".md") || !p.startsWith("artifacts/")) continue;
      try {
        const raw = gh(["api", `repos/${repo}/contents/${p}?ref=${pr.headRefOid}`, "-H", "Accept: application/vnd.github.raw"]);
        texts.push(raw);
      } catch {
        // A record we cannot read cannot skip anything. Fail open to "review".
      }
    }
  }
  return texts;
}

export function frontier(repo, { recordsDirs = [], remoteRecords = true, gh = defaultGh, globs = RECORD_GLOBS } = {}) {
  const prs = listOpenPrs(repo, gh).map((pr) => withRenameSources(repo, pr, { globs, gh }));
  const texts = [];
  for (const d of recordsDirs) for (const f of walkMarkdown(d)) texts.push(readFileSync(f, "utf8"));
  if (remoteRecords) {
    const recordPrs = prs.filter((p) => isRecordPr(p.files.map((f) => f.path), { globs, changedFiles: p.changedFiles }));
    texts.push(...readRemoteRecordTexts(repo, recordPrs, gh));
  }
  return selectReviewTargets(prs, { recordedHeads: collectRecordedHeads(texts), globs });
}

function main(argv) {
  const args = { recordsDirs: [], remoteRecords: true, json: false, repo: "" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--repo") args.repo = argv[++i] ?? "";
    else if (a === "--records-dir") args.recordsDirs.push(argv[++i] ?? "");
    else if (a === "--no-remote-records") args.remoteRecords = false;
    else if (a === "--json") args.json = true;
    else {
      console.error(`unknown argument: ${a}`);
      process.exit(2);
    }
  }
  if (!args.repo) {
    console.error("usage: frontier.mjs --repo OWNER/REPO [--records-dir DIR] [--no-remote-records] [--json]");
    process.exit(2);
  }
  const r = frontier(args.repo, args);
  const slim = (p) => ({ number: p.number, head: p.headRefOid, branch: p.headRefName, title: p.title });
  if (args.json) {
    console.log(JSON.stringify({ selected: r.selected.map(slim), records: r.records.map(slim), recorded: r.recorded.map(slim) }, null, 2));
    return;
  }
  const show = (label, list) => {
    console.log(`${label} (${list.length})`);
    for (const p of list) console.log(`  #${p.number}\t${p.headRefOid.slice(0, 7)}\t${p.headRefName}`);
  };
  show("review-eligible", r.selected);
  show("record PRs (merge order only, never reviewed)", r.records);
  show("already recorded at this head (skipped)", r.recorded);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2));

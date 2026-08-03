import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { classifyScoutStartup } from "../src/autonomy/scout.js";
import {
  buildCompactSessionContext,
  capturePreCompact,
  collectGitOperationalState,
  continuitySnapshotLocation,
  MAX_CONTINUITY_CONTEXT_BYTES,
  MAX_CONTINUITY_FILE_BYTES,
  persistPostCompact,
  truncateUtf8,
  validateCompactSessionStartPayload,
  validatePostCompactPayload,
  validatePreCompactPayload,
  type ContinuityOptions,
  type GitOperationalState,
} from "../src/hooks/compaction-continuity.js";

const NOW = new Date("2026-07-20T00:00:00.000Z");

function payload(event: "PreCompact" | "PostCompact" | "SessionStart", cwd: string, session = "session-a") {
  const common = {
    session_id: session,
    transcript_path: path.join(cwd, "transcript.jsonl"),
    cwd,
    hook_event_name: event,
  };
  if (event === "SessionStart") return { ...common, source: "compact" as const };
  if (event === "PostCompact") return { ...common, trigger: "auto" as const, compact_summary: "summary" };
  return { ...common, trigger: "manual" as const };
}

function liveState(goalTitle: string, ticketTitle: string, blocker?: string): unknown {
  return {
    active_goal_id: "g",
    goals: {
      g: {
        id: "g",
        title: goalTitle,
        status: blocker ? "blocked" : "active",
        assurance: "standard",
        backend: { kind: "local" },
        blocker,
      },
    },
    local_tickets: {
      t: {
        id: "t",
        goal_id: "g",
        title: ticketTitle,
        status: "active",
        order: 0,
      },
    },
    checkpoints: {
      c: {
        id: "c",
        goal_id: "g",
        kind: "decision",
        decision: `Decision for ${goalTitle}`,
        created_at: NOW.toISOString(),
      },
    },
  };
}

function options(configDir: string, root: string, now = NOW): ContinuityOptions {
  const git: GitOperationalState = {
    root,
    branch: "feature/continuity",
    dirty_paths: ["src/one.ts", "tests/two.test.ts"],
    dirty_truncated: false,
  };
  return { configDir, now: () => now, gitProbe: async () => git };
}

async function tempFixture(name: string) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
  const root = path.join(base, "repo");
  const configDir = path.join(base, "claude");
  await fs.mkdir(root, { recursive: true });
  return { base, root, configDir };
}

test("compaction payload validators require documented lifecycle fields", async () => {
  const { base, root } = await tempFixture("ch-compact-payload");
  try {
    assert.deepEqual(validatePreCompactPayload(payload("PreCompact", root)), {
      session_id: "session-a",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      trigger: "manual",
    });
    assert.equal(validatePreCompactPayload({ ...payload("PreCompact", root), trigger: "other" }), undefined);
    assert.equal(validatePreCompactPayload({ ...payload("PreCompact", root), hook_event_name: "PostCompact" }), undefined);
    assert.equal(validatePostCompactPayload({ ...payload("PostCompact", root), compact_summary: 1 }), undefined);
    assert.deepEqual(validateCompactSessionStartPayload(payload("SessionStart", root)), {
      session_id: "session-a",
      transcript_path: path.join(root, "transcript.jsonl"),
      cwd: root,
      source: "compact",
    });
    assert.equal(validateCompactSessionStartPayload({ ...payload("SessionStart", root), source: "resume" }), undefined);
    assert.equal(validateCompactSessionStartPayload({ ...payload("SessionStart", root), cwd: "relative" }), undefined);
    assert.equal(validateCompactSessionStartPayload({ ...payload("SessionStart", root), transcript_path: undefined }), undefined);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("PreCompact writes a private bounded atomic snapshot without reading the transcript", async (t) => {
  const { base, root, configDir } = await tempFixture("ch-compact-pre");
  try {
    const pre = payload("PreCompact", root);
    await fs.writeFile(pre.transcript_path, "TRANSCRIPT_MUST_NOT_BE_READ secret@example.com", "utf8");
    const originalReadFile = fs.readFile;
    let transcriptRead = false;
    t.mock.method(fs, "readFile", ((file: unknown, ...args: unknown[]) => {
      if (path.resolve(String(file)) === pre.transcript_path) {
        transcriptRead = true;
        throw new Error("transcript read attempted");
      }
      return Reflect.apply(originalReadFile, fs, [file, ...args]);
    }) as typeof fs.readFile);
    const snapshot = await capturePreCompact(
      pre,
      liveState("Captured goal", "Captured ticket"),
      options(configDir, root),
    );
    assert.ok(snapshot);
    assert.equal(transcriptRead, false);
    assert.ok(Buffer.byteLength(snapshot.markdown, "utf8") <= MAX_CONTINUITY_FILE_BYTES);
    assert.match(snapshot.markdown, /Captured goal/);
    assert.match(snapshot.markdown, /feature\/continuity/);
    assert.doesNotMatch(snapshot.markdown, /TRANSCRIPT_MUST_NOT_BE_READ/);
    assert.doesNotMatch(snapshot.path, /session-a/);
    assert.doesNotMatch(snapshot.pointer, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")));
    assert.match(snapshot.pointer, /^claude-cache:\/\/ycm-harness\/compaction-continuity\/[0-9a-f]{32}\/[0-9a-f]{32}\/continuity\.md$/u);
    const entries = await fs.readdir(path.dirname(snapshot.path));
    assert.deepEqual(entries, ["continuity.md"]);
    if (process.platform !== "win32") {
      const stat = await fs.stat(snapshot.path);
      assert.equal(stat.mode & 0o777, 0o600);
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("real Git spawn failures render dirty state unavailable", async () => {
  const { base, root, configDir } = await tempFixture("ch-compact-git-failure");
  const priorPath = process.env.PATH;
  try {
    process.env.PATH = path.join(base, "missing-bin");
    const git = await collectGitOperationalState(root);
    assert.equal(git.dirty_unavailable, true);
    assert.deepEqual(git.dirty_paths, []);
    const context = await buildCompactSessionContext(undefined, payload("SessionStart", root), {
      configDir,
      now: () => NOW,
      gitProbe: async () => git,
    });
    assert.match(context, /dirty paths unavailable/u);
    assert.doesNotMatch(context, /dirty paths 0/u);
  } finally {
    if (priorPath === undefined) delete process.env.PATH;
    else process.env.PATH = priorPath;
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("Git probing preserves non-repository and detached-HEAD behavior", async () => {
  const { base, root } = await tempFixture("ch-compact-git-modes");
  try {
    const nonRepo = await collectGitOperationalState(root);
    assert.equal(nonRepo.branch, undefined);
    assert.equal(nonRepo.dirty_unavailable, undefined);
    assert.deepEqual(nonRepo.dirty_paths, []);

    const repo = path.join(base, "detached-repo");
    await fs.mkdir(repo);
    const git = (...args: string[]) => {
      const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: false });
      assert.equal(result.status, 0, result.stderr);
    };
    git("init", "-q");
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "Continuity Test");
    await fs.writeFile(path.join(repo, "tracked.txt"), "tracked\n", "utf8");
    git("add", "tracked.txt");
    git("commit", "-q", "-m", "fixture");
    git("checkout", "-q", "--detach");

    const detached = await collectGitOperationalState(repo);
    assert.match(detached.branch ?? "", /^\(detached [0-9a-f]+\)$/u);
    assert.equal(detached.dirty_unavailable, undefined);
    assert.deepEqual(detached.dirty_paths, []);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("snapshots isolate roots and sessions using hashes", async () => {
  const { base, root, configDir } = await tempFixture("ch-compact-isolation");
  try {
    const otherRoot = path.join(base, "other-repo");
    const first = continuitySnapshotLocation(root, "session-a", { configDir });
    const otherSession = continuitySnapshotLocation(root, "session-b", { configDir });
    const otherProject = continuitySnapshotLocation(otherRoot, "session-a", { configDir });
    assert.notEqual(first.path, otherSession.path);
    assert.notEqual(first.path, otherProject.path);
    assert.equal(first.root_hash, otherSession.root_hash);
    assert.notEqual(first.session_hash, otherSession.session_hash);
    assert.notEqual(first.root_hash, otherProject.root_hash);
    for (const location of [first, otherSession, otherProject]) {
      assert.doesNotMatch(location.path, /session-[ab]/);
      assert.doesNotMatch(location.pointer, /session-[ab]/);
    }
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("PostCompact redacts and bounds the private summary but SessionStart never reinjects it", async () => {
  const { base, root, configDir } = await tempFixture("ch-compact-post");
  try {
    const opts = options(configDir, root);
    await capturePreCompact(payload("PreCompact", root), liveState("Captured goal", "Captured ticket"), opts);
    const secret = "sk-ant-" + "api03-" + "abcdefghijklmnopqrstuvwxyz0123456789";
    const summary = `Full compact summary ${secret} owner@example.com ${"x".repeat(40 * 1024)}`;
    const snapshot = await persistPostCompact(
      { ...payload("PostCompact", root), compact_summary: summary },
      liveState("Captured goal", "Captured ticket"),
      opts,
    );
    assert.ok(snapshot);
    assert.ok(Buffer.byteLength(snapshot.markdown, "utf8") <= MAX_CONTINUITY_FILE_BYTES);
    assert.match(snapshot.markdown, /Compaction recovery summary/);
    assert.match(snapshot.markdown, /<redacted:/u);
    assert.doesNotMatch(snapshot.markdown, new RegExp(secret, "u"));
    assert.doesNotMatch(snapshot.markdown, /owner@example\.com/u);

    const context = await buildCompactSessionContext(
      liveState("Live goal", "Live ticket"),
      payload("SessionStart", root),
      opts,
    );
    assert.ok(Buffer.byteLength(context, "utf8") <= MAX_CONTINUITY_CONTEXT_BYTES);
    assert.match(context, /Live goal/);
    assert.match(context, /Live ticket/);
    assert.match(context, /Recovery summary: stored privately; not reinjected\./);
    assert.doesNotMatch(context, /Full compact summary/);
    assert.doesNotMatch(context, /Captured goal/);
    assert.doesNotMatch(context, new RegExp(secret, "u"));
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("live Harness state overrides cached state after compaction", async () => {
  const { base, root, configDir } = await tempFixture("ch-compact-live");
  try {
    const opts = options(configDir, root);
    await capturePreCompact(payload("PreCompact", root), liveState("Old goal", "Old ticket", "Old blocker"), opts);
    const context = await buildCompactSessionContext(
      liveState("New goal", "New ticket", "New blocker"),
      payload("SessionStart", root),
      opts,
    );
    assert.match(context, /New goal/);
    assert.match(context, /New ticket/);
    assert.match(context, /New blocker/);
    assert.doesNotMatch(context, /Old goal|Old ticket|Old blocker/u);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("generic compact recovery contains Git state and no parallel workflow", async () => {
  const { base, root, configDir } = await tempFixture("ch-compact-generic");
  try {
    const opts = options(configDir, root);
    await capturePreCompact(payload("PreCompact", root), undefined, opts);
    const context = await buildCompactSessionContext(undefined, payload("SessionStart", root), opts);
    assert.match(context, /Mode: generic; no active YCM Harness workflow\./);
    assert.match(context, /Do not create a parallel workflow from this card\./);
    assert.match(context, /Git: feature\/continuity; dirty paths 2\./);
    assert.match(context, /Snapshot: claude-cache:\/\//);
    assert.match(context, /continue the user's current task/);
    assert.doesNotMatch(context, /# ycm-harness/u);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("stale, future, wrong-session, and oversized snapshots are not injected", async () => {
  const { base, root, configDir } = await tempFixture("ch-compact-freshness");
  try {
    await capturePreCompact(payload("PreCompact", root), undefined, options(configDir, root, NOW));
    const stale = await buildCompactSessionContext(
      undefined,
      payload("SessionStart", root),
      options(configDir, root, new Date(NOW.getTime() + 25 * 60 * 60 * 1000)),
    );
    assert.match(stale, /Snapshot: unavailable or stale\./);

    const wrongSession = await buildCompactSessionContext(
      undefined,
      payload("SessionStart", root, "session-b"),
      options(configDir, root, NOW),
    );
    assert.match(wrongSession, /Snapshot: unavailable or stale\./);

    const location = continuitySnapshotLocation(root, "session-a", { configDir });
    await fs.writeFile(location.path, "x".repeat(MAX_CONTINUITY_FILE_BYTES + 1), "utf8");
    const oversized = await buildCompactSessionContext(undefined, payload("SessionStart", root), options(configDir, root, NOW));
    assert.match(oversized, /Snapshot: unavailable or stale\./);

    await capturePreCompact(
      payload("PreCompact", root),
      undefined,
      options(configDir, root, new Date(NOW.getTime() + 10 * 60 * 1000)),
    );
    const future = await buildCompactSessionContext(undefined, payload("SessionStart", root), options(configDir, root, NOW));
    assert.match(future, /Snapshot: unavailable or stale\./);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("mandatory live recovery fields survive the 2 KiB card cap", async () => {
  const { base, root, configDir } = await tempFixture("ch-compact-reserve");
  try {
    const long = "x".repeat(2_000);
    const dirty = Array.from({ length: 20 }, (_, index) => `${index}-${"d".repeat(500)}`);
    const opts: ContinuityOptions = {
      configDir,
      now: () => NOW,
      gitProbe: async () => ({
        root,
        branch: `feature/${long}`,
        dirty_paths: dirty,
        dirty_truncated: true,
      }),
    };
    await capturePreCompact(payload("PreCompact", root), liveState(`Goal ${long}`, `Ticket ${long}`, `Blocker ${long}`), opts);
    const context = await buildCompactSessionContext(
      liveState(`Live goal ${long}`, `Live ticket ${long}`, `Live blocker ${long}`),
      payload("SessionStart", root),
      opts,
    );
    assert.ok(Buffer.byteLength(context, "utf8") <= MAX_CONTINUITY_CONTEXT_BYTES);
    assert.match(context, /^# ycm-harness/mu);
    assert.match(context, /^Goal: Live goal/mu);
    assert.match(context, /^Ticket: Live ticket/mu);
    assert.match(context, /^Blocker: Live blocker/mu);
    assert.match(context, /^Next:/mu);
    assert.match(context, /^Git:/mu);
    assert.match(context, /^Snapshot: claude-cache:\/\//mu);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("redaction expansion cannot evict required compact recovery fields", async () => {
  const { base, root, configDir } = await tempFixture("ch-compact-redaction-reserve");
  try {
    const emails = "a@b.co ".repeat(300);
    const opts = options(configDir, root);
    await capturePreCompact(
      payload("PreCompact", root),
      liveState(`Goal ${emails}`, `Ticket ${emails}`, `Blocker ${emails}`),
      opts,
    );
    const context = await buildCompactSessionContext(
      liveState(`Live goal ${emails}`, `Live ticket ${emails}`, `Live blocker ${emails}`),
      payload("SessionStart", root),
      opts,
    );
    assert.ok(Buffer.byteLength(context, "utf8") <= MAX_CONTINUITY_CONTEXT_BYTES);
    assert.match(context, /^# ycm-harness/mu);
    assert.match(context, /^Goal: Live goal/mu);
    assert.match(context, /^Ticket: Live ticket/mu);
    assert.match(context, /^Blocker: Live blocker/mu);
    assert.match(context, /^Next:/mu);
    assert.match(context, /^Git:/mu);
    assert.match(context, /^Snapshot: claude-cache:\/\//mu);
    assert.match(context, /<redacted:email>/u);
  } finally {
    await fs.rm(base, { recursive: true, force: true });
  }
});

test("UTF-8 truncation is byte bounded and compact starts create no scout obligation", () => {
  const truncated = truncateUtf8("🧭".repeat(1000), 127);
  assert.ok(Buffer.byteLength(truncated, "utf8") <= 127);
  assert.doesNotMatch(truncated, /�/u);
  assert.deepEqual(classifyScoutStartup({
    hook_event_name: "SessionStart",
    source: "compact",
    session_id: "session-a",
  }), { kind: "none" });
});

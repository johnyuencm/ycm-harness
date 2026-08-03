import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { Command } from "commander";
import {
  authorizeScoutAdapterRequest,
  executeGuardedScoutAdapter,
  SCOUT_GUARD_ASSURANCE,
  type ScoutGuardScope,
} from "../src/autonomy/scout-guard.js";
import {
  appendScoutTelemetry,
  buildScoutTelemetry,
  SCOUT_TELEMETRY_VERSION,
  type ScoutTelemetryEvent,
  type ScoutTerminalStatus,
} from "../src/autonomy/scout-telemetry.js";
import { fulfillScoutObligation, SCOUT_BRIEF_HEADINGS, SCOUT_BRIEF_VERSION } from "../src/autonomy/scout-brief.js";
import { renderScoutObligation } from "../src/autonomy/scout.js";
import { registerAutonomy } from "../src/cli/commands/autonomy.js";
import { createContext } from "../src/cli/context.js";

function validBrief(marker = "context"): string {
  return [SCOUT_BRIEF_VERSION, ...SCOUT_BRIEF_HEADINGS.flatMap((heading, index) => [heading, index ? "none found" : marker])].join("\n");
}
function scoutKey(root: string, generation: string): string {
  const key = renderScoutObligation(root, generation).match(/key=(scout-v1-[0-9a-f-]+)/)?.[1];
  assert.ok(key);
  return key;
}

test("structural guard allows only enumerated reads in verified scopes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-guard-allow-"));
  const memory = await fs.mkdtemp(path.join(os.tmpdir(), "ch-guard-memory-"));
  try {
    const harness = path.join(root, ".ycm-harness");
    const pointerRoot = path.join(harness, "autonomy");
    const projectFile = path.join(root, "README.md");
    const harnessFile = path.join(harness, "state.json");
    const pointerFile = path.join(pointerRoot, "latest.md");
    const memoryFile = path.join(memory, "summary.md");
    await fs.mkdir(pointerRoot, { recursive: true });
    await Promise.all([
      fs.writeFile(projectFile, "project"), fs.writeFile(harnessFile, "{}"),
      fs.writeFile(pointerFile, "pointer"), fs.writeFile(memoryFile, "memory"),
    ]);
    const scope: ScoutGuardScope = {
      projectRoot: root, cwd: root, pointerRoots: [pointerRoot], memoryReferences: [memoryFile],
      multicaWorkspaceId: "11111111-1111-4111-8111-111111111111",
      githubRepo: "johnyuencm/ycm-harness",
      gitRoot: root,
    };
    const requests = [
      { adapter: "project", operation: "read", target: projectFile },
      { adapter: "harness", operation: "read", target: harnessFile },
      { adapter: "pointer", operation: "read", target: pointerFile },
      { adapter: "memory", operation: "read", target: memoryFile },
      { adapter: "multica", operation: "get", workspaceId: scope.multicaWorkspaceId },
      { adapter: "multica", operation: "search", workspaceId: scope.multicaWorkspaceId, query: "AUT-13", limit: 10 },
      { adapter: "github", operation: "view", workspaceId: "johnyuencm/ycm-harness" },
      { adapter: "github", operation: "list", workspaceId: "johnyuencm/ycm-harness", query: "Parent:#42", limit: 10 },
      { adapter: "schedule", operation: "list", limit: 20 },
      { adapter: "git", operation: "status", argv: ["--short", "--branch"] },
      { adapter: "git", operation: "log", argv: ["--max-count=20", "--format=%h%x09%s", "--no-decorate"] },
    ];
    for (const request of requests) assert.deepEqual(await authorizeScoutAdapterRequest(scope, request), { allowed: true, reason: "allowed" });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(memory, { recursive: true, force: true });
  }
});

test("structural guard denies mutation, authority widening, hostile paths, and harmless writes before execution", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-guard-deny-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ch-guard-outside-"));
  try {
    const harness = path.join(root, ".ycm-harness");
    await fs.mkdir(harness, { recursive: true });
    const safe = path.join(root, "safe.txt");
    const secret = path.join(root, ".env");
    const outsideFile = path.join(outside, "outside.txt");
    await Promise.all([fs.writeFile(safe, "safe"), fs.writeFile(secret, "TOKEN=x"), fs.writeFile(outsideFile, "outside")]);
    const scope: ScoutGuardScope = {
      projectRoot: root, cwd: root, multicaWorkspaceId: "11111111-1111-4111-8111-111111111111", gitRoot: root,
    };
    const denied = [
      { adapter: "project", operation: "write", target: path.join(root, "harmless.txt") },
      { adapter: "harness", operation: "search", target: harness },
      { adapter: "project", operation: "read", target: path.join(root, ".ｅｎｖ") },
      { adapter: "project", operation: "read", target: path.join(root, ".e​nv") },
      { adapter: "project", operation: "read", target: root + path.sep + "．​．" + path.sep + "safe.txt" },
      { adapter: "project", operation: "read", target: outsideFile },
      { adapter: "project", operation: "read", target: secret },
      { adapter: "project", operation: "read", target: root + path.sep + ".." + path.sep + path.basename(root) + path.sep + "safe.txt" },
      { adapter: "project", operation: "read", target: path.join(root, "missing.txt") },
      { adapter: "project", operation: "read", target: "\\\\?\\C:\\safe" },
      { adapter: "project", operation: "read", target: "C:\\safe.txt:stream" },
      { adapter: "project", operation: "read", target: process.platform === "win32" ? "/etc/passwd" : "C:\\Windows\\win.ini" },
      { adapter: "project", operation: "read", target: root + (process.platform === "win32" ? "/safe.txt" : "\\safe.txt") },
      { adapter: "project", operation: "read", target: path.join(root, "safe.") },
      { adapter: "project", operation: "read", target: path.join(root, "safe ") },
      { adapter: "project", operation: "read", target: path.join(root, "NUL") },
      { adapter: "git", operation: "status", argv: ["--short", "HEAD"] },
      { adapter: "git", operation: "reset", argv: ["--hard"] },
      { adapter: "git", operation: "log", argv: [] },
      { adapter: "git", operation: "log", argv: ["--format=%h%x09%s"] },
      { adapter: "git", operation: "log", argv: ["--max-count=1", "--max-count=2"] },
      { adapter: "multica", operation: "update", workspaceId: scope.multicaWorkspaceId },
      { adapter: "multica", operation: "list", workspaceId: "22222222-2222-4222-8222-222222222222" },
      { adapter: "multica", operation: "search", workspaceId: scope.multicaWorkspaceId, query: "api_key" },
      { adapter: "schedule", operation: "run" },
      { adapter: "message", operation: "send" },
      { adapter: "connector", operation: "call" },
      { adapter: "agent", operation: "spawn" },
      { adapter: "process", operation: "read", command: "cat safe.txt && whoami" },
      { adapter: "project", operation: "read", target: safe, futureAuthority: true },
    ];
    for (const request of denied) assert.equal((await authorizeScoutAdapterRequest(scope, request)).allowed, false, JSON.stringify(request));
    assert.equal((await authorizeScoutAdapterRequest({ ...scope, cwd: outside }, { adapter: "project", operation: "read", target: safe })).reason, "cwd_denied");


    let searchExecuted = 0;
    await assert.rejects(executeGuardedScoutAdapter(scope,
      { adapter: "harness", operation: "search", target: harness },
      async () => { searchExecuted += 1; return "bad"; }), /scout_guard_operation_denied/);
    assert.equal(searchExecuted, 0);

    const harmless = path.join(root, "harmless.txt");
    let executed = 0;
    await assert.rejects(executeGuardedScoutAdapter(scope,
      { adapter: "project", operation: "write", target: harmless },
      async () => { executed += 1; await fs.writeFile(harmless, "bad"); }), /scout_guard_operation_denied/);
    assert.equal(executed, 0);
    await assert.rejects(fs.access(harmless));

    let disabledExecuted = 0;
    await assert.rejects(executeGuardedScoutAdapter(scope,
      { adapter: "project", operation: "read", target: safe },
      async () => { disabledExecuted += 1; return "bad"; },
      { YCM_HARNESS_SCOUT_GUARD_ENABLED: "0" }), /scout_guard_guard_disabled/);
    assert.equal(disabledExecuted, 0);

    const caseDecision = await authorizeScoutAdapterRequest(
      { ...scope, projectRoot: root.toUpperCase(), cwd: root.toUpperCase() },
      { adapter: "project", operation: "read", target: safe.toUpperCase() },
    );
    assert.equal(caseDecision.allowed, process.platform === "win32");
    assert.match(SCOUT_GUARD_ASSURANCE, /structural guard/i);
    assert.match(SCOUT_GUARD_ASSURANCE, /native\/MCP\/OS.*reparse TOCTOU.*residual risk/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("structural guard rejects a symlink or junction escape before execution", async (context) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-guard-link-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ch-guard-link-outside-"));
  try {
    const link = path.join(root, "escape");
    try {
      await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      context.skip(`link creation unavailable: ${(error as NodeJS.ErrnoException).code ?? "unknown"}`);
      return;
    }
    const decision = await authorizeScoutAdapterRequest(
      { projectRoot: root, cwd: root },
      { adapter: "project", operation: "read", target: link },
    );
    assert.equal(decision.allowed, false);
    assert.equal(decision.reason, "outside_root");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  }
});

test("telemetry projects the exact derived allowlist for every terminal status", () => {
  const statuses: ScoutTerminalStatus[] = ["success", "cache", "fallback", "timeout", "denial", "cancel", "failure"];
  const expectedKeys = ["brief_size", "budget_ms", "cache_hit", "contract_version", "elapsed_ms", "fallback", "guard_result",
    "reason", "root_id", "session_generation_hash", "status", "tier", "tool_count"];
  const forbidden = "RAW prompt command C:\\secret TOKEN=credential ticket-body transcript";
  for (const status of statuses) {
    const event = buildScoutTelemetry({
      generationHash: forbidden, rootId: forbidden, tier: "none", status,
      reason: status === "cache" ? "cache_hit" : status === "fallback" ? "direct_fallback"
        : status === "timeout" ? "deadline_exhausted" : status === "denial" ? "guard_denied"
          : status === "cancel" ? "cancelled" : status === "failure" ? "collector_failed" : "validated",
      elapsedMs: 123.9, toolCount: 2, briefSize: 50, cacheHit: status === "cache",
      fallback: status === "fallback", guardResult: status === "denial" ? "denied" : "not_observed",
      raw_prompt: forbidden,
    } as Parameters<typeof buildScoutTelemetry>[0] & { raw_prompt: string });
    assert.deepEqual(Object.keys(event).sort(), expectedKeys);
    assert.equal(event.contract_version, SCOUT_TELEMETRY_VERSION);
    assert.doesNotMatch(JSON.stringify(event), /RAW|prompt|command|secret|TOKEN|credential|ticket-body|transcript|C:\\/i);
  }
});

test("telemetry persistence reprojects runtime extras before writing JSONL", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-guard-persist-"));
  try {
    const forbidden = "RAW prompt command C:\\secret TOKEN=credential ticket-body transcript";
    const built = buildScoutTelemetry({
      generationHash: "a".repeat(24), rootId: "b".repeat(24), tier: "direct", status: "fallback",
      reason: "direct_fallback", elapsedMs: 50, toolCount: 1, briefSize: 100,
      cacheHit: false, fallback: true, guardResult: "allowed",
    });
    await appendScoutTelemetry(root, { ...built, status: forbidden, root_id: forbidden, raw_prompt: forbidden });
    const file = path.join(root, ".ycm-harness", "autonomy", "scout", "telemetry.jsonl");
    const persisted = JSON.parse((await fs.readFile(file, "utf8")).trim()) as Record<string, unknown>;
    assert.deepEqual(Object.keys(persisted).sort(), ["brief_size", "budget_ms", "cache_hit", "contract_version", "elapsed_ms", "fallback", "guard_result",
      "reason", "root_id", "session_generation_hash", "status", "tier", "tool_count"]);
    assert.equal(persisted.status, "failure");
    assert.match(String(persisted.root_id), /^[0-9a-f]{24}$/);
    assert.doesNotMatch(JSON.stringify(persisted), /RAW|prompt|command|secret|TOKEN|credential|ticket-body|transcript|C:\\/i);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("autonomy scout status exposes structural guard residual risks without claiming confinement", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-guard-status-"));
  try {
    const json: unknown[] = [];
    const program = new Command();
    program.exitOverride();
    registerAutonomy(program, createContext(root), { out() {}, err() {}, json(value) { json.push(value); } });
    await program.parseAsync(["autonomy", "scout", "status"], { from: "user" });
    assert.deepEqual(json, [{
      guard: "structural",
      complete_confinement: false,
      residual_risks: ["native", "MCP", "OS", "reparse TOCTOU"],
      assurance: SCOUT_GUARD_ASSURANCE,
    }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("fulfillment emits success, cache, fallback, timeout, denial, cancellation, and failure terminals", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "ch-guard-terminal-"));
  const events: ScoutTelemetryEvent[] = [];
  const base = { resolveRoot: async () => ({ root, goalId: "goal" }), emitTelemetry: (event: ScoutTelemetryEvent) => { events.push(event); } };
  try {
    const nativeKey = scoutKey(root, "native");
    const proof = { readOnlyToolsOmitted: true, credentialsOmitted: true, sandboxed: true, boundedDescendantCleanup: true } as const;
    await fulfillScoutObligation(root, nativeKey, { ...base, nativeProof: proof, launchNative: () => ({ result: Promise.resolve(validBrief()), cleanup: async () => undefined }) });
    await fulfillScoutObligation(root, nativeKey, base);
    await fulfillScoutObligation(root, scoutKey(root, "direct"), { ...base, collect: async () => validBrief() });
    await assert.rejects(fulfillScoutObligation(root, scoutKey(root, "timeout"), {
      ...base, collect: async () => validBrief(), wait: async () => { throw new Error("scout_timeout"); },
    }), /scout_timeout/);
    const controller = new AbortController();
    await assert.rejects(fulfillScoutObligation(root, scoutKey(root, "cancel"), {
      ...base, nativeProof: proof, signal: controller.signal,
      launchNative: () => {
        controller.abort();
        return { result: new Promise<string>(() => undefined), cleanup: async () => undefined };
      },
    }), /scout_cancelled/);
    await assert.rejects(fulfillScoutObligation(root, scoutKey(root, "failure"), { ...base, collect: async () => "bad" }), /invalid_scout_brief/);
    await assert.rejects(fulfillScoutObligation(root, scoutKey(root, "denial"), base), /scout_guard_target_missing/);
    assert.deepEqual(events.map((event) => [event.status, event.tier, event.tool_count, event.fallback, event.guard_result]), [
      ["success", "native", 1, false, "not_observed"],
      ["cache", "cache", 0, false, "not_observed"],
      ["fallback", "direct", 1, true, "not_observed"],
      ["timeout", "direct", 1, true, "not_observed"],
      ["cancel", "native", 1, false, "not_observed"],
      ["failure", "direct", 1, true, "not_observed"],
      ["denial", "direct", 1, true, "denied"],
    ]);
    assert.equal(events.every((event) => Object.keys(event).length === 13), true);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

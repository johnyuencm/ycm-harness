import { execFile } from "node:child_process";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  appendContinuationEvidence,
  bindCoordination,
  coordinationBindingPath,
  continuationRecordPath,
  ensureContinuation,
  retryContinuations,
  resolveHarnessGoal,
  verifyCoordinationBinding,
  type MulticaInvocation,
  type MulticaRunner,
} from "../src/autonomy/coordination.js";
import { HarnessStore } from "../src/state/store.js";
import { cleanup, tempProject } from "./helpers.js";

const exec = promisify(execFile);
const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const PARENT = "22222222-2222-4222-8222-222222222222";
const PROJECT = "33333333-3333-4333-8333-333333333333";
const PROJECT_2 = "44444444-4444-4444-8444-444444444444";
const GOAL = "goal_phase_2";
const noGit = async (): Promise<undefined> => undefined;

function taskEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    MULTICA_TOKEN: "mat_" + "1234567890abcdef1234567890abcdef",
    MULTICA_TASK_ID: "task-1",
    MULTICA_AGENT_ID: "agent-1",
    MULTICA_DAEMON_PORT: "4567",
    MULTICA_SERVER_URL: "https://example.com",
    MULTICA_WORKSPACE_ID: WORKSPACE,
    ...overrides,
  };
}

async function writeTaskMarker(root: string, content = JSON.stringify({
  managed_by: "multica-daemon-task",
  agent_id: "agent-1",
  issue_id: PARENT,
})): Promise<void> {
  const marker = path.join(root, ".multica", "daemon_task_context.json");
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, content, "utf8");
}

async function initializeHarness(root: string, status: "active" | "done" = "active"): Promise<void> {
  const store = new HarnessStore(root);
  await store.init();
  await store.update((state) => {
    state.goals[GOAL] = {
      id: GOAL,
      title: "Phase 2",
      status,
      worktree_status: "active",
      created_at: state.created_at,
      updated_at: state.created_at,
    };
    state.active_goal_id = GOAL;
    return state;
  });
}

function parent(projectId: string | null = PROJECT): Record<string, unknown> {
  return {
    id: PARENT,
    identifier: "AUT-3",
    workspace_id: WORKSPACE,
    project_id: projectId ?? undefined,
  };
}

function profileRunner(
  calls: MulticaInvocation[],
  issue: Record<string, unknown> = parent(),
  project: Record<string, unknown> = { id: PROJECT, workspace_id: WORKSPACE },
): MulticaRunner {
  return async (call) => {
    calls.push(call);
    if (call.argv.includes("identity")) {
      return { stdout: JSON.stringify({ profile: "dev", server_origin: "https://example.com", workspace_id: WORKSPACE }) };
    }
    if (call.argv.includes("project")) return { stdout: JSON.stringify(project) };
    return { stdout: JSON.stringify(issue) };
  };
}

test("root resolution covers main, nested, linked worktree, absence, ambiguity, and inactive/mismatch", async () => {
  const sandbox = await tempProject("ch-coordination-roots-");
  const main = path.join(sandbox, "main");
  const linked = path.join(sandbox, "linked");
  try {
    await fs.mkdir(main);
    await exec("git", ["init", "-q"], { cwd: main });
    await exec("git", ["config", "user.email", "test@example.invalid"], { cwd: main });
    await exec("git", ["config", "user.name", "Harness Test"], { cwd: main });
    await fs.writeFile(path.join(main, "tracked.txt"), "x\n", "utf8");
    await exec("git", ["add", "tracked.txt"], { cwd: main });
    await exec("git", ["commit", "-qm", "fixture"], { cwd: main });
    await initializeHarness(main);
    await exec("git", ["worktree", "add", "-q", linked, "HEAD"], { cwd: main });
    const nested = path.join(main, "a", "b");
    await fs.mkdir(nested, { recursive: true });

    assert.equal((await resolveHarnessGoal(main))?.root, await fs.realpath(main));
    assert.equal((await resolveHarnessGoal(nested))?.root, await fs.realpath(main));
    assert.equal((await resolveHarnessGoal(linked))?.root, await fs.realpath(main));
    assert.equal(await resolveHarnessGoal(sandbox, undefined, noGit), undefined);
    await assert.rejects(() => resolveHarnessGoal(main, "different_goal"), /goal_mismatch/);

    const nestedHarness = path.join(main, "nested-harness");
    await fs.mkdir(nestedHarness);
    await initializeHarness(nestedHarness);
    await assert.rejects(() => resolveHarnessGoal(nestedHarness, undefined, noGit), /ambiguous_harness_root/);

    const inactive = path.join(sandbox, "inactive");
    await fs.mkdir(inactive);
    await initializeHarness(inactive, "done");
    await assert.rejects(() => resolveHarnessGoal(inactive, undefined, noGit), /inactive_goal/);
  } finally {
    await cleanup(sandbox);
  }
});

test("profile bind derives token-free origin before auth, scrubs env, live-reads, and stores no credential", async () => {
  const root = await tempProject("ch-coordination-bind-");
  const calls: MulticaInvocation[] = [];
  const secret = "mul_profile_token_never_persisted_123456";
  try {
    await initializeHarness(root);
    const binding = await bindCoordination({
      cwd: root,
      goal: GOAL,
      mode: "profile",
      profile: "dev",
      serverOrigin: "https://EXAMPLE.com/path",
      workspaceId: WORKSPACE,
      parent: "AUT-3",
    }, {
      runner: profileRunner(calls),
      gitProbe: noGit,
      now: () => "2026-07-14T00:00:00.000Z",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        USERPROFILE: process.env.USERPROFILE,
        MULTICA_TOKEN: secret,
        MULTICA_SERVER_URL: "https://attacker.invalid",
        MULTICA_WORKSPACE_ID: PROJECT_2,
        MULTICA_QUICK_CREATE_TASK_ID: "hostile",
        MULTICA_QUICK_CREATE_ATTACHMENT_IDS: "[\"hostile\"]",
      },
    });
    assert.equal(binding?.parent_id, PARENT);
    assert.equal(binding?.project_id, PROJECT);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0]?.argv, ["--profile", "dev", "config", "identity"]);
    for (const call of calls) {
      assert.equal(call.executable, "multica");
      assert.equal(call.shell, false);
      assert.equal(call.windowsHide, true);
      assert.equal(Object.keys(call.env).some((key) => key.toUpperCase().startsWith("MULTICA_")), false);
      assert.equal(call.argv.includes("--server-url") && call.argv.includes("https://example.com"), call === calls[1]);
      assert.equal(call.argv.some((arg) => arg.includes("attachment")), false);
    }
    const stored = await fs.readFile(coordinationBindingPath(root, GOAL), "utf8");
    assert.equal(stored.includes(secret), false);
    assert.equal(stored.includes("token"), false);
  } finally {
    await cleanup(root);
  }
});

test("profile origin/workspace mismatch fails after config identity and before authenticated read or write", async () => {
  const root = await tempProject("ch-coordination-mismatch-");
  try {
    await initializeHarness(root);
    for (const [serverOrigin, workspaceId, reason] of [
      ["https://wrong.invalid", WORKSPACE, "origin_mismatch"],
      ["https://example.com", PROJECT_2, "workspace_mismatch"],
    ] as const) {
      const calls: MulticaInvocation[] = [];
      await assert.rejects(() => bindCoordination({
        cwd: root,
        mode: "profile",
        profile: "dev",
        serverOrigin,
        workspaceId,
        parent: "AUT-3",
      }, { runner: profileRunner(calls), gitProbe: noGit }), new RegExp(reason));
      assert.equal(calls.length, 1);
      await assert.rejects(() => fs.access(coordinationBindingPath(root, GOAL)));
    }
  } finally {
    await cleanup(root);
  }
});

test("raw, NFKC, and zero-width secrets are rejected before runner or autonomy persistence", async () => {
  const root = await tempProject("ch-coordination-secrets-");
  try {
    await initializeHarness(root);
    for (const profile of [
      "token=abc123456789",
      "to\u200bken=abc123456789",
      "ｔｏｋｅｎ＝abc123456789",
    ]) {
      let calls = 0;
      await assert.rejects(() => bindCoordination({
        cwd: root,
        mode: "profile",
        profile,
        workspaceId: WORKSPACE,
        parent: "AUT-3",
      }, {
        runner: async () => { calls += 1; return { stdout: "{}" }; },
        gitProbe: noGit,
      }), /secret_rejected/);
      assert.equal(calls, 0);
      const files: string[] = [];
      async function walk(dir: string): Promise<void> {
        for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
          const target = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(target);
          else files.push(await fs.readFile(target, "utf8"));
        }
      }
      await walk(path.join(root, ".ycm-harness"));
      assert.equal(files.join("\n").includes(profile), false);
    }
  } finally {
    await cleanup(root);
  }
});

test("task mode requires complete daemon authority and preserves only validated task identity/token in child env", async () => {
  const root = await tempProject("ch-coordination-task-");
  const calls: MulticaInvocation[] = [];
  const token = taskEnv().MULTICA_TOKEN!;
  try {
    await initializeHarness(root);
    const base = { cwd: root, mode: "task" as const, workspaceId: WORKSPACE, parent: "AUT-3" };
    await assert.rejects(() => bindCoordination(base, { runner: profileRunner(calls), gitProbe: noGit, env: {} }), /task_authority_missing/);
    assert.equal(calls.length, 0);
    await writeTaskMarker(root);

    const runner: MulticaRunner = async (call) => {
      calls.push(call);
      return { stdout: JSON.stringify(parent(null)) };
    };
    const binding = await bindCoordination(base, {
      runner,
      gitProbe: noGit,
      env: taskEnv({ MULTICA_QUICK_CREATE_TASK_ID: "must-not-survive" }),
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.env.MULTICA_TOKEN, token);
    assert.deepEqual(Object.keys(calls[0]?.env ?? {}).filter((key) => key.startsWith("MULTICA_")).sort(), [
      "MULTICA_AGENT_ID", "MULTICA_DAEMON_PORT", "MULTICA_TASK_ID", "MULTICA_TOKEN",
    ]);
    assert.equal(JSON.stringify(binding).includes(token), false);
    assert.equal(binding?.task_id, "task-1");
    assert.equal(binding?.agent_id, "agent-1");
    assert.equal((await fs.readFile(coordinationBindingPath(root, GOAL), "utf8")).includes(token), false);
  } finally {
    await cleanup(root);
  }
});

test("parent/project mismatch and later project drift never overwrite the verified binding", async () => {
  const root = await tempProject("ch-coordination-drift-");
  try {
    await initializeHarness(root);
    const calls: MulticaInvocation[] = [];
    const original = await bindCoordination({
      cwd: root,
      mode: "profile",
      profile: "dev",
      workspaceId: WORKSPACE,
      parent: "AUT-3",
    }, { runner: profileRunner(calls), gitProbe: noGit, now: () => "2026-07-14T00:00:00.000Z" });
    const before = await fs.readFile(coordinationBindingPath(root, GOAL), "utf8");

    const driftCalls: MulticaInvocation[] = [];
    await assert.rejects(() => verifyCoordinationBinding(root, undefined, {
      gitProbe: noGit,
      runner: profileRunner(driftCalls, parent(PROJECT_2), { id: PROJECT, workspace_id: WORKSPACE }),
    }), /binding_drift|project_drift/);
    assert.equal(await fs.readFile(coordinationBindingPath(root, GOAL), "utf8"), before);
    assert.equal(original?.project_id, PROJECT);

    const wrongCalls: MulticaInvocation[] = [];
    await assert.rejects(() => bindCoordination({
      cwd: root,
      mode: "profile",
      profile: "dev",
      workspaceId: WORKSPACE,
      parent: PROJECT_2,
    }, { runner: profileRunner(wrongCalls), gitProbe: noGit }), /binding_drift/);
    assert.equal(wrongCalls.length, 1);
    assert.equal(await fs.readFile(coordinationBindingPath(root, GOAL), "utf8"), before);
  } finally {
    await cleanup(root);
  }
});


test("task mode rejects forged env without a valid ancestor daemon marker before runner or write", async () => {
  const root = await tempProject("ch-coordination-task-marker-");
  try {
    await initializeHarness(root);
    const input = { cwd: root, mode: "task" as const, workspaceId: WORKSPACE, parent: "AUT-3" };
    for (const marker of [
      undefined,
      '{"managed_by":"someone-else"}',
      "not-json",
      JSON.stringify({ managed_by: "multica-daemon-task", agent_id: "agent-2", issue_id: PARENT }),
      JSON.stringify({ managed_by: "multica-daemon-task", agent_id: "agent-1" }),
    ]) {
      const markerPath = path.join(root, ".multica", "daemon_task_context.json");
      await fs.rm(markerPath, { force: true });
      if (marker !== undefined) await writeTaskMarker(root, marker);
      let calls = 0;
      await assert.rejects(() => bindCoordination(input, {
        runner: async () => { calls += 1; return { stdout: "{}" }; },
        gitProbe: noGit,
        env: taskEnv(),
      }), /task_authority_missing/);
      assert.equal(calls, 0);
      await assert.rejects(() => fs.access(coordinationBindingPath(root, GOAL)));
    }
  } finally {
    await cleanup(root);
  }
});

test("task and agent authority drift fails before bind or verify performs an authenticated read", async () => {
  const root = await tempProject("ch-coordination-task-drift-");
  try {
    await initializeHarness(root);
    await writeTaskMarker(root);
    const input = { cwd: root, mode: "task" as const, workspaceId: WORKSPACE, parent: "AUT-3" };
    await bindCoordination(input, {
      runner: async () => ({ stdout: JSON.stringify(parent(null)) }),
      gitProbe: noGit,
      env: taskEnv(),
    });
    const before = await fs.readFile(coordinationBindingPath(root, GOAL), "utf8");

    let calls = 0;
    const runner: MulticaRunner = async () => { calls += 1; return { stdout: JSON.stringify(parent(null)) }; };
    await assert.rejects(() => bindCoordination(input, {
      runner,
      gitProbe: noGit,
      env: taskEnv({ MULTICA_TASK_ID: "task-2" }),
    }), /task_authority_drift/);
    assert.equal(calls, 0);
    assert.equal(await fs.readFile(coordinationBindingPath(root, GOAL), "utf8"), before);

    await writeTaskMarker(root, JSON.stringify({
      managed_by: "multica-daemon-task",
      agent_id: "agent-2",
      issue_id: PARENT,
    }));
    await assert.rejects(() => verifyCoordinationBinding(root, undefined, {
      runner,
      gitProbe: noGit,
      env: taskEnv({ MULTICA_AGENT_ID: "agent-2" }),
    }), /task_authority_drift/);
    assert.equal(calls, 0);
  } finally {
    await cleanup(root);
  }
});

test("an unprojected binding rejects empty-to-assigned project drift without overwrite", async () => {
  const root = await tempProject("ch-coordination-empty-project-drift-");
  try {
    await initializeHarness(root);
    await bindCoordination({
      cwd: root,
      mode: "profile",
      profile: "dev",
      workspaceId: WORKSPACE,
      parent: "AUT-3",
    }, { runner: profileRunner([], parent(null)), gitProbe: noGit });
    const before = await fs.readFile(coordinationBindingPath(root, GOAL), "utf8");

    await assert.rejects(() => bindCoordination({
      cwd: root,
      mode: "profile",
      profile: "dev",
      workspaceId: WORKSPACE,
      parent: "AUT-3",
    }, { runner: profileRunner([], parent(PROJECT)), gitProbe: noGit }), /project_drift/);
    assert.equal(await fs.readFile(coordinationBindingPath(root, GOAL), "utf8"), before);
  } finally {
    await cleanup(root);
  }
});

test("explicit project identifiers must exactly match returned identifiers", async () => {
  const root = await tempProject("ch-coordination-project-identifier-");
  const calls: MulticaInvocation[] = [];
  try {
    await initializeHarness(root);
    await assert.rejects(() => bindCoordination({
      cwd: root,
      mode: "profile",
      profile: "dev",
      workspaceId: WORKSPACE,
      parent: "AUT-3",
      project: "PRJ-1",
    }, {
      runner: profileRunner(calls, parent(null), {
        id: PROJECT,
        identifier: "OTHER-9",
        workspace_id: WORKSPACE,
      }),
      gitProbe: noGit,
    }), /project_mismatch/);
    assert.equal(calls.length, 3);
    await assert.rejects(() => fs.access(coordinationBindingPath(root, GOAL)));
  } finally {
    await cleanup(root);
  }
});

test("verify rejects secret-like and noncanonical stored binding fields before argv construction", async () => {
  const root = await tempProject("ch-coordination-hostile-binding-");
  try {
    await initializeHarness(root);
    await bindCoordination({
      cwd: root,
      mode: "profile",
      profile: "dev",
      workspaceId: WORKSPACE,
      parent: "AUT-3",
    }, { runner: profileRunner([]), gitProbe: noGit });
    const file = coordinationBindingPath(root, GOAL);
    const original = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;

    for (const [field, value, expected] of [
      ["profile", "sk-SecretABC12345678", /secret_rejected/],
      ["parent_id", "not-a-uuid", /binding_invalid/],
    ] as const) {
      await fs.writeFile(file, `${JSON.stringify({ ...original, [field]: value }, null, 2)}\n`, "utf8");
      let calls = 0;
      await assert.rejects(() => verifyCoordinationBinding(root, undefined, {
        runner: async () => { calls += 1; return { stdout: "{}" }; },
        gitProbe: noGit,
      }), expected);
      assert.equal(calls, 0);
    }
  } finally {
    await cleanup(root);
  }
});
test("ensure persists pending before one create and returns only exact live-read verified continuations", async (t) => {
  const REMOTE = "55555555-5555-4555-8555-555555555555";
  const ATTACHMENT_A = "66666666-6666-4666-8666-666666666666";
  const ATTACHMENT_B = "77777777-7777-4777-8777-777777777777";
  const SERVER_DIGEST = "a".repeat(64);
  const keys: string[] = [];
  const digests: string[] = [];

  function request(variant = false) {
    return {
      title: variant ? "  Durable   follow-up  " : "Durable follow-up",
      source_class: "agent",
      source: "Follow-up evidence café",
      problem: "The continuation needs a durable reference.",
      impact_scope: "One autonomous program child.",
      owner_control: "The current agent can create and verify the child.",
      acceptance: variant ? ["Reference is live-read", "Only one child exists", "Reference is live-read"] : ["Only one child exists", "Reference is live-read"],
      verification: variant ? ["Read the child", "Inspect the state file"] : ["Inspect the state file", "Read the child"],
      dependencies: ["Verified Multica binding"],
      safety_blockers: [],
      cost_class: "low",
      evidence_horizon: "this invocation",
      rollback: "Stop before returning an unverified reference.",
      status: "todo" as const,
      priority: "medium" as const,
      evidence: variant ? ["deed-2", "deed-1", "deed-1"] : ["deed-1", "deed-2"],
      attachment_ids: variant ? [ATTACHMENT_B, ATTACHMENT_A, ATTACHMENT_A] : [ATTACHMENT_A, ATTACHMENT_B],
      session_id: variant ? "session-b" : "session-a",
      turn_id: variant ? "turn-b" : "turn-a",
    };
  }

  const mismatchedReadbackFields = [
    "id", "identifier", "workspace_id", "parent_id", "project_id",
    "client_idempotency_key", "client_idempotency_digest", "title", "description", "status", "priority",
  ] as const;
  const scenarios = [
    { name: "canonical-a", policy: "none" as const, variant: false },
    { name: "canonical-b", policy: "none" as const, variant: true },
    { name: "metadata-success", policy: "optional" as const, variant: false },
    { name: "metadata-optional-failure", policy: "optional" as const, variant: false, metadataFailure: true },
    { name: "metadata-required-failure", policy: "required" as const, variant: false, metadataFailure: true, rejects: /metadata_unverified/ },
    ...mismatchedReadbackFields.map((badField) => ({
      name: `bad-${badField}`,
      policy: "none" as const,
      variant: false,
      badField,
      rejects: /readback_mismatch/,
    })),
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const root = await tempProject(`ch-continuation-${scenario.name}-`);
      const calls: MulticaInvocation[] = [];
      let key = "";
      let title = "";
      let description = "";
      try {
        await initializeHarness(root);
        await bindCoordination({
          cwd: root,
          goal: GOAL,
          mode: "profile",
          profile: "dev",
          workspaceId: WORKSPACE,
          parent: "AUT-3",
        }, { runner: profileRunner([]), gitProbe: noGit });

        const runner: MulticaRunner = async (call) => {
          calls.push(call);
          assert.equal(call.executable, "multica");
          assert.equal(call.shell, false);
          if (call.argv.includes("identity")) {
            return { stdout: JSON.stringify({ profile: "dev", server_origin: "https://example.com", workspace_id: WORKSPACE }) };
          }
          const getIndex = call.argv.indexOf("get");
          if (getIndex >= 0 && call.argv[getIndex - 1] === "issue") {
            const ref = call.argv[getIndex + 1];
            if (ref === PARENT) return { stdout: JSON.stringify(parent()) };
            const live: Record<string, unknown> = {
              id: REMOTE,
              identifier: "AUT-20",
              workspace_id: WORKSPACE,
              parent_id: PARENT,
              project_id: PROJECT,
              title,
              description,
              status: "todo",
              priority: "medium",
              client_idempotency_key: key,
              client_idempotency_digest: SERVER_DIGEST,
            };
            if (scenario.badField) live[scenario.badField] = `${String(live[scenario.badField])} `;
            return { stdout: JSON.stringify(live) };
          }
          if (call.argv.includes("create")) {
            key = call.argv[call.argv.indexOf("--idempotency-key") + 1]!;
            title = call.argv[call.argv.indexOf("--title") + 1]!;
            description = call.stdin ?? "";
            const pending = JSON.parse(await fs.readFile(continuationRecordPath(root, key), "utf8")) as Record<string, unknown>;
            assert.equal(pending.state, "pending");
            assert.match(description, new RegExp(`^Continuation-Key: ${key}\\nContract-SHA256: [0-9a-f]{64}\\n`));
            assert.match(description, /café/);
            const attachmentArgs = call.argv.flatMap((arg, index) => arg === "--attachment-id" ? [call.argv[index + 1]] : []);
            assert.deepEqual(attachmentArgs, [ATTACHMENT_A, ATTACHMENT_B]);
            return { stdout: JSON.stringify({
              id: REMOTE,
              identifier: "AUT-20",
              client_idempotency_key: key,
              client_idempotency_digest: SERVER_DIGEST,
              reused: false,
            }) };
          }
          if (call.argv.includes("metadata")) {
            if (scenario.metadataFailure) throw new Error("metadata unavailable");
            if (call.argv.includes("list")) return { stdout: JSON.stringify({ continuation_key: key }) };
            return { stdout: JSON.stringify({ continuation_key: key }) };
          }
          throw new Error(`unexpected argv: ${call.argv.join(" ")}`);
        };

        const action = ensureContinuation({
          cwd: root,
          goal: GOAL,
          metadataPolicy: scenario.policy,
          request: request(scenario.variant),
        }, { runner, gitProbe: noGit, now: () => "2026-07-15T00:00:00.000Z" });
        if (scenario.rejects) {
          await assert.rejects(() => action, scenario.rejects);
          const stored = JSON.parse(await fs.readFile(continuationRecordPath(root, key), "utf8")) as Record<string, unknown>;
          assert.equal(stored.state, "created_unverified");
          assert.notEqual(stored.reason, "verified");
        } else {
          const result = await action;
          assert.equal(result?.state, "verified");
          assert.equal(result?.id, REMOTE);
          assert.equal(result?.key, key);
          assert.deepEqual(result?.warnings, scenario.metadataFailure ? ["metadata_unverified"] : []);
          const stored = JSON.parse(await fs.readFile(continuationRecordPath(root, key), "utf8")) as Record<string, unknown>;
          assert.equal(stored.state, "verified");
          assert.equal(stored.reason, "verified");
          keys.push(result!.key);
          digests.push(result!.contract_sha256);
        }
        const createCalls = calls.filter((call) => call.argv.includes("create"));
        assert.equal(createCalls.length, 1);
        assert.equal(createCalls[0]?.stdin, description);
      } finally {
        await cleanup(root);
      }
    });
  }

  assert.equal(keys[0], keys[1]);
  assert.equal(digests[0], digests[1]);

  await t.test("secret input fails before runner or continuation persistence", async () => {
    const root = await tempProject("ch-continuation-secret-");
    try {
      await initializeHarness(root);
      let calls = 0;
      await assert.rejects(() => ensureContinuation({
        cwd: root,
        goal: GOAL,
        metadataPolicy: "none",
        request: { ...request(), problem: "token=abc123456789" },
      }, {
        runner: async () => { calls += 1; return { stdout: "{}" }; },
        gitProbe: noGit,
      }), /secret_rejected/);
      assert.equal(calls, 0);
      await assert.rejects(() => fs.access(path.join(root, ".ycm-harness", "autonomy", "continuations")));
    } finally {
      await cleanup(root);
    }
  });
});

test("continuation convergence, lease recovery, faults, and retry bounds", async (t) => {
  const roots: string[] = [];
  const SERVER_DIGEST = "b".repeat(64);
  const remotes = new Map<string, Record<string, unknown>>();
  const calls: MulticaInvocation[] = [];
  let activeCreates = 0;
  let maxActiveCreates = 0;
  let createDelayMs = 0;

  const request = (title = "Convergent follow-up") => ({
    title,
    source_class: "agent",
    source: "Durable coordination evidence",
    problem: "Independent detections must converge.",
    impact_scope: "One program continuation.",
    owner_control: "The current agent may create and verify it.",
    acceptance: ["One canonical issue"],
    verification: ["Live-read the keyed issue"],
    dependencies: [],
    safety_blockers: [],
    cost_class: "low",
    evidence_horizon: "this invocation",
    rollback: "Keep nonverified state on failure.",
    status: "todo" as const,
    priority: "medium" as const,
  });

  async function setup(prefix: string): Promise<string> {
    const root = await tempProject(prefix);
    roots.push(root);
    await initializeHarness(root);
    await bindCoordination({
      cwd: root,
      goal: GOAL,
      mode: "profile",
      profile: "dev",
      workspaceId: WORKSPACE,
      parent: "AUT-3",
    }, { runner: profileRunner([]), gitProbe: noGit });
    return root;
  }

  const runner: MulticaRunner = async (call) => {
    calls.push(call);
    if (call.argv.includes("identity")) {
      return { stdout: JSON.stringify({ profile: "dev", server_origin: "https://example.com", workspace_id: WORKSPACE }) };
    }
    const getIndex = call.argv.indexOf("get");
    if (getIndex >= 0 && call.argv[getIndex - 1] === "issue") {
      const ref = call.argv[getIndex + 1]!;
      if (ref === PARENT) return { stdout: JSON.stringify(parent()) };
      const remote = [...remotes.values()].find((item) => item.id === ref);
      if (!remote) throw new Error(`missing remote ${ref}`);
      return { stdout: JSON.stringify(remote) };
    }
    if (call.argv.includes("create")) {
      assert.equal(call.stdin?.endsWith("\n"), false);
      activeCreates += 1;
      maxActiveCreates = Math.max(maxActiveCreates, activeCreates);
      const key = call.argv[call.argv.indexOf("--idempotency-key") + 1]!;
      let remote = remotes.get(key);
      if (!remote) {
        const suffix = String(remotes.size + 1).padStart(12, "0");
        remote = {
          id: `00000000-0000-4000-8000-${suffix}`,
          identifier: `AUT-${50 + remotes.size}`,
          workspace_id: WORKSPACE,
          parent_issue_id: PARENT,
          project_id: PROJECT,
          title: call.argv[call.argv.indexOf("--title") + 1],
          description: call.stdin,
          status: "todo",
          priority: "medium",
          client_idempotency_key: key,
          client_idempotency_digest: SERVER_DIGEST,
        };
        remotes.set(key, remote);
      }
      if (createDelayMs) await new Promise((resolve) => setTimeout(resolve, createDelayMs));
      activeCreates -= 1;
      return { stdout: JSON.stringify({
        id: remote.id,
        identifier: remote.identifier,
        client_idempotency_key: key,
        client_idempotency_digest: SERVER_DIGEST,
        reused: remotes.has(key),
      }) };
    }
    throw new Error(`unexpected argv: ${call.argv.join(" ")}`);
  };

  try {
    const rootA = await setup("ch-converge-a-");
    const rootB = await setup("ch-converge-b-");

    await t.test("same-root barrier and independent roots converge without title search", async () => {
      createDelayMs = 20;
      const input = { cwd: rootA, goal: GOAL, metadataPolicy: "none" as const, request: request() };
      const sameRoot = await Promise.all([
        ensureContinuation(input, { runner, gitProbe: noGit }),
        ensureContinuation(input, { runner, gitProbe: noGit }),
      ]);
      assert.equal(sameRoot[0]?.id, sameRoot[1]?.id);
      assert.equal(maxActiveCreates, 1);
      const independent = await Promise.all([
        ensureContinuation({ ...input, cwd: rootA }, { runner, gitProbe: noGit }),
        ensureContinuation({ ...input, cwd: rootB }, { runner, gitProbe: noGit }),
      ]);
      assert.equal(independent[0]?.id, independent[1]?.id);
      assert.equal(independent[0]?.id, sameRoot[0]?.id);
      assert.equal(calls.some((call) => call.argv.includes("search")), false);
      assert.equal(calls.filter((call) => call.argv.includes("create")).length, 4);
      createDelayMs = 0;
    });

    await t.test("verified retitle/close replays the key while local contract conflict stops before create", async () => {
      const only = [...remotes.values()][0]!;
      only.title = "Operator-retitled continuation";
      only.status = "closed";
      const before = calls.filter((call) => call.argv.includes("create")).length;
      const replay = await ensureContinuation({
        cwd: rootA, goal: GOAL, metadataPolicy: "none", request: request(),
      }, { runner, gitProbe: noGit });
      assert.equal(replay?.id, only.id);
      assert.equal(calls.filter((call) => call.argv.includes("create")).length, before + 1);
      await assert.rejects(() => ensureContinuation({
        cwd: rootA,
        goal: GOAL,
        metadataPolicy: "none",
        request: { ...request(), impact_scope: "A conflicting local scope." },
      }, { runner, gitProbe: noGit }), /continuation_conflict/);
      assert.equal(calls.filter((call) => call.argv.includes("create")).length, before + 1);
    });

    await t.test("owner, lease, stale evidence, heartbeat, and nonce release matrix", async () => {
      const key = [...remotes.keys()][0]!;
      const lockDir = path.join(rootA, ".ycm-harness", "autonomy", "locks", `${key}.lock`);
      const ownerFile = path.join(lockDir, "owner.json");
      const old = "2000-01-01T00:00:00.000Z";
      const fresh = () => new Date().toISOString();
      const durableOwnerFile = (nonce: string) => `${lockDir}.${nonce}.owner.json`;
      const writeOwner = async (owner: unknown) => {
        await fs.rm(lockDir, { recursive: true, force: true });
        await fs.mkdir(lockDir, { recursive: true });
        await fs.writeFile(ownerFile, `${JSON.stringify(owner)}\n`, "utf8");
        if (owner && typeof owner === "object" && typeof (owner as { nonce?: unknown }).nonce === "string") {
          await fs.writeFile(durableOwnerFile((owner as { nonce: string }).nonce), `${JSON.stringify(owner)}\n`, "utf8");
        }
      };
      const ensure = (extra: Record<string, unknown> = {}) => ensureContinuation({
        cwd: rootA, goal: GOAL, metadataPolicy: "none", request: request(),
      }, { runner, gitProbe: noGit, lockLeaseMs: 5, lockWaitMs: 15, lockPollMs: 2, ...extra });
      const owner = (overrides: Record<string, unknown> = {}) => ({
        hostname: os.hostname(), pid: process.pid, nonce: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        acquired_at: fresh(), heartbeat_at: fresh(), ...overrides,
      });

      await writeOwner(owner());
      await assert.rejects(() => ensure(), /continuation_lock_timeout/);
      await writeOwner(owner({ pid: 999999, heartbeat_at: fresh() }));
      await assert.rejects(() => ensure({ pidIsAlive: () => false, lockLeaseMs: 10_000 }), /continuation_lock_timeout/);
      await writeOwner(owner({ pid: 999999, acquired_at: old, heartbeat_at: old }));
      await ensure({ pidIsAlive: () => false });
      const staleRoot = path.join(rootA, ".ycm-harness", "autonomy", "stale-locks", key);
      assert.equal((await fs.readdir(staleRoot)).some((name) => name.endsWith(".json")), true);
      await writeOwner(owner({ hostname: "foreign-host", acquired_at: old, heartbeat_at: old }));
      await ensure();
      await writeOwner({ malformed: true });
      const oldDate = new Date(Date.now() - 60_000);
      await fs.utimes(lockDir, oldDate, oldDate);
      await ensure();

      let stole = false;
      const successor = owner({ nonce: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });
      const successorJson = `${JSON.stringify(successor)}\n`;
      await assert.rejects(() => ensureContinuation({
        cwd: rootA, goal: GOAL, metadataPolicy: "none", request: request(),
      }, {
        runner,
        gitProbe: noGit,
        afterLockOwnerCheck: async () => {
          if (stole) return;
          stole = true;
          await fs.rename(lockDir, `${lockDir}.taken-over`);
          await fs.mkdir(lockDir);
          await fs.writeFile(ownerFile, successorJson, "utf8");
          await fs.writeFile(durableOwnerFile(successor.nonce), successorJson, "utf8");
        },
      }), /continuation_lock_lost/);
      assert.equal(await fs.readFile(ownerFile, "utf8"), successorJson);
      assert.equal(await fs.readFile(durableOwnerFile(successor.nonce), "utf8"), successorJson);
      await fs.rm(lockDir, { recursive: true, force: true });
    });

    await t.test("crash, outage, malformed output, and wrong destination remain recoverable and nonverified", async () => {
      for (const scenario of ["outage", "malformed", "wrong_destination", "crash"] as const) {
        const root = await setup(`ch-fault-${scenario}-`);
        let crashed = false;
        const faultRunner: MulticaRunner = async (call) => {
          if (call.argv.includes("create")) {
            if (scenario === "outage") throw new Error("tracker unavailable");
            if (scenario === "malformed") return { stdout: "{" };
            if (scenario === "crash" && !crashed) {
              crashed = true;
              await runner(call);
              throw new Error("local crash after create");
            }
          }
          const result = await runner(call);
          if (scenario === "wrong_destination" && call.argv.includes("get") && call.argv[call.argv.indexOf("get") + 1] !== PARENT) {
            const value = JSON.parse(result.stdout) as Record<string, unknown>;
            value.workspace_id = PROJECT_2;
            return { stdout: JSON.stringify(value) };
          }
          return result;
        };
        const action = () => ensureContinuation({
          cwd: root, goal: GOAL, metadataPolicy: "none", request: request(`Fault ${scenario}`),
        }, { runner: faultRunner, gitProbe: noGit });
        await assert.rejects(action);
        const directory = path.join(root, ".ycm-harness", "autonomy", "continuations");
        const name = (await fs.readdir(directory))[0]!;
        const stored = JSON.parse(await fs.readFile(path.join(directory, name), "utf8")) as Record<string, unknown>;
        assert.notEqual(stored.state, "verified");
        if (scenario === "crash") {
          const recovered = await ensureContinuation({
            cwd: root, goal: GOAL, metadataPolicy: "none", request: request(`Fault ${scenario}`),
          }, { runner, gitProbe: noGit });
          assert.equal(recovered?.state, "verified");
        }
      }
    });

    await t.test("retry is key-sorted, explicitly/default capped, and invokes create once per selected record", async () => {
      const root = await setup("ch-retry-cap-");
      const failedKeys: string[] = [];
      const outage: MulticaRunner = async (call) => {
        if (call.argv.includes("create")) throw new Error("offline");
        return runner(call);
      };
      for (let index = 0; index < 15; index += 1) {
        await assert.rejects(() => ensureContinuation({
          cwd: root, goal: GOAL, metadataPolicy: "none", request: request(`Retry ${index}`),
        }, { runner: outage, gitProbe: noGit }));
      }
      const directory = path.join(root, ".ycm-harness", "autonomy", "continuations");
      failedKeys.push(...(await fs.readdir(directory)).map((name) => name.replace(/\.json$/, "")).sort());
      const before = calls.length;
      const explicit = await retryContinuations({ cwd: root, goal: GOAL, metadataPolicy: "none", limit: 2 }, { runner, gitProbe: noGit });
      const explicitCreates = calls.slice(before).filter((call) => call.argv.includes("create"));
      assert.deepEqual(explicit.map((item) => item.key), failedKeys.slice(0, 2));
      assert.equal(explicitCreates.length, 2);
      const beforeDefault = calls.length;
      const defaults = await retryContinuations({ cwd: root, goal: GOAL, metadataPolicy: "none" }, { runner, gitProbe: noGit });
      const defaultCreates = calls.slice(beforeDefault).filter((call) => call.argv.includes("create"));
      assert.equal(defaults.length, 12);
      assert.equal(defaultCreates.length, 12);
      assert.ok(defaultCreates.length <= 12);
    });
  } finally {
    for (const root of roots.reverse()) await cleanup(root);
  }
});
test("evidence comments use keyed stdin and exact live readback", async () => {
  const root = await tempProject("ch-evidence-comment-");
  const calls: MulticaInvocation[] = [];
  const comments = new Map<string, Record<string, unknown>>();
  const issueId = "55555555-5555-4555-8555-555555555555";
  const commentId = "66666666-6666-4666-8666-666666666666";
  let effects = 0;
  let corruptReadback = false;
  const runner: MulticaRunner = async (call) => {
    calls.push(call);
    if (call.argv.includes("identity")) {
      return { stdout: JSON.stringify({ profile: "dev", server_origin: "https://example.com", workspace_id: WORKSPACE }) };
    }
    const commentIndex = call.argv.indexOf("comment");
    const action = commentIndex >= 0 ? call.argv[commentIndex + 1] : undefined;
    if (action === "add") {
      const key = call.argv[call.argv.indexOf("--idempotency-key") + 1]!;
      const content = call.stdin ?? "";
      const current = comments.get(key);
      if (current && current.content !== content) throw new Error("conflict");
      if (!current) {
        effects += 1;
        comments.set(key, { id: commentId, issue_id: issueId, client_idempotency_key: key, content });
      }
      return { stdout: JSON.stringify(comments.get(key)) };
    }
    if (action === "list") {
      const values = [...comments.values()].map((comment) => (
        corruptReadback ? { ...comment, content: `${comment.content as string} ` } : comment
      ));
      return { stdout: JSON.stringify(values) };
    }
    return { stdout: JSON.stringify(parent()) };
  };
  try {
    await initializeHarness(root);
    await bindCoordination({
      cwd: root, goal: GOAL, mode: "profile", profile: "dev",
      workspaceId: WORKSPACE, parent: "AUT-3",
    }, { runner, gitProbe: noGit });
    const input = {
      cwd: root,
      goal: GOAL,
      issueId,
      key: "evidence-aaaaaaaaaaaaaaaaaaaaaaaa",
      content: "Verified UTF-8 evidence: 完成",
    };
    const [first, replay] = await Promise.all([
      appendContinuationEvidence(input, { runner, gitProbe: noGit }),
      appendContinuationEvidence(input, { runner, gitProbe: noGit }),
    ]);
    assert.equal(first?.id, commentId);
    assert.deepEqual(replay, first);
    assert.equal(effects, 1);
    const addCalls = calls.filter((call) => call.argv.includes("add"));
    assert.equal(addCalls.length, 2);
    for (const call of addCalls) {
      assert.equal(call.shell, false);
      assert.equal(call.stdin, input.content);
      assert.equal(call.argv.includes("--content-stdin"), true);
      assert.equal(call.argv.includes("--content-file"), false);
    }
    await assert.rejects(() => appendContinuationEvidence({ ...input, content: "changed" }, { runner, gitProbe: noGit }), /conflict/);
    corruptReadback = true;
    await assert.rejects(() => appendContinuationEvidence({
      ...input,
      key: "evidence-bbbbbbbbbbbbbbbbbbbbbbbb",
    }, { runner, gitProbe: noGit }), /evidence_readback_failed/);
  } finally {
    await cleanup(root);
  }
});

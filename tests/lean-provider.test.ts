import { test } from "node:test";
import assert from "node:assert/strict";
import { localTicketProvider, multicaTicketProvider } from "../src/tickets/provider.js";
import type { MulticaInvocation, MulticaRunner } from "../src/autonomy/coordination.js";
import { emptyStateV3 } from "../src/schema/v3.js";

test("local provider reads canonical ticket content and exact evidence references", async () => {
  const state = emptyStateV3("2026-07-15T01:02:03.000Z");
  state.local_tickets.ticket_local = {
    id: "ticket_local", goal_id: "goal_local", title: "Inspect the artifact", brief: "Read the durable result",
    acceptance: ["Comment exists"], blocked_by: [], status: "in_progress", code_changed: false, order: 0,
    created_at: state.created_at, updated_at: state.updated_at,
  };
  state.evidence.evidence_local = {
    id: "evidence_local", goal_id: "goal_local", ticket_id: "ticket_local", kind: "other",
    remote_comment_id: "comment-local", provenance: {}, recorded_at: state.updated_at,
  };
  const provider = localTicketProvider(state);
  assert.deepEqual(await provider.readProof("missing"), { kind: "missing" });
  const read = await provider.readProof("ticket_local");
  assert.equal(read.kind, "found");
  if (read.kind === "found") assert.deepEqual(read.proof, {
    ticket_id: "ticket_local",
    configured_parent_id: "goal_local",
    parent_id: "goal_local",
    status: "in_progress",
    content_strings: ["Inspect the artifact", "Read the durable result", "Comment exists"],
    evidence_reference_ids: ["comment-local", "evidence_local"],
    readback_at: read.proof.readback_at,
  });
});

test("Multica provider is idempotent without unsupported CLI flags", async () => {
  const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const parent = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
  const child = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5";
  const calls: MulticaInvocation[] = [];
  const issues: Record<string, unknown>[] = [{ id: "root-issue", title: "Unrelated root", status: "todo", parent_issue_id: null }];
  const comments: Record<string, unknown>[] = [];
  const runner: MulticaRunner = async (call) => {
    calls.push(call);
    const args = call.argv.slice(call.argv.indexOf("issue"));
    if (args[1] === "get") {
      if (args[2] === parent) return { stdout: JSON.stringify({ id: parent, workspace_id: workspace, title: "Parent", status: "todo" }) };
      const issue = issues.find((row) => row.id === args[2] || row.identifier === args[2]);
      if (issue) return { stdout: JSON.stringify(issue) };
      throw new Error(`resolve issue: GET /api/issues/${encodeURIComponent(args[2])} returned 404: {"error":"issue not found"}`);
    }
    if (args[1] === "list") return { stdout: JSON.stringify({ issues, total: issues.length, limit: 200, offset: 0, has_more: false }) };
    if (args[1] === "create") {
      const row = { id: child, identifier: "AUT-34", title: "Child", description: call.stdin, status: "todo", parent_issue_id: parent, position: -10 };
      issues.push(row);
      return { stdout: JSON.stringify(row) };
    }
    if (args[1] === "comment" && args[2] === "list") return { stdout: JSON.stringify(comments) };
    if (args[1] === "comment" && args[2] === "add") {
      const row = { id: "comment-1", content: call.stdin };
      comments.push(row);
      return { stdout: JSON.stringify(row) };
    }
    throw new Error("unexpected call: " + args.join(" "));
  };
  const provider = multicaTicketProvider({ kind: "multica", origin: "http://127.0.0.1:3000", workspace_id: workspace, parent_issue_id: parent }, { runner, goalId: "goal" });

  assert.equal((await provider.create("goal", { title: "Child", acceptance: ["Remote evidence survives readback"] })).id, child);
  assert.equal((await provider.create("goal", { title: "Child", acceptance: ["Remote evidence survives readback"] })).id, child);
  const listed = await provider.list("goal");
  assert.deepEqual(listed.map((ticket) => ticket.id), [child]);
  assert.deepEqual(listed[0]?.acceptance, ["Remote evidence survives readback"]);
  assert.equal(await provider.addEvidence(child, "PASS evidence", "key"), "comment-1");
  assert.equal(await provider.addEvidence(child, "PASS evidence", "key"), "comment-1");
  const listsBeforeProof = calls.filter((call) => call.argv.includes("list") && !call.argv.includes("comment")).length;
  const proof = await provider.readProof(child);
  assert.equal(proof.kind, "found");
  if (proof.kind === "found") {
    assert.equal(proof.proof.configured_parent_id, parent);
    assert.equal(proof.proof.parent_id, parent);
    assert.equal(proof.proof.status, "todo");
    assert.ok(proof.proof.content_strings.includes("Child"));
    assert.deepEqual(proof.proof.evidence_reference_ids, ["comment-1"]);
  }
  const identifierProof = await provider.readProof("AUT-34");
  assert.equal(identifierProof.kind, "found");
  if (identifierProof.kind === "found") assert.equal(identifierProof.proof.ticket_id, "AUT-34");
  assert.deepEqual(await provider.readProof("missing-child"), { kind: "missing" });
  assert.equal(calls.filter((call) => call.argv.includes("list") && !call.argv.includes("comment")).length, listsBeforeProof);
  assert.ok(calls.some((call) => call.argv.includes("get") && call.argv.includes(child)));
  assert.ok(calls.some((call) => call.argv.includes("get") && call.argv.includes("AUT-34")));

  assert.equal(calls.filter((call) => call.argv.includes("create")).length, 1);
  assert.equal(calls.filter((call) => call.argv.includes("add")).length, 1);
  assert.ok(calls.every((call) => !call.argv.includes("--idempotency-key")));

  const outage = multicaTicketProvider(
    { kind: "multica", origin: "http://127.0.0.1:3000", workspace_id: workspace, parent_issue_id: parent },
    { runner: async () => { throw new Error("tracker offline"); }, goalId: "goal" },
  );
  await assert.rejects(() => outage.readProof("AUT-34"), /tracker offline/);
});

test("Multica strategic capability live-reads bounded ticket state and uses supported idempotent commands", async () => {
  const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const parent = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
  const existingId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5";
  const createdId = "dddddddd-dddd-4ddd-8ddd-ddddddddddd4";
  const actionIdentity = `action-${"a".repeat(64)}`;
  const rootCause = "Accepted feedback was not bound to durable work.";
  const calls: MulticaInvocation[] = [];
  const issues: Record<string, any>[] = [{
    id: existingId,
    identifier: "AUT-34",
    title: "Existing ordinary work",
    description: `${rootCause}\n\n## Acceptance\n- Durable ownership exists`,
    status: "todo",
    priority: "medium",
    parent_issue_id: parent,
    assignee_id: null,
    assignee_type: null,
    comments: [],
  }];
  const runner: MulticaRunner = async (call) => {
    calls.push(call);
    const args = call.argv.slice(call.argv.indexOf("issue"));
    if (args[1] === "get") {
      if (args[2] === parent) return { stdout: JSON.stringify({ id: parent, workspace_id: workspace, title: "Parent", status: "todo" }) };
      const issue = issues.find((row) => row.id === args[2] || row.identifier === args[2]);
      if (!issue) throw new Error(`resolve issue: GET /api/issues/${encodeURIComponent(args[2])} returned 404: {"error":"issue not found"}`);
      return { stdout: JSON.stringify(issue) };
    }
    if (args[1] === "search") {
      const query = String(args[2] ?? "");
      const matched = issues.filter((row) => JSON.stringify(row).includes(query));
      return { stdout: JSON.stringify({ issues: matched, total: matched.length, limit: 200, offset: 0, has_more: false }) };
    }
    if (args[1] === "create") {
      const row = {
        id: createdId,
        identifier: "AUT-35",
        title: String(args[args.indexOf("--title") + 1]),
        description: call.stdin,
        status: "todo",
        priority: "medium",
        parent_issue_id: parent,
        assignee_id: null,
        assignee_type: null,
        comments: [],
      };
      issues.push(row);
      return { stdout: JSON.stringify(row) };
    }
    if (args[1] === "comment" && args[2] === "add") {
      const issue = issues.find((row) => row.id === args[3]);
      if (!issue) throw new Error("missing issue");
      const comment = { id: `comment-${issue.comments.length + 1}`, content: call.stdin };
      issue.comments.push(comment);
      return { stdout: JSON.stringify(comment) };
    }
    if (args[1] === "update") {
      const issue = issues.find((row) => row.id === args[2]);
      if (!issue) throw new Error("missing issue");
      issue.priority = args[args.indexOf("--priority") + 1];
      return { stdout: JSON.stringify(issue) };
    }
    throw new Error("unexpected call: " + args.join(" "));
  };
  const provider = multicaTicketProvider(
    { kind: "multica", origin: "http://127.0.0.1:3000", workspace_id: workspace, parent_issue_id: parent },
    { runner, goalId: "goal" },
  );

  const strategic = provider.strategic;
  assert.ok(strategic);
  const ordinary = await strategic.search({ root_cause: rootCause, action_identity: actionIdentity, owner: null });
  assert.equal(ordinary.length, 1);
  assert.deepEqual(ordinary[0]?.action_identities, []);
  assert.equal(ordinary[0]?.owner, null);
  assert.match(ordinary[0]?.provider_proof.digest ?? "", /^[a-f0-9]{64}$/);

  const created = await strategic.create({
    title: "Bind accepted feedback",
    brief: rootCause,
    acceptance: ["Durable ownership exists"],
    root_cause: rootCause,
    action_identity: actionIdentity,
    owner: null,
  });
  const replayedCreate = await strategic.create({
    title: "Bind accepted feedback",
    brief: rootCause,
    acceptance: ["Durable ownership exists"],
    root_cause: rootCause,
    action_identity: actionIdentity,
    owner: null,
  });
  assert.equal(created.ticket_id, createdId);
  assert.equal(replayedCreate.provider_proof.digest, created.provider_proof.digest);

  const commented = await strategic.comment(createdId, "Accepted evidence: explicit-feedback", actionIdentity);
  const replayedComment = await strategic.comment(createdId, "Accepted evidence: explicit-feedback", actionIdentity);
  assert.equal(commented.comments.length, 1);
  assert.equal(replayedComment.comments.length, 1);
  assert.equal(commented.comments[0]?.action_identity, actionIdentity);

  const prioritized = await strategic.setPriority(createdId, "high");
  const replayedPriority = await strategic.setPriority(createdId, "high");
  assert.equal(prioritized.priority, "high");
  assert.equal(replayedPriority.provider_proof.digest, prioritized.provider_proof.digest);

  const issueCalls = calls.map((call) => call.argv.slice(call.argv.indexOf("issue")));
  assert.ok(issueCalls.some((args) => args[1] === "search"));
  assert.equal(issueCalls.filter((args) => args[1] === "create").length, 1);
  assert.equal(issueCalls.filter((args) => args[1] === "comment" && args[2] === "add").length, 1);
  assert.equal(issueCalls.filter((args) => args[1] === "update" && args.includes("--priority")).length, 1);
  assert.ok(issueCalls.every((args) => !args.includes("list") && !args.includes("--idempotency-key")));
});

test("Multica provider classifies only the exact requested issue 404 as missing", async () => {
  const workspace = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
  const parent = "cccccccc-cccc-4ccc-8ccc-ccccccccccc3";
  const requested = "00000000-0000-0000-0000-000000000000";
  const providerForError = (message: string) => multicaTicketProvider(
    { kind: "multica", origin: "http://127.0.0.1:3000", workspace_id: workspace, parent_issue_id: parent },
    {
      goalId: "goal",
      runner: async (call) => {
        const args = call.argv.slice(call.argv.indexOf("issue"));
        if (args[1] === "get" && args[2] === parent) {
          return { stdout: JSON.stringify({ id: parent, workspace_id: workspace, title: "Parent", status: "todo" }) };
        }
        throw new Error(message);
      },
    },
  );

  const liveMissing = `resolve issue: GET /api/issues/${requested} returned 404: {"error":"issue not found"}`;
  assert.deepEqual(await providerForError(liveMissing).readProof(requested), { kind: "missing" });

  const outages = [
    `resolve workspace: GET /api/workspaces/${workspace} returned 404: {"error":"workspace not found"}`,
    "proxy returned 404",
    "getaddrinfo ENOTFOUND tracker.internal",
    `resolve issue: GET /api/issues/${requested} returned 404: not-json`,
    `resolve issue: GET /api/issues/11111111-1111-1111-1111-111111111111 returned 404: {"error":"issue not found"}`,
    `resolve issue: GET /api/issues/${requested} returned 404: {"error":"issue not found","source":"proxy"}`,
  ];
  for (const message of outages) {
    await assert.rejects(() => providerForError(message).readProof(requested), (error: unknown) => {
      assert.equal((error as Error).message, message);
      return true;
    });
  }
});

test("GitHub provider is idempotent for create and evidence via gh", async () => {
  const parent = 42;
  const child = 99;
  const calls: import("../src/autonomy/coordination.js").GhInvocation[] = [];
  const issues: Record<string, unknown>[] = [{
    number: parent,
    title: "Parent",
    state: "OPEN",
    body: "Goal parent",
    url: `https://github.com/johnyuencm/ycm-harness/issues/${parent}`,
  }];
  const commentsByIssue = new Map<number, Record<string, unknown>[]>();
  const bodyFor = (title: string, brief: string) => [
    `Parent: #${parent}`,
    "",
    `<!-- ycm-harness:ticket:v1 parent=${parent} status=todo goal=goal -->`,
    brief,
    "",
    "## Acceptance",
    "- Remote evidence survives readback",
  ].join("\n");
  const runner: import("../src/autonomy/coordination.js").GhRunner = async (call) => {
    calls.push(call);
    const args = call.argv;
    if (args[0] === "issue" && args[1] === "view") {
      const id = Number(args[2]);
      const issue = issues.find((row) => row.number === id);
      if (!issue) throw new Error(`HTTP 404: issue ${id} not found`);
      return {
        stdout: JSON.stringify({
          ...issue,
          comments: commentsByIssue.get(id) ?? [],
        }),
      };
    }
    if (args[0] === "issue" && args[1] === "list") {
      return {
        stdout: JSON.stringify(issues.filter((row) => row.number !== parent)),
      };
    }
    if (args[0] === "issue" && args[1] === "create") {
      const row = {
        number: child,
        title: "Child",
        state: "OPEN",
        body: call.stdin,
        url: `https://github.com/johnyuencm/ycm-harness/issues/${child}`,
      };
      issues.push(row);
      return { stdout: JSON.stringify(row) };
    }
    if (args[0] === "issue" && args[1] === "comment") {
      const id = Number(args[2]);
      const list = commentsByIssue.get(id) ?? [];
      const existing = list.find((row) => row.body === call.stdin);
      if (existing) return { stdout: JSON.stringify(existing) };
      const row = { id: `comment-${list.length + 1}`, body: call.stdin, url: `https://github.com/johnyuencm/ycm-harness/issues/${id}#comment-${list.length + 1}` };
      list.push(row);
      commentsByIssue.set(id, list);
      return { stdout: JSON.stringify(row) };
    }
    if (args[0] === "project" && args[1] === "item-add") return { stdout: "" };
    throw new Error("unexpected call: " + args.join(" "));
  };
  const { githubTicketProvider } = await import("../src/tickets/provider.js");
  const provider = githubTicketProvider({
    kind: "github",
    owner: "johnyuencm",
    repo: "ycm-harness",
    project_owner: "johnyuencm",
    project_number: 1,
    parent_issue_number: parent,
  }, { runner, goalId: "goal" });

  assert.equal((await provider.create("goal", { title: "Child", brief: "brief", acceptance: ["Remote evidence survives readback"] })).id, String(child));
  assert.equal((await provider.create("goal", { title: "Child", brief: "brief", acceptance: ["Remote evidence survives readback"] })).id, String(child));
  const listed = await provider.list("goal");
  assert.deepEqual(listed.map((ticket) => ticket.id), [String(child)]);
  assert.equal(await provider.addEvidence(String(child), "PASS evidence", "key"), "comment-1");
  assert.equal(await provider.addEvidence(String(child), "PASS evidence", "key"), "comment-1");
  const proof = await provider.readProof(String(child));
  assert.equal(proof.kind, "found");
  if (proof.kind === "found") {
    assert.equal(proof.proof.configured_parent_id, String(parent));
    assert.equal(proof.proof.parent_id, String(parent));
    assert.ok(proof.proof.content_strings.includes("Child"));
    assert.deepEqual(proof.proof.evidence_reference_ids, ["comment-1"]);
  }
  assert.equal(calls.filter((call) => call.argv.includes("create")).length, 1);
  void bodyFor;
});

test("GitHub markers write ycm-harness and still read legacy cursor-harness", async () => {
  const parent = 7;
  const child = 8;
  const legacyBody = [
    `Parent: #${parent}`,
    "",
    `<!-- cursor-harness:ticket:v1 parent=${parent} status=in_progress goal=goal -->`,
    "legacy brief",
    "",
    "## Acceptance",
    "- dual-read",
  ].join("\n");
  const issues: Record<string, unknown>[] = [
    {
      number: parent,
      title: "Parent",
      state: "OPEN",
      body: "Goal parent",
      url: `https://github.com/johnyuencm/ycm-harness/issues/${parent}`,
    },
    {
      number: child,
      title: "Legacy child",
      state: "OPEN",
      body: legacyBody,
      url: `https://github.com/johnyuencm/ycm-harness/issues/${child}`,
    },
  ];
  let lastCreateBody = "";
  const runner: import("../src/autonomy/coordination.js").GhRunner = async (call) => {
    const args = call.argv;
    if (args[0] === "issue" && args[1] === "view") {
      const id = Number(args[2]);
      const issue = issues.find((row) => row.number === id);
      if (!issue) throw new Error(`HTTP 404: issue ${id} not found`);
      return { stdout: JSON.stringify({ ...issue, comments: [] }) };
    }
    if (args[0] === "issue" && args[1] === "list") {
      return { stdout: JSON.stringify(issues.filter((row) => row.number !== parent)) };
    }
    if (args[0] === "issue" && args[1] === "create") {
      lastCreateBody = String(call.stdin ?? "");
      const row = {
        number: 9,
        title: "New",
        state: "OPEN",
        body: call.stdin,
        url: "https://github.com/johnyuencm/ycm-harness/issues/9",
      };
      issues.push(row);
      return { stdout: JSON.stringify(row) };
    }
    if (args[0] === "project" && args[1] === "item-add") return { stdout: "" };
    throw new Error("unexpected call: " + args.join(" "));
  };
  const { githubTicketProvider } = await import("../src/tickets/provider.js");
  const provider = githubTicketProvider({
    kind: "github",
    owner: "johnyuencm",
    repo: "ycm-harness",
    project_owner: "johnyuencm",
    project_number: 1,
    parent_issue_number: parent,
  }, { runner, goalId: "goal" });

  const listed = await provider.list("goal");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, String(child));
  assert.equal(listed[0]!.status, "in_progress");

  await provider.create("goal", { title: "New", brief: "brief", acceptance: ["x"] });
  assert.match(lastCreateBody, /<!-- ycm-harness:ticket:v1 /);
  assert.doesNotMatch(lastCreateBody, /<!-- cursor-harness:ticket:v1 /);
});

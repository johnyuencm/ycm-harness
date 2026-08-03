import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import {
  handoffPm,
  pmHandoffReceiptPath,
  pmWorkerActorPayload,
  pmWorkerClaimId,
  pmWorkerRunRoot,
  preparePm,
  readPmHandoffReceipt,
  type HandoffPmInput,
  type PmCandidate,
  type PmProvider,
} from "../src/autonomy/pm.js";
import { HarnessStore } from "../src/state/store.js";
import { cleanup, tempProject } from "./helpers.js";
import { actorBinding, actorRegistry, testArtifactManifest, testWorker, workerSelector } from "./pm-actor-fixture.js";

async function activeHarness(): Promise<string> {
  const root = await tempProject("ch-pm-handoff-");
  const store = new HarnessStore(root);
  await store.init();
  await store.update((state) => {
    state.goals.goal = {
      id: "goal", title: "PM goal", status: "active", worktree_status: "active",
      created_at: state.created_at, updated_at: state.updated_at,
    };
    state.active_goal_id = "goal";
    return state;
  });
  return root;
}

const candidate: PmCandidate = {
  id: "ticket-1", root_key: "root-1", priority: "high", updated_at: "2026-07-15T08:00:00.000Z",
  active: true, material: true, concrete_acceptance: true, dependencies_satisfied: true,
  safe_authority: true, clear: true,
};

const prepareRequest = {
  cwd: "", goal: "goal", producer_slot: "daily-0900", invocation_key: "2026-07-15",
  run_id: "prepare-run", session_id: "prepare-session",
  brief: {
    objective: "Complete the selected bounded task.", non_goals: ["No schedule mutation."],
    acceptance: ["Targeted tests pass."], evidence: ["Inspect the selected ticket live."],
    first_steps: ["Read instructions."], verification: ["npm test -- tests/pm-handoff.test.ts"],
    capability_cost_rationale: "Use one bounded local implementation run.",
    safety_rollback: "Stop before unsafe authority.", risks: ["Artifact readback can fail."],
    handoff_contract: "Return files, commands, evidence, risks, and status.",
  },
};

async function claimed(root: string) {
  const provider: PmProvider = {
    async listCandidates() { return [candidate]; },
    async annotate(candidateId, key, content) { return { id: "comment-1", issue_id: candidateId, key, content }; },
  };
  return preparePm({ ...prepareRequest, cwd: root }, { provider });
}

function baseHandoff(prepared: Awaited<ReturnType<typeof claimed>>): Omit<HandoffPmInput, "cwd"> {
  return {
    goal: "goal", producer_slot: prepareRequest.producer_slot, invocation_key: prepareRequest.invocation_key,
    prepare_receipt_id: prepared.receipt_id,
    claim: {
      claim_id: pmWorkerClaimId("goal", prepared, testWorker),
      ticket_id: candidate.id,
      provider_annotation_id: "comment-1",
    },
    worker_origin: workerSelector,
    artifacts: { prompt: "prompt.txt", output: "output.txt", exit_status: "exit-status.txt", meaningful_log: "meaningful.log" },
    outcome: "completed",
    handoff: {
      acceptance_checklist: [{ criterion: "Targeted tests pass.", status: "pass", evidence: ["test-output"] }],
      remaining_risks: [], severity_self_assessment: "None",
      changed_files: ["src/autonomy/pm.ts", "tests/pm-handoff.test.ts"], evidence: ["test-output"],
      commands: [{ command: "npm test -- tests/pm-handoff.test.ts", result: "pass" }],
      follow_up: { ids: [], suggestions: ["Independent review"] },
    },
  };
}

function handoffManifest(request: Omit<HandoffPmInput, "cwd">) {
  const status = request.outcome === "timed_out" ? "124\n" : request.outcome === "crashed" ? "137\n" : "0\n";
  return testArtifactManifest([
    { kind: "prompt", relative_path: request.artifacts.prompt, content: "Implement only the bounded PM handoff." },
    { kind: "output", relative_path: request.artifacts.output, content: "Implementation and tests completed." },
    { kind: "exit_status", relative_path: request.artifacts.exit_status, content: status },
    { kind: "meaningful_log", relative_path: request.artifacts.meaningful_log, content: "targeted tests: pass\n" },
  ]);
}

function signedHandoffDeps(
  request: Omit<HandoffPmInput, "cwd">,
  identity: typeof testWorker = testWorker,
  mutate?: (record: ReturnType<ReturnType<typeof actorRegistry>["addWorker"]>) => void,
) {
  const actors = actorRegistry();
  const payload = pmWorkerActorPayload({ goal_id: "goal", parent_id: actorBinding.parent_id,
    ticket_id: request.claim.ticket_id, prepare_receipt_id: request.prepare_receipt_id, claim_id: request.claim.claim_id,
    producer_slot: request.producer_slot, invocation_key: request.invocation_key, outcome: request.outcome,
    manifest: handoffManifest(request), handoff: request.handoff });
  const record = actors.addWorker({ identity, selector: request.worker_origin, ticketId: request.claim.ticket_id,
    prepareReceiptId: request.prepare_receipt_id, claimId: request.claim.claim_id, payload });
  mutate?.(record);
  return actors.deps;
}

function executeHandoff(
  root: string,
  request: Omit<HandoffPmInput, "cwd">,
  deps: Parameters<typeof handoffPm>[1] = {},
  identity: typeof testWorker = testWorker,
) {
  return handoffPm({ ...request, cwd: root }, { ...signedHandoffDeps(request, identity), ...deps });
}

async function writeArtifacts(root: string, request: Omit<HandoffPmInput, "cwd">): Promise<string> {
  const runRoot = pmWorkerRunRoot(root, "goal", request.claim.claim_id);
  await fs.mkdir(runRoot, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(runRoot, request.artifacts.prompt), "Implement only the bounded PM handoff.", "utf8"),
    fs.writeFile(path.join(runRoot, request.artifacts.output), "Implementation and tests completed.", "utf8"),
    fs.writeFile(path.join(runRoot, request.artifacts.exit_status), `${request.outcome === "timed_out" ? 124 : request.outcome === "crashed" ? 137 : 0}\n`, "utf8"),
    fs.writeFile(path.join(runRoot, request.artifacts.meaningful_log), "targeted tests: pass\n", "utf8"),
  ]);
  return runRoot;
}

test("handoff authenticates the claimed prepare receipt and persists a hash-bound structured manifest", async () => {
  const root = await activeHarness();
  try {
    const prepared = await claimed(root);
    const request = baseHandoff(prepared);
    await writeArtifacts(root, request);
    const receipt = await executeHandoff(root, request);
    assert.equal(receipt.state, "handed_off");
    assert.equal(receipt.prepare_receipt_id, prepared.receipt_id);
    assert.deepEqual(receipt.worker, testWorker);
    assert.equal(receipt.worker_origin.assurance, "authenticated_install");
    assert.deepEqual(receipt.worker_origin.selector, workerSelector);
    assert.deepEqual(receipt.worker_payload, pmWorkerActorPayload({ goal_id: "goal", parent_id: actorBinding.parent_id,
      ticket_id: request.claim.ticket_id, prepare_receipt_id: request.prepare_receipt_id, claim_id: request.claim.claim_id,
      producer_slot: request.producer_slot, invocation_key: request.invocation_key, outcome: request.outcome,
      manifest: receipt.manifest, handoff: request.handoff }));
    assert.deepEqual(receipt.claim, request.claim);
    assert.equal(receipt.manifest.length, 4);
    const prompt = receipt.manifest.find((entry) => entry.kind === "prompt")!;
    assert.equal(prompt.sha256, createHash("sha256").update("Implement only the bounded PM handoff.").digest("hex"));
    assert.deepEqual(await readPmHandoffReceipt(root, "goal", request.claim.claim_id), receipt);
  } finally { await cleanup(root); }
});

test("handoff rejects legacy caller-authored worker identity and evidence before receipt advancement", async () => {
  const root = await activeHarness();
  try {
    const prepared = await claimed(root);
    const request = baseHandoff(prepared);
    await writeArtifacts(root, request);
    const legacy = { ...request, worker: testWorker, worker_evidence: { reviewer_source: "caller" } };
    delete (legacy as Partial<typeof legacy>).worker_origin;
    await assert.rejects(handoffPm({ ...legacy, cwd: root } as unknown as HandoffPmInput), /pm_invalid_handoff_request/);
    assert.equal(await readPmHandoffReceipt(root, "goal", request.claim.claim_id), undefined);
  } finally { await cleanup(root); }
});

test("handoff public actor selector rejects caller paths, keys, hashes, timestamps, and modules", async () => {
  for (const field of ["record_path", "public_key", "private_key", "record_sha256", "signed_at", "reader_module"] as const) {
    const root = await activeHarness();
    try {
      const prepared = await claimed(root); const request = baseHandoff(prepared); await writeArtifacts(root, request);
      const forged = { ...request, worker_origin: { ...workerSelector, [field]: "caller-controlled" } };
      await assert.rejects(handoffPm({ ...forged, cwd: root } as unknown as HandoffPmInput, signedHandoffDeps(request)),
        /pm_invalid_handoff_request/);
      assert.equal(await readPmHandoffReceipt(root, "goal", request.claim.claim_id), undefined);
    } finally { await cleanup(root); }
  }
});

test("handoff rejects missing, role-mismatched, scoped, or identity-forged actor records before advancement", async () => {
  for (const hazard of ["missing", "role", "subject", "run", "session", "goal"] as const) {
    const root = await activeHarness();
    try {
      const prepared = await claimed(root);
      const request = baseHandoff(prepared);
      await writeArtifacts(root, request);
      const deps = hazard === "missing" ? { binding: actorBinding, readActorOrigin: async () => undefined }
        : signedHandoffDeps(request, testWorker, (record) => {
          if (hazard === "role") record.role = "reviewer";
          if (hazard === "subject") record.subject = "forged-worker";
          if (hazard === "run") record.run_id = "forged-run";
          if (hazard === "session") record.session_id = "forged-session";
          if (hazard === "goal") record.goal_id = "other-goal";
        });
      await assert.rejects(handoffPm({ ...request, cwd: root }, deps),
        /pm_(?:worker_origin_invalid|worker_origin_scope_invalid|claim_identity_invalid)/);
      await assert.rejects(fs.access(path.join(root, ".ycm-harness", "autonomy", "pm", "claims", `${prepared.receipt_id}.json`)));
      await assert.rejects(fs.access(path.join(pmWorkerRunRoot(root, "goal", request.claim.claim_id), ".pm-artifact-manifest.json")));
      assert.equal(await readPmHandoffReceipt(root, "goal", request.claim.claim_id), undefined);
    } finally { await cleanup(root); }
  }
});

test("handoff fails closed for claim mismatch and unsafe, empty, secret, or oversized artifacts", async () => {
  for (const hazard of ["claim", "escape", "symlink", "empty_log", "invalid_utf8", "secret", "oversized"] as const) {
    const root = await activeHarness();
    const outside = await tempProject("ch-pm-handoff-outside-");
    try {
      const prepared = await claimed(root);
      const request = baseHandoff(prepared);
      const runRoot = await writeArtifacts(root, request);
      if (hazard === "claim") request.claim.provider_annotation_id = "wrong-comment";
      if (hazard === "escape") request.artifacts.output = "../outside.txt";
      if (hazard === "symlink") {
        await fs.writeFile(path.join(outside, "output.txt"), "outside", "utf8");
        await fs.rm(path.join(runRoot, request.artifacts.output));
        await fs.symlink(path.join(outside, "output.txt"), path.join(runRoot, request.artifacts.output));
      }
      if (hazard === "empty_log") await fs.writeFile(path.join(runRoot, request.artifacts.meaningful_log), "", "utf8");
      if (hazard === "invalid_utf8") await fs.writeFile(path.join(runRoot, request.artifacts.output), Buffer.from([0xc3, 0x28]));
      if (hazard === "secret") await fs.writeFile(path.join(runRoot, request.artifacts.output), "Authorization: Bearer abcdefghijklmnop", "utf8");
      if (hazard === "oversized") await fs.writeFile(path.join(runRoot, request.artifacts.output), "x".repeat(1024 * 1024 + 1), "utf8");
      await assert.rejects(executeHandoff(root, request), /pm_(?:claim_mismatch|invalid_handoff_request|artifact_unsafe|artifact_empty|artifact_invalid_text|artifact_secret|artifact_too_large)/);
      assert.equal(await readPmHandoffReceipt(root, "goal", request.claim.claim_id), undefined);
    } finally { await cleanup(root); await cleanup(outside); }
  }
});

test("handoff replay authenticates a staged manifest, rejects conflict and tamper, and does not advance before write", async () => {
  const root = await activeHarness();
  try {
    const prepared = await claimed(root);
    const request = baseHandoff(prepared);
    const runRoot = await writeArtifacts(root, request);
    await assert.rejects(executeHandoff(root, request, { faultAt: "before_write" }), /pm_fault_before_handoff_write/);
    assert.equal(await readPmHandoffReceipt(root, "goal", request.claim.claim_id), undefined);
    await assert.rejects(executeHandoff(root, request, { faultAt: "after_artifact_before_finalize" }), /pm_fault_after_artifact_before_finalize/);
    const replay = await executeHandoff(root, request);
    assert.deepEqual(await executeHandoff(root, request), replay);
    const alternateOrigin = { ...request, worker_origin: { origin_id: "test-actors", record_id: "worker-record-2" } };
    await assert.rejects(executeHandoff(root, alternateOrigin), /pm_claim_conflict/);
    const conflicting = { ...request, handoff: { ...request.handoff, remaining_risks: ["conflict"] } };
    await assert.rejects(executeHandoff(root, conflicting), /pm_claim_conflict/);
    await fs.writeFile(path.join(runRoot, request.artifacts.output), "tampered", "utf8");
    await assert.rejects(executeHandoff(root, request), /pm_worker_origin_payload_invalid/);
  } finally { await cleanup(root); }
});

test("crash and timeout remain incomplete with High review classification and worker input has no lifecycle authority", async () => {
  for (const outcome of ["crashed", "timed_out"] as const) {
    const root = await activeHarness();
    try {
      const prepared = await claimed(root);
      const request = { ...baseHandoff(prepared), outcome };
      await writeArtifacts(root, request);
      const receipt = await executeHandoff(root, request);
      assert.equal(receipt.state, "incomplete");
      assert.equal(receipt.required_review_classification, "High");
      await assert.rejects(
        handoffPm({ ...request, cwd: root, complete_ticket: true } as typeof request & { complete_ticket: boolean }, signedHandoffDeps(request)),
        /pm_invalid_handoff_request/,
      );
    } finally { await cleanup(root); }
  }
});

test("a partial manifest write cannot advance the handoff receipt", async () => {
  const root = await activeHarness();
  try {
    const prepared = await claimed(root);
    const request = baseHandoff(prepared);
    await writeArtifacts(root, request);
    await assert.rejects(executeHandoff(root, request, { faultAt: "during_manifest_write" }), /pm_fault_during_manifest_write/);
    await assert.rejects(fs.access(pmHandoffReceiptPath(root, "goal", request.claim.claim_id)));
    assert.equal(await readPmHandoffReceipt(root, "goal", request.claim.claim_id), undefined);
  } finally { await cleanup(root); }
});

test("one authenticated prepare receipt durably binds exactly one worker claim", async () => {
  const root = await activeHarness();
  try {
    const prepared = await claimed(root);
    const first = baseHandoff(prepared);
    await writeArtifacts(root, first);
    await executeHandoff(root, first);

    const worker = { subject: "worker-2", run_id: "worker-run-2", session_id: "worker-session-2",
      capability: { id: "implementation", rank: 1 } };
    const second = {
      ...baseHandoff(prepared),
      worker_origin: { origin_id: "test-actors", record_id: "worker-record-2" },
      claim: {
        ...first.claim,
        claim_id: pmWorkerClaimId("goal", prepared, worker),
      },
    };
    const secondRoot = await writeArtifacts(root, second);
    await assert.rejects(executeHandoff(root, second, {}, worker), /pm_claim_conflict/);
    await assert.rejects(fs.access(path.join(secondRoot, ".pm-artifact-manifest.json")));
  } finally { await cleanup(root); }
});

test("prepare provenance replay preserves the stable worker claim and exact handoff replay", async () => {
  const root = await activeHarness();
  try {
    const prepared = await claimed(root);
    const request = baseHandoff(prepared);
    await writeArtifacts(root, request);
    const first = await executeHandoff(root, request);

    const provider: PmProvider = {
      async listCandidates() { throw new Error("prepare replay must use its authenticated snapshot"); },
      async annotate(candidateId, key, content) {
        return { id: "comment-1", issue_id: candidateId, key, content };
      },
    };
    const replayedPrepare = await preparePm({
      ...prepareRequest,
      cwd: root,
      run_id: "prepare-run-2",
      session_id: "prepare-session-2",
    }, { provider });
    assert.equal(replayedPrepare.receipt_id, prepared.receipt_id);
    assert.notEqual(replayedPrepare.protected_state_sha256, prepared.protected_state_sha256);
    assert.equal(pmWorkerClaimId("goal", replayedPrepare, testWorker), request.claim.claim_id);
    assert.deepEqual(await executeHandoff(root, request), first);

    const otherWorker = { subject: "worker-2", run_id: "worker-run-2", session_id: "worker-session-2",
      capability: { id: "implementation", rank: 1 } };
    const conflicting = {
      ...baseHandoff(replayedPrepare),
      worker_origin: { origin_id: "test-actors", record_id: "worker-record-2" },
      claim: {
        ...request.claim,
        claim_id: pmWorkerClaimId("goal", replayedPrepare, otherWorker),
      },
    };
    await writeArtifacts(root, conflicting);
    await assert.rejects(executeHandoff(root, conflicting, {}, otherWorker), /pm_claim_conflict/);
  } finally { await cleanup(root); }
});

test("exit status is strict and reconciled with the declared worker outcome", async () => {
  const root = await activeHarness();
  try {
    const prepared = await claimed(root);
    const request = baseHandoff(prepared);
    const runRoot = await writeArtifacts(root, request);
    await fs.writeFile(path.join(runRoot, request.artifacts.exit_status), "137\n", "utf8");
    await assert.rejects(executeHandoff(root, request), /pm_exit_status_mismatch/);
  } finally { await cleanup(root); }
});

test("artifact authentication detects same-size replacement with restored mtime between reads", async () => {
  const root = await activeHarness();
  try {
    const prepared = await claimed(root);
    const request = baseHandoff(prepared);
    const runRoot = await writeArtifacts(root, request);
    const output = path.join(runRoot, request.artifacts.output);
    const original = await fs.stat(output);
    let replaced = false;
    await assert.rejects(executeHandoff(root, request, {
      async afterArtifactFirstRead(kind) {
        if (kind !== "output" || replaced) return;
        replaced = true;
        const length = (await fs.readFile(output)).byteLength;
        const replacement = path.join(runRoot, "replacement.tmp");
        await fs.writeFile(replacement, "X".repeat(length), "utf8");
        await fs.rename(replacement, output);
        await fs.utimes(output, original.atime, original.mtime);
      },
    }), /pm_artifact_tampered/);
  } finally { await cleanup(root); }
});

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HARNESS_DIR_NAME } from "../state/paths.js";
import { readJsonIfExists, writeJsonAtomic } from "../state/io.js";
import { type CoordinationDeps, withCoordinationLease } from "./coordination.js";

export const MUTATION_ACTIONS = ["raised", "commented", "advanced", "blocked", "completed"] as const;
export type MutationAction = typeof MUTATION_ACTIONS[number];

export const MutationProofSchema = z.object({
  schema_version: z.literal(1),
  proof_id: z.string().regex(/^[0-9a-f]{64}$/),
  ticket_id: z.string().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
  action: z.enum(MUTATION_ACTIONS),
  outcome: z.enum(["success", "failed"]),
  run_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  session_sha256: z.string().regex(/^[0-9a-f]{64}$/),
  recorded_at: z.string().datetime(),
}).strict();

export type MutationProofRecord = z.infer<typeof MutationProofSchema>;

export interface MutationProofInput {
  root: string;
  runId: string;
  sessionId: string;
  ticketId: string;
  action: MutationAction;
  outcome?: "success" | "failed";
}

export interface MutationProofWriteResult {
  status: "written" | "replayed";
  proof: MutationProofRecord;
}

function sha(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function proofDigest(record: Pick<MutationProofRecord, "ticket_id" | "action" | "outcome" | "run_sha256" | "session_sha256">): string {
  return sha(JSON.stringify({
    ticket_id: record.ticket_id,
    action: record.action,
    outcome: record.outcome,
    run_sha256: record.run_sha256,
    session_sha256: record.session_sha256,
  }));
}

function storedProof(raw: unknown, expectedProofId: string): MutationProofRecord {
  const parsed = MutationProofSchema.safeParse(raw);
  if (!parsed.success || parsed.data.proof_id !== expectedProofId || proofDigest(parsed.data) !== parsed.data.proof_id) {
    throw new Error("invalid_stored_mutation_proof");
  }
  return parsed.data;
}

function directory(root: string): string {
  return path.join(root, HARNESS_DIR_NAME, "autonomy", "mutation-proofs");
}

export async function recordMutationProof(
  input: MutationProofInput,
  deps: CoordinationDeps = {},
): Promise<MutationProofWriteResult> {
  const run = sha(input.runId);
  const session = sha(input.sessionId);
  const outcome = input.outcome ?? "success";
  const proofId = proofDigest({ ticket_id: input.ticketId, action: input.action, outcome, run_sha256: run, session_sha256: session });
  const parsed = MutationProofSchema.safeParse({
    schema_version: 1,
    proof_id: proofId,
    ticket_id: input.ticketId,
    action: input.action,
    outcome,
    run_sha256: run,
    session_sha256: session,
    recorded_at: (deps.now ?? (() => new Date().toISOString()))(),
  });
  if (!parsed.success) throw new Error("invalid_mutation_proof");
  const file = path.join(directory(input.root), `${proofId}.json`);
  return withCoordinationLease(input.root, `mutation-${proofId.slice(0, 32)}`, async () => {
    const existingRaw = await readJsonIfExists<unknown>(file);
    if (existingRaw !== undefined) {
      return { status: "replayed", proof: storedProof(existingRaw, proofId) };
    }
    await writeJsonAtomic(file, parsed.data);
    const reread = storedProof(await readJsonIfExists<unknown>(file), proofId);
    return { status: "written", proof: reread };
  }, deps);
}

export async function readMutationProofs(root: string): Promise<MutationProofRecord[]> {
  const dir = directory(root);
  const names = await fs.readdir(dir).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? [] : Promise.reject(error));
  const records: MutationProofRecord[] = [];
  for (const name of names.filter((value) => /^[0-9a-f]{64}\.json$/.test(value)).sort()) {
    records.push(storedProof(await readJsonIfExists<unknown>(path.join(dir, name)), name.slice(0, -5)));
  }
  return records;
}

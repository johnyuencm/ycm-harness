# Portable autonomy operating policy

## Continuation decision table

| Observation | Required disposition |
| --- | --- |
| bounded read-only inspection; no action remains | report evidence; no ticket required |
| mutation completed in this run | update owning task/issue, attach proof, then live-read current state |
| actionable work remains or is deferred | create/reuse durable task/issue before final prose; live-read exact ID and objective |
| tracker unavailable | persist a recoverable pending record and retry by bounded policy; never call prose durable |
| duplicate candidate | reuse only after ID/content/owner/status readback proves it is the same current objective |
| mistaken reference | cancel/correct with supersession evidence; live-read it and its replacement; do not delete history |

A valid reference includes objective, acceptance, evidence, owner or owning phase, and next verification horizon. A title match or stale same-name ticket is insufficient.

## Cost and resource ladder

1. deterministic local script or schema check;
2. focused repository/wiki/ticket reads and existing tests;
3. reuse current durable evidence;
4. cheapest bounded synthesis capable of the remaining reasoning;
5. stronger model only for a demonstrated unresolved reasoning need.

Do not introduce an auxiliary LLM judge for deterministic continuation, health, or schedule checks. Retry at most three times with a changed approach; one bounded correction is the normal path. Script monitors stay LLM-free.

## Authority boundary

- Read within the selected repository/worktree and approved user surfaces.
- Write only the owning repository, harness state, authorized GitHub Issues/Projects updates (`gh`), or an explicitly authorized target.
- Ask for new authority before irreversible/destructive changes, credentials, private data, messaging other people, live trading, production changes, or materially broader external effects.
- For install/user-level projection, record the exact source, complete preimage, unrelated-file guard, rollback, and re-enable proof.
- Never overwrite unrelated dirty changes or edit installed plugin copies as the source of truth.

## Evidence and assurance

Use these labels honestly:

- **observed**: current evidence was read;
- **guidance**: policy text describes required behavior;
- **shadow**: a mechanism records a verdict but does not block delivery;
- **enforced**: the target-native mechanism blocks/corrects and its tests pass;
- **natural proof**: the installed lifecycle passed its required elapsed real cycles.

Guidance must not be reported as enforcement. A deed pointer is an evidence index, not truth; a ticket is coordination, not acceptance; delivery is not natural proof.

## Knowledge and memory boundary

- skills/references: procedural memory;
- project wiki: durable repository knowledge with provenance;
- tickets/evidence: transient work and current commitments;
- personal memory: only stable declarative preferences or durable environment facts after allow/deny/conflict filtering.

Never persist secrets, private identifiers/URLs, transcripts, ticket IDs, commit hashes, temporary progress, live-verification claims, source-only paths, or procedures better owned by a skill. Personal memory is not edited by the harness; exact authorized updates use the host memory workflow and a reversible correction.

## Phase 1 exclusions

This baseline does not implement deed telemetry, automatic follow-up raising, startup scouting, continuation-ledger enforcement, schedules, PM/reviewer jobs, strategic-review runtime, knowledge promotion, watchdogs, optional-domain execution, Git enforcement, or natural-cycle promotion. Those mechanisms belong to Phase 2 through Phase 7 and require their own workflow, tests, live tickets, rollback, and independent acceptance.

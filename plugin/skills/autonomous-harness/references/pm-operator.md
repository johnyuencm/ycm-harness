# Daily PM operator runbook

The installed `ycm-harness autonomy pm` family owns durable prepare, handoff,
review, and status receipts. It does not own a scheduler, delivery channel, or
ticket lifecycle transition.

## Enablement and authority

1. Build and project the checked-in package; never edit an installed plugin
   cache as the source of truth. Verify the projection from a fresh process.
2. Keep the active goal pinned to its live-read coordination binding. `prepare`
   may add its content-addressed brief annotation, and `review` may add the one
   bounded disposition required by its authenticated findings. Workers cannot
   complete/block tickets, mutate schedules, deliver messages, handle unsafe
   authority, or rewrite Git history.
3. Select workers by the smallest sufficient structured capability `{ id,
   rank }`, not a time-sensitive model name. A correction uses the same
   capability class at equal or greater rank and converges on one root-cause
   reference.

PM worker files live under the content-addressed
`.ycm-harness/autonomy/pm/runs/pm-run-<24-lowercase-hex>/` returned by the
`pmWorkerRunRoot` helper. The repository ignore rules must exclude
`.ycm-harness/`. Prompt, output, exit status, and meaningful log must be
distinct relative regular files. Path traversal, symlinks, secrets, invalid
UTF-8, empty required artifacts, per-file sizes over 1 MiB, and totals over
2 MiB fail closed before receipt advancement.

The installed canary does not publish mutable receipt files directly. It stages
each logical `prepare`, `claims`, singular `handoff`, singular `review`, `gaps`,
and `gates` value as
`.ycm-harness/autonomy/pm/staging/<claim-id>/records/pm-record-<32-lowercase-hex>-<64-lowercase-hex>.json`.
One `.ycm-harness/autonomy/pm/commits/pm-commit-<32-lowercase-hex>.json`
commit index authenticates every record version, maps the current logical keys,
and binds the four artifact hashes. `pmHandoffReceiptPath` and
`pmReviewReceiptPath` name the singular logical stores; replay reads them
through that index.

## Daily sequence and recovery

- `autonomy pm prepare --file request.json` selects zero or one eligible root
  and persists the complete brief before its exact provider annotation.
- Run the bounded worker outside the PM module and write only the declared
  artifact files. The handoff request carries only opaque `worker_origin:
  {origin_id, record_id}`. The installed `config/pm-actor-origins.json` pins the
  record root and Ed25519 public key; no private key ships. Its signed canonical
  record supplies the worker role, subject/run/session, capability, exact
  goal/parent/ticket/prepare/claim scope, and complete artifact/handoff payload
  commitment. Missing, forged, raced, noncanonical, or mismatched records fail
  before claim or receipt advancement.
- Legacy v1 and v2 installed-canary reports remain byte-retained for audit. The
  v3 canary uses the `installed-no-delivery-v3` invocation identity and replays
  only its exact claim, so it creates a distinct immutable chain without
  accepting or rewriting either legacy generation. Its internal actors are
  explicitly `manual_local_double`; they are never promoted to installed-key
  assurance, and the gate remains honest `PARTIAL` manual evidence.
- A different reviewer calls `autonomy pm review --file request.json` with only
  `reviewer_origin: {origin_id, record_id}`. Review reauthenticates the stored
  worker record, rejects record or normalized identity reuse, reopens the live
  ticket, artifact hashes, and Phase 4 proof, then verifies the reviewer-signed
  exact manifest, verdict, findings, Phase 4 result, and live target before any
  mutation. Worker prose is not acceptance evidence.
- `autonomy pm status --file request.json` without `--record-gap` is read-only.
  `--record-gap` is the sole bounded, idempotent local receipt mutation: it
  creates or reuses one gap receipt. Neither path repairs or mutates provider or
  scheduler state. A `mutation_uncommitted` result names the owning command;
  rerun only that command with the original producer slot and invocation key so
  it can reconcile exact provider readback. Status rereads and verifies both
  actor records and rejects any disappearance, replacement, or payload change.

Receipts are content-addressed and replay-safe. A crash before commit-index
publication exposes no logical receipt chain. An exact staged prefix can resume;
a conflicting input, stage inventory, commit index, digest, identity,
provenance, live reference, or artifact fails closed. Retain the original files
and use the reported stable reason code; do not delete or rewrite audit history
to recover.

## Manual and natural evidence

A local no-delivery cycle is `manual` evidence even when every receipt and test
passes. Build the package and compare a fresh-process call to
`runPmInstalledManualCanaryTrace` from `dist/index.js` with the installed
operator output. Source parity calls the source runtime directly; the source
checkout's `plugin/scripts/pm-installed-canary.mjs` is not an operator
entrypoint and has no fallback into the source tree.

From an installed Cursor projection, run the installed operator with the
canonical active-goal root explicitly pinned:

```sh
node /absolute/plugin-root/scripts/pm-installed-canary.mjs --root /absolute/canonical/project-root
```

The script resolves only `<plugin-root>/runtime/dist/index.js`. A missing,
non-regular, symlinked, or escaped runtime and a symlinked script layout fail
closed with `pm_canary_runtime_missing`; there is no sibling checkout fallback.
Its JSON has `commands.prepare`, `commands.handoff`, `commands.review`, and
`commands.status`, containing the exact successful shared-function results,
plus `report` with the prepare, handoff, review, and gap receipt IDs and the
content-addressed gate report ID. The logical gate path is
`.ycm-harness/autonomy/pm/gates/<report-id>.json` in the authenticated commit
index. The report explicitly says `manual_local_provider` and
`deterministic_local_double`; the runner has no GitHub tracker, scheduler, delivery, or
ticket-lifecycle adapter. Repeating the command authenticates and returns the
same JSON, paths, bytes, hashes, and mtimes without adding files.

Do not clean these records from a canonical goal: retention is the rollback and
audit policy. Cleanup is appropriate only for an intentionally disposable test
root, by deleting that whole test root after evidence is no longer needed.

To evaluate the operational gate, request `evidence_requirement:
"natural"` and use `status --record-gap`. Raw or synthetic scheduler files can
never promote the gate. Only a pre-existing persisted scheduler record returned
through the authenticated scheduler-reader dependency, bound to this exact PM
review chain, local date, authoritative timezone, 09:00 prepare slot, 17:00
review-completion slot, scheduled trigger, and `local_no_delivery`, may produce
`verified_natural` and a P5-E `PASS` gate report.

When that trusted record is absent, `--record-gap` creates or reuses one local
tamper-evident gap receipt. The canonical P5-E report is `PARTIAL`, points to the
gap receipt, and leaves any existing scheduler/tracker state untouched.

## Disable and rollback

Disable the caller's PM enforcement invocation (stop issuing new prepare/review
mutations) while leaving the command family and `.ycm-harness/autonomy/pm/`
receipts readable for audit and recovery. Re-enable only from the canonical
package after projection parity and the failing reason has been independently
verified. Do not delete provider annotations, gap receipts, or actor-origin audit records.

Phase 6 owns strategic nightly learning and knowledge promotion. Phase 7 owns
scheduler lifecycle integration, delivery/runtime watchdogs, three-natural-cycle
promotion, optional-domain execution, Git closeout, and final handoff. None is
implemented or implied by this Phase 5 surface.

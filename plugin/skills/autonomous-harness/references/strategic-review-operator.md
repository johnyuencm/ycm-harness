# Phase 6 strategic review operator runbook

The installed `ycm-harness autonomy review|action|promotion` family owns
evaluate, apply, promote, and status for the universal strategic learning loop.
It does not own a scheduler, delivery channel, provider lifecycle, merge, push,
commit, or Git-history mutation. Manual proof is always labeled manual and is
never natural schedule evidence.

## Four installed profiles

Installation-owned profile configuration lives in
`config/strategic-review-profiles.json`. Profiles cannot expand their own
capabilities through a report body or operator input.

| Profile | Domain | Default |
| --- | --- | --- |
| `pm-17:00` | product-management | enabled |
| `nightly-workspace` | workspace | enabled |
| `operations-cron-output` | operations | enabled |
| `optional-domain` | optional-domain | disabled until enrolled |

Each profile carries the fixed capability set: ticket reuse/create, ticket
comment, ticket priority, installed-loop pause, and compensating rollback.
Authority proofs are installation-owned
(`strategic-review/v1/<profile>/<domain>` and
`strategic-action/v1/<profile>/<domain>`).

## Bounded-snapshot exemption

`mode: bounded_snapshot` is an explicit read-only exemption. It authenticates
evidence, returns a content-addressed SNAPSHOT report, and performs zero
mutation. Snapshot reports cannot authorize apply, promote, pause, or rollback.

## Evidence classes

Evidence references classify as `FACT`, `INFERENCE`, `UNKNOWN`, or
`UNAVAILABLE`. Fabricated FACT claims, authority expansion, and unavailable
required evidence fail closed with stable reason codes (`PARTIAL` or
`BLOCKED`).

## Authority boundaries

- Reports do not grant authority. Reauthenticate installation-owned profile
  capabilities independently before apply or promote.
- Protected selectors (code edit, credentials, publish, payment, destructive,
  schedule, delivery, provider-lifecycle, merge, push, commit, history) are
  structurally absent, not prompt-denied.
- Optional-domain remains unauthorized until the installation enrolls it.

## evaluate / apply / promote / status

1. `autonomy review evaluate --file request.json` — universal review for one
   enrolled profile (normal or bounded_snapshot).
2. `autonomy action apply --file request.json` — authenticated ticket steering,
   pause, or compensating rollback under the fixed capability set.
3. `autonomy promotion promote --file request.json` — later-worker, ticket-first
   knowledge promotion only.
4. `autonomy review|action|promotion status|replay --file request.json` —
   read-only status and exact replay. Replay preserves tracked references and
   never duplicates mutation or knowledge events.

## Outage, replay, pause, rollback

- Provider, evidence, or readback outages stop honestly at `PARTIAL` or
  `BLOCKED`. The loop never invents Phase 7 schedule behavior.
- Replay returns the same content-addressed receipt identity with
  `mutation_count: 0`.
- `installed_loop_pause` freezes the unsafe installed loop while retaining
  reports, receipts, and logs.
- `rollback` is compensating and append-only: restore the last authenticated
  safe loop state or keep the loop disabled.

## Knowledge-promotion rules

- Ticket-first: a live durable promotion ticket linked to accepted action
  evidence is required.
- Later-worker only: the promoter must be distinct from and later than the
  producer.
- Promote reusable process lessons with provenance, raw immutability, curated
  metadata, index/log/query/lint, and no secret or volatile leakage.
- Do not promote raw daily outputs, rolling monitors, scheduler metadata,
  credentials, ticket-prose-only follow-ups, or unverified claims.
- Promotion and rollback never commit, push, merge, rewrite history, or write
  global memory.

## Manual canary

`plugin/scripts/strategic-installed-canary.mjs` (and the source runtime export
`runStrategicInstalledManualCanaryTrace`) demonstrates the four profiles, one
bounded snapshot with zero mutation, ticket steering, pause, rollback, one
later-worker promotion, status, and exact replay. The report is explicitly
`manual_local_provider` / non-natural and records
`schedule_mutations: 0`, `deliveries: 0`.

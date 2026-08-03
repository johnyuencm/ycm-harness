---
name: ycm-harness-work
description: Coordinate long-running coding work with lean ycm-harness goals, tickets, checkpoints, submitted-state verification, and durable project knowledge.
---

# ycm-harness work

Use the lean 0.3 CLI as a coordination ledger. The harness records work; it
does not replace reading the code, making a focused change, or running the
project's real checks.

## Start or resume

1. Run `ycm-harness status` and `ycm-harness next`.
2. If state is absent, run `ycm-harness init`.
3. Create or activate one goal. Use the local backend unless the user or
   repository requires an existing GitHub parent issue and Project.
4. Create bounded tickets with observable acceptance criteria and dependencies.
5. For high-assurance work, run `ycm-harness goal worktree init` before starting
   a ticket.

## Execute

For each actionable ticket:

1. `ycm-harness ticket start <id>`
2. Inspect the real code path and implement the smallest complete change.
3. Run focused checks while iterating.
4. Record durable decisions, blockers, or compaction boundaries with
   `ycm-harness checkpoint`.
5. Commit the coherent submitted state when the repository workflow expects it.
6. `ycm-harness ticket submit <id>`

Do not change code or acceptance criteria after submission without submitting
again.

## Verify and complete

Run verification from a verifier context distinct from the implementer:

```bash
ycm-harness verify run \
  --ticket <id> \
  --command "<real project verification command>" \
  --implementer-run <id> \
  --verifier-run <different-id> \
  --knowledge none
```

The command must exercise the submitted behavior. Fix failures, rerun project
checks, submit again, and obtain fresh verification. Use `ticket done` only
when fresh passing evidence exists.

When every ticket is done or cancelled:

```bash
ycm-harness goal verify <goal-id>
ycm-harness goal complete <goal-id>
```

## Durable knowledge

Record only reusable contracts, decisions, environment facts, and root causes:

```bash
ycm-harness wiki durable --id <slug> --title "<title>" \
  --trigger <contract|decision|environment|root-cause> \
  --body-file <path>
```

Never put credentials, private identifiers, personal paths, or transient task
progress in durable knowledge.

## Boundaries

- Do not hand-edit `.ycm-harness/` state or generated wiki indexes.
- Do not fabricate verification evidence or reuse the implementer as verifier.
- Do not use retired phase, review, ritual, session, artifact, commit,
  user-wiki, or caveman commands.
- Ask before destructive or irreversible actions the user did not authorize.

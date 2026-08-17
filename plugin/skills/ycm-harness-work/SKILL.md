---
name: ycm-harness-work
description: Coordinate long-running coding work with lean ycm-harness goals, tickets, checkpoints, submitted-state verification, and durable project knowledge.
---

# ycm-harness work

The harness is a **coordination ledger for a strong agent** (Opus-class). It
records goals, tickets, and proof so work survives context loss. It does not
replace reading the code, making a focused change, or running the project's
real checks. Do not walk retired phase/ritual SOPs. Do not invent extra
reviewers beyond the named panel or a review JSON file.

Enter after `ycm-harness-design` or when resuming an existing goal. Use the
strongest available model for implementation **and** for the independent
review panel.

## Start or resume

If the CLI resolves through an npm link to a moved checkout, do not recreate the stale path. Use shell-appropriate executable lookup, inspect npm's active global prefix, relink only the current checkout, and verify with `ycm-harness --help` rather than `--version`; never record machine-specific absolute paths.

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

## Independent review

Dispatch a fresh-context **review panel** in one parallel turn. None of these
agents may be the implementer. Prefer a different model family. Each follows
`plugin/agents/<role>.md`:

- `tech_lead` — architecture, correctness, tests, ops, security
- `spec_reviewer` — every acceptance criterion vs code and evidence
- `user_advocate` — live operator value and job-to-be-done
- `uiux` — Shneiderman / modern usability; always `kimi-k3-high`; pairs with `user_advocate`
- `project_manager` — goal alignment and honest done-state

Panel PASS requires every reviewer PASS and no unresolved high findings.
Never self-score. Full findings go in `artifacts/review-<role>-<ticket>.md`.
Max **3** fix rounds (implementer fix → submit again → fresh panel).

Do not run `ycm-harness review *` (deprecated exit-2 alias). Do not write
`review-combined.json` or any harness review evidence file. Do not dispatch
`combined_reviewer` (retired). Optional durable note after PASS: `checkpoint`
or `wiki durable`.

Kernel proof (same command as verify below): `ticket submit` then `verify run`
with distinct implementer vs verifier run IDs. Inspect with `verify verdict` /
`verify status`.

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

## Depth (optional, when sibling files exist)

Skip any file that is missing (public install ships `SKILL.md` +
`github-tickets.md` only). These are lookup, not a second SOP:

- `review-fix-loop.md` — independent review dispatch
- `execute-agents.md` — implementer + acceptance verifier
- `commander-dispatch.md` — model tier and done bar
- `context-index.md` — when to read other siblings
- `orchestrator-checklist.md` — close-out scan
- `autonomy.md` — what to do without asking
- `commands.md` — live 0.3 CLI
- `github-tickets.md` — GitHub mirror
- `anti-stop.md` — do not stop after execute

## Boundaries

- Do not hand-edit `.ycm-harness/` state or generated wiki indexes.
- Do not fabricate verification evidence or reuse the implementer as verifier.
- Do not use retired phase, review, ritual, session, artifact, commit,
  user-wiki, or caveman commands.
- Ask before destructive or irreversible actions the user did not authorize.

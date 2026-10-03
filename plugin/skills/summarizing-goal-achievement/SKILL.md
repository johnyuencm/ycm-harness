---
name: summarizing-goal-achievement
description: >-
  Use when a ycm-harness goal has finished, or when the user asks
  what was achieved, what now, ticket status, how much shipped, or how well the
  harness run went after finish bookkeeping.
---

# Summarizing goal achievement

Closing report for a finished harness goal. Evidence only — no invented scores.

**When:** after finish bookkeeping (wiki durable if needed, GitHub Issues, architecture, worktree finish, checkpoint, goal complete), or when the user asks for the same retrospective.

## Evidence

```bash
ycm-harness status
ycm-harness goal status --json
ycm-harness ticket list
ycm-harness verify status
ycm-harness verify verdict
```

Also: named blockers, `.ycm-harness/followups.md` if present, GitHub follow-ups.

Do not run `ycm-harness review *`, `phase list`, `ritual status`, or
`smoke verify --phase`. Independent review findings live in the review-panel
artifact files. Kernel proof is `ticket submit` + `verify run` with distinct
implementer vs verifier run IDs.

## Report (exact headings, in order)

1. **Achieved so far** — shipped tickets/worktree; name anything not done.
2. **What now** — follow-ups, deferred findings, human blockers, open merge/PR; or one line “nothing left”.
3. **Tickets — status now** — one line each: id, title, terminal status, verify run IDs if present.
4. **How much we achieved** — counts (`7/8 tickets`), acceptance covered vs open — not “mostly”.
5. **How well we achieved** — independent review panel PASS/FAIL, fresh verify evidence, named leftovers; no fake letter grades.

Write the report in ASD-STE100 Simplified Technical English.

## Visual report

When the goal has 3+ tickets or changed the architecture, also make
`artifacts/goal-report-<goal-id>.html` with the `explainer` skill. Contents, same evidence as above:

- Verdict and the five sections above.
- Ticket board: one card per ticket with status and verify run IDs.
- Before/after diagram of the parts the goal changed.
- Leftovers and blockers in a separate, visible box.

Commit and push it, then put its path in **Achieved so far**. Make an explainer video only when the user asks.

## Rules / red flags

- Unknown → say **unknown** + which command failed. Never hide blockers inside “achieved”.
- Complements GitHub parent summary; does not replace it.
- Skip this after `ycm-harness-work` finish = violation. “Complete” with unowned leftovers in §2 = violation. Ungrounded % scores = violation.

---
name: summarizing-goal-achievement
description: >-
  Use when a ycm-harness goal has finished all phases, or when the user asks
  what was achieved, what now, phase status, how much shipped, or how well the
  harness run went after finish bookkeeping.
---

# Summarizing goal achievement

Closing report for a finished harness goal. Evidence only — no invented scores.

**When:** after finish bookkeeping (progress, wiki, GitHub Issues, architecture, worktree finish, checkpoint, finish complete), or when the user asks for the same retrospective.

## Evidence

```bash
ycm-harness goal status --json
ycm-harness phase list
ycm-harness task list
ycm-harness ritual status --json
ycm-harness smoke verify --phase <validate-phase-id>
```

Also: `progress` + plan artifacts, review gate, GitHub follow-ups, `.ycm-harness/followups.md`, named blockers.

Phase purpose cheat-sheet (status from CLI): explore=lock codebase; discuss=grill ambiguity; design=architecture; plan=impl+test plan; execute=Ralph/T5+smoke; validate=full bar+review; finish=wiki/follow-ups/merge-ready.

## Report (exact headings, in order)

1. **Achieved so far** — shipped tasks/artifacts/worktree; name anything not done.
2. **What now** — follow-ups, deferred findings, human blockers, open merge/PR; or one line “nothing left”.
3. **Phases — purpose and status now** — one line each explore→finish (purpose + CLI status).
4. **How much we achieved** — counts (`7/8 tasks`), acceptance covered vs open — not “mostly”.
5. **How well we achieved** — T5, smoke, review/fix-loop, ritual gaps; no fake letter grades.

## Rules / red flags

- Unknown → say **unknown** + which command failed. Never hide blockers inside “achieved”.
- Complements GitHub parent summary + `progress` artifact; does not replace them.
- Skip this after `ycm-harness-work` finish = violation. “Complete” with unowned leftovers in §2 = violation. Ungrounded % scores = violation.

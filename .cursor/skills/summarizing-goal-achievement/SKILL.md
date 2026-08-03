---
name: summarizing-goal-achievement
description: >-
  Use when a ycm-harness goal has finished all phases, or when the user asks
  what was achieved, what now, phase status, how much shipped, or how well the
  harness run went after finish bookkeeping.
---

# Summarizing goal achievement

Closing report for a finished harness goal. Ground every claim in CLI/state evidence. Do not invent coverage or quality scores.

**REQUIRED:** Run this only after finish bookkeeping is done (progress, wiki, GitHub Issues, architecture pass, worktree finish, final checkpoint, finish phase complete) — or when the user asks for the same retrospective mid/post-goal.

## Evidence first

Collect (or reuse just-collected) facts:

```bash
ycm-harness goal status --json
ycm-harness phase list
ycm-harness task list
ycm-harness ritual status --json
ycm-harness smoke verify --phase <validate-phase-id>
```

Also read: registered artifacts (`progress`, PRD/design/plans), review gate outcome, GitHub follow-ups, `.ycm-harness/followups.md`, and any blocked/deferred items named in the session.

## Output (user-facing — exact sections, in order)

Emit one report with these headings only:

### 1. Achieved so far
What shipped for this goal: tasks done, key artifacts, commits/worktree outcome. Name anything **not** done.

### 2. What now
Immediate leftovers: GitHub follow-ups, deferred findings, human-only blockers, merge/PR only if still open. If nothing remains, say so in one line.

### 3. Phases — purpose and status now
One short line per phase (explore → discuss → design → plan → execute → validate → finish):

| Phase | Purpose (one clause) | Status now |
|-------|----------------------|------------|
| explore | Lock what exists before debate | complete / skipped-blocked / … |
| discuss | Remove ambiguity (`grill-with-docs`) | … |
| design | Architecture + interfaces | … |
| plan | Implementation + test plan + tasks | … |
| execute | Ralph/TDD build with T5 + smoke | … |
| validate | Full bar + review gate | … |
| finish | Wiki, follow-ups, merge readiness | … |

Purpose text may be paraphrased; status must match harness state.

### 4. How much we achieved
Completeness against the goal: tasks done vs blocked/cancelled, acceptance criteria covered vs open, follow-ups filed. Prefer counts (`7/8 tasks done`) over vague “mostly”.

### 5. How well we achieved
Quality signals only: T5 acceptance evidence, full smoke pass/fail, review gate + fix-loop rounds, wiki/ritual gaps, honesty about shortcuts. No fake grades (no “A+” without evidence).

## Rules

- Evidence > narrative. If status is unknown, say **unknown** and which command failed.
- Do not hide blocked/deferred work inside “achieved”.
- Keep it scannable; no phase essay, no re-litigating the whole PRD.
- This report is the finish closing message — do not replace GitHub parent summary or the `progress` artifact; complement them.

## Red flags

- Ending finish without this report when `ycm-harness-work` ran finish
- Claiming “complete” while section 2 still lists unowned leftovers
- Percentage scores with no task/smoke/review basis

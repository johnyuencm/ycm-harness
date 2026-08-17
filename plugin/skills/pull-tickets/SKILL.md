---
name: pull-tickets
description: >-
  Pull agent-eligible open issues and PRs from the tracker, rank the frontier,
  claim the top three, and implement or review each via ycm-harness-work-lite.
  Use for /pull-tickets, backlog execution, or PR review when not ready-for-human.
disable-model-invocation: true
---

# Pull Tickets

Pull the **agent frontier**, prioritize, work the top **3** via **`ycm-harness-work-lite`**, then close issues or leave PR review evidence.

## Agent eligibility (default policy)

**In scope:** any open **issue** or **PR** that does **not** carry `ready-for-human`.

**Out of scope:** anything labeled `ready-for-human` (device validation, ops, secrets, vendor decisions, human merge approval).

`ready-for-agent` is a strong positive signal but **not required**. Unlabeled issues and draft PRs are eligible unless `ready-for-human`.

**Compose with (not duplicate):** `to-tickets`, `create-github-tickets`, `triage`, `wayfinder`, **`ycm-harness-work-lite`**.

**Do not** use bare `implement`, full `ycm-harness` goals/worktrees, or orchestrator-authored product code.

## Tracker setup

1. Read project tracker docs when present: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`.
2. Else read `plugin/skills/ycm-harness-work/github-tickets.md` for `gh` conventions.
3. Run `gh` inside the target repo clone; infer owner/repo from `git remote -v`.

## Invocation args (optional)

| Arg | Effect |
| --- | --- |
| `#81` / parent URL | Scope to epic children (`Part of #81` or sub-issues) |
| `issues-only` | Skip open PRs |
| `prs-only` | Only open PRs |
| `limit:N` | Items to work (default **3**) |
| `dry-run` | Rank only |

## Phase 1 — Pull

1. `gh auth status` — stop if not authenticated.
2. **Issues:** `gh issue list --state open` (add `--label` only when user scoped a label).
3. **PRs:** `gh pr list --state open` unless `issues-only`.
4. Fetch `number`, `title`, `body`, `labels`, `assignees`, `createdAt`, `updatedAt`, `issue_dependencies_summary`; for PRs also `isDraft`, `reviewDecision`, `additions`, `deletions`.
5. **Drop:** `ready-for-human`; `wontfix`; assigned to someone else (unless overruled); open issue blockers.
6. Tag each survivor `kind: implement` (issue) or `kind: review` (PR).
7. `gh issue view` / `gh pr view` when criteria or test plan are thin.

## Phase 2 — Prioritize

Score all survivors. Higher wins. Ties: lower number, then older `createdAt`.

| Signal | Points |
| --- | --- |
| User named item/parent in invocation | +100 |
| `ready-for-agent` label | +50 |
| `kind: review` (open PR) | +45 |
| `bug` or fix/regression in title/body | +40 |
| Unblocks other frontier items | +30 per dependent (cap +60) |
| Small diff / UI / copy-only | +20 |
| User-reported pain this session | +50 |
| Large feature / migration | −30 |
| Assignee @me | +10 |

Take top `limit`. Present table with `kind` column. **`dry-run`** stops here.

## Phase 3 — Claim

```bash
gh issue edit <n> --add-assignee @me   # issues
gh pr edit <n> --add-assignee @me      # PRs
```

## Phase 4 — Work via ycm-harness-work-lite

Orchestrator only. One lite run per item.

### `kind: implement` (issue)

Hand lite: issue link, acceptance criteria, done-when, workspace = repo root.

Follow `plugin/skills/ycm-harness-work-lite/SKILL.md`. After PASS: comment; close when criteria met.

### `kind: review` (PR)

Hand lite: PR link, `gh pr diff <n>`, author test claims, done-when = independent review panel PASS (`tech_lead` + `spec_reviewer` + `user_advocate` + `project_manager`).

Checkout PR branch → verify on branch → **review panel** on diff → fix-loop if needed → report.

After PASS: `gh pr comment` with verdict + verify; optionally `--add-label ready-for-agent`. Do not merge unless user asked.

## Phase 5 — Session report

Table with `kind`, status, evidence. List remaining frontier.

## Parallelism

Sequential by default. Multitask only when user asks and items touch disjoint files.

## Stop conditions

Ask when nothing eligible; merge/deploy required; verify fails twice; destructive git not requested.

## Examples

- **`/pull-tickets`** — top 3 agent-eligible issues + PRs.
- **`/pull-tickets prs-only`** — review open PRs.
- **`/pull-tickets dry-run`** — ranked frontier only.

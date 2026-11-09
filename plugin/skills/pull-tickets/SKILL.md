---
name: pull-tickets
description: >-
  Pull every pending GitHub task (open issues, open PRs that need a review or a
  fix, and GitHub Project backlog items) across the user's repos, rank them by
  one priority score, claim the top three, and work each via ycm-harness-work-lite.
  Use for /pull-tickets, backlog execution, PR review or PR fixes when not ready-for-human.
disable-model-invocation: true
---

# Pull Tickets

Pull the **agent frontier** from every pending source on GitHub, prioritize it as one list, work the top **3** via **`ycm-harness-work-lite`**, then close issues, fix or review PRs, and move Project items.

```text
sources: issues  ─┐
         PRs     ─┼─► drop ready-for-human / blocked ─► score ─► top N ─► claim ─► lite run each ─► report
         Project ─┘                                                    (implement | review | fix-pr)
```

## Agent eligibility (default policy)

**In scope:** any open **issue**, open **PR**, or open **GitHub Project item** (including draft items) that does **not** carry `ready-for-human`.

**Out of scope:** anything labeled `ready-for-human` (device validation, ops, secrets, vendor decisions, human merge approval).

`ready-for-agent` is a strong positive signal but **not required**. Unlabeled issues and draft PRs are eligible unless `ready-for-human`.

**Compose with (not duplicate):** `to-tickets`, `create-github-tickets`, `triage`, `wayfinder`, **`ycm-harness-work-lite`**.

**Do not** use bare `implement`, full `ycm-harness` goals/worktrees, or orchestrator-authored product code.

## Tracker setup

1. Read project tracker docs when present: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`.
2. Else read `plugin/skills/ycm-harness-work/github-tickets.md` for `gh` conventions.
3. **Scope.** When the request or the routine prompt names one repository (for example "Repository: OWNER/REPO"), scope is that repository only; this keeps single-repo routines single-repo. Otherwise the default scope is every non-archived repo owned by the authenticated user (`gh api user -q .login`) and by each of that user's orgs (`gh api user/orgs -q ".[].login"`). With the `here` arg inside a repo clone, scope is that repo only (owner/repo from `git remote -v`). Archived repos are always out of scope.
4. Work each item inside a local clone of its repo. Look for the clone under the workspace root first; run `gh repo clone` only when none exists.

## Invocation args (optional)

| Arg | Effect |
| --- | --- |
| `#81` / parent URL | Scope to epic children (`Part of #81` or sub-issues) |
| `here` | Only the repo of the current clone |
| `repo:OWNER/REPO` / `owner:NAME` | Only that repo, or only that owner's repos |
| `project:OWNER/N` | Only items of that GitHub Project |
| `issues-only` | Skip open PRs and Project drafts |
| `prs-only` | Only open PRs |
| `backlog-only` | Only GitHub Project items |
| `limit:N` | Items to work (default **3**) |
| `dry-run` | Rank only |

## Phase 1 — Pull

1. `gh auth status` — stop if not authenticated. Project items need the `project` scope. If it is missing, say so and continue without Project items (`gh auth refresh -s project` is a human step).
2. **Issues:** for each owner in scope, `gh search issues --owner <owner> --state open --archived=false --limit 200 --json repository,number,title,labels,assignees,createdAt,updatedAt,url` (add `--label` only when the user scoped a label). In `here` scope use `gh issue list --state open`.
3. **PRs:** unless `issues-only`, `gh search prs --owner <owner> --state open --archived=false --json repository,number,title,labels,isDraft,author,url`, plus `gh search prs --review-requested @me --state open` for PRs in other owners' repos that wait on you. In `here` scope use `gh pr list --state open`. For each PR read `gh pr view <n> -R <repo> --json statusCheckRollup,mergeable,reviewDecision,headRefOid,additions,deletions`.
4. **Project backlog:** unless `issues-only` or `prs-only`, for each owner run `gh project list --owner <owner> --format json`, then `gh project item-list <N> --owner <owner> --format json --limit 500`. Keep items whose Status is not Done or Closed. Read the `Priority`, `Status`, `Size` and iteration fields when present. A Project item that points at an issue or PR merges with that issue or PR (one entry, fields combined). A draft item becomes its own `kind: implement` entry.
5. Fetch `number`, `title`, `body`, `labels`, `assignees`, `createdAt`, `updatedAt`, `issue_dependencies_summary`; for PRs also `isDraft`, `reviewDecision`, `additions`, `deletions`.
6. **Drop:** `ready-for-human`; `wontfix`; assigned to someone else (unless overruled); open issue blockers.
7. **PR frontier filter (never skip).** Select PR review targets with `node <this skill dir>/frontier.mjs --repo OWNER/REPO --records-dir <checkout of the default branch>`. It reads `record-globs.json` next to it, and applies two rules:
   - **Record PR:** a PR whose changed files ALL match `record-globs.json` is a record PR. Classify by changed files, never by branch name (`claude/pull-tickets-run-*` is also used for real work). Record PRs are never `kind: review`. List them for merge ordering only. A PR that mixes one work file (for example an executable `artifacts/verify-*.sh`) with records is a work PR and gets a normal review.
   - **Recorded tip:** skip a PR whose head SHA already has a record (merged records in `--records-dir`, plus the records of open record PRs). An unchanged tip is never re-reviewed.
8. Tag each survivor:
   - `kind: implement` — an issue or a Project draft item.
   - `kind: review` — a PR from the filter's `review-eligible` list with no passing review yet.
   - `kind: fix-pr` — a PR (yours or agent-authored) with failing checks, merge conflicts, or `reviewDecision: CHANGES_REQUESTED`. Fix it on its branch. Never force-push someone else's branch.
   - `kind: decide` — the item needs an owner decision. Do not work it; list it in the report.
9. `gh issue view` / `gh pr view` when criteria or test plan are thin.

**Fail closed.** If `frontier.mjs` exits non-zero (missing or malformed `record-globs.json`, `gh` failure, unreadable `--records-dir`), do not guess record PRs from branch names or titles and do not skip anything: treat every open PR as `kind: review`-eligible and say so in the session report.

`record-globs.json` is the single list. Keep it equal to the `pull_request` `paths-ignore` in the target repo's `ci.yml`, its `docs-fragments.yml` `paths`, and the guard regex there. `tests/pull-tickets-frontier.test.ts` fails when they differ.

## Phase 2 — Prioritize

Score all survivors. Higher wins. Ties: lower number, then older `createdAt`.

| Signal | Points |
| --- | --- |
| User named item/parent in invocation | +100 |
| `security` label or advisory, or `P0` / `priority: critical` | +80 |
| Project `Priority` field: P0/Urgent +80, P1/High +50, P2/Medium +20 | per field |
| `P1` / `priority: high` label (when no Project field) | +50 |
| `kind: fix-pr` (red CI, conflicts, changes requested) | +60 |
| Milestone or iteration due within 7 days | +40 |
| `ready-for-agent` label | +50 |
| `kind: review` (open PR) | +45 |
| `bug` or fix/regression in title/body | +40 |
| Unblocks other frontier items | +30 per dependent (cap +60) |
| Small diff / UI / copy-only | +20 |
| User-reported pain this session | +50 |
| Large feature / migration | −30 |
| Assignee @me | +10 |
| Project Status `In progress` | +15 |
| `P3` / `priority: low` label or field | −20 |

Take the top `limit` across all repos. Present one table with `repo`, `#`, `kind`, `score` and the signals that scored. **`dry-run`** stops here.

## Phase 3 — Claim

Run each claim in the item's repo (`-R OWNER/REPO`). For a Project item, also set Status to In progress with `gh project item-edit` when the Project has a Status field.

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

Hand lite: PR link, `gh pr diff <n>`, author test claims, done-when = two-phase review PASS (`tech_lead` × `project_manager` debate, then `user_advocate` last).

Checkout PR branch → verify on branch → **review panel** on diff → fix-loop if needed → report.

After PASS: `gh pr comment` with verdict + verify; optionally `--add-label ready-for-agent`. Do not merge unless user asked.

**Every review record names the head it reviewed**, so the next run can skip an unchanged tip. Put this front matter at the top of each record file (`artifacts/review-*.md`, `artifacts/reviews/*.md`):

```yaml
---
reviewed_head_sha: <40-char head SHA of the reviewed PR>
---
```

A record that covers several PRs lists them: `reviewed_head_shas: [<sha>, <sha>]`. Never put a record PR's own head in a review target list.

### `kind: fix-pr` (PR that needs a fix)

Hand lite: PR link, failing check logs (`gh run view --log-failed`), conflict files or requested changes. Done-when = checks green, no conflicts, and an answer for each requested change. Fix on the PR branch and push. Then run the `kind: review` panel on the new head. Comment what changed. Do not merge unless the user asked.

## Phase 5 — Session report

Table with `repo`, `#`, `kind`, status, evidence. List the remaining frontier by score. List each `kind: decide` item with the decision it needs. Raise a GitHub issue for any new problem found during the run.

## Parallelism

Sequential by default. Multitask only when user asks and items touch disjoint files.

## Stop conditions

Ask when nothing eligible; merge/deploy required; verify fails twice; destructive git not requested.

## Examples

- **`/pull-tickets`** — top 3 pending tasks across all your repos: issues, PRs and Project backlog.
- **`/pull-tickets here`** — the same, for the current repo only.
- **`/pull-tickets backlog-only limit:5`** — work the top 5 GitHub Project items.
- **`/pull-tickets prs-only`** — review open PRs.
- **`/pull-tickets dry-run`** — ranked frontier only.

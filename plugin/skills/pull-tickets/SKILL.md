---
name: pull-tickets
description: >-
  Pull open implementation tickets from the issue tracker, rank the unblocked
  frontier, claim the top three, and implement each via ycm-harness-work-lite.
  Use for /pull-tickets, working the backlog, or executing ready-for-agent issues.
disable-model-invocation: true
---

# Pull Tickets

Pull actionable tickets from the tracker, prioritize the **frontier** (unblocked, ready to start), implement the **top 3** via **`ycm-harness-work-lite`**, then close or hand back with evidence.

**Compose with (not duplicate):**

| Skill | Role |
| ----- | ---- |
| `to-tickets` (mattpocock-skills) | Create tracer-bullet tickets |
| `create-github-tickets` (plugin) | File bugs/feedback as issues |
| `triage` (mattpocock-skills) | Label and brief — no batch implement |
| `wayfinder` (mattpocock-skills) | Decision map — one ticket per session |
| **`ycm-harness-work-lite`** (plugin) | **Implementation lane** — one lite run per ticket |

**Do not** use bare `implement`, full `ycm-harness` goals/worktrees, or orchestrator-authored product code.

## Tracker setup

1. Read project tracker docs when present: `docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`.
2. Else read `plugin/skills/ycm-harness-work/github-tickets.md` for `gh` conventions.
3. Run `gh` inside the target repo clone; infer owner/repo from `git remote -v`.

## Invocation args (optional)

| Arg | Effect |
| --- | --- |
| `#81` / parent issue URL | Scope to epic children (`Part of #81` in body or sub-issues) |
| `label:ready-for-agent` | Filter (default AFK-ready label from triage doc) |
| `limit:3` | Tickets to implement (default **3**) |
| `dry-run` | Rank and present only — no claim or implement |

## Phase 1 — Pull

1. `gh auth status` — stop with exact blocker if not authenticated.
2. List open issues: default `--label ready-for-agent`; intersect with parent when scoped.
3. Fetch `number`, `title`, `body`, `labels`, `assignees`, `createdAt`, `updatedAt`, `issue_dependencies_summary` (or parse `## Blocked by` in body).
4. **Drop:** assigned to someone else; open blockers; `wontfix`, `needs-info`, `needs-triage`, `wayfinder:map`; unlabeled (unless parent-scoped).
5. `gh issue view <n> --comments` when acceptance criteria are thin.

## Phase 2 — Prioritize

Score frontier tickets. Higher wins. Ties: lower issue number, then older `createdAt`.

| Signal | Points |
| --- | --- |
| User named issue/parent in invocation | +100 |
| `bug` label or fix/broken/regression in title/body | +40 |
| Unblocks other frontier tickets | +30 per dependent (cap +60) |
| Small / UI / copy-only | +20 |
| User-reported pain this session | +50 |
| `ready-for-human` | −20 |
| Large feature / migration | −30 |
| Assignee @me | +10 |

Take top `limit` (default 3). Present ranked table unless user said "just do it". **`dry-run`** stops here.

## Phase 3 — Claim

```bash
gh issue edit <n> --add-assignee @me
```

## Phase 4 — Implement via ycm-harness-work-lite

Orchestrator only. Run **`/ycm-harness-work-lite`** once per ticket (sequential by default).

Per ticket, hand lite:

- Issue link + acceptance criteria
- Done-when (one sentence)
- Working directory = target repo root (no harness worktree)

Follow `plugin/skills/ycm-harness-work-lite/SKILL.md`:

```text
dispatch implementer → real verify → fresh combined_reviewer → fix-loop → commit/push → finish-architecture → report
```

After lite PASS:

1. `gh issue comment <n>` — shipped summary, verify command + result, review PASS.
2. `gh issue close <n>` when criteria met.
3. If blocked: comment blocker; leave open.

Lite forbids harness rituals/wiki mirroring beyond claim/comment/close on the ticket.

## Phase 5 — Session report

Table: issue, status, evidence. List remaining frontier.

## Parallelism

Default **sequential** lite runs. Multitask only when user requests it **and** tickets touch disjoint files.

## Stop conditions

Ask the user when: fewer than `limit` unblocked tickets; top ticket needs product decision; verify fails after two fix attempts; destructive git not requested.

## Examples

- **`/pull-tickets #81`** — epic children; top 3 UX tickets.
- **`/pull-tickets dry-run`** — ranked frontier only.
- **`/pull-tickets limit:1`** — highest-priority ticket only.

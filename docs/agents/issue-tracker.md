# Issue tracker: GitHub Issues + Projects

Use GitHub Issues in this repository (`johnyuencm/ycm-harness`) and an optional
GitHub Project for kanban. Forks should set owner/repo/project via flags or
`YCM_HARNESS_GITHUB_*` env vars rather than copying upstream project numbers.

GitHub Issues on the bound repository are the source of truth for goal and ticket coordination. GitHub Projects provides kanban status when a project is linked to the goal.

## Prerequisites

1. Install and authenticate the GitHub CLI: `gh auth status` must succeed.
2. Know the target **owner**, **repository**, and **Project number** (or set `YCM_HARNESS_GITHUB_OWNER`, `YCM_HARNESS_GITHUB_REPO`, and `YCM_HARNESS_GITHUB_PROJECT`).
3. Prefer a Project board with a **Status** field (Todo, In Progress, In Review, Done, Blocked).

## Goal binding

Create or activate a goal with the GitHub backend:

```bash
ycm-harness goal create "<title>" \
  --backend github \
  --owner <owner> \
  --repo <repo> \
  --project <number>
```

When owner/repo/project env vars are set, `--backend github` is the default. The CLI creates a **parent issue** for the goal (or reuse one with `--parent <number>`).

Local-only work remains available with `--backend local` when GitHub is not configured.

## Tickets through ycm-harness

Use `ycm-harness ticket` (alias `task`) — do not hand-roll a parallel tracker:

- `ycm-harness ticket create "<title>" -b "<brief>" -a "<acceptance...>"` — child issue under the goal parent
- `ycm-harness ticket list` — sync and list tickets from GitHub
- `ycm-harness ticket start <id>` — claim / move to in progress
- `ycm-harness ticket submit <id>` — submit for verification (posts evidence comment when on GitHub)
- `ycm-harness verify --ticket <id> --command "..." --implementer-run <id> --verifier-run <id>` — record PASS/FAIL evidence
- `ycm-harness ticket done <id>` — complete only after fresh PASS verification
- `ycm-harness ticket block <id> -r "<reason>"` — mark blocked

Day-to-day SOP: `plugin/skills/ycm-harness-work/github-tickets.md`.

## Direct `gh` operations

Use `gh` for readback, comments, and Project updates the CLI does not wrap:

```bash
gh issue view <number> --repo <owner>/<repo> --json number,title,state,labels
gh issue comment <number> --repo <owner>/<repo> --body-file artifacts/<note>.md
gh issue list --repo <owner>/<repo> --label "<label>" --json number,title,state
```

At **finish**, add a parent-issue summary comment and open follow-up child issues for anything still actionable. Link implementation via pull requests (`Fixes #<n>`).

## Scope and acceptance

Put scope, acceptance criteria, plans, evidence, and review notes in Issue bodies or comments. Harness artifacts under `.ycm-harness/goals/<id>/artifacts/` remain the typed product record; GitHub Issues are the coordination mirror agents and humans share.

Historical Multica → GitHub migration (one-shot only): `$migrate-multica-to-github-projects`. Multica is no longer the active tracker.
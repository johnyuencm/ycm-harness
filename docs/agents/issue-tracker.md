# Issue tracker: GitHub Issues + Projects

Use GitHub Issues in this repository (`johnyuencm/ycm-harness`). Use a GitHub Project for kanban when one is linked to the goal.

The CLI default binding is in `src/schema/v3.ts` (`DEFAULT_GITHUB_TRACKER`):

| Field | Default |
| --- | --- |
| owner | `johnyuencm` |
| repo | `ycm-harness` |
| project owner | `johnyuencm` |
| project number | `1` |

Forks pass `--owner`, `--repo`, `--project-owner`, and `--project` on `goal create`. The CLI does not read `YCM_HARNESS_GITHUB_OWNER`, `YCM_HARNESS_GITHUB_REPO`, or `YCM_HARNESS_GITHUB_PROJECT`. Those names are not in the source. Plugin refresh uses `YCM_HARNESS_GITHUB_PLUGIN`, `YCM_HARNESS_GITHUB_REMOTE`, and `YCM_HARNESS_GITHUB_REF` only.

GitHub Issues on the bound repository are the coordination mirror. The harness ledger is `.ycm-harness/state.json`.

## Prerequisites

1. Install and authenticate the GitHub CLI. `gh auth status` must succeed.
2. Know the target owner, repository, project number, and an existing parent issue.
3. Prefer a Project board with a Status field (Todo, In Progress, In Review, Done, Blocked).

## Goal binding

The default backend is `local`. A GitHub goal needs `--backend github` and `--parent`. The CLI does not create the parent issue.

```bash
ycm-harness goal create "<title>" \
  --backend github \
  --owner johnyuencm \
  --repo ycm-harness \
  --project-owner johnyuencm \
  --project 1 \
  --parent <number>
```

Omit the owner, repo, and project flags to use the defaults above. You must still pass `--parent`.

Local work uses `--backend local`.

## Tickets through ycm-harness

Use `ycm-harness ticket` (alias `task`). Do not keep a second tracker for the same goal.

- `ycm-harness ticket create "<title>" -b "<brief>" -a "<acceptance...>"` — child issue under the goal parent when the backend is GitHub
- `ycm-harness ticket list` — list tickets from the bound provider
- `ycm-harness ticket start <id>` — move the ticket to in progress (`claim` does the same)
- `ycm-harness ticket submit <id>` — store the submission digest and set `in_review`
- `ycm-harness verify run --ticket <id> --command "..." --implementer-run <id> --verifier-run <other-id>` — record PASS or FAIL evidence
- `ycm-harness verify verdict <id>` — print the latest verdict
- `ycm-harness ticket done <id>` — complete only after a fresh PASS from a different verifier run
- `ycm-harness ticket block <id> -r "<reason>"` — mark blocked

Day-to-day GitHub commands that the CLI does not wrap: `plugin/skills/ycm-harness-work/github-tickets.md`.

## Direct `gh` operations

Use `gh` for readback, comments, and Project fields the CLI does not set:

```bash
gh issue view <number> --repo <owner>/<repo> --json number,title,state,labels
gh issue comment <number> --repo <owner>/<repo> --body-file artifacts/<note>.md
gh issue list --repo <owner>/<repo> --label "<label>" --json number,title,state
```

At finish, add a parent-issue summary comment. Open a follow-up child issue for each open problem. Link the pull request with `Fixes #<n>`.

## Scope and acceptance

Put scope, acceptance criteria, plans, evidence, and review notes in issue bodies or comments. The work skill writes review files at `artifacts/review-<role>-<ticket>.md`. The 0.3 CLI does not scaffold `.ycm-harness/goals/<id>/artifacts/`.

Historical Multica migration is one-shot only: `$migrate-multica-to-github-projects`. Multica is not the active tracker. The CLI rejects `--backend multica`.

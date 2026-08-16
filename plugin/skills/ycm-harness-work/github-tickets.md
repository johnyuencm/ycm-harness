# GitHub tickets

Use GitHub Issues + the **harness** Project board as the kanban mirror for every active ycm-harness goal. Do **not** add a ycm-harness ticket wrapper for day-to-day mirroring; call the `gh` CLI directly. Harness lean goals may also bind `--backend github` for provider-backed tickets.

Default destination for this product repo:

- Issues repo: `johnyuencm/harness`
- Project: `TheNewBee` / **harness** (project number `1`)

## Preflight

1. Check the CLI with `gh --help`.
2. If `gh` is missing, dispatch a **Composer 2.5 Fast** subagent (`composer-2.5-fast`) to install GitHub CLI and verify the command works.
3. Verify auth with `gh auth status` (needs `repo` + `project` scopes).
4. If setup still needs browser login, token entry, or org/project access the agent cannot complete itself, stop and report the exact blocker plus the exact command the user needs to run.

## Reuse before create (mandatory)

**Never create a duplicate.** Before every `gh issue create` (parent, ticket child, follow-up, or skill publish such as `/to-spec`):

1. Search and list existing issues in the destination repo — open first, then recently closed if the title looks familiar:
   - `gh issue list --repo <owner>/<repo> --state open --search "<keywords>" --limit 30`
   - `gh issue list --repo <owner>/<repo> --state all --search "<keywords>" --limit 20` when unsure
2. Prefer **reuse**: comment on, relabel, reopen, or board an existing match instead of creating another issue.
3. For harness mirrors, also match by body markers (`harness_goal_id`, `Parent: #<n>`, ticket title) before creating the parent or a ticket child.
4. Create only when no adequate match exists. If near-duplicates exist, link them in the new body (`Related: #n`) or ask only when ownership/scope is genuinely ambiguous.

## Issue shape

- Create **one parent issue** per harness goal.
- Create one child issue per ticket (not per retired V5 phase).
- At finish, create one child **follow-up** issue for each actionable leftover item.

Link children to the parent in the body (`Parent: #<n>`) and board every issue onto Project `harness`. Prefer GitHub sub-issues when the API/UI supports them; otherwise keep the parent link visible in the body.

Project **Status** mapping:

- pending ticket -> `Todo`
- active ticket -> `In Progress`
- submitted / verifying ticket -> `In Review`
- done ticket -> `Done` (close the issue)
- blocked ticket -> `Blocked`
- cancelled follow-up -> `Cancelled` (close as not planned)

## What belongs where

- Put detailed plans, acceptance criteria, evidence, review notes, risks, and summaries in issue bodies or comments.
- Prefer `--body-file` for multi-line content, especially on Windows.
- Keep lookup markers lightweight in the body:
  - `<!-- ycm-harness:ticket:v1 parent=<n> status=<status> goal=<goal-id> -->`
  - optional `harness_goal_id` / `harness_ticket_id` lines
- Do not store the full implementation plan blob as Project field metadata; fields are for board status, not narrative state.

## Command patterns

Parent issue:

```bash
gh issue create --repo johnyuencm/harness --title "<goal>" --body-file artifacts/github-goal.md
gh project item-add 1 --owner TheNewBee --url <issue-url>
```

Ticket child issue:

```bash
gh issue create --repo johnyuencm/harness --title "[ticket] <title>" --body-file artifacts/github-ticket.md
gh project item-add 1 --owner TheNewBee --url <issue-url>
```

Comments and evidence:

```bash
gh issue comment <n> --repo johnyuencm/harness --body-file artifacts/<note>.md
```

Status sync (body marker + Project Status + close when Done/Cancelled):

```bash
gh issue edit <n> --repo johnyuencm/harness --body-file artifacts/github-status.md
gh issue close <n> --repo johnyuencm/harness --reason completed   # Done
gh issue reopen <n> --repo johnyuencm/harness                     # leave Todo/In Progress/In Review/Blocked open
```

Triage labels (see `docs/agents/triage-labels.md`): `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`.

## Pull requests

- During execute / verify, open or update a PR for the goal worktree.
- PR body must link the parent issue (`Fixes #<parent>`, plus ticket issue refs).
- Prefer one PR per goal worktree; update it as tickets land rather than opening noise PRs.
- At finish, include the PR URL in the parent summary comment.

## Finish

Before the harness goal is treated as done:

1. Convert each actionable leftover into a child **follow-up** issue under the parent (body `Parent: #<parent>` + board on Project harness) — **search existing issues first**.
2. Add one final parent issue comment summarizing completed work, verification, PR URL, risks, and future notes.
3. Mark ticket child issues Done on the Project board (and close them), then mark the parent issue Done.

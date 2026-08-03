---
name: create-github-tickets
description: >-
  Create clear, well-contextualized GitHub issues from bugs, features, or
  feedback via gh. Use when the user asks to create tickets/issues, file bugs,
  open GitHub issues, or turn notes/screenshots into tracker items.
---

# Create GitHub Tickets

Publish feedback as GitHub issues with `gh`. Infer repo from `git remote`.

Read project tracker docs when present (`docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`).

## Quality bar

Every ticket must make the **problem** and **context** obvious to a stranger:

- **Problem** — what is wrong / missing, in one crisp summary (symptom + impact).
- **Context** — platform, screen/flow, related issues, product constraints.
- **Repro** (bugs) — numbered steps someone else can follow; include env (OS, build, device).
- **Logs / evidence** — paste or attach logs, screenshots, error text when available; say explicitly if none.

Do not publish a vague one-liner. Expand short notes into the template below. Ask only when repro or env is unknowable from chat/attachments.

## Steps

1. **Dedupe** — `gh issue list --state open --search "<keywords>"` (then `--state all`). Prefer comment / reopen / relabel over a duplicate.
2. **Labels** — `gh label list`. Use project triage labels if present; else `bug` / `enhancement`. Never invent a missing label mid-create.
3. **Body** — write markdown to a file; create with `--body-file`. One issue per distinct request.
4. **Create** — `gh issue create --title "..." --label "..." --body-file <path>`.
5. **Board** — add to the project's GitHub Project when one exists.
6. **Evidence** — attach screenshots/logs (see below).
7. **Report** — table of URLs (number, title, label).

PowerShell: chain with `;`, not `&&`.

## Body template

```markdown
## Summary
<problem in 1–3 sentences: what fails / is missing, and why it matters>

## Context
- Platform / env: <iOS/Android/web, version, device if known>
- Where: <screen, flow, feature area>
- Related: <#n if any>

## Current behavior
<what happens now>

## Expected behavior
<what should happen>

## Reproduction
1. ...
2. ...
3. ...
<!-- Features: replace with "N/A — enhancement" or a concrete usage scenario -->

## Logs / evidence
<!-- Paste logs, stack traces, network errors, or link screenshots.
     If none available: "None provided." -->

## Acceptance criteria
- [ ] ...

## Source
<user feedback / date>
```

Bugs require Reproduction + Logs/evidence sections. Features may use a usage scenario instead of repro, but still need Context and clear Expected behavior.

Keep stale file paths out of bodies unless they encode a durable decision.

## Screenshots / files

`gh` has no reliable official attach API.

1. Embed in the issue body or a comment when possible.
2. Fallback: commit under `artifacts/` (or project convention), push, embed raw URL:
   `https://raw.githubusercontent.com/<owner>/<repo>/<branch>/path/to/file.png`
3. Never leave “see screenshot” as prose-only when the image exists in chat.

## Done when

- Each requested item is a new issue URL **or** an explicit reuse of an existing issue.
- Problem, context, repro (bugs), and logs/evidence are filled (or honestly marked unavailable).
- Labels applied; board updated when applicable; evidence linked when provided.

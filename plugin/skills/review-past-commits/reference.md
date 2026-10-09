# Reference — git forensics, grading, report template

The defect checklist lives in [SKILL.md](SKILL.md). This file holds the commands, the scales, and the output shape.

## Git forensics

Run these from a clean checkout or a detached worktree.

```bash
# The range. Pin both ends to full SHAs.
git rev-parse <base> <head>
git merge-base <default-branch> <branch>    # the base for a branch or pull request
git log --oneline <base>..<head>
git diff --stat <base>..<head>

# Per commit.
git show --stat <sha>
git log --format='%H %an %ad %s' --date=short <base>..<head>

# Ancestry claims (see the table in SKILL.md).
git branch --all --no-merged <base>
git merge-base --is-ancestor <tip> <base>   # exit 0 means already included
git cherry <base> <branch>                  # '-' an equivalent is upstream, '+' none found
git range-diff <old-base>..<old-tip> <new-base>..<new-tip> -- <paths>
git diff --exit-code <before> <after> -- <paths>

# Callers of a changed public symbol.
git diff <base>..<head> --name-only
git grep -n '\b<symbol>\b' -- <source dirs>

# Hygiene after any integration.
git diff --check <base>
git ls-files -u
git status --short --branch
```

`git cherry` compares patch ids. A rebase that absorbed surrounding changes shifts the patch id, so a `+` means "no identical patch upstream", not "the work is missing". Settle every `+` with `git range-diff` or by reading the current code.

Read the continuous-integration result for the exact head SHA, not for the branch.

## Severity and grade

Severity answers how bad. Grade answers how sure. Report both.

| Severity | Meaning |
|----------|---------|
| CRITICAL | Data loss, access-control break, or outage on a path that runs today. Blocks the merge. |
| HIGH | A real defect on a path that runs today, or a latent access-control gap the next change activates. |
| MEDIUM | Wrong behaviour on a reachable edge case. |
| LOW | Cosmetic, fragile, or a maintenance risk. |

| Grade | Meaning |
|-------|---------|
| CONFIRMED | A command, a test, or a reproduction shows it. |
| PLAUSIBLE | A careful code read shows it, and nothing executed it. |
| UNVERIFIED | The specific claim could not be checked. Say why. |

## Report template

```markdown
# <Project> commit review — <range label> (`<base>..<head>`), <date>

Scope: <n> commits. Method: <read-only commands, worktree, which checks ran>.
Intent sources: <tickets, pull requests, specs, decision records>.

## Verdict

<Ship or do not ship.> <Highest severity, and the one sentence that matters.>

## Findings

### H1 HIGH (PLAUSIBLE) — <one-line claim>
- `path/to/file.ts:104`, `path/to/other.ts:75`
- Failure: <inputs or state, then the wrong result>. <Where the single fix belongs.>

### M1 MEDIUM (CONFIRMED) — <one-line claim>
- `path/to/file.ts:68`
- Failure: <concrete path>. <Fix location.>

## Checks that passed

- <Area> — PASS (CONFIRMED): <evidence>.

## Spec drift

<Per criterion: met, not met, or deferred with its tracked item.>

## Done well (patterns for other agents)

1. `path/to/file.ts:26` — <what to copy, and why>.

## Verification

- `<command>`: exit <code>. <Counts, or the reason it could not run.>
- Continuous integration at `<head>`: <result and run reference>.
- Independent reviewer: <accept or reject, and what they checked>.

## Not checked

- <Claim>: <why>.
```

Commit the report into the repository and link committed paths only.

# Reference — git forensics, grading, report template

Normative. The review questions live in [SKILL.md](SKILL.md); worked instances of each live in [examples.md](examples.md).

## Git forensics

Run these from a clean checkout or a detached worktree.

```bash
# The range. Pin both ends to full commit ids.
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

# Dependents of a changed public thing.
git diff <base>..<head> --name-only
git grep -n '<name>' -- <search paths>

# Hygiene after any integration.
git diff --check <base>
git ls-files -u
git status --short --branch
```

`git cherry` compares patch ids. A rebase that absorbed surrounding changes shifts the patch id, so a `+` means "no identical patch upstream", not "the work is missing". Settle every `+` with `git range-diff` or by reading the current state.

Read the continuous-integration result for the exact head commit, not for the branch.

## Severity and grade

Severity answers how bad. Grade answers how sure. Report both.

| Severity | Meaning |
|----------|---------|
| CRITICAL | Loss, exposure, or outage on a path that runs today. Blocks the merge. |
| HIGH | A real defect on a path that runs today, or a latent one the next change activates. |
| MEDIUM | Wrong behaviour on a reachable edge case. |
| LOW | Cosmetic, fragile, or a maintenance risk. |

| Grade | Meaning |
|-------|---------|
| CONFIRMED | A command, a test, or a reproduction shows it. |
| PLAUSIBLE | Careful reading shows it, and nothing executed it. |
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
- `<location>`, `<location>`
- Failure: <inputs or state, then the wrong result>. <Where the single fix belongs.>

### M1 MEDIUM (CONFIRMED) — <one-line claim>
- `<location>`
- Failure: <concrete path>. <Fix location.>

## Questions answered

One row per review question. "None" is an answer; an empty cell is not.

| # | Question | Answer | What was looked at |
|---|----------|--------|--------------------|
| 1 | Intent | <finding ids, or none> | <ledger claims checked> |
| … | … | … | … |

## Checks that passed

- <Area> — PASS (CONFIRMED): <evidence>.

## Intent drift

<Per recorded claim: met, not met, or deferred with its tracked item.>

## Worth copying

1. `<location>` — <what to reuse, and why>.

## Verification

- `<command>`: exit <code>. <Counts, or the reason it could not run.>
- Continuous integration at `<head>`: <result and run reference, or none configured>.
- Independent reviewer: <accept or reject, and what they checked>.

## Not checked

- <Claim>: <why>.
```

Commit the report into the project and link committed paths only.

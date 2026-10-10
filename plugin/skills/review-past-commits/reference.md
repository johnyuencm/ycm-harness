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
| REJECTED | The artifact does not do what the finding claims. Drop it. |

Grade and severity are independent. A grade never lowers a severity, and the verdict follows the highest severity, whatever its grade.

**The execution inversion.** Where the environment cannot run the risky paths — no live service, no data store, no device, no deployment target, no rendering or publishing step — the grades invert by construction. The cheap findings earn CONFIRMED, because they are the ones the environment can run; the dangerous ones stay PLAUSIBLE. This is a property of the environment, not of the findings. Say so in one line, so no reader mistakes an ungraded danger for a small one. List each path that could not run in "Not checked", with what would settle it.

## Review shapes

Same workflow, different starting material. Each shape adds one thing, and removes nothing.

| Shape | Range | What it adds |
|-------|-------|--------------|
| What shipped | A release window, or a branch | Nothing. This is the default. |
| Behind a pull request | Merge base to head | The pull request body is the intent ledger. |
| Resolve an earlier review's open finding | The earlier review's head to now | The open finding is claim one of the ledger. |
| A history claim | Whatever the claim names | Settle the claim first, with the table in [SKILL.md](SKILL.md). |

### Resolve an earlier review's open finding

Pin the base at the earlier review's head commit, so the new range holds only what happened since. The earlier report is the intent ledger, and each of its open findings is a claim in it.

Report every open finding as exactly one of:

- **Fixed** — name the commit and the evidence that the failure path is now closed. A fix with no new check is fixed today and open again tomorrow; say which it is.
- **Open** — the failure path still holds. Carry the original severity forward. A finding does not decay because it is old.
- **Moved** — the artifact changed, and the finding no longer describes it. State what replaced it, and grade the replacement as a new finding.
- **Rejected** — the earlier review was wrong. Give the evidence, not an opinion.

Do not re-grade a carried-forward finding from the earlier report alone. Read the artifact again. The grade belongs to this run's evidence.

Done when: every open finding in the earlier report carries one of the four labels and an evidence line, and this report links the earlier report's committed path.

## Report template

```markdown
# <Project> commit review — <range label> (`<base>..<head>`), <date>

Scope: <n> commits, <n> changed lines, read in <n> pass(es) sliced by <merge | pull request | day | path>, because <reason>. Slices: `<base>..<head>`, `<base>..<head>`.
Method: <read-only commands, worktree, which checks ran, which host review command, or none>.
Intent sources: <tickets, pull requests, specs, decision records>.

## Verdict

<Ship or do not ship.> <Highest severity, and the one sentence that matters.>
<Where the risky paths could not run, say so here: the highest severity is PLAUSIBLE by
environment, not by weakness.>

## Findings

Origin is `first pass` or `verifier`. A verifier finding is a miss, and it is reported as one.

### H1 HIGH (PLAUSIBLE, first pass) — <one-line claim>
- `<location>`, `<location>`
- Failure: <inputs or state, then the wrong result>. <Where the single fix belongs.>

### H2 HIGH (CONFIRMED, verifier) — <one-line claim the first pass missed>
- `<location>`
- Failure: <concrete path>. <Fix location.> Missed by the first pass at question <n>.

### M1 MEDIUM (CONFIRMED, first pass) — <one-line claim>
- `<location>`
- Failure: <concrete path>. <Fix location.>

## Questions answered

One row per review question. "None" is an answer; an empty cell is not.

| # | Question | Effort | Answer | What was looked at |
|---|----------|--------|--------|--------------------|
| 1 | Intent | diff | <finding ids, or none> | <ledger claims checked> |
| 2 | Authority | read | <finding ids, or none> | <guards read> |
| … | … | … | … | … |

## Checks that passed

- <Area> — PASS (CONFIRMED): <evidence>.

## Intent drift

<Per recorded claim: met, not met, or deferred with its tracked item.>

## Worth copying

1. `<location>` — <what to reuse, and why>.

## Verification

- `<command>`: exit <code>. <Counts, or the reason it could not run.>
- Continuous integration at `<head>`: <result and run reference, or none configured>.
- Independent reviewer: <ACCEPT or BLOCK>.
  - Reviewed: <the questions it re-ran, over which slices, from the artifacts>.
  - Rejected: <finding ids, and the evidence that each claim was wrong — or none>.
  - Added: <finding ids the first pass missed, and the question each sits under — or
    none, with the questions it re-ran to get there>.
  - Could not check: <claims, and why>.

## Not checked

- <Claim>: <why>.
- <Risky path the environment could not run>: <what would settle it>.
```

Commit the report into the project and link committed paths only.

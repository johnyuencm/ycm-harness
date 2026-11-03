---
name: merge-branches-to-master
description: Use when a user asks to merge, consolidate, reconcile, or keep merging multiple local or remote Git branches or pull requests into master, especially when branches diverge, worktrees are dirty, conflicts may combine newer behavior, branch ancestry is unclear, or a merge may silently regress architectural contracts (docs/code drift, reintroducing removed dependencies, dropping install/resolve paths). For a pull request, it requires an independent review of the pinned head before the merge.
---

# Merge Branches to Master

## Core principle

Merge intent and ancestry, not timestamps. Preserve every uncommitted change, integrate each unique commit once, and prove every requested tip is reachable from `master`.

**Merging green is not enough.** A conflict-free merge can still corrupt architecture: reintroducing intentionally removed dependencies, dropping resolve/audit/sync machinery, or leaving docs that contradict install behavior. Spot that corruption **before and after** integration, and fix it in the same merge session unless the user forbids follow-up commits.

**Never merge an unreviewed pull request.** When a tip is a pull request, run the [pull request review gate](#pull-request-review-gate) before you integrate it.

## Workflow

1. Read repository instructions and identify its verification commands and commit-message rules.
2. Refresh refs with `git fetch --all --prune`, unless offline or the user limited work to local refs.
3. Capture evidence before mutation:

   ```powershell
   git status --short --branch
   git worktree list --porcelain
   git branch --all --verbose --no-abbrev
   git log --graph --decorate --oneline --all -n 100
   ```

4. Run `git status --short --branch` inside every registered worktree. Never stash, reset, clean, delete, or checkout over existing dirt. If a worktree's registered branch disagrees with its own status, treat its Git metadata as corrupt and do not operate from it.
5. Build an ancestry map with `git merge-base --is-ancestor`. Skip redundant ancestor merges; record why they are already included. Separate committed branch history from uncommitted worktree changes.
6. Classify dirty changes with diffs:
   - coherent newer work: preserve it; replay the exact change on the integration branch only when the request includes latest work or verification proves it is required;
   - stale or regressive work: preserve it in place and exclude it;
   - uncertain ownership: preserve and report it, never silently commit it.
7. Predict each unique merge with `git merge-tree` and compare both sides from their merge base. For overlapping functions, inspect callers, tests, blame, and commit intent. Combine valid contracts; never choose `ours` or `theirs` wholesale merely because one commit is newer.
8. **Pull request review gate** (required for every pull request — see below). Do not integrate a pull request until its gate passes.
9. **Pre-merge contract audit** (required — see below). Record the intended contracts you must preserve.
10. Integrate in a clean temporary worktree when `master` is dirty or risk is broad. Otherwise merge directly on `master`. Merge the most comprehensive descendant first, then remaining independent feature branches, then documentation/configuration branches.
11. Use explicit merge commits when preserving branch provenance matters. Follow the repository's commit protocol. Do not push, delete branches, or remove user worktrees unless explicitly requested.
12. Resolve and verify iteratively. Do not hide failures by increasing timeouts. If the active environment causes locks or contention, verify the exact commit in a clean detached worktree and report the environment distinction.
13. **Post-merge corruption audit** (required — see below). If corruption is found, fix it with follow-up commit(s) on the integration tip **before** claiming the merge done. Do not leave docs/code split-brain for a later cleanup.

## Pull request review gate

Apply this gate to every tip that is a pull request, or that has an open pull request against `master`. A local review is not enough when a pull request exists.

1. Pin the reviewed state. Record the head SHA, the base branch, and the merge base:

   ```powershell
   gh pr view <pr> --json number,title,author,headRefName,headRefOid,baseRefName,isDraft,mergeable,reviewDecision,body,closingIssuesReferences
   gh pr diff <pr>
   gh pr checks <pr>
   git fetch origin pull/<pr>/head
   git merge-base origin/<base> <head-sha>
   ```

2. Read the intent. Read the pull request body, the linked issues, and the existing review comments. Unresolved comments from people are findings.
3. Stop when the pull request is a draft or targets a different base. Report the state and ask the user. When it shows `mergeable: CONFLICTING`, resolve the conflict with the workflow above, and include the resolution in the reviewed diff.
4. Run an independent review of the pinned diff. The reviewer must not be the author of the pull request or of its fix commits.
   - In ycm-harness, use the two-phase panel. Dispatch `tech_lead` and `project_manager` in parallel. They debate at most 3 rounds. Then dispatch `user_advocate` last.
   - In other hosts, use the host's independent review seats or a fresh-context reviewer subagent. Give each reviewer the pinned SHA, the diff, and the intent from step 2.
   - Cover correctness, tests, security, the contract audit below, and every acceptance criterion in the linked issues.
5. Write the full review to the repository's review location (for example `artifacts/` or `docs/reviews/`). Name it `review-pr-<number>-<short-sha>.md`. Commit it with the merge work.
6. Post a short summary on the pull request with `gh pr review <pr> --comment --body-file <file>`. Give the verdict, the high findings, and the committed review path. Use `--request-changes` when the verdict is FAIL and you are not the author.
7. Fix high findings before the merge. Fix them on the pull request branch when you are allowed to push it. Otherwise report them and stop. After any new commit, pin the new head SHA and review the new diff again.
8. Require all of these before the merge:
   - the review verdict is PASS with no unresolved high finding;
   - every required check in `gh pr checks <pr>` passes;
   - no unresolved change request from a person remains;
   - the head SHA is still the reviewed SHA.
9. Merge only the reviewed SHA. Use `gh pr merge <pr> --merge --match-head-commit <reviewed-sha>`, or merge `<reviewed-sha>` locally with the workflow above. Use `--squash` or `--rebase` only when the repository rules or the user ask for it. Do not use `--admin` to bypass branch protection. Do not delete the branch unless the user asks.

A merge without a committed review file and a pinned SHA is not complete.

## Pre-merge contract audit

Before integrating tips that touch packaging, install/sync, dependency vendoring, plugin/skill trees, marketplace wiring, or public CLI surfaces:

1. Discover **canonical contracts** from this repository — README, ADRs, lessons, design docs, and the newest intentional “un-vendor / externalize / slim install” commits — not from whichever tip has the largest diff.
2. Diff each tip against `master` for contract-sensitive paths (adapt to the repo): install/sync/doctor/CLI entrypoints, packaged skill or plugin trees, `vendor/` (or equivalent), marketplace manifests, and docs that describe how dependencies are obtained.
3. Classify each tip’s delta as:
   - **contract-preserving** — keeps the declared ownership model (what the repo owns vs what the environment owns); only adds first-party assets that belong here;
   - **contract-regressing** — re-adds trees a prior commit intentionally removed; expands install lists with formerly external dependencies; deletes resolve/audit/prune/sync helpers; prefers in-repo copies over the documented external source;
   - **orthogonal** — unrelated features/runtime that do not change ownership of dependencies.
4. When merge-tree predicts conflicts on install or packaging files: **never take a regressing side wholesale** because it is “newer” or “more files.” Combine: keep the last good ownership/resolve/prune/audit/sync contract, then layer orthogonal fixes from the other parent.

Ask of every packaging overlap: *After this merge, do docs, install behavior, and on-disk trees still agree on who owns each dependency?*

## Post-merge corruption audit

Run after all requested tips are ancestors of the integration tip (and again after any conflict-resolution commits):

```powershell
# 1) Ancestry + hygiene
git diff --check HEAD
git ls-files -u
git branch --all --no-merged master
git status --short --branch
```

Then, adapted to the repo:

1. **Doc/code agreement** — search docs and install code for “external,” “not vendored,” “bundled,” “marketplace,” “resolve.” Fail if they disagree about the same dependency.
2. **Reintroduction smoke** — fail if paths a prior intentional commit deleted (vendor trees, forked skill/plugin bodies, etc.) are back without a new explicit decision.
3. **Resolve/audit surface** — if the contract requires resolve/prune/doctor/sync against an external install, confirm those entrypoints still exist and are wired; fail if they were dropped while docs still describe them.
4. **Client/plugin fallbacks** — fail if loaders prefer in-repo copies of dependencies the contract says must come from the user/environment/marketplace.
5. **Focused tests** — run install/resolve/packaging tests that cover the overlapped contracts, not only the default suite.

If any signal fires:

1. Trace which merge parent introduced it (`git log -S`, blame, merge-tree on that path).
2. Restore the **last good contract tip** while keeping orthogonal fixes from the other parent.
3. Delete reintroduced trees; fix contradictory docs; remove regressive fallbacks.
4. Commit the repair on the integration branch; re-run this audit.
5. Report corruption and repair SHAs — do not hide a “clean merge” that left split-brain.

## Completion gate

Run the repository’s full checks plus focused tests for resolved overlaps **and** the post-merge corruption audit, then require all of:

```powershell
git diff --check HEAD
git ls-files -u
git branch --all --no-merged master
git status --short --branch
```

Also run `git merge-base --is-ancestor <tip> master` for every requested local and remote tip and scan for conflict markers. A clean ancestry audit is mandatory even when Git reported no conflicts. A green ancestry audit **does not** waive the corruption audit.

## Final report

State:

- merge and follow-up commit IDs (including corruption-repair commits);
- for each pull request: the reviewed SHA, the review verdict, the committed review path, the check results, and the fixed or open findings;
- which branches were redundant ancestors;
- every conflict or semantic overlap and why the chosen behavior is current;
- **contract audit**: what was preserved, what almost regressed, what was repaired;
- updated versus stale uncommitted work and where it remains preserved;
- exact verification results, warnings, and device/external gaps;
- whether `master` was pushed and how far it is ahead of its remote.

## Red flags

- Merging a pull request because its checks are green, without an independent review.
- Reviewing one head SHA and merging a newer one.
- The author reviewing their own pull request, or `gh pr merge --admin` past branch protection.
- “Merge every branch separately” when some are ancestors.
- “Take the newest file” without tracing behavior.
- Treating uncommitted changes as branch history.
- Running `checkout`, `stash`, `reset`, or cleanup in a dirty linked worktree.
- Claiming completion without proving all requested tips are ancestors of `master`.
- Taking `ours`/`theirs` on install/packaging/skill trees without a contract audit.
- Declaring success when docs describe one ownership model and install still ships the opposite.
- Keeping a merge that deletes resolve/audit/sync helpers “because tests still pass.”
- Preferring in-repo copies of dependencies a prior tip intentionally externalized, without a new recorded decision.
- Re-shipping vendor trees a prior tip removed without an explicit new decision in a commit or checkpoint.

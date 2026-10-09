# Examples

## Worked finding — the latent access-control gap

The range added a command module for a domain object. Every function took raw record ids.

```markdown
### H1 HIGH (PLAUSIBLE) — write path has no ownership check
- `src/<domain>/commands.ts:104` (`createChild`), `:158` (`deleteChild`), `:216` (`restoreChild`);
  `src/<domain>/blocks.ts:75` (`createBlock`)
- Failure: every function takes a raw id and never compares the record owner to the session
  subject. Only one branch checks ownership. Today the callers are the seed script and tests
  (verified: no route or component callers), so nothing is exploitable yet. The first server
  action that wires these behind an owner guard, without re-checking inside, ships an
  insecure direct object reference. Fix once in the shared functions, not per caller.
```

Why this earns HIGH while nothing is exploitable: the grep proved the callers, so the claim is bounded and checkable; the next change activates it; and the fix location is one layer, not six call sites.

## Worked finding — the degraded suite

```markdown
### L3 LOW (CONFIRMED) — concurrency tests never executed here
- `src/<domain>/blocks.test.ts:214` (20-way concurrent insert), `:175` (concurrent reorder)
- Failure: these are the load-bearing proofs of "stable under concurrent edits", and they
  need a live database. The run degraded to 199 passed / 33 skipped without failing. Gate the
  job on the database URL, or skip loudly, so the suite cannot quietly shrink.
```

## Worked history check — the branch that looked unmerged

A graph showed two branch labels outside the main line, and the commits under them were not on the main branch. The work was not missing; it had been rebased before merging.

```bash
git branch --all --no-merged main          # two local branches listed
git cherry main env-hardening              # 3 commits marked '-', 3 marked '+'
git range-diff <old-base>..<old-tip> <new-base>..<new-tip> -- src/env-schema.ts src/env.ts
# every '+' commit paired with its rebased counterpart already on main
```

The three `-` commits had identical patch ids upstream. The three `+` commits did **not**, and they were still present: the rebase absorbed newer surrounding code, which changed each patch id. `git cherry` alone would have reported missing work. `range-diff` paired them, and the only real difference was the newer configuration the rebase picked up, which is the state to keep.

Report the pairing, not the label.

When the user wants those original commit ids preserved in the main line, record them with an explicit merge that keeps the approved tree:

```bash
git merge -s ours <original-tip> -m "Merge original <branch> history" \
  -m "The fixes already landed as <sha>, <sha>, <sha>. This merge records provenance and
changes no files."
git diff --exit-code <before> HEAD          # proves the tree is unchanged
git branch --all --no-merged HEAD           # proves every tip is now included
```

Use the ancestry-only merge when the content is already present or deliberately superseded. State the reason in the merge message, and prove the tree did not change.

## Dispatch prompt — independent verification

```text
GOAL: Independently verify a commit review. Trust nothing in its report; check the artifacts.
CONTEXT: Repo <absolute path>. Range <base SHA>..<head SHA>. Read-only: make no edits,
no commits, no merges, no database writes. Claimed findings: <paste the finding list>.
VERIFY:
1. Read each cited file:line. Does the code do what the finding claims?
2. Run <check commands>. Quote exit codes.
3. Grep the callers of each changed public symbol named in the review.
4. Scan the range for skipped tests, loosened assertions, and silenced lint rules.
REPORT (max 15 lines): per finding CONFIRMED / PLAUSIBLE / REJECTED with one evidence line
each; then overall ACCEPT or BLOCK with specific reasons; then what you could not check.
```

Give the reviewer pinned SHAs and the absolute path of the checkout it must use. A reviewer that resolves a branch name reviews a different range than the one you reported.

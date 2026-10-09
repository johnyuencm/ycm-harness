# Examples

Illustrations only. The shape transfers; the domain does not. Bind each question to what the project under review is actually made of.

## Worked instances of each question

**1. Intent.** A commit claims one fix and also renames a published symbol. A pull request claims a refactor and changes a default. An acceptance criterion names a behaviour nobody can observe.

**2. Authority.** A write path takes a raw record id and never compares the owner to the caller. A deploy job gains a credential scope it did not need. A document becomes world-readable. A feature flag defaults to on.

**3. Dependents.** A changed function signature with unvisited call sites. A renamed configuration key still referenced in a template. A schema field a report still selects. A moved file an import, a link, or a build rule still points at.

**4. Weakened proof.** A check skipped or gated on an environment variable. A tolerance widened. A rule silenced. A validation step dropped from the pipeline. An executed count lower than the claimed count.

**5. One-way doors.** A migration with no down path. A delete that cascades further than the record. A published package version. A message sent to an external system. A job described as idempotent that diverges on the second run.

**6. Order and repetition.** Resources acquired in an order that depends on input order. A uniqueness rule used as the only protection instead of a backstop. Sleeps or retries added around a race the change introduced. A two-phase write whose middle state is visible to readers. A migration that sorts before one already applied upstream.

**7. Boundaries.** A private field crossing into a client bundle, a log line, a serialized payload, or an error message. An internal helper exported from a public entry point. A credential, host, or token inside an error string.

**8. Assumptions about input.** A range, length, or format accepted that later work treats as already valid. A date, money, or identifier parsed by a check weaker than the type it produces. An optional value read as required one layer down.

**9. Weight added.** An abstraction with one implementation. Dead configuration. Unused exports. A dependency added for a few lines.

**10. Worth copying.** A validation that models the real threat rather than the obvious one. A state transition that makes an invariant unbreakable instead of merely checked. A fixture that converges rather than duplicating on re-run.

## Worked findings

One per shape.

## Authority — the latent gap (question 2)

A range added a command module. Every function took raw record ids.

```markdown
### H1 HIGH (PLAUSIBLE) — write path has no ownership check
- `<module>/commands:104` (`createChild`), `:158` (`deleteChild`), `:216` (`restoreChild`)
- Failure: every function takes a raw id and never compares the record owner to the caller.
  Today the only callers are the fixture script and tests (verified: no route or component
  callers), so nothing is exploitable yet. The first entry point that wires these behind an
  owner guard, without re-checking inside, hands any caller someone else's records.
  Fix once in the shared functions, not per caller.
```

Why HIGH while nothing is exploitable: the dependent search bounded the claim, the next change activates it, and the fix is one layer rather than six call sites.

## Weakened proof — the degraded suite (question 4)

```markdown
### L3 LOW (CONFIRMED) — concurrency checks never executed here
- `<module>/blocks.test:214` (20-way concurrent insert), `:175` (concurrent reorder)
- Failure: these are the load-bearing proofs of "stable under concurrent edits", and they
  need a live backing service. The run degraded to 199 passed / 33 skipped without failing.
  Gate the job on that service, or skip loudly, so the suite cannot quietly shrink.
```

The finding is the silence, not the skip. A suite that shrinks without saying so reports success it did not earn.

## History — the branch that looked unmerged

A graph showed two branch labels outside the main line, and their commits were not on the main branch. The work was not missing; it had been rebased before merging.

```bash
git branch --all --no-merged main          # two local branches listed
git cherry main <branch>                   # 3 commits marked '-', 3 marked '+'
git range-diff <old-base>..<old-tip> <new-base>..<new-tip> -- <paths>
# every '+' commit paired with its rebased counterpart already on main
```

The three `-` commits had identical patch ids upstream. The three `+` commits did **not**, and they were still present: the rebase absorbed newer surrounding work, which changed each patch id. `git cherry` alone would have reported missing work. `range-diff` paired them, and the only real difference was the newer state the rebase picked up, which is the state to keep.

Report the pairing, not the label.

When the user wants those original commit ids preserved in the main line, record them with an explicit merge that keeps the approved tree:

```bash
git merge -s ours <original-tip> -m "Merge original <branch> history" \
  -m "The work already landed as <sha>, <sha>, <sha>. This merge records provenance and
changes no files."
git diff --exit-code <before> HEAD          # proves the tree is unchanged
git branch --all --no-merged HEAD           # proves every tip is now included
```

Use the ancestry-only merge when the content is already present or deliberately superseded. State the reason in the merge message, and prove the tree did not change.

## Dispatch prompt — independent verification

```text
GOAL: Independently verify a commit review. Trust nothing in its report; check the artifacts.
CONTEXT: Project <absolute path>. Range <base>..<head>. Read-only: make no edits, no commits,
no merges, no writes to any external system. Claimed findings: <paste the finding list>.
VERIFY:
1. Read each cited location. Does the artifact do what the finding claims?
2. Run <check commands>. Quote exit codes.
3. Search for the dependents of each changed public thing named in the review.
4. Scan the range for checks that got easier to pass: skipped, gated, loosened, silenced.
REPORT (max 15 lines): per finding CONFIRMED / PLAUSIBLE / REJECTED with one evidence line
each; then overall ACCEPT or BLOCK with specific reasons; then what you could not check.
```

Give the reviewer pinned commit ids and the absolute path of the checkout it must use. A reviewer that resolves a branch name reviews a different range than the one you reported.

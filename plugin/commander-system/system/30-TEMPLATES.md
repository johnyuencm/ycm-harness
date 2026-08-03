# 30-TEMPLATES — Fill-in dispatch prompts

Copy the block, replace every ALL_CAPS placeholder, delete inapplicable lines. Never send a template with a placeholder still in it.
Cursor: pass as Task `prompt` with the noted `subagent_type`/`model`. Claude Code / Codex: same text to the equivalent subagent; map tiers via `11-INVENTORY-*.md` for the active harness only.
Tier names (FAST/MID/HIGH) → concrete slugs: that harness's `11-INVENTORY-*.md` (pointer table in `10-DISPATCH.md` §2). After results return: verification per `10-DISPATCH.md` §6 — the worker's own "done" is never acceptance.

## T1 — SEARCH / codebase recon

(Cursor: subagent_type `explore`, readonly. FAST for "where is X", MID for "how does X work".)

```
GOAL: Answer: "QUESTION". I need this because WHY_ONE_LINE.
CONTEXT: Repo: ABSOLUTE_PATH (branch BRANCH). Likely areas: HINTS_OR_"unknown".
  Not looking for: EXCLUSIONS.
Thoroughness: quick | medium | very thorough  (pick one)
ACCEPTANCE:
- Every claim carries file:line.
- Cover ALL matches for KEY_TERMS, not the first hit (state the total count found).
- If the answer is "not present", say so explicitly — that is a valid result.
REPORT (max 12 lines): 1 line direct answer; then file:line bullets with a half-line role note each;
  then "Not found:" list. No file contents over 5 lines.
```

## T2 — IMPLEMENTATION

(Cursor: subagent_type `generalPurpose`. MID default. FAST only when pasting an already-solved pattern.)

```
GOAL: Implement WHAT in repo ABSOLUTE_PATH (branch BRANCH). Motivation: WHY_ONE_LINE.
CONTEXT: Relevant files: LIST_FROM_YOUR_RECON. Conventions to follow: EXAMPLE_FILE_TO_IMITATE.
  Constraints: NO_NEW_DEPS / API_MUST_NOT_CHANGE / ETC.
  Already tried & failed (if escalation): PASTE_PRIOR_ATTEMPTS_AND_ERRORS.
SCOPE: You may edit: FILE_LIST_OR_GLOB. Touch nothing else. If insufficient, STOP and report "scope-too-small: <need>".
ACCEPTANCE:
- CRITERION_1 (mechanically checkable)
- CRITERION_2
- TEST_COMMAND exits 0; no placeholder/TODO/commented-out code introduced.
REPORT (max 15 lines): verdict; files changed w/ one-line purpose each; test command + exit code verbatim;
  assumptions made; anything NOT done. Full diff stays on disk — do not paste it.
```

## T3 — REFACTOR / batch mechanical change

(First instance: MID via T2. This template batches the REST on FAST.)

```
GOAL: Apply the pattern below to each listed target. Pure mechanical application — no redesign, no improvements.
CONTEXT: Repo: ABSOLUTE_PATH. The pattern, already solved and verified on SOLVED_FILE:
--- BEFORE
PASTE_BEFORE_SNIPPET
--- AFTER
PASTE_AFTER_SNIPPET
--- END
Adaptation notes: WHAT_LEGITIMATELY_VARIES (names, import paths).
TARGETS: EXPLICIT_FILE_LIST
ACCEPTANCE:
- Every target transformed; a target that doesn't match the pattern is SKIPPED and reported, not improvised on.
- Behavior-preserving: no logic changes outside the pattern. CHECK_COMMAND exits 0.
REPORT (max 15 lines): N transformed / M skipped (skips with file + one-line reason); check command + exit code.
```

## T4 — RESEARCH (web / library docs)

(Cursor: `docs-researcher` for library APIs, `generalPurpose` otherwise. MID. Never do this in the main thread.)

```
GOAL: Find out: QUESTION. Decision this feeds: DECISION_ONE_LINE.
CONTEXT: Stack & versions: FROM_LOCKFILE_NOT_MEMORY. Date sensitivity: NEEDS_CURRENT_INFO_YES_NO.
ACCEPTANCE:
- Every factual claim has a source URL; API/version claims must come from official docs or the package's own repo.
- Distinguish verified fact vs inference vs vendor marketing. Unresolved → "UNVERIFIED", not a guess.
- Check version compatibility against OUR versions above.
REPORT (max 15 lines): 1-line answer/recommendation; key facts w/ source URLs; version caveats; what remains UNVERIFIED.
  Long notes → {{HOME}}\.agents\reports\YYYY-MM-DD-TOPIC.md; return the path.
```

## T5 — REVIEW / acceptance verification

(Cursor: `generalPurpose` with readonly: true. MID; HIGH if the work is high-risk per `10-DISPATCH.md` §6 item 4. Model family ≠ worker's family when possible.)

```
GOAL: Independently verify work done by another agent. Trust NOTHING in its report — check the artifacts.
CONTEXT: Repo: ABSOLUTE_PATH (branch BRANCH). The work claimed: PASTE_WORKER_SUMMARY.
ORIGINAL ACCEPTANCE CRITERIA:
- CRITERION_1
- CRITERION_2 ...
VERIFY (read-only):
1. Read back every changed file (list: FILES) — does the code actually do what the summary claims?
2. Run: TEST_OR_BUILD_COMMANDS — quote exit codes.
3. Diff scan: unrelated changes, placeholders/TODOs, weakened tests or silenced linters (auto-FAIL if found).
4. Spot-check SPOT_CHECK_TARGET (e.g. 2 random call sites of changed symbols, or 2 cited sources).
REPORT (max 15 lines): per-criterion PASS/FAIL + one line of evidence each; then overall
  ACCEPT / REJECT: <specific reasons + file:line>. A criterion you couldn't check = FAIL (say why), never a pass.
```

## Placement note

Repo-local artifacts (diffs, long analyses) → the repo's scratch/reports dir if one exists; cross-project artifacts → `{{HOME}}\.agents\reports\`. Date-prefix everything: `YYYY-MM-DD-topic.md`.

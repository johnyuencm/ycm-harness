# 10-DISPATCH — Commander protocol: who does what, on which model

Audience: the main-conversation model in any harness (Cursor, Claude Code, Codex).
Everything here is executable at Sonnet tier. Numbers are deliberate — follow them, don't re-derive them.
Why these rules exist: `00-DIAGNOSIS.md` Problems 1 and 3.

## §0 Session bootstrap (30 seconds, before real work)

1. Identify which harness you are in (Cursor Agent / Claude Code / Codex). Read **only** that harness's inventory file (§2) — never the other two.
2. ONE workflow system per session: if the user invoked ycm-harness, follow that system's own SOP; use this file for **model-tier choices and verification discipline** (§6 + `20-JUDGMENT.md` §2 + `30-TEMPLATES.md` T5) — not a second phase machine. Otherwise operate in plain commander mode per this file. Never blend two SOPs.
3. Skill budget: read at most 2 SKILL.md files per task. Needing a third means you've lost the thread — re-read the user's message instead.
4. For multi-session or >1-hour work: write your plan and open questions to a scratch file on disk (e.g. `<repo>\.agents-scratch.md`) BEFORE starting. Context can be compacted at any time; disk survives, your context doesn't.

## §1 Division of labor (hard thresholds)

DELEGATE to a subagent when the task matches ANY of:

- You'd need to read more than 2 files or ~300 total lines just to build context.
- Repo-wide search where you don't already know which file holds the answer.
- Web research beyond fetching a single URL you already have.
- The same mechanical edit applied to more than 3 files.
- Any run-fix-rerun loop (tests, build, lint) expected to take more than 2 iterations.
- Any single step expected to produce >200 lines of output into your context.

DO IT YOURSELF when:

- Answerable from context already loaded.
- One targeted read (<300 lines) or edits to ≤3 files you already understand.
- A single shell command whose output you need verbatim.
- Talking to the user, deciding, integrating subagent reports. This is your actual job.

The commander's context is the most expensive real estate in the system: every line loaded there is re-paid every turn afterward. Subagent contexts are disposable; yours is not.

## §2 Verified inventory (tiers here; concrete IDs on demand)

Tiers are **harness-agnostic**. When dispatching, name **tier + concrete model/alias** for _this_ harness — never paste a Cursor slug into Claude/Codex, or an Anthropic alias into Cursor Task.

**Shared tier meaning:**

| Tier          | Role                                                                       |
| ------------- | -------------------------------------------------------------------------- |
| FAST          | recon, file finding, mechanical/batch edits, applying a solved pattern     |
| MID (default) | implementation, refactors, research, standard review / T5 acceptance       |
| HIGH          | hard debugging, architecture, escalations, second opinions                 |
| MAX           | taste / adversarial review of critical work; twice-escalated failures only |

**Default pick policy (all harnesses):** implementer → MID; escalation → HIGH (prefer a different model family than the failed worker); MAX only after the §5 budget is spent or for taste-critical review.

**Concrete IDs — read exactly one file for this session's harness (do not open the others):**

| Harness                  | Read on demand                                         |
| ------------------------ | ------------------------------------------------------ |
| Cursor                   | `{{HOME}}\.agents\system\11-INVENTORY-cursor.md` |
| Claude Code (`cex` only) | `{{HOME}}\.agents\system\11-INVENTORY-claude.md` |
| Codex                    | `{{HOME}}\.agents\system\11-INVENTORY-codex.md`  |

## §3 The dispatch three-piece set (mandatory in every subagent prompt)

Subagents see NOTHING of your conversation. Every dispatch prompt contains:

1. **GOAL + CONTEXT** — what to do, why it matters, and every fact they can't discover alone: absolute repo path, branch, relevant prior findings, constraints, what was already tried.
2. **ACCEPTANCE CRITERIA** — enumerated, mechanically checkable. "Works correctly" is not a criterion; "all 3 call sites updated and `npm test` exits 0" is.
3. **REPORT FORMAT** — exact shape and length cap of what comes back (see §4).

A dispatch missing any piece produces garbage you'll pay to re-do. Fill-in templates: `30-TEMPLATES.md`.

## §4 Report contract (paste into every dispatch, worker-side rules)

- Return AT MOST 15 lines: verdict first line, then bullets — each conclusion with `file:line` or a command+exit code as evidence.
- Anything longer (full analysis, logs, diffs, scraped content) goes to a file: `{{HOME}}\.agents\reports\YYYY-MM-DD-<topic>.md` (or the repo's scratch dir if project-local). Return the path.
- Never paste more than 30 consecutive lines of file content into the reply.
- If blocked or the task is ambiguous: STOP, report the blocker in one line, return. Do not improvise scope.
- Report failures as failures ("could not verify X" / "found no match"), never dressed as partial success.

## §5 Escalation and downgrade ladder

Definitions, so the cap is unambiguous: attempt 1 = the initial dispatch. A "redispatch" = sending the same subtask again, at any tier. BUDGET: at most 2 redispatches per subtask — 3 attempts total, then hard stop.

Start: FAST for mechanical/search, MID for everything else. Ladder within the budget:

- Started on FAST, failed → redispatch on MID (attempt 2), include the failed attempt's output. Fails again → final redispatch on HIGH (attempt 3) with the full trace.
- Started on MID, failed → redispatch on MID with improved context if the failure was a context gap you can fill, otherwise on HIGH (attempt 2). Failed twice on MID → final redispatch on HIGH (attempt 3) with the full failure trace: all attempts, exact errors, your current hypothesis.
- All 3 attempts spent (or HIGH failed) → STOP. Do not reach for MAX by reflex. Run the wrong-direction checklist (`20-JUDGMENT.md` §4); usually the decomposition is wrong, not the model.
- Escalate early (skip the same-tier retry) when the failure is a reasoning failure: the report ignored acceptance criteria, hedged without evidence, or claimed success without running anything. Retrying the same tier on a reasoning failure wastes an attempt.
- Mechanical failures (typo'd path you gave, missing flag, transient network) are NOT attempts: fix the input and resend at the same tier, provided the fix is obvious in under a minute.

DOWNGRADE (this pays for the whole system): once an instance of a repeating problem is solved and verified, batch the remaining instances to FAST with the solved instance pasted in as the template. Example: 12 files need the same API migration → MID solves file 1 → FAST applies the diff-pattern to files 2–12 → verification per §6 covers all 12.

## §6 Verification is never self-verification

1. The agent (or you) who wrote the work never accepts it. After any substantive delegated work, dispatch a fresh-context acceptance agent: Cursor `generalPurpose` with `readonly: true`, MID tier, different model family than the worker when feasible (claude worker → gpt reviewer, and vice versa).
2. Evidence by type: **files** → read back from disk and check against each acceptance criterion; **code** → actually run tests/build/lint and quote exit codes; **claims/research** → spot-check 2 random citations at the source.
3. Verification report: per-criterion PASS/FAIL with one line of evidence each. A criterion without evidence is FAIL.
4. High-risk work (irreversible ops, security-touching, architecture, >10 files changed) gets a second opinion from a HIGH model of a different family, or best-of-n (2–3 independent attempts, a separate reviewer picks the winner and says why).
5. Cheap-tier output gets 100% verification. MID output on multi-file work: verify a 30% sample, minimum 2 items; any failure → verify everything.

## §7 Parallelism

- Independent subtasks → dispatch in one message, run in parallel. Cap: 4 concurrent (integration of >4 reports costs more than the parallelism saves).
- Never give two concurrent agents write access to the same files. Overlap → merge into one dispatch or serialize.
- While a background agent runs, do other work; don't poll. Integrate on the completion notification.

## §8 When a model slug / alias errors (re-verification procedure)

1. Read the harness error (Cursor Task lists valid slugs; Claude `/model` and Agent errors; Codex unsupported-model messages).
2. Choose the nearest **same-tier** ID from **that harness's** `11-INVENTORY-*.md` (never cross-paste Cursor ↔ Claude ↔ Codex IDs).
3. Update that inventory file and its "verified" date, per `40-MAINTENANCE.md` (backup first). Log one line in `LESSONS.md`. Cursor slug changes: also update the harness `commander-dispatch.md` mirror.
4. Never hardcode a guessed model name into any dispatch or file. If you can't verify a name, write "UNVERIFIED" next to it.
5. For Claude `cex` sessions: if an alias resolves wrong, see the remaps note in `11-INVENTORY-claude.md`.

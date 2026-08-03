---
name: plan-and-advance
description: >-
  Use when the user wants planning before implementation, edge-case hunting,
  upgrades they missed, permission to improve their idea then ship it
  autonomously without interviews, or when they invoke plan-and-advance / quote
  the plan-then-advance contract. Mandatory: self-grill every fork and fill
  Decisions + Edge cases in the Plan before any edit — Plan-only is invalid.
---

# Plan and advance

## Mandate (verbatim)

first you will plan this out and think of the edge cases, improvements I did not think of/missed, and you may advance/improve on top of my idea and work on it

## Overview

Plan before code. **Self-grill is mandatory** (not optional flavor). Grill forks and edge cases yourself, pick defaults, write them in the Plan, then hand off to **`/ycm-harness-work-lite`** to implement — **without interviewing or interrupting the user**.

A Plan block with only Goal/Approach is **invalid**. You have not followed this skill until **Decisions (self-grilled)** and **Edge cases** are filled and the category pass below has been run.

## Autonomy (non-negotiable)

- **Do not interview the user.** No AskQuestion, no clarifying Q&A, no "which do you prefer?", no "should I proceed?".
- **Grill yourself.** For each decision fork: list 2–3 options, pick the single best default, record it in the Plan, continue.
- **Prefer codebase evidence** over questions. Read code, configs, tests, and docs to resolve ambiguity.
- **Run to completion.** Emit complete Plan → hand off to `/ycm-harness-work-lite` → report. Do not pause for approval after the Plan.
- **Only interrupt** for irreversible external ops the user did not authorize in this chat (force-push, hard reset, prod delete, secrets exfiltration, user-wiki `--confirm`). Everything else: decide and ship.

## Hard gate (all steps required — skip none)

Before any implementation edit, shell mutation, or commit, complete **every** step in order:

1. Restate the goal and **explicit constraints** (do not "improve away" named requirements).
2. Run the **Self-grill protocol** on every meaningful fork (options → pick → reason).
3. Run the **Edge-case pass** (category table); resolve each applicable row yourself.
4. Emit a **complete Plan** block (template below). Incomplete = stop; do not implement.
5. Immediately hand off to **`/ycm-harness-work-lite`** to implement — no waiting for a reply.

**Plan completeness check (must pass before step 5):**

- [ ] `Decisions (self-grilled)` has ≥1 real fork with options and a picked winner (or explicit `none — single obvious path` with why)
- [ ] `Edge cases` lists non-obvious applicable categories **and how handled** (not empty, not "TBD")
- [ ] `Improvements` states what you advanced or `none`
- [ ] No question marks aimed at the user

Trivial one-liners still get a 2–4 line Plan that includes Decisions + Edge cases (even if short). Skip only pure Q&A with no deliverable.

## Plan template

```markdown
## Plan

- Goal:
- Approach: (chosen; 1 sentence why)
- Decisions (self-grilled): option A vs B → **picked X** because …
- Edge cases: Category → how handled; …
- Improvements (missed / advanced):
- Non-goals / won't expand:
- Then: implement now
```

Keep it tight. Prefer bullets over essays. **Do not emit a Plan that omits Decisions or Edge cases.**

## Self-grill protocol (mandatory — do before Plan)

For every meaningful fork (API shape, storage, error policy, test seam, scope edge, OS/path, failure mode):

1. Name the decision.
2. Sketch 2–3 viable options (include the user's implied one if clear).
3. Pick **one** — prefer: matches existing patterns, smallest diff, edge-case-correct, reversible.
4. Write the pick in the Plan. Do not ask the user to choose.

If information is missing and code cannot answer: assume the safest reversible default that still delivers the request, note the assumption in the Plan, and proceed.

Skipping this protocol and jumping to implement is a **skill violation**, even if you wrote a Goal/Approach Plan first.

## Edge-case pass (mandatory — resolve yourself)

Probe categories that apply; resolve each in the Plan (do not ask the user):

| Category                 | Resolve                                             |
| ------------------------ | --------------------------------------------------- |
| Empty / null / first-run | No data, missing config, cold start                 |
| Concurrency              | Two writers, stale reads, partial failure           |
| Boundaries               | Auth, trust edges, path/OS differences, size limits |
| Failure                  | Mid-step crash; rollback or fail closed             |
| Idempotency              | Safe retry                                          |
| Compatibility            | Existing callers, schemas, clients                  |
| Ops                      | Smallest decisive verification                      |

List only non-obvious ones. Skip the trivial. **Do not leave the Edge cases line blank** — if truly none apply, write `none material` and one sentence why.

## Improvement classes

| Class                       | Examples                                                                       | Action                                                                                                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Local**                   | Better name, reuse helper, tighter API, missing guard, simpler path            | Do it. Mention in Plan.                                                                                                                                                                          |
| **Material**                | Extra vertical slice, new persistence, parallel subsystem                      | Decide yes/no via self-grill; if yes, put under Improvements and implement.                                                                                                                      |
| **Breaking / irreversible** | Public API break, destructive data migration, push/force, secrets, delete prod | Prefer a non-breaking path. If no non-breaking path exists and the user did not authorize it: stop with the blocker only — do not interview for alternatives; state the one recommended unblock. |

Default bias: elevate quality of the _same_ request. Not a new product.

## Advance rules

- Advance = stronger version of their idea (edge cases covered, simpler design, reused patterns, clearer seams).
- Do **not** invent unrelated features to look clever.
- Prefer deletion and reuse over new abstractions (ponytail / YAGNI).
- If two approaches are equal size, pick the edge-case-correct one.
- When ycm-harness design/work is active: record material advances as checkpoints; do not bypass grill/spec _gates_ — but **you** answer grill forks; do not wait on user Q&A for this skill's path.

## Then work on it

After a **complete** Plan block (same turn):

1. Invoke **`/ycm-harness-work-lite`** to implement the advanced plan. Do not freestyle product implementation under this skill alone — lite owns implement → verify → independent review → ship (no harness state machine).
2. Under lite, verify with that skill’s decisive bar (not a weaker proxy).
3. Report what you advanced and which decisions you self-picked (1–3 bullets).

## Related skills (pick one)

| Need                                     | Use                                                               |
| ---------------------------------------- | ----------------------------------------------------------------- |
| User wants to be interviewed             | `grill-me` / `grill-with-docs` (only when they ask to be grilled) |
| Evidence-grounded architecture discussion | `run-technical-design-discussion` (packet + validate; no harness state) |
| Full harness design → tickets            | `ycm-harness-design`                                           |
| Advice only, no edits                    | `oracle-advisor`                                                  |
| Plan, self-grill, elevate (no user Q&A)  | **this skill**                                                    |
| After Plan: implement / verify / review  | **`ycm-harness-work-lite`** (`/ycm-harness-work-lite`)      |
| Full harness execute → validate → finish | `ycm-harness-work` (`/ycm-harness-work`)                    |

## Anti-patterns

- Emitting Goal/Approach only, then coding — **Plan without self-grill is not this skill**.
- Implementing freestyle after Plan without invoking **`/ycm-harness-work-lite`**.
- Handing off to full `/ycm-harness-work` from this skill (lite is mandatory here).
- Interviewing, clarifying questions, or AskQuestion under this skill.
- Coding in the first tool call with no Plan block.
- Asking "should I also think about edge cases?" or "which option?" — decide yourself.
- Stopping after the Plan for approval.
- Expanding into a rewrite when a small fix was requested.
- Treating user constraints as optional suggestions.
- Offering a menu of equal options to the user instead of picking one.
- Claiming "partially followed" after skip — incomplete Plan means you did not run the skill.

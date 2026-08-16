---
name: ycm-harness-work-lite
description: >-
  Lightweight implement→verify→review loop for quick tasks without harness
  state, phases, rituals, or issue-tracker mirroring. Requires an llm-wiki run
  record so future agents know what happened. Use when the user invokes
  /ycm-harness-work-lite, ycm-harness-work-lite, or when plan-and-advance
  hands off after a complete Plan. Not for full harness goals.
---

# ycm-harness-work-lite

Standalone work procedure for simple/quick tasks. **No harness CLI state.**

You are the **orchestrator**. Product edits belong to an implementer subagent. You own verify + independent review + ship.

## Prerequisite: mattpocock-skills plugin

The finish-stage architecture pass is **not** bundled. Invoke from **`mattpocock-skills@mattpocock`**:

- `improve-codebase-architecture` + `codebase-design` (via `finish-architecture.md`)

If missing, stop and point the user at `ycm-harness doctor` or the install block in `ycm-harness-design`. Do **not** vendor copies into harness.

Context: `finish-architecture.md` — lite architecture pass (no harness rituals or GitHub mirroring).

## Entry

Enter this skill only when:

1. The user explicitly invokes `/ycm-harness-work-lite` / `ycm-harness-work-lite`, **or**
2. `plan-and-advance` hands off after a complete Plan, **or**
3. `pull-tickets` hands off one claimed ticket at a time after Phase 3 claim.

Do **not** auto-pick lite for arbitrary tasks. `ycm-harness-design` still hands off to full `/ycm-harness-work`.

If scope grows mid-run: **stay in lite**. Tighten verify and review. Do not switch to design/full work mid-flight.

## Forbidden (skill violation)

- `ycm-harness` goals, phases, rituals, artifacts, smoke CLI, review CLI, checkpoints
- Goal worktrees (`.worktrees/`)
- Issue-tracker (GitHub) ticket mirroring
- Harness ritual wiki (`project-wiki-update`), session nudge, progress/PRD/design docs “for the harness”, user-wiki `--confirm` without approval
- Ralph / ultrawork ritual recording
- Writing product code yourself (orchestrator lane)
- Self-certifying without a fresh-context independent reviewer

## Procedure

```text
dispatch implementer → real verify → fresh combined_reviewer → fix-loop → commit/push → finish-architecture → llm-wiki run record → report
```

### 1. Dispatch implementer

Dispatch **one** implementer subagent (reuse `plugin/agents/implementer.md` when available). Give it:

- Goal / Plan summary
- Explicit acceptance criteria
- Working directory = current workspace (no harness worktree)
- **TDD encouraged** for behavior changes (not mandatory); docs/config/renames may skip
- Commit after every coherent change; leave the tree clean when done

You do **not** implement product code in this skill.

### 2. Verify

Run the project’s real test / lint / build bar in the **current workspace** via plain shell (not `ycm-harness smoke run`).

- Prefer a scoped command when the affected surface is clear
- If unsure, run the full project verify bar
- Failures → fix via implementer, then re-verify

### 3. Independent review

Dispatch **one fresh-context** read-only reviewer bound to `plugin/agents/combined_reviewer.md`. Cover all four lenses (tech, spec, security, user-value) in that single pass.

- Reviewer must not be the implementer / author. Never self-score.
- Findings live in the subagent report (≤15 lines back + severity).
- Do not run `ycm-harness review *` (deprecated exit-2 alias). Do not write
  `review-combined.json` or any harness review evidence file.
- Lite close-out is plain-shell verify (this skill forbids harness tickets).
  Full-harness close-out elsewhere is `ticket submit` + `verify run` with
  distinct implementer vs verifier run IDs.

### 4. Fix-loop

If review has actionable findings:

1. Dispatch implementer to fix
2. Re-verify
3. Fresh combined reviewer again

Max **3** rounds. If still failing: report blocked with remaining findings — **still under lite** (do not escalate skills).

### 5. Ship

- Working tree clean
- Commit and push per environment rules

### 6. Architecture pass

Run **`finish-architecture.md`** (`improve-codebase-architecture` from mattpocock-skills). Scope to this run's diff; write/open the HTML report; carry the **Top recommendation** into the report below.

### 7. llm-wiki run record

**Required.** Invoke **`$llm-wiki`** and file a durable run record so future agents know what happened on this task. Chat history does not compound; the wiki does.

Minimum page content:

- **Goal** — one-line task summary
- **Shipped** — what changed (modules/files, commit SHAs or branch if relevant)
- **Verify** — command(s) run + pass/fail
- **Review** — PASS/FAIL; actionable findings fixed or explicitly deferred
- **Architecture** — Top recommendation from step 6
- **Leftovers** — blockers, follow-ups, or “none”

**Harness project** (`.ycm-harness/wiki/`):

1. `ycm-harness wiki durable --id work-lite-YYYY-MM-DD-<short-slug> --title "<goal>" --trigger <decision|root-cause> --body-file <path>`
2. Append a parseable entry to `log.md` (see `$llm-wiki` ingest format)
3. Do not run deprecated wiki init/upsert aliases (exit-2)

**Standalone / non-harness workspace:** follow `$llm-wiki` standalone backend (`WIKI.md` layout); same minimum content.

Do **not** skip because the task was “small”. Do **not** run `session nudge` or record harness rituals — only this run record.

### 8. Report

Short user report: what shipped, verify command + result, review PASS/FAIL, architecture **Top recommendation**, **wiki page id/path**, leftovers if any

## Done bar

Claim done only when **all** hold:

- [ ] Implementer finished; orchestrator did not author product code
- [ ] Real verify command(s) passed (evidence: command + exit)
- [ ] Fresh combined reviewer returned PASS (or only deferred low noise explicitly named)
- [ ] Git working tree clean; commits pushed when the environment expects push
- [ ] **`finish-architecture.md`** ran: HTML report path noted; Top recommendation in user report
- [ ] **`$llm-wiki` run record** upserted (page id + log entry); path noted in user report
- [ ] No harness state / rituals / issue-tracker side effects beyond the required wiki run record

---
name: ycm-harness-work-lite
description: >-
  Lightweight implement→verify→review loop for quick tasks without harness
  state, phases, rituals, wiki, or issue-tracker mirroring. Use when the user invokes
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
2. `plan-and-advance` hands off after a complete Plan.

Do **not** auto-pick lite for arbitrary tasks. `ycm-harness-design` still hands off to full `/ycm-harness-work`.

If scope grows mid-run: **stay in lite**. Tighten verify and review. Do not switch to design/full work mid-flight.

## Forbidden (skill violation)

- `ycm-harness` goals, phases, rituals, artifacts, smoke CLI, review CLI, checkpoints
- Goal worktrees (`.worktrees/`)
- Issue-tracker (GitHub) ticket mirroring
- Project/user wiki updates, session nudge, progress/PRD/design docs “for the harness”
- Ralph / ultrawork ritual recording
- Writing product code yourself (orchestrator lane)
- Self-certifying without a fresh-context independent reviewer

## Procedure

```text
dispatch implementer → real verify → fresh combined_reviewer → fix-loop → commit/push → finish-architecture → report
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

- Reviewer must not be the implementer / author
- No harness `review start` / `verdict` / evidence registry
- Collect findings in the subagent report (≤15 lines back + severity)

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

### 7. Report

Short user report: what shipped, verify command + result, review PASS/FAIL, architecture **Top recommendation**, leftovers if any

## Done bar

Claim done only when **all** hold:

- [ ] Implementer finished; orchestrator did not author product code
- [ ] Real verify command(s) passed (evidence: command + exit)
- [ ] Fresh combined reviewer returned PASS (or only deferred low noise explicitly named)
- [ ] Git working tree clean; commits pushed when the environment expects push
- [ ] **`finish-architecture.md`** ran: HTML report path noted; Top recommendation in user report
- [ ] No harness state / rituals / wiki / issue-tracker side effects from this run

# 00-DIAGNOSIS — Why this system exists

Every other file in `{{HOME}}\.agents\system\` exists to fix one of these three
problems. When a rule elsewhere seems arbitrary, this file is the "why". Read
once; then use the routing in your entry file (CLAUDE.md / AGENTS.md /
commander skill).

Machine-specific evidence and dates belong in the operator's private tracking
repo / local `LESSONS.md`, not in this portable template.

## Problem 1 — The main conversation does grunt work until it drowns (biggest token waste)

**Typical failure:** No harness entry file states delegation thresholds. The
main model greps the repo itself, reads whole files itself, pastes web pages
into its own context, and does batch edits itself.

**Cost:** The main thread is the most expensive context in the system —
everything loaded there is re-paid on every subsequent turn. Filling it with
raw file contents causes mid-task context compaction, which destroys plan
state.

**Fix, now written down:** Hard numeric delegation thresholds and a subagent
report contract → `10-DISPATCH.md` §1 and §4. The main thread receives
conclusions and `file:line` references only; long artifacts go to
`{{HOME}}\.agents\reports\`.

## Problem 2 — Instruction sprawl with contradictions (biggest focus loss)

**Typical failure:** Dozens of skills from multiple install locations; duplicated
skill packs; more than one workflow OS active; older user rules that demand
clarifying questions or rigid plan ceremony while newer autonomy contracts say
to keep moving with checkable criteria.

**Cost:** A weak model facing contradictory instructions does one of three
things, all bad: obeys whichever instruction is loudest/most recent, freezes
and asks the user, or burns its first 20k tokens reading five overlapping SOPs
before starting work.

**Fix:** A single precedence order stated in every entry file, plus two hard
rules: engage at most ONE workflow system per session (ycm-harness OR plain
commander mode — never mixed), and a skill read budget (read at most 2
SKILL.md files per task; if you think you need a third, you are lost —
re-read the task instead) → entry-file pointers and `10-DISPATCH.md` §0.

## Problem 3 — Self-verification and blind retries (most frequent failure)

**Typical failure:** No escalation ladder or acceptance protocol. Nothing
prevents the classic weak-model loop: claim done without running anything, or
retry the same failing edit five times with no new information.

**Cost:** False "done" reports cost a full round-trip through the user's
attention (the scarcest resource in the system). Blind retries burn tokens with
zero information gain.

**Fix:** A checkable definition of done, verification by a fresh-context agent
(never the author), a 3-attempt budget per subtask, and an explicit
escalation/downgrade ladder → `20-JUDGMENT.md` §2 and §4, `10-DISPATCH.md` §5
and §6.

## Cross-cutting waste (smaller, still real)

- Shell quirks differ by platform (example: PowerShell 5.1 rejects `&&`).
  Capture durable operator facts in `LESSONS.md`, not here.
- MCP descriptors + the skill list are a fixed per-session token cost that
  rules cannot remove. The only lever: keep additions near zero and delete
  duplicates → `40-MAINTENANCE.md` §5.

## The one-sentence version

Keep the main thread small and decisive; push volume to disposable subagent
contexts; never let the author grade their own work; stop repeating what failed.

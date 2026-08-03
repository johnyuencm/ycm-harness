# 20-JUDGMENT — Decisions turned into checklists

Frontier models make these calls by feel. You don't have to: run the checklist, count the signals, follow the verdict.
Each section: rule → checkable signals → one GOOD call → one BAD call. The examples are the spec — when unsure, ask "which example is this closer to?"

## §1 When to upgrade the model tier

Upgrade (per the ladder in `10-DISPATCH.md` §5) when ANY of:

- [ ] Second failed attempt on the same subtask with a _different_ error each time (the model is thrashing).
- [ ] The output ignored an explicit written constraint from the dispatch.
- [ ] The task needs holding an invariant across >3 files simultaneously (cross-file reasoning is what tiers buy).
- [ ] The report contradicts itself or hedges every claim without evidence.

Do NOT upgrade when:

- [ ] The failure is mechanical: wrong path, missing dependency, typo, transient network. Fix the input, same tier.
- [ ] You never gave the context the model needed. Fix the dispatch (three-piece set), same tier.

GOOD: Sonnet twice produced a migration that fails FK constraints, differently each time → escalate to HIGH with both diffs and both error logs pasted in.
BAD: Haiku-tier agent used a path with a typo and errored once → jumping to Opus. The fix was correcting one path; upgrading buys nothing and costs 10x.

## §2 When something is truly DONE

All boxes, no exceptions. Any unchecked box = the words "done", "complete", "fixed" may not appear in your report.

- [ ] Every acceptance criterion from the original dispatch checked individually, each with evidence (command + exit code, file:line, or read-back).
- [ ] Verification performed by a fresh-context agent or an actual execution — not by the author rereading their own diff (`10-DISPATCH.md` §6).
- [ ] Tests/build/lint that the repo already has: ran and passing, output quoted. "Should pass" is not a state of the world.
- [ ] No placeholder left behind: TODO, FIXME, `...`, mock data standing in for real logic, commented-out code.
- [ ] Untouched-but-related callers still work (grep for callers of every changed public symbol; each hit updated or confirmed unaffected).
- [ ] Anything you promised the user in earlier turns of this task is either delivered or explicitly reported as not done.

GOOD: "3 criteria PASS (evidence attached), `npm test` exit 0 — 42 passed. Reviewer agent read back all 4 files. One promised item NOT done: docs update — blocked on X."
BAD: "Refactor complete, everything should work now." (No run, no read-back, no per-criterion check. This sentence is banned.)
GOOD (harness): "Finish phase complete; T5 ACCEPT on all tasks; `npm run verify` exit 0 in worktree; wiki + GitHub parent summarized (PR URL in comment). NOT done: owner-only deploy step, merge to main (awaiting ask)."
BAD (harness): "Goal complete — `blocking_gates: []`." (CLI floor cleared; no T5, weak/missing smoke, silent open tickets. Example failure mode: harness finish while acceptance leftovers remain.)

This applies to PLANS too — a plan is a deliverable. A plan item is done only when it is a demoable vertical slice with acceptance criteria an implementer could confirm without asking you what "done" means. (Altitude note: plan/issue acceptance criteria are OBSERVABLE BEHAVIOR — file paths and exact commands are resolved at execute-time dispatch, not baked into the issue; the `to-prd`/`to-issues` skills forbid file paths on purpose.)
GOOD plan item: "Slice: kill-switch blocks orders. With KILL=1 set, submitting an order returns OrderBlocked and nothing reaches the broker; demoable via the paper-trading CLI. Blocked by: none."
BAD plan item: "Implement robust risk management for the trading engine." (No slice, no checkable behavior — a topic, not a task. Example failure mode: freeform design notes instead of to-prd/to-issues vertical slices.)

## §3 When to stop and ask the user

ASK (and block) only for:

- [ ] Destructive/irreversible: deleting data or branches, force-push, `reset --hard` over uncommitted work, prod deploys, sending external messages, spending money.
- [ ] Real scope change: completing the task requires changing something the user didn't mention AND that they plausibly care about (public API shape, dependency addition, schema change).
- [ ] Credentials/secrets/payments in any form.
- [ ] A taste decision that is long-lived and user-visible (UI layout, naming of a public API, choice between frameworks) with no signal in the repo, rules, or conversation. Present 2–3 options with a recommendation; don't pick silently. (See §6 — taste is a known system limit.)

Do NOT ask about: which of two equivalent internal implementations; formatting the repo already answers; whether to continue a task already assigned; anything reversible in under 5 minutes. Decide, write the assumption down in your report, proceed.

GOOD: "Fixing this requires renaming a public endpoint used by mobile clients — that's a breaking API change you didn't mention. Options: (a) rename + shim, (b)..."
BAD: "I found the bug. Should I fix it?" (That was the assignment. Asking is a stall.)

## §4 Wrong-direction signals — change approach, don't retry

Before ANY fix attempt: collect the full error/log/trace and ALL failing cases first — never patch based on the first stack trace alone (deep workflow: the `hard-problem-solving` skill).

Two or more checked = STOP. Revert to last green state. Write down your current hypothesis and two alternative approaches in one sentence each. Pick using a fresh-context second opinion (different model family) if available; otherwise pick the alternative that deletes the most assumptions.

- [ ] Same error class three times despite edits (you're not learning; you're guessing).
- [ ] Each "fix" adds scaffolding: special cases, try/except around the symptom, sleeps, retries around flakiness you introduced.
- [ ] You're about to edit vendored, generated, or node_modules/library code to make your change work.
- [ ] You're about to weaken the oracle: disable/skip a test, loosen an assertion, silence a linter rule — to make red turn green. HARD STOP, always, no counter-signal needed.
- [ ] You can't state in ONE sentence why the current attempt will succeed where the last one failed.
- [ ] The diff keeps growing while the observed behavior doesn't change.

GOOD: Two failed attempts to patch an async race in a callback → stop, revert, write: "hypothesis: shared state mutated across awaits; alternatives: (1) make handler idempotent, (2) move state into request scope" → second opinion picks (2) → clean fix.
BAD: Test fails with a timeout → raise the timeout from 5s to 30s → passes locally → declare victory. The race is still there; the oracle was weakened.

## §5 Quality floor — minimum bar for ANY change that lands

- [ ] Build + tests + lint pass (run, not assumed — quote exit codes).
- [ ] Reread the full diff hunk-by-hunk; every hunk traceable to the task. Unrelated drive-by changes reverted.
- [ ] Errors at system boundaries (user input, network, file I/O) handled the way _neighboring code in this repo_ handles them — no bare swallows, no new error-handling framework either.
- [ ] Names/style match the surrounding file, not your habits.
- [ ] No new dependency unless the user approved it (§3).
- [ ] Dead code deleted, not commented out.

GOOD: 4-file change; diff reread; one stray console.log removed before handoff; `pnpm lint` exit 0 and `pnpm test` exit 0 both quoted in the report (run as two commands — on PowerShell 5.1 do not chain with `&&`).
BAD: Feature works, but the diff also reformats 200 untouched lines because the agent's editor auto-formatted. Reviewer now can't see the real change. Rejected at the floor.

## §6 Honest limits — what this system CANNOT compensate for

Decomposition, escalation, and fresh-context verification compensate for _execution_ quality. They do not compensate for:

1. **Ambiguous intent.** No pipeline turns a fuzzy request into the right product. If two reasonable readings of the user's message lead to different deliverables → §3, ask (one batch of questions, not a drip).
2. **Taste.** Visual design, API ergonomics, writing voice. Checklists get you to "not broken", never to "good". Escalate to the highest available tier, generate 2–3 genuinely different candidates, have a different-family model rank them, and present the top options with trade-offs to the user. Do not present a checklist-pass as a taste-pass.
3. **Novel architecture trade-offs.** When the answer depends on facts about the future (scale, team, roadmap), the honest output is a decision memo: options, costs, what evidence would settle it — not a confident pick.
4. **Unverifiable claims.** If you can't check it, say so: mark the specific claim `UNVERIFIED` inline. Never silently downgrade "verified" to "probably fine". Fabricating a path, API, version number, or benchmark is the worst failure mode in this file.

The sentence "I could not verify X" or "this needs a stronger model / a human decision" is always an acceptable report. A confident wrong answer is not.

---
name: hard-problem-solving
description: Evidence-first troubleshooting for unclear, failing, or expensive problems. Use when the path is unclear, attempts are failing, or the symptom is costly, especially for performance, latency, cost, errors, concurrency, or contract bugs.
---

# Hard Problem Solving

## Overview

Use this skill to diagnose hard problems by measuring first and editing second. Debug the mechanism, not the label: a root-cause fix removes or changes the dominant reason the problem exists; a symptom fix renames, moves, or hides it. Choose the smallest intervention that moves the primary metric.

## Debug Pattern

Follow this sequence on every hard problem. Do not skip stages or implement before the plan is validated against the root cause.

```
RCA → Evidence → 3 Whys → Solution Plan → Address how this plan solves the problem → Fix
```

### 1. RCA (Root Cause Analysis)

Define what is actually broken before collecting data or proposing fixes.

- State the business or product impact in one line.
- Choose one primary success metric; record current value and target value.
- Separate symptoms from suspected causes; name the failure mode, not just the error label.
- Pick the most likely root-cause bucket (see below) as a starting hypothesis only — not a conclusion.

### 2. Evidence

Collect complete evidence before editing. Evidence must be able to explain the failure.

- Capture full logs, traces, profiles, and all failing cases (not just the first).
- Record environment, load conditions, and reproduction steps.
- Find dominant work: where most time, CPU, memory, I/O, or money is spent.
- Build a ranked list of top contributors; separate heavy contributors from incidental noise.
- Confirm the runtime contract: payloads, status codes, schemas, timing.

Do not edit until evidence can explain the failure.

### 3. 3 Whys

Drill from observed symptom to mechanism. Ask "why?" at least three times; stop when you reach something you can change that explains the dominant work.

Format each level explicitly:

- **Why 1:** Why does the symptom appear? → `<observed cause tied to evidence>`
- **Why 2:** Why does that happen? → `<next mechanism>`
- **Why 3:** Why does that happen? → `<dominant mechanism or irreducible constraint>`

Reject explanations that name a component without proving the burden it creates. If the chain stalls, descend one abstraction layer and repeat with fresh evidence.

### 4. Solution Plan

Propose the smallest intervention that removes or changes the dominant mechanism from the 3 Whys chain.

- Compare options by irreducible cost, not familiarity.
- Score copies, chunking, transitions, synchronization, predictability, complexity, and risk.
- Reject options that change the visible component but preserve the dominant mechanism.
- Choose the smallest decisive intervention; avoid broad rewrites unless the bottleneck is structural.

### 5. Address how this plan solves the problem

Validate the plan against the RCA and 3 Whys before implementing. This gate is mandatory.

- Trace the causal chain: plan change → mechanism removed or altered → metric movement.
- State explicitly which Why in the chain the plan addresses and how.
- Confirm the plan does not merely rename, move, or hide the symptom.
- List guardrails: contract regressions, shifted bottlenecks, or new failure classes to watch.
- If you cannot explain how the measured outcome will improve, return to Evidence or 3 Whys — do not implement.

Use Proposal Critique and Stop Conditions (below) at this stage.

### 6. Fix

Implement only after step 5 passes.

- Apply the minimal change from the solution plan.
- Verify against the original top-level metric end to end.
- Confirm no contract regressions or shifted bottlenecks.
- If the metric does not move, the root cause was not fixed — return to Evidence with fresh data, not incremental patching.

## Proposal Critique

Pause before accepting a proposed fix when:

- It changes the visible component but preserves the same burden.
- It reduces one local cost while the dominant loop remains.
- It adds a new layer to manage pain created by an older layer.
- It cannot explain how the measured outcome will improve.

Accept a riskier or more custom fix only when evidence shows the standard path cannot remove the dominant mechanism and the improvement is worth the ownership cost.

## Root-Cause Buckets

Use these buckets to keep the search focused:

- Contract or schema mismatches
- State or data integrity issues
- Async, concurrency, or synchronization failures
- Serialization, transport, or copy overhead
- Time, timezone, or order-of-events bugs
- Infrastructure or resource saturation

## Stop Conditions

Pause and redesign when:

- You need multiple unrelated edits before the story makes sense.
- New fixes keep creating new failure classes.
- You cannot explain the causal chain from change to metric movement.
- The fix is justified by familiarity, speed, or simplicity instead of mechanism change.

## Decision Note Template

Keep decisions short and explicit:

- Problem: `<impact + metric>`
- RCA: `<failure mode vs symptom>`
- Evidence: `<measurements, traces, cases, or observations>`
- 3 Whys: `<Why 1 → Why 2 → Why 3>`
- Dominant mechanism: `<what repeatedly creates the impact>`
- Solution plan: `<minimal change>`
- How plan solves it: `<causal chain from plan to metric>`
- Alternatives considered: `<A, B, C>`
- Irreducible cost comparison: `<why chosen option wins>`
- Verification: `<before/after metric + guardrails>`

## Expected Output Style

- Walk the debug pattern explicitly: RCA → Evidence → 3 Whys → Solution Plan → how it solves the problem → Fix.
- Keep output concise, evidence-backed, and single-path by default.
- Prefer one clear recommendation over many equal options.
- Call out assumptions when runtime evidence is missing.

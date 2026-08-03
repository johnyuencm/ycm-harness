---
name: autonomous-harness
description: >-
  Applies the portable autonomy baseline: durable follow-up references with live
  readback, evidence-first closure, deterministic cost control, bounded
  authority, and reversible execution. Use for autonomous or recurring work.
---

# Autonomous harness baseline

Canary: `PORTABLE_TARGET_CANARY_V1`

This skill is portable policy, not proof that later runtime enforcement exists.

## Operating contract

1. Inspect current evidence and existing tickets before acting.
2. For every mutation or deferred continuation, create or reuse a durable task/issue and immediately live-read its ID, objective, owner, status, and acceptance context. Prose-only follow-up is not captured.
3. Bounded read-only inspection may be ticket-exempt when it creates no continuation. If it discovers actionable work, ticket it before reporting it as deferred.
4. Run deterministic scripts, focused reads, and existing tests before using an agent. When an agent is required, use the least expensive adequate tier and one bounded correction path. Do not add a per-run LLM judge where deterministic validation works.
5. Stay inside the sandbox, selected repository/worktree, and explicit external authority. Snapshot affected state and define rollback before installation, scheduling, messaging, credential, or user-level mutation.
6. Separate observation, guidance, shadow evidence, and enforced behavior. Never claim a control exists until its target-native mechanism and tests pass.
7. Finish only after current evidence, tests, live ticket reconciliation, rollback/re-enable, and independent review satisfy the owning phase.

Read [operating-policy.md](references/operating-policy.md) for the decision table, memory boundary, assurance language, and phase exclusions.


---
name: ycm-harness-design
description: Turn a non-trivial coding goal into a bounded lean ycm-harness goal and implementation-ready tickets before execution.
---

# ycm-harness design

Use this skill when scope or acceptance needs design before implementation.

1. Inspect the repository and existing issue/spec context.
2. Resolve the problem, constraints, non-goals, risks, and observable success
   criteria with the user when code and docs cannot answer them.
3. Run `ycm-harness status`; initialize state if absent.
4. Create one goal. Use local tickets by default; use the GitHub backend only
   when an existing parent issue and Project binding are known.
5. Create dependency-ordered vertical-slice tickets. Each ticket must be small
   enough for one implementation pass, contain observable acceptance criteria,
   and include enough context for a fresh implementer.
6. Record major decisions with `ycm-harness checkpoint decision`.
7. Run `ycm-harness next` and hand execution to `ycm-harness-work`.

Do not prescribe speculative abstractions or fabricate issue/project bindings.
Do not use the retired phase, ritual, artifact, review, session, or user-wiki
commands.

---
name: run-technical-design-discussion
description: Run, use, or test an evidence-grounded technical architecture discussion covering competing designs, mechanism overlap, source-of-truth choices, recommendations, user decisions, and implementation planning.
---

# Technical Design Discussion

## Run (agent path)

Use this skill directory's `driver.mjs` (the folder that contains this `SKILL.md`). The driver collects a deterministic evidence packet; the agent supplies research, architectural judgment, and the human-facing discussion.

Resolve `SKILL_DIR` to that folder (for a Cursor/OpenCode user install that is typically `~/.cursor/skills/run-technical-design-discussion` or the matching project `.cursor/skills/...` path; inside this repo it is `plugin/skills/run-technical-design-discussion`).

Syntax-check and test the driver:

```bash
node --check "$SKILL_DIR/driver.mjs"
node --test "$SKILL_DIR/driver.test.mjs"
```

Collect an evidence packet for the target repository (write output outside the repo):

```bash
node "$SKILL_DIR/driver.mjs" collect \
  --repo . \
  --goal "Decide the reliable policy for <mechanism>, then produce an executable implementation plan." \
  --evidence context=CONTEXT.md grilling-evidence=docs/harness/discuss-grill-me-evidence.md product-requirements=docs/harness/prd.md technical-design=docs/harness/design.md \
  --out /tmp/technical-design-packet.json
```

Enrich the packet to `stage: "discussion"` and validate it before asking the next user decision:

```bash
node "$SKILL_DIR/driver.mjs" validate --packet /tmp/technical-design-packet.json
```

A valid `discussion` packet must stop before implementation planning. After the user answers, resolve the decision, set `stage: "final"`, add the executable plan, and run the same validator again before presenting the final design.

Run the isolated non-mutation smoke check:

```bash
node "$SKILL_DIR/driver.mjs" smoke --repo .
```

## Driver boundary

The driver is read-only with respect to the target repository and writes collected output only outside it. It is deterministic and performs bounded local file reads, Git metadata collection, packet validation, and an isolated smoke check.

It does not call an LLM, access the network, make architectural judgments, conduct the discussion, mutate repository files, implement a plan, or authorize work. Those remain agent responsibilities.

## Discussion workflow

1. **Frame the decision.** State the goal, measurable success criteria, in-scope and out-of-scope work, constraints, and assumptions. If the prompt is ambiguous, identify the decision that must be made rather than broadening scope silently.
2. **Research discoverable facts.** Prefer primary sources: repository code and configuration, official documentation, specifications, and first-party source. Research facts instead of asking the user to supply them. Never present an unverified claim as fact.
3. **Inspect the local implementation.** Trace entry points, ownership, state and data flow, persistence, lifecycle, error handling, tests, and callers. Cite exact repository files and line ranges.
4. **Classify every material claim.** Use `Fact` for directly established evidence, `Inference` for a conclusion supported by cited evidence, and `Unknown` when evidence is absent or conflicting.
5. **Analyze overlap and source of truth.** Compare existing and proposed mechanisms by responsibility, owner, data model, write path, read path, lifecycle, failure behavior, and cleanup. Identify duplication, split-brain state, ordering hazards, and which mechanism should be authoritative.
6. **Design it twice.** For consequential choices, provide at least two genuinely distinct options, including retaining or simplifying the current mechanism when credible. Compare correctness, complexity, migration cost, operability, reversibility, and verification. Do not manufacture alternatives for a trivial question.
7. **Recommend.** Lead with the recommended option and why it best satisfies the evidence and constraints. Separate evidence-backed rationale from judgment and state what could overturn the recommendation.
8. **Resolve user decisions one at a time.** Present the recommended answer first, then ask exactly one decision question and wait. Resolve dependencies before later questions. Do not ask the user for discoverable facts or present a batch questionnaire.
9. **Plan only after the decision is stable.** Produce dependency-ordered implementation steps, criterion-linked verification, risks, and a rollback or disable path. The plan must be executable but is not authorization to execute.

## Enrich and validate the packet

Treat `collect` output as scaffolding, not the analysis. Read each collected source and replace generic claims with concise findings before writing the human-facing response.

- Preserve `schemaVersion`, repository identity, stable source order, source metadata, and required discussion categories.
- `collect` creates `stage: "scaffold"`. Change it to `discussion` only after evidence analysis is complete; that stage permits exactly one unresolved decision and requires an empty executable plan. Change it to `final` only after all decisions are resolved and the executable plan is complete.
- Preserve driver-assigned source IDs (`S1`, `S2`, ...). Number claims as `C1`, options as `O1`, decisions as `D1`, success criteria as `SC1`, and plan steps as `P1`; IDs are unique across their category.
- A claim contains `id`, `classification`, `statement`, and `citations`. Attach citations to every `Fact` and `Inference`; each citation contains `sourceId`, inclusive `startLine`/`endLine`, and `excerptHash`, the lowercase SHA-256 of those lines joined with `\n`.
- Give `Unknown` claims no citations. Convert an unknown only when evidence supports the new classification.
- Fill goal, scope, constraints, current mechanisms, local implementation, overlap, options, recommendation, unresolved questions, risks, and success criteria with evidence-specific content.
- For consequential designs, record at least two distinctly titled options; each needs nonempty evidence-backed claims and trade-offs.
- Keep a decision unresolved with `answer: null`; after the user answers, mark it resolved, record the answer, and support its rationale only with `Fact` or `Inference` claims.
- Order `executablePlan` through `dependsOn`, link every step to success criteria, state deterministic verification, and include migration and rollback actions where relevant.
- Re-run validation after enrichment and after any evidence file changes. Do not present a completed design packet if validation fails; correct stale hashes, invalid citations, missing dependencies, or unsupported classifications first.

External primary sources may inform the analysis, but the packet's structured citations can reference only files collected by the driver. If a material claim is not supported by collected evidence, keep it `Unknown` in the packet and identify the missing primary evidence rather than fabricating support.

## Human-facing response contract

Lead with the verdict. For `stage: "discussion"`, present items 1-10 and then stop for the user's answer. Only a validated `stage: "final"` response may add items 11-13.

1. Verdict
2. Goal, success criteria, scope, and constraints
3. Current mechanism and local implementation
4. Evidence with primary-source or repository citations
5. Fact / Inference / Unknown classifications
6. Mechanism overlap and source-of-truth analysis
7. Competing options and trade-offs
8. Recommendation and overturning conditions
9. Risks
10. Resolved decisions and the next single unresolved decision, with the recommended answer first; stop here and wait
11. Dependency-ordered implementation plan
12. Verification mapped to success criteria
13. Rollback or disable path

Scale this structure down for trivial questions, but retain a verdict, evidence, classification, and recommendation. Never continue past an unresolved user decision, bury uncertainty, or imply that a discussion-only plan was implemented.

## Mode and harness boundaries

This is a headless, library-style, discussion-only workflow. Do not start a GUI, server, screenshot flow, or human-run path.

If Plan mode is active, remain in Plan mode and return only research, decisions, and a plan. Implementation requires separate, explicit authorization after the discussion.

Do not invoke, reproduce, or rename YCM Harness phases, tasks, artifacts, worktrees, validation, or finish procedures. The evidence packet and discussion stand alone; they do not replace or enter YCM Harness workflow state. After decisions are stable, hand off to `ycm-harness-design` / `ycm-harness-work` only when the user explicitly asks to enter harness workflow state.

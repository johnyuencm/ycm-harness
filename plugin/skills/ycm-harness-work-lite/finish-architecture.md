# Ship: architecture pass (`improve-codebase-architecture`)

Mandatory before claiming lite done, after the first commit/push and before the llm-wiki run record.

## Attach the skill

Follow `~/.cursor/skills/improve-codebase-architecture/SKILL.md` (plugin: `skills/improve-codebase-architecture/SKILL.md`). Also read **`codebase-design`** from the same plugin when the report needs design vocabulary.

## Procedure

1. Run the attached **`improve-codebase-architecture`** skill (external mattpocock — not bundled in harness).
2. Scope to this lite run's diff / recent commits (YAGNI hot spots from what just shipped).
3. Write the HTML report under `%TEMP%/architecture-review-<timestamp>.html` (or `$TMPDIR` / `/tmp`) and open it for the user.
4. **Harness override — do not follow the skill's grilling gate.** Do **not** ask "Which of these would you like to explore?" Do **not** wait for a pick. Dispatch **one** implementer (`plugin/agents/implementer.md` when available) with the report as the spec. Implement every candidate in the report (Strong, Worth exploring, and Speculative). Start with the **Top recommendation**, then the rest. Orchestrator does not write this product code. No harness GitHub follow-ups in lite.
5. Skip only candidates marked as contradicting an ADR, and destructive/irreversible work the user did not authorize. Name those leftovers. An empty report means nothing to implement.
6. Re-run the project's real verify command. Fix failures via implementer. Commit and push the architecture changes per environment rules.
7. Carry implemented candidates plus the **Top recommendation** into the final user report and the llm-wiki run record. Do **not** re-run the architecture skill after implementing (one pass).

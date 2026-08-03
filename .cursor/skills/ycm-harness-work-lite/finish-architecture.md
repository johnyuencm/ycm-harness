# Ship: architecture pass (`improve-codebase-architecture`)

Mandatory before claiming lite done, after commit/push and before the final user report.

## Attach the skill

Follow `~/.cursor/skills/improve-codebase-architecture/SKILL.md` (plugin: `skills/improve-codebase-architecture/SKILL.md`). Also read **`codebase-design`** from the same plugin when the report needs design vocabulary.

## Procedure

1. Run the attached **`improve-codebase-architecture`** skill (external mattpocock — not bundled in harness).
2. Scope to this lite run's diff / recent commits (YAGNI hot spots from what just shipped).
3. Write the HTML report under `%TEMP%/architecture-review-<timestamp>.html` (or `$TMPDIR` / `/tmp`) and open it for the user.
4. Include the **Top recommendation** in the final user report (no harness GitHub follow-ups in lite).
5. Do **not** block completion on the optional grilling loop unless the user picks a candidate in-session.

# 11-INVENTORY-claude — Example Claude Code model map

Audience: commanders in a **Claude Code** session only. Do not load this file
from Cursor or Codex.
Parent protocol: `10-DISPATCH.md`. Re-verify on alias error per
`10-DISPATCH.md` §8.

**Example only.** Replace the IDs below with models verified in *your*
Claude Code / proxy session (`/model`, Agent tool). Do not treat this table as
operator-specific machine config.

## Dispatch by agent type, not by model ID

The Agent tool's `model` parameter is an enum (`sonnet`, `opus`, `haiku`,
`fable`); any other value fails with `InputValidationError`. There is no
`effort` parameter. Model and effort are settable **only** in an agent
definition's frontmatter:

```markdown
---
name: implementer-mid
description: MID implementation worker.
tools: Read, Glob, Grep, Edit, Write, Bash
model: your-mid-tier-model-id
effort: max
---
```

So a dispatch names a **`subagent_type`**; model and effort ride along from the
definition. Put the files in `~/.claude/agents/` (or a directory passed to
`claude --agents`). They load **once at launch** — a new or edited definition
needs a Claude Code restart, or the dispatch fails `Agent type 'x' not found`.

A rung with no agent definition behind it is a missing file, not a blocked
dispatch: report which definition is missing and use the next rung.

| Tier          | Example agent type   | Example model / effort               | Notes                      |
| ------------- | -------------------- | ------------------------------------ | -------------------------- |
| FAST          | `explorer-fast`      | your flash-tier ID, `high`, read-only | explore / mechanical      |
| MID (default) | `implementer-mid`    | your mid-tier ID, `max`               | implementer + verification |
| HIGH          | `implementer-high`   | your high-tier ID, `high`/`xhigh`     | escalations                |
| MAX           | `implementer-max`    | your strongest ID, `max`              | taste / adversarial        |

If you use a proxy that remaps Claude aliases, document those remaps in your
**private** operator overlay / local `LESSONS.md`, not in this public template.

Do **not** set `CLAUDE_CODE_SUBAGENT_MODEL` globally — it overrides per-agent
`model:` and forces inheritance bugs. If an alias resolves wrong, check
`ANTHROPIC_DEFAULT_*_MODEL` remaps and that `CLAUDE_CODE_SUBAGENT_MODEL` is
unset.

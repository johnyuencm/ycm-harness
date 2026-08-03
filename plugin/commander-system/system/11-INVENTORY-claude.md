# 11-INVENTORY-claude — Example Claude Code model map

Audience: commanders in a **Claude Code** session only. Do not load this file
from Cursor or Codex.
Parent protocol: `10-DISPATCH.md`. Re-verify on alias error per
`10-DISPATCH.md` §8.

**Example only.** Replace the IDs below with models verified in *your*
Claude Code / proxy session (`/model`, Agent tool). Do not treat this table as
operator-specific machine config.

Dispatch via Agent / Task. Prefer an explicit **model ID + effort** over a bare
alias when effort differs from the session default.

| Tier          | Example preferred pick              | Example alt pick                  | Notes                          |
| ------------- | ----------------------------------- | --------------------------------- | ------------------------------ |
| FAST          | `haiku` (or your flash-tier ID)     | your low-cost coding ID           | explore / mechanical           |
| MID (default) | `sonnet` (or your mid-tier ID)      | your implementer ID + effort      | implementer + verification     |
| HIGH          | `opus` (or your high-tier ID)       | same family + higher effort       | escalations                    |
| MAX           | your strongest available ID + max   | alternate frontier ID + max       | taste / adversarial            |

If you use a proxy that remaps Claude aliases, document those remaps in your
**private** operator overlay / local `LESSONS.md`, not in this public template.

Do **not** set `CLAUDE_CODE_SUBAGENT_MODEL` globally — it overrides per-agent
`model:` and forces inheritance bugs. If an alias resolves wrong, check
`ANTHROPIC_DEFAULT_*_MODEL` remaps and that `CLAUDE_CODE_SUBAGENT_MODEL` is
unset.

# 11-INVENTORY-codex — Example Codex model IDs

Audience: commanders in a **Codex** session only. Do not load this file from
Cursor or Claude Code.
Parent protocol: `10-DISPATCH.md`. Re-verify on unsupported-model error per
`10-DISPATCH.md` §8.

**Example only.** Replace the IDs below with models verified against *your*
Codex account / proxy. Accounts may subset the catalog — treat unavailable picks
as a mechanical failure and rerun on the default inherited model.

Prefer raising `reasoning_effort` over jumping models when the role is right
but thinking is shallow. **Do not import Cursor Task slugs.**

| Tier          | Example model ID                              | Notes                              |
| ------------- | --------------------------------------------- | ---------------------------------- |
| FAST          | your mini / flash coding ID                   | recon / mechanical                 |
| MID (default) | your default coding ID                        | implementer + review               |
| HIGH          | your high-reasoning coding ID                 | escalations, hard debugging        |
| MAX           | same high ID + high/`xhigh` reasoning_effort  | taste / adversarial                |

Account-specific availability notes belong in private operator tracking /
local `LESSONS.md`, not in this public template.

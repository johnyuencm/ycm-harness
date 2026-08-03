# 11-INVENTORY-cursor — Example Task model slugs

Audience: commanders in a **Cursor** session only. Do not load this file from
Claude Code or Codex.
Canonical for Cursor; when slugs change, update this file first, then the
ycm-harness `commander-dispatch.md` mirror.
Parent protocol: `10-DISPATCH.md` (tiers + dispatch rules). Re-verify on slug
error per `10-DISPATCH.md` §8.

**Example defaults** (replace after verifying against the live Task allowlist):

| Tier          | Example slug           | Use for                                              |
| ------------- | ---------------------- | ---------------------------------------------------- |
| FAST          | `composer-2.5`         | explore / file finding / repo scans only             |
| MID (default) | `cursor-grok-4.5-high` | implementation, refactors, research, standard review |
| HIGH          | `cursor-grok-4.5-high` | hard debugging, architecture, escalations            |
| MAX           | `cursor-grok-4.5-high` | taste / adversarial review                           |

Suggested pattern: use a strong general slug for most Task/subagent work;
restrict explore-only agents to a cheaper/faster explore slug (and its
allowlist fallback if required).

Effort in Cursor is encoded in the slug (`-high`, `-max`, `-fast`) — choosing
the slug IS choosing effort. Never omit `model` on Task dispatches (no inherit).

Subagent types (`subagent_type`): `explore` (read-only; thoroughness
quick/medium/very thorough), `generalPurpose` (implementation),
`docs-researcher`, `code-reviewer`, `best-of-n-runner`, `shell`,
`browser-use`. Flags: `readonly: true` for verification;
`run_in_background: true`; multiple Task calls in one message = parallel.

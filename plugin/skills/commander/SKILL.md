---
name: commander
description: Global commander protocol for delegation-heavy work. Use at the start of any task that will take more than ~3 tool calls, before dispatching any subagent, when choosing a model tier, when deciding if work is done or should be retried/escalated, or when the user mentions commander mode, dispatch rules, or the agent system.
---

# Commander protocol (pointer skill)

The system lives in `~/.agents/system/`. This skill only routes you there — start with the file the current situation routes to, and read another routed file only when the task actually reaches that decision (never all of them up front).

| Situation                                                      | Read                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Delegating anything; choosing subagent type/model/tier         | `~/.agents/system/10-DISPATCH.md`, then **only** matching `11-INVENTORY-{cursor\|claude\|codex}.md` |
| Is it done? Retry or escalate? Ask the user? Wrong direction?  | `~/.agents/system/20-JUDGMENT.md`                                                                   |
| Writing the actual dispatch prompt                             | `~/.agents/system/30-TEMPLATES.md`                                                                  |
| Editing the system files themselves                            | `~/.agents/system/40-MAINTENANCE.md`                                                                |
| Long/multi-session effort starting; or curious why rules exist | `50-LETTER.md`, `00-DIAGNOSIS.md`, `LESSONS.md` (same dir)                                          |

Iron rules if you read nothing else: delegate anything returning >200 lines into your context (conclusions + file:line come back, not dumps); every dispatch = goal+context, acceptance criteria, report format; the author never verifies their own work; max 3 attempts per subtask and never two identical ones (each retry escalates tier or changes approach; after the 3rd failure stop and reassess); ask the user before destructive/irreversible actions; write hard-won environment facts to `LESSONS.md` in the same turn you learn them.

One workflow system per session: if ycm-harness is active, follow its SOP and use these files only for model-tier choice and verification discipline.

Install/refresh the system files on a machine with:

```bash
npm run commander:install
# or: node plugin/scripts/install-commander.mjs
```

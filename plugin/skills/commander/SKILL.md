---
name: commander
description: Global commander protocol for delegation-heavy work. Use at the start of any task that will take more than ~3 tool calls, before dispatching any subagent, when choosing a model tier, when deciding if work is done or should be retried/escalated, or when the user mentions commander mode, dispatch rules, or the agent system.
---

# Commander protocol (plugin-sourced)

The ycm-harness plugin is the **only** golden source. These files update when the plugin updates. Do **not** read `~/.agents/system/` for protocol (local copies are retired).

Resolve guides from this SKILL.md: `../../commander-system/system/<file>.md` (plugin root `commander-system/system/`, next to `skills/`). If this SKILL.md is a copy outside the plugin, use the installed ycm-harness plugin's `commander-system/system/` instead.

| Situation                                                      | Read                                                                                                |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Delegating anything; choosing subagent type/model/tier         | `../../commander-system/system/10-DISPATCH.md`, then **only** matching `11-INVENTORY-{cursor\|claude\|codex}.md` |
| Is it done? Retry or escalate? Ask the user? Wrong direction?  | `../../commander-system/system/20-JUDGMENT.md`                                                      |
| Writing the actual dispatch prompt                             | `../../commander-system/system/30-TEMPLATES.md`                                                     |
| Editing the system files themselves                            | `../../commander-system/system/40-MAINTENANCE.md`                                                   |
| Long/multi-session effort starting; or curious why rules exist | `50-LETTER.md`, `00-DIAGNOSIS.md` (same folder); machine journal `~/.agents/system/LESSONS.md`      |

Iron rules if you read nothing else: delegate anything returning >200 lines into your context (conclusions + file:line come back, not dumps); every dispatch = goal+context, acceptance criteria, report format; the author never verifies their own work; max 3 attempts per subtask and never two identical ones (each retry escalates tier or changes approach; after the 3rd failure stop and reassess); ask the user before destructive/irreversible actions; write hard-won environment facts to `~/.agents/system/LESSONS.md` in the same turn you learn them.

One workflow system per session: if ycm-harness is active, follow its SOP and use these files only for model-tier choice and verification discipline.

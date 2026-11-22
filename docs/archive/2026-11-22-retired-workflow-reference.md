# Archived workflow reference (moved 2026-11-22)

This file keeps reference text that contradicted the 0.3 CLI.
The commands below exit 2 in ycm-harness 0.3, or they describe state the lean kernel no longer writes.
The living install and command reference is [`docs/reference.md`](../reference.md).
The release contract is [`docs/lean-0.3.md`](../lean-0.3.md).
The work procedure is `plugin/skills/ycm-harness-work/SKILL.md`.

Do not follow this file for new work.

The excerpt below links to `docs/workflow-doctrine.md`. That file is not in this repo. The link was already broken on `master` when this text was moved.

<!-- source: docs/reference.md lines 231-346 as of master fa04705 -->

## V1 golden path

```bash
ycm-harness init
ycm-harness goal create "Ship feature X"
ycm-harness goal worktree init        # V5: bind .worktrees/<slug>/ (detached HEAD, no new branch)
ycm-harness phase start explore       # V5: first phase
ycm-harness artifact register --kind explore-synthesis --path artifacts/explore-synthesis.md
ycm-harness ritual record --kind explore-codebase --evidence-file artifacts/explore-synthesis.md --summary "..."
ycm-harness ritual record --kind explore-knowledge-base --evidence-file artifacts/explore-knowledge-base.md --summary "..."
ycm-harness phase start discuss
ycm-harness checkpoint decision "Approach chosen" --decision "Use approach A"
ycm-harness phase start plan
ycm-harness phase start execute
ycm-harness task create "Implement first feature"
ycm-harness task start <task_id>
ycm-harness smoke --task <task_id> --command "npm test" --expected "tests pass" --actual "tests pass" --outcome pass --exit 0
ycm-harness task done <task_id>
ycm-harness phase start validate
ycm-harness smoke --phase <phase_id> --outcome pass --command "npm run e2e"
ycm-harness phase complete
ycm-harness phase start finish
ycm-harness checkpoint manual "Goal closed"
```

`ycm-harness status` prints the current goal/phase/task with recent decisions and the suggested next command. `ycm-harness next` prints just the next-action command.

Tasks drafted during `plan` migrate forward automatically: `task list` from `execute` shows the active-phase tasks first and queues plan-phase tasks underneath, and `task start <id>` migrates the task into the active phase.

## V4 strict SOP: how the workflow actually runs

V4 is not just a command log. It is a strict SOP:

```text
discuss -> plan -> execute -> validate -> finish
```

Each phase has mandatory rituals. The CLI refuses to leave a phase until its ritual and artifact gate is satisfied.

### Discuss

Always invoke `grill-with-docs` (and `domain-modeling` as decisions crystallize). Resolve the goal, constraints, accepted approach, non-goals, unresolved risks, and success criteria. Record at least one decision checkpoint and a ritual:

```powershell
ycm-harness checkpoint decision "Design resolved" -d "..."
ycm-harness ritual record --kind grill-me --evidence-file <file> --summary "grill-me resolved the design tree"
```

### Plan

Always invoke `writing-plans`. Record whether `ralplan` is required. `ralplan` is required for architecture, security, data persistence, multiple subsystems, more than 5 files, parallel agents, or high-risk scope.

```powershell
ycm-harness ritual record --kind writing-plans --evidence-file <plan-file> --summary "Plan complete" --meta ralplan_required=true
ycm-harness ritual record --kind ralplan --evidence-file <consensus-file> --summary "Consensus plan complete"
ycm-harness task create "First task" -b "Acceptance criteria and validation notes"
```

Use `--meta ralplan_required=false` when no trigger applies.

### Execute

Always invoke `ultrawork`, then `ralph`. Record both rituals. Complete or block every task. Runnable tasks need smoke evidence before `task done`.

```powershell
ycm-harness ritual record --kind ultrawork --evidence-file <ledger> --summary "Task lanes executed"
ycm-harness ritual record --kind ralph --evidence-file <completion-report> --summary "Ralph completion verified"
ycm-harness smoke --task <task_id> --command "npm test" --expected "pass" --actual "pass" --outcome pass --exit 0
ycm-harness task done <task_id>
```

### Validate

Run phase-level build/test/lint/smoke. Always open the review gate with the two-phase panel (`tech_lead` × `project_manager` debate, then `user_advocate` last), different from every author/implementer. If the gate fails, run the fix-loop using `$hard-problem-solving` before editing (RCA, Evidence, 3 Whys, Fix plan, why it fixes the root cause, fix, re-test, re-review). Close a passed phase-targeted review and record `review-gate`.

### Finish

Update the project wiki, record `project-wiki-update`, run user-wiki dry-run for reusable cross-project lessons, ask before `--confirm`, and record the final manual checkpoint.

Full doctrine: [`docs/workflow-doctrine.md`](workflow-doctrine.md).

## V2 wiki memory

The wiki is a project-local knowledge surface the agent grows over time. Sources are immutable inputs (copied into `wiki/raw/`); pages are agent-synthesised summaries of one or more sources. JSON state owns metadata; `pages/<id>.md` and the generated overview and log files are readable mirrors.

```bash
ycm-harness wiki init
ycm-harness wiki source add docs/architecture.md --title "Architecture overview"
ycm-harness wiki page upsert \
  --id arch-summary \
  --title "Architecture summary" \
  --source <source_id> \
  --body-file /tmp/page-body.md
ycm-harness wiki page list
ycm-harness wiki query "session digest"
ycm-harness wiki lint --json
ycm-harness wiki checkpoint -n "post-refactor knowledge sweep"
```

Page bodies may reference other pages with `[[other-page-id]]`. `wiki lint` reports orphans (no sources), missing references, and pages stale beyond `--stale-days` (default 14). The session-start hook adds a compact wiki block (`Wiki: pages=N sources=M`, last 3 wiki log entries) so the agent re-orients on the project's knowledge state at the top of every conversation.

## V3 user wiki + promotion

The user wiki at `~/.ycm-harness/wiki/` mirrors the project wiki layout but holds knowledge that is durable across projects. Promotion is explicit: project pages are scrubbed by a builtin redactor before they land in the user wiki.

```bash
ycm-harness user-wiki init                      # one-time scaffold under $HOME
ycm-harness wiki promote arch-summary --rules   # list redaction rule ids
ycm-harness wiki promote arch-summary --dry-run # preview redacted body
ycm-harness wiki promote arch-summary --confirm # write to ~/.ycm-harness/wiki/pages/arch-summary.md
ycm-harness user-wiki page-list
ycm-harness user-wiki query "deployment"
ycm-harness user-wiki lint --json
```

Builtin redactor strips emails, IPv4 addresses, OpenAI / Anthropic / GitHub / Stripe / AWS API keys, PEM private-key blocks, and absolute home-directory paths. Use `--allow <regex>` to keep specific matches, `--extra <regex>` to add project-specific patterns. Override the user-wiki home for testing with the `YCM_HARNESS_HOME` environment variable.

<!-- source: docs/reference.md lines 367-376 as of master fa04705 -->

## V3 session nudge

Cursor does not yet expose per-message hook events, so the harness exposes a polled counter the agent ticks itself.

```bash
ycm-harness session tick --kind user_message    # call once per visible user reply
ycm-harness session nudge --json                # {due, count, threshold:15}
```

`wiki init`, `wiki source add`, and `wiki page upsert` reset the counter automatically. The session-start hook adds a `WIKI UPDATE DUE` line to `additional_context` whenever the threshold is exceeded, prompting the agent to capture the most recent learning before continuing.

<!-- source: docs/reference.md lines 416-427 as of master fa04705 -->

## Workflow contract

Phases (V4): `discuss → plan → execute → validate → finish`. `blocked` is an escape state, not a phase.

Rules:

- First phase must be `discuss`.
- Forward transitions advance one phase at a time. Rollbacks are allowed and recorded.
- Forward transitions and `phase complete` are blocked unless the current phase's V4 ritual/artifact gate is satisfied.
- Tasks belong to the active phase. Only one task is `active` per phase at a time.
- A task with `smoke = required` cannot be marked `done` until at least one `SmokeEvidence` is attached. Use `--smoke not_applicable` plus `--reason` for docs/config-only tasks.
- `phase complete` marks the active phase complete; starting the next phase auto-completes the previous one.

<!-- source: docs/reference.md lines 477-484 as of master fa04705 -->

## Future phase backlog

V4 lands strict SOP ritual enforcement. V5 adds executed-smoke and subagent-evidence review enforcement (strict by default).

Open work:

- **Native per-message hooks.** Replace the polled `session tick` with a Cursor-native hook event once `userMessage` (or equivalent) is exposed.
- **Wiki conflict resolution.** When `wiki promote` updates an existing user-wiki page, surface a structured diff and let the agent merge instead of overwrite.


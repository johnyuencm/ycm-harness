# ycm-harness reference

Full reference for the CLI, hooks, install paths and state layout. Start with the [README](../README.md).

## Output style

Agents write every reply, report and doc in ASD-STE100 Simplified Technical English, about 80% strict. The commander entry files hold the rule, and `ste-reminder-hook.mjs` repeats it on every prompt. Use the `explainer` skill when a diagram, an HTML page or a video is clearer than text. The harness does not use caveman.

## Recommended vendor plugins

ycm-harness stays a thin coordination kernel. It does **not** vendor third-party
skill packs. Install these separately; `ycm-harness doctor` audits all three.

| Plugin | Role in the agentic loop | Install hint |
| ------ | ------------------------ | ------------ |
| [mattpocock-skills](https://github.com/mattpocock/skills) (`mattpocock-skills@mattpocock`) | Spec/tickets, TDD, architecture finish passes the harness skills call out | `claude plugin marketplace add mattpocock/skills && claude plugin install mattpocock-skills@mattpocock` then `/setup-matt-pocock-skills` |
| [ralph-loop](https://github.com/anthropics/claude-plugins-official) (`ralph-loop@claude-plugins-official`) | Persistence loop during long execute turns | `claude plugin install ralph-loop@claude-plugins-official` |
| [ponytail](https://github.com/DietrichGebert/ponytail) (`ponytail@ponytail`) | Minimalism / YAGNI discipline so agents write less code | `claude plugin marketplace add DietrichGebert/ponytail && claude plugin install ponytail@ponytail` (Cursor: install from the marketplace, or copy `.cursor/rules/ponytail.mdc`) |

Other complementary skills are fine as long as you keep **one** workflow OS per
session: ycm-harness coordination plus these vendor skills, not a second
competing harness.

## Paste this to an agent

Copy the entire block below into a coding-agent chat **in the project you want
coordinated**. The agent should install the CLI (if needed), project the client
assets, initialize harness state, and report readiness — you should not have to
run the steps by hand.

````text
Set up ycm-harness for this project so agentic work can use durable goals,
tickets, checkpoints, and separate implementer/verifier evidence.

Execute end-to-end. Only ask me when something is destructive, needs a secret,
or needs a choice you cannot infer.

### Preconditions
- Node.js 20+ and Git available (`node -v`, `git --version`).
- Work in THIS project root (the repo I opened), not inside the harness source,
  except when building/linking the CLI.

### 1. Install the CLI if missing
If `ycm-harness --help` already works, skip to step 2.

Otherwise install from this private checkout (or the public ycm-harness mirror):

```bash
git clone <this repo URL> "$HOME/src/ycm-harness"
cd "$HOME/src/ycm-harness"
npm ci
npm run build
npm link
ycm-harness --help
```

On Windows PowerShell, use a stable tools path instead of `$HOME/src/...`
(e.g. `$env:USERPROFILE\src\ycm-harness`). Reuse an existing clone if present;
do not nest a second clone inside my project unless I ask.

Also install portable commander templates, then the personal overlay:

```bash
npm run commander:install
npm run commander:overlay -- --force
```

### 2. Project client assets into my agent host
Detect whether this workspace is Cursor and/or OpenCode. Then:

```bash
ycm-harness install --client cursor
# or: ycm-harness sync
ycm-harness doctor
```

Fix doctor failures that are clearly install-related. Do not invent personal
paths or commit machine-specific audits into a public product repo.

### 3. Recommended vendor plugins (not bundled)
ycm-harness does not ship these. Prefer installing them; `ycm-harness doctor`
audits all four when Cursor and/or Claude Code is present:

- mattpocock-skills@mattpocock — TDD / architecture finish
  `claude plugin marketplace add mattpocock/skills && claude plugin install mattpocock-skills@mattpocock`
  then `/setup-matt-pocock-skills`
- ralph-loop@claude-plugins-official — long-run persistence
  `claude plugin install ralph-loop@claude-plugins-official`
- ponytail@ponytail — minimalism / YAGNI
  `claude plugin marketplace add DietrichGebert/ponytail && claude plugin install ponytail@ponytail`
  (Cursor: marketplace install, or copy `.cursor/rules/ponytail.mdc`)

If a plugin cannot be installed non-interactively, list the exact command I
should run and continue with the rest of setup.

### 4. Initialize harness state in THIS project
From my project root:

```bash
ycm-harness init
ycm-harness status
ycm-harness next
```

If I already named an outcome in this chat, create a local goal and a first
ticket with observable acceptance criteria:

```bash
ycm-harness goal create "<outcome>" --backend local
ycm-harness ticket create "<first slice>" \
  --code-changed \
  --acceptance "<observable check>"
ycm-harness status
ycm-harness next
```

Use `--backend local` unless I explicitly asked for GitHub (then I must provide
owner/repo/project/parent — do not invent them).

### 5. Done criteria
Report back with:
1. `ycm-harness` path / version proof (`ycm-harness --help` ok)
2. which client install ran and `doctor` summary (include mattpocock / ralph /
   ponytail status when shown)
3. which vendor plugins are present vs still need a manual install
4. whether `.ycm-harness/` was initialized
5. goal/ticket IDs if created
6. anything I must do manually (e.g. restart the IDE session so hooks load)

Do not start implementing product code in this setup turn unless I also asked
for that work. After setup, prefer the installed `ycm-harness-work` skill for
the claim → implement → submit → verify loop.
````

## Install

```bash
git clone <this repo URL> ycm-harness
cd ycm-harness
npm install
npm run build
npm link            # exposes the `ycm-harness` bin
```

Node.js **>= 20**. See also [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## One-click client install / update

Sync the packaged plugin assets into every detected local client:

```bash
ycm-harness sync
```

Installs are global (user-level). `install`, `sync` and `doctor --repair` never write harness copies into the current project. Older versions copied skills, agents and `rules/ycm-harness.mdc` into a project's `.cursor/`. Those copies duplicate the global plugin: `ycm-harness doctor` lists identical copies as `project_leftovers`, and `ycm-harness doctor --repair` removes them. A same-named path that differs from the plugin source, or has extra files, is kept and listed as `project_leftovers_kept`. Inspect a kept path and delete it manually if it is an old harness copy; `--repair` will not remove it, and it can shadow the global skill in that project.

Useful variants:

```bash
ycm-harness sync --cursor
ycm-harness sync --codex
ycm-harness sync --claude              # GitHub marketplace with autoUpdate (default)
ycm-harness sync --claude --claude-local  # this checkout only; no git autoUpdate
ycm-harness sync --claude --claude-ref master
ycm-harness sync --all
ycm-harness plugin update      # sync latest assets and refresh Codex plugin cache
ycm-harness doctor --repair
```

Behavior:

- `sync` updates managed Cursor, Codex CLI, OpenCode, and Claude Code plugin installs in one step.
- Cursor GitHub marketplace installs **pin a commit SHA** and do not auto-update. `sync --cursor` copies current plugin assets into `~/.cursor/plugins/local/ycm-harness` **and** overwrites any SHA-pinned `plugins/cache/**/ycm-harness/<sha>/` copy Cursor is actually loading. A Cursor SessionStart hook then starts `plugin/scripts/github-refresh.mjs` in the background (fail-open). That script does not need a sibling `runtime/` CLI — SHA-pinned marketplace copies only ship plugin files — so later chats can track GitHub HEAD. This chat still uses already-loaded rules; start a new chat after refresh. `YCM_HARNESS_SKIP_GITHUB_PLUGIN=1` skips that SessionStart clone/overwrite; `sync --cursor` still writes this checkout onto dests.
- `plugin update` is the simplest local update path: it syncs managed plugin files and, for Codex, refreshes the installed plugin cache using official `codex plugin remove/add`.
- Stable/default sync uses the bundled package assets, then refreshes the GitHub clone when network is allowed.
- `doctor --repair` repairs the global installs. In the current project it removes only identical harness copies listed in `project_leftovers`; same-named paths that differ (`project_leftovers_kept`) and other `.cursor/` files stay. Inspect a kept leftover and delete it manually if it is an old harness copy. It also flags pinned Cursor/Claude cache copies whose rules/agents are behind the package. If `--repair` tries to remove a leftover and `fs.rm` fails, the path stays on disk, text mode prints `project leftover not removed` (or `not fully removed` after a partial delete), `--json` includes that path in `repair_errors` as `{path, code}`, and the command exits nonzero in both text and JSON mode.
- `doctor --json` fields include `project_leftovers` (identical copies `--repair` can remove), `project_leftovers_kept` (same-named paths that differ), `needs_sync`, `repaired` (true when this invocation ran `--repair`), `repair_command`, and `repair_errors` (array of `{path, code}` for leftover removals that failed; empty when none failed or `--repair` was not used).

### Claude Code

Claude Code installs via its marketplace system (not a file copy into `~/.claude/plugins` by hand):

1. Repo root ships `.claude-plugin/marketplace.json` (marketplace name: `harness`).
2. Plugin root ships `plugin/.claude-plugin/plugin.json` + `plugin/hooks/hooks-claude.json`.
3. Default: `ycm-harness sync --claude` registers the GitHub marketplace with `autoUpdate: true` (tracks **`master`**) **and** overwrites `~/.claude/plugins/cache/**/ycm-harness/<sha>/` (Claude also pins the first-install SHA). Pin another branch with `--claude-ref <branch>`.
4. Local checkout (no git auto-update): `ycm-harness sync --claude --claude-local`. A directory marketplace pointing at a local checkout will not pull GitHub until you re-register with `sync --claude`.

**Which branch to push for Claude auto-updates?** Push to the git **ref you registered the marketplace with**. Default is **`master`**. Then run `/plugin marketplace update harness` (or wait for `autoUpdate`), and `/reload-plugins` or restart Claude Code.

Version note: Claude `plugin.json` intentionally omits `version`, so each git commit on the tracked ref counts as a new plugin version. If you later add a `version` field, bump it on every release or updates will stall.

#### Claude compaction continuity

The Claude plugin registers bounded, fail-open `PreCompact`, `PostCompact`, and `SessionStart(compact)` hooks. `PreCompact` records deterministic operational state only: the active Harness resume digest plus a capped Git branch/dirty-path view. It never reads the transcript. `PostCompact` may add Claude's redacted, bounded compaction summary to the private snapshot, but that summary is never reinjected verbatim.

Snapshots are generated Markdown under `${CLAUDE_CONFIG_DIR:-~/.claude}/cache/ycm-harness/compaction-continuity/<root-hash>/<session-hash>/continuity.md`. Root and session directory names are SHA-256-derived, writes use atomic rename with best-effort mode `0600`, and stale or mismatched snapshots are ignored. Limits are 128 KiB per hook payload, 32 KiB per snapshot, and 2 KiB per injected resume card.

On compact resume, canonical live `.ycm-harness/state.json` remains authoritative: goal, ticket, blocker, decisions, and next action are recomputed with the normal SessionStart digest. The cache contributes only a private snapshot pointer/status. Outside an active Harness workflow, the card contains bounded Git state and explicitly avoids creating a parallel workflow. Compact resumes do not create context-scout obligations, and every non-required adapter failure exits successfully with `{}`.

Verify the lifecycle with:

```bash
npm run typecheck
node --test --import tsx/esm tests/compaction-continuity.test.ts tests/plugin-hook.test.ts tests/claude-plugin.test.ts
npm test
```

Inside any project:

```bash
ycm-harness init
```

## Skill split

The packaged plugin exposes two harness entrypoints:

- `ycm-harness-design`: pre-work design flow. It runs explore, `grill-with-docs` in Plan mode, then spec and ticket planning with `to-spec`, `to-tickets`, and Wayfinder when the route is still unclear.
- `ycm-harness-work`: execution flow. It starts from implementation-ready work, follows `/ralph` through execute, then continues through validate and finish without stopping after implementation.

**Matt Pocock skills are external.** `to-spec`, `to-tickets`, `wayfinder`, `grill-with-docs`, `tdd`, `domain-modeling`, `codebase-design`, and `improve-codebase-architecture` are **not** vendored into this repo. Install and keep them updated via Claude Code:

```bash
claude plugin marketplace add mattpocock/skills
claude plugin install mattpocock-skills@mattpocock
# then /setup-matt-pocock-skills
```

`ycm-harness doctor` / `sync` report whether `mattpocock-skills` is present and prune any stale formerly-vendored copies from managed Cursor/OpenCode skill dirs.

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

## Independent review (skill procedure, not a harness review file)

Dispatch a **two-phase review panel**, distinct from every author/implementer: `tech_lead` and `project_manager` debate first (max 3 rounds; stop on settlement), then `user_advocate` last. Each follows `plugin/agents/<role>.md` and writes `artifacts/review-<role>-<ticket>.md`. `project_manager` owns specification completeness. `user_advocate` owns live operator value and Shneiderman / modern usability. Do not dispatch `spec_reviewer` or `uiux`. Rank findings `high`/`medium`/`low`. High findings block close-out; `medium` is orchestrator-discretion and `low` is deferred — name leftovers as not-done. Panel PASS requires phase 1 settled plus `user_advocate` PASS. High-risk work keeps this same named panel; it does not invent extra reviewers and does not revive `combined_reviewer`.

Do not run `ycm-harness review *` (deprecated exit-2 alias; mutates nothing). Do not write a harness review JSON file. Do not `artifact register`. Full findings live in the review artifacts. Durable harness proof is `ticket submit` then `verify run` with distinct implementer/verifier run IDs. Persist a reusable PASS only via `checkpoint` or `wiki durable`.

```bash
ycm-harness ticket submit <ticket-id>
ycm-harness verify run \
  --ticket <ticket-id> \
  --command "npm test" \
  --implementer-run <id> \
  --verifier-run <different-id> \
  --knowledge none
ycm-harness verify verdict <ticket-id>
```

Fix-loop: max 3 rounds. Invoke `$hard-problem-solving` before editing; re-submit after code changes; restart the two-phase panel (phase 1 first) distinct from the fix author; obtain fresh `verify run`. Round 3 still failing → delegate to a human reviewer. See the `ycm-harness-work` skill.

## V3 session nudge

Cursor does not yet expose per-message hook events, so the harness exposes a polled counter the agent ticks itself.

```bash
ycm-harness session tick --kind user_message    # call once per visible user reply
ycm-harness session nudge --json                # {due, count, threshold:15}
```

`wiki init`, `wiki source add`, and `wiki page upsert` reset the counter automatically. The session-start hook adds a `WIKI UPDATE DUE` line to `additional_context` whenever the threshold is exceeded, prompting the agent to capture the most recent learning before continuing.

## Cursor plugin

The `plugin/` folder is a ready-to-install Cursor plugin layout:

- `plugin/.cursor-plugin/plugin.json` — plugin manifest.
- `plugin/hooks/hooks-cursor.json` — registers Cursor `sessionStart` and `stop`.
- `plugin/hooks/hooks-codex.json` — registers Codex `SessionStart`, `UserPromptSubmit` and `Stop`. The `Stop` hook is a high-assurance safety net: it blocks only the host session that claimed the goal (or a session whose cwd is inside that goal's worktree), never every chat in the repo.
- `plugin/scripts/session-start-hook.mjs` — runs `ycm-harness hook session-start` and emits `additional_context` for Cursor or Codex-native `hookSpecificOutput` when Codex invokes SessionStart.
- `plugin/scripts/ste-reminder-hook.mjs` — the `UserPromptSubmit` hook for Claude Code and Codex. It adds the ASD-STE100 output rule to the context on every prompt, so the rule holds for every reply and does not fade in a long session. Cursor has no per-prompt context hook; it uses the always-on plugin rules.
- `plugin/scripts/stop-hook.mjs` — the Stop hook for Claude Code, Codex and Cursor.
  - It finds the CLI with `findHarnessCli` (the same resolver as SessionStart) and runs `ycm-harness hook stop`. It gives Cursor's `stop` payload the CLI's Stop shape. A harness block wins.
  - If the CLI does not block, it runs a self-contained notes check. When the current turn wrote files or made a git or tracker write, it asks once whether all findings, decisions, deferrals, hand-offs and environment facts are recorded durably, and tells the agent to raise a GitHub issue for anything that needs attention and is not fixed in the turn. Writes are file edits (`Edit`, `Write`, `StrReplace`, `apply_patch`, …), `git commit`/`push`/`merge`/`tag`, and `gh pr`/`gh issue` create, comment, edit, merge or close.
  - It reads the host `transcript_path`: Claude and Cursor message JSONL, and the Codex rollout, where each task starts at `task_started`.
  - Output is `decision: "block"` for Claude and Codex, and `followup_message` for Cursor.
  - It skips a continued turn (`stop_hook_active`, or Cursor `loop_count > 0`) and `YCM_NOTES_CHECK=off`. It fails open without a readable transcript and always exits 0.
- `plugin/skills/ycm-harness-design/SKILL.md` — design and planning skill.
- `plugin/skills/ycm-harness-work/SKILL.md` — work execution skill (`name: ycm-harness-work`).
- `plugin/skills/hard-problem-solving/SKILL.md` — evidence-first RCA for review fix-loop (`$hard-problem-solving`).
- `plugin/skills/llm-wiki/SKILL.md` — Karpathy compounding-wiki pattern: ingest, query, lint (`$llm-wiki`); pairs with `ycm-harness wiki` CLI.
- `plugin/skills/commander/SKILL.md` — commander protocol router into this plugin's `commander-system/system/` (`$commander` / `/commander`).
- `plugin/rules/commander.mdc` — always-apply pointer at the plugin-sourced commander files.
- `plugin/commands/commander.md` — Claude slash-command pointer at the same skill.
- `plugin/skills/plan-and-advance/SKILL.md` — plan first, mandatory self-grill (Decisions + Edge cases), advance the idea, then implement without interviewing.
- `plugin/skills/pull-tickets/SKILL.md` — pull unblocked `ready-for-agent` issues, prioritize top 3, implement each via `ycm-harness-work-lite`.
- `plugin/skills/summarizing-goal-achievement/SKILL.md` — finish closing report: achieved / what now / phase purpose+status / how much / how well (invoked from `ycm-harness-work` after finish bookkeeping).
- `plugin/skills/run-technical-design-discussion/` — evidence-grounded technical architecture discussion (`SKILL.md` + `driver.mjs`); standalone packet/validate/smoke workflow that does not enter harness phase state.
- `plugin/skills/review-past-commits/SKILL.md` — review landed work over a pinned commit range, in any kind of project: intent ledger, ten domain-neutral review questions, graded findings, independent verification, report committed into the project.
- `plugin/skills/integrating-google-adsense/SKILL.md` — connect a public website to Google AdSense (loader, account meta, ads.txt, CSP, manual units).
- `plugin/skills/explainer/SKILL.md` — pick the clearest output format: STE text, a diagram, an HTML page, or a narrated video (`$explainer`).
- `plugin/skills/eli5/SKILL.md` — explain to a complete beginner as an HTML page with big pictures and few words (`$eli5`); routes to `explainer`.
- `plugin/skills/designing-ux-mechanics/SKILL.md` — design and audit app mechanics before visuals: one-router back, at most one layer, load/empty/error states, single-flight actions, live data, motion; stress walk in `checklist.md` (`$designing-ux-mechanics`).
- `plugin/rules/ycm-harness.mdc` — thin rule pointing agents at the harness CLI.
- `plugin/rules/git-commits.mdc` — default commit+push after implementation (worktree and irreversible-op exceptions).

The global Cursor plugin loads `plugin/rules/ycm-harness.mdc` in every project. Do not copy it into a project's `.cursor/rules/`; a copy only duplicates the plugin rule. The session-start hook reads state from the project's `.ycm-harness/state.json` automatically.

**Stop scoping (lean):** `active_goal_id` is only the CLI default for commands without `--goal`. High-assurance Stop enforcement uses `session_claims[host_session_id]` (set via `goal create|activate --session <id>`) or a cwd inside the goal's `worktree_path`. Unrelated sessions in the same repo are not blocked. SessionStart with a host `session_id` resumes the claimed/worktree goal and surfaces the host session id for activate; it does not auto-claim from bare `active_goal_id`.

## Workflow contract

Phases (V4): `discuss → plan → execute → validate → finish`. `blocked` is an escape state, not a phase.

Rules:

- First phase must be `discuss`.
- Forward transitions advance one phase at a time. Rollbacks are allowed and recorded.
- Forward transitions and `phase complete` are blocked unless the current phase's V4 ritual/artifact gate is satisfied.
- Tasks belong to the active phase. Only one task is `active` per phase at a time.
- A task with `smoke = required` cannot be marked `done` until at least one `SmokeEvidence` is attached. Use `--smoke not_applicable` plus `--reason` for docs/config-only tasks.
- `phase complete` marks the active phase complete; starting the next phase auto-completes the previous one.

## State layout

```
.ycm-harness/
  state.json          # canonical JSON, validated by Zod
  events.jsonl        # append-only event log
  goals/              # reserved for future Markdown artifacts
  phases/
  tasks/
  checkpoints/
  rituals/           # reserved for future Markdown ritual artifacts; JSON owns records
  sessions/
  smoke/
  followups.md        # low-severity review findings drained on review close
  wiki/
    schema.md         # generated, do not edit by hand
    ...               # plus a generated overview page and an append-only log
    raw/              # immutable source files (registered via 'wiki source add')
    pages/            # one Markdown body per page; metadata lives in state.json
```

User-level state lives separately:

```
~/.ycm-harness/
  state.json          # canonical user-level state (wiki block + counters)
  wiki/
    schema.md
    ...               # plus the overview page and the log
    raw/
    pages/
    promotions.jsonl  # append-only history of project->user promotions
```

Override the user-state root with `YCM_HARNESS_HOME=<dir>` (used by tests).

Atomic writes use temp-file + rename. The events log is append-only; never edit it by hand.

> **Concurrency note.** `state.json` is written through `tmp + rename`, so a single in-flight write is crash-safe. There is no advisory lock or optimistic-concurrency token, so two CLI invocations racing the same file (for example a session-start hook firing while the agent runs `wiki page upsert`) will last-write-wins and silently drop the loser's mutation. The harness assumes serial CLI usage from a single agent loop. A version field is on the follow-up list once we see it bite in practice.

## Tests

```bash
npm test            # all unit + smoke tests
npm run smoke       # CLI golden path only
npm run typecheck
```

## Future phase backlog

V4 lands strict SOP ritual enforcement. V5 adds executed-smoke and subagent-evidence review enforcement (strict by default).

Open work:

- **Native per-message hooks.** Replace the polled `session tick` with a Cursor-native hook event once `userMessage` (or equivalent) is exposed.
- **Wiki conflict resolution.** When `wiki promote` updates an existing user-wiki page, surface a structured diff and let the agent merge instead of overwrite.

## Commander system (plugin-sourced operating contract)

`plugin/commander-system/` is the **only** golden source for the commander protocol. It ships inside the ycm-harness plugin (`skills/commander`, `rules/commander.mdc`, Claude `commands/commander.md`) and updates when that plugin updates. Do not copy protocol files to `~/.agents/system/`.

On a machine that still has local protocol copies or old CLAUDE.md / AGENTS.md routers:

```bash
git clone <this repo> && cd ycm-harness
npm run commander:install          # or: node plugin/scripts/install-commander.mjs
```

That migrate script rewrites entry pointers, retires local `~/.agents/system/` protocol files (keeps `LESSONS.md`), and removes the duplicate `~/.cursor/skills/commander` user skill. `LESSONS.md` remains a machine journal only. One manual step is printed at the end: replace the Cursor user rule with the plugin pointer.

Refresh client copies from this checkout with `ycm-harness sync` (Cursor/Codex local marketplace + pinned caches). Claude GitHub marketplace autoUpdate tracks `master`. Do not run `sync` on a dirty git checkout of this plugin — GitHub clone refresh can reset uncommitted work.

Personal overlay (`npm run commander:overlay`) may copy **only** `LESSONS.md`.


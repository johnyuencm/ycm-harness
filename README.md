# ycm-harness

Coordination for coding agents that run longer than one chat turn.

Status: **0.3 lean kernel / V5 doctrine** (experimental). Private operator
checkout: [`johnyuencm/harness`](https://github.com/johnyuencm/ycm-harness). Public
portable product mirror: [`johnyuencm/ycm-harness`](https://github.com/johnyuencm/ycm-harness).

## Why agentic workflows need this

A capable agent can write code. The hard part is keeping multi-step work honest
across sessions, subagents, and context resets:

| Without a harness | What goes wrong |
| ----------------- | --------------- |
| Work lives only in chat | Progress evaporates when the context window fills or a new agent starts |
| One agent implements and self-approves | "Done" means the author believes it, not that checks passed on the submitted state |
| Decisions stay in prose | The next run rediscovers the same fork, or contradicts an earlier choice |
| Tickets are optional notes | Nothing forces acceptance criteria, claim/start/submit, or a clear next action |
| Knowledge stays in the transcript | Reusable contracts and root causes never become project memory |

ycm-harness is a lean ledger for that loop. Agents still read code, change it,
and run the project's real checks. The harness records *what* is in flight,
*what* was decided, and *what* evidence closed a ticket — so the next agent can
resume instead of re-negotiate.

## How it helps an agentic workflow

### 1. Durable goals instead of chat memory

Create one goal for the outcome. Tickets under it are the bounded work units.
`status` and `next` tell any new session what is actionable without rereading
the whole transcript.

```bash
ycm-harness init
ycm-harness goal create "Ship the change" --backend local
ycm-harness ticket create "Implement the change" \
  --code-changed \
  --acceptance "Targeted tests pass"
ycm-harness status
ycm-harness next
```

### 2. Claim → implement → submit (not "I think it's done")

Tickets move through an explicit lifecycle. Code-changing work is submitted as a
coherent state. Changing code or acceptance after submit requires submitting
again, so verification always targets what was claimed.

```bash
ycm-harness ticket start <ticket-id>
# …implement, run focused checks…
ycm-harness checkpoint decision "Use the existing adapter" \
  --ticket <ticket-id> \
  --next "Implement and test"
ycm-harness ticket submit <ticket-id>
```

Checkpoints capture decisions, blockers, and compaction boundaries so a later
agent inherits the fork instead of guessing.

### 3. Separate implementer and verifier

Completion is evidence-backed. The verifier run must differ from the
implementer run. Passing evidence binds to the submitted digest; stale or
self-authored evidence does not close the ticket.

```bash
ycm-harness verify run \
  --ticket <ticket-id> \
  --command "npm test" \
  --implementer-run <run-id> \
  --verifier-run <different-run-id> \
  --knowledge none
ycm-harness verify verdict <ticket-id>
ycm-harness goal verify <goal-id>
ycm-harness goal complete <goal-id>
```

That split is the main guardrail against agents rubber-stamping their own work.

### 4. Knowledge that compounds across runs

Reusable contracts, decisions, environment facts, and root causes go into a
small durable wiki — not credentials, personal paths, or transient progress.

```bash
ycm-harness wiki durable \
  --id retry-contract \
  --title "Retry contract" \
  --trigger contract \
  --body "Retries are idempotent."
ycm-harness wiki list
ycm-harness wiki show retry-contract
```

### 5. Client hooks that keep sessions on the rails

`ycm-harness install` / `ycm-harness sync` projects skills and hooks into
Cursor, OpenCode, Codex, and Claude Code. SessionStart orients an active goal;
Stop can enforce unfinished high-assurance work when you turn that on.
Companion packs such as mattpocock-skills, ralph-loop, caveman, and ponytail
stay as separate vendor installs — see
[Recommended vendor plugins](#recommended-vendor-plugins).

### 6. Optional GitHub as the shared board

Local tickets are the default. A GitHub-backed goal binds to an existing parent
issue and Project so humans and agents share one queue. Remote mutations fail
closed — no silent local shadow queue when `gh` or the network is down.

## Recommended vendor plugins

ycm-harness stays a thin coordination kernel. It does **not** vendor third-party
skill packs. Install these separately; `ycm-harness doctor` audits all four.

| Plugin | Role in the agentic loop | Install hint |
| ------ | ------------------------ | ------------ |
| [mattpocock-skills](https://github.com/mattpocock/skills) (`mattpocock-skills@mattpocock`) | Spec/tickets, TDD, architecture finish passes the harness skills call out | `claude plugin marketplace add mattpocock/skills && claude plugin install mattpocock-skills@mattpocock` then `/setup-matt-pocock-skills` |
| [ralph-loop](https://github.com/anthropics/claude-plugins-official) (`ralph-loop@claude-plugins-official`) | Persistence loop during long execute turns | `claude plugin install ralph-loop@claude-plugins-official` |
| [caveman](https://github.com/JuliusBrussee/caveman) (`caveman@caveman`) | Terse agent communication / compress-review helpers | `claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman` (Cursor: `npx skills add JuliusBrussee/caveman -a cursor`) |
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
git clone https://github.com/johnyuencm/ycm-harness.git "$HOME/src/ycm-harness"
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
- caveman@caveman — terse compress/review helpers
  `claude plugin marketplace add JuliusBrussee/caveman && claude plugin install caveman@caveman`
  (Cursor: `npx skills add JuliusBrussee/caveman -a cursor`)
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
   caveman / ponytail status when shown)
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
git clone https://github.com/johnyuencm/ycm-harness.git
cd harness
npm install
npm run build
npm link            # exposes the `ycm-harness` bin
```

Node.js **>= 20**. See also [`CONTRIBUTING.md`](CONTRIBUTING.md).

## One-click client install / update

Sync the packaged plugin assets into every detected local client:

```bash
ycm-harness sync
```

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
- `doctor --repair` repairs managed installs without force-overwriting edited project `.cursor/` files. It also flags pinned Cursor/Claude cache copies whose rules/agents are behind the package.

### Claude Code

Claude Code installs via its marketplace system (not a file copy into `~/.claude/plugins` by hand):

1. Repo root ships `.claude-plugin/marketplace.json` (marketplace name: `harness`).
2. Plugin root ships `plugin/.claude-plugin/plugin.json` + `plugin/hooks/hooks-claude.json`.
3. Default: `ycm-harness sync --claude` registers the GitHub marketplace with `autoUpdate: true` (tracks **`master`**) **and** overwrites `~/.claude/plugins/cache/**/ycm-harness/<sha>/` (Claude also pins the first-install SHA). Pin another branch with `--claude-ref <branch>`.
4. Local checkout (no git auto-update): `ycm-harness sync --claude --claude-local`. A directory marketplace pointing at a local checkout will not pull GitHub until you re-register with `sync --claude`.

**Which branch to push for Claude auto-updates?** Push to the git **ref you registered the marketplace with**. Default is **`master`**. Then run `/plugin marketplace update harness` (or wait for `autoUpdate`), and `/reload-plugins` or restart Claude Code.

## Hermes Agent autonomy reference

This repository also carries a portable reference for the related Hermes Agent operating harness under [`docs/hermes-agent-autonomy/`](docs/hermes-agent-autonomy/). It is a documented companion rather than part of the Cursor CLI state machine.

Start with [`CODEX_MIGRATION_PROMPT.md`](docs/hermes-agent-autonomy/CODEX_MIGRATION_PROMPT.md). The tree excludes credentials and source-machine configuration; treat target runtime docs as authoritative when porting.

Version note: Claude `plugin.json` intentionally omits `version`, so each git commit on the tracked ref counts as a new plugin version. If you later add a `version` field, bump it on every release or updates will stall.

#### Claude compaction continuity

The Claude plugin registers bounded, fail-open `PreCompact`, `PostCompact`, and `SessionStart(compact)` hooks. `PreCompact` records deterministic operational state only: the active Harness resume digest plus a capped Git branch/dirty-path view. It never reads the transcript. `PostCompact` may add Claude's redacted, bounded compaction summary to the private snapshot, but that summary is never reinjected verbatim.

Snapshots are generated Markdown under `${CLAUDE_CONFIG_DIR:-~/.claude}/cache/ycm-harness/compaction-continuity/<root-hash>/<session-hash>/continuity.md`. Root and session directory names are SHA-256-derived, writes use atomic rename with best-effort mode `0600`, and stale or mismatched snapshots are ignored. Limits are 128 KiB per hook payload, 32 KiB per snapshot, and 2 KiB per injected resume card.

On compact resume, canonical live `.ycm-harness/state.json` remains authoritative: goal, ticket, blocker, decisions, and next action are recomputed with the normal SessionStart digest. The cache contributes only a private snapshot pointer/status. Outside an active Harness workflow, the card contains bounded Git state and explicitly avoids creating a parallel workflow. Compact resumes do not create context-scout obligations, and every optional adapter failure exits successfully with `{}`.

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

**Caveman skills are external.** The JuliusBrussee/caveman skill set (`caveman`, `caveman-compress`, `caveman-commit`, …) is **not** vendored into this repo. Install and keep it updated via Claude Code (or Cursor skills):

```bash
claude plugin marketplace add JuliusBrussee/caveman
claude plugin install caveman@caveman
# Cursor: npx skills add JuliusBrussee/caveman -a cursor
```

`ycm-harness doctor` / `sync` report whether `caveman` is present and prune any stale formerly-vendored copies from managed Cursor/OpenCode skill dirs.

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

Full doctrine: [`docs/workflow-doctrine.md`](docs/workflow-doctrine.md).

## V2 wiki memory

The wiki is a project-local knowledge surface the agent grows over time. Sources are immutable inputs (copied into `wiki/raw/`); pages are agent-synthesised summaries of one or more sources. JSON state owns metadata; `pages/<id>.md`, `index.md`, and `log.md` are readable mirrors.

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

Fix-loop: max 3 rounds. Invoke `$hard-problem-solving` before editing; re-submit after code changes; restart the two-phase panel (phase 1 first) distinct from the fix author; obtain fresh `verify run`. Round 3 still failing → delegate to a human reviewer. See `plugin/skills/ycm-harness-work/review-fix-loop.md`.

## V3 Caveman compression (agent-internal only)

Caveman skills are **not** shipped in this repo. Use the installed **`caveman@caveman`** plugin from [JuliusBrussee/caveman](https://github.com/JuliusBrussee/caveman) for LLM-driven compression (`/caveman`, `/caveman-compress`, …). The harness `caveman` CLI command is deprecated in 0.3.

Apply this only to agent-internal artefacts. Never compress user-facing replies or irreversible-action confirmations.

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
- `plugin/hooks/hooks-cursor.json` — registers Cursor `sessionStart`.
- `plugin/hooks/hooks-codex.json` — registers Codex `SessionStart` and `Stop`. The `Stop` hook is a high-assurance safety net: it blocks only the host session that claimed the goal (or a session whose cwd is inside that goal's worktree), never every chat in the repo.
- `plugin/scripts/session-start-hook.mjs` — runs `ycm-harness hook session-start` and emits `additional_context` for Cursor or Codex-native `hookSpecificOutput` when Codex invokes SessionStart.
- `plugin/scripts/stop-hook.mjs` — runs `ycm-harness hook stop` and emits Codex Stop JSON.
- `plugin/skills/ycm-harness-design/SKILL.md` — design and planning skill.
- `plugin/skills/ycm-harness-work/SKILL.md` — work execution skill (`name: ycm-harness-work`).
- `plugin/skills/hard-problem-solving/SKILL.md` — evidence-first RCA for review fix-loop (`$hard-problem-solving`).
- `plugin/skills/llm-wiki/SKILL.md` — Karpathy compounding-wiki pattern: ingest, query, lint (`$llm-wiki`); pairs with `ycm-harness wiki` CLI.
- `plugin/skills/commander/SKILL.md` — pointer into `~/.agents/system/` commander protocol (`$commander`).
- `plugin/skills/building-ios-ipa-sideloadly/SKILL.md` — Windows → GitHub → Sideloadly IPA path.
- `plugin/skills/deploying-to-mumu-emulator/SKILL.md` — MuMu Player Android/ADB deploy path.
- `plugin/skills/plan-and-advance/SKILL.md` — plan first, mandatory self-grill (Decisions + Edge cases), advance the idea, then implement without interviewing.
- `plugin/skills/pull-tickets/SKILL.md` — pull unblocked `ready-for-agent` issues, prioritize top 3, implement each via `ycm-harness-work-lite`.
- `plugin/skills/summarizing-goal-achievement/SKILL.md` — finish closing report: achieved / what now / phase purpose+status / how much / how well (invoked from `ycm-harness-work` after finish bookkeeping).
- `plugin/skills/setup-autonomy-p1-p7/SKILL.md` — new-instance Phase 1–7 bootstrap: carry-forward vs local configure.
- `plugin/skills/run-technical-design-discussion/` — evidence-grounded technical architecture discussion (`SKILL.md` + `driver.mjs`); standalone packet/validate/smoke workflow that does not enter harness phase state.
- `plugin/rules/ycm-harness.mdc` — thin rule pointing agents at the harness CLI.
- `plugin/rules/git-commits.mdc` — default commit+push after implementation (worktree and irreversible-op exceptions).

Copy `plugin/rules/ycm-harness.mdc` into your project's `.cursor/rules/` (or symlink it). The session-start hook reads state from the project's `.ycm-harness/state.json` automatically.

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
    index.md          # generated overview of pages and sources
    log.md            # append-only wiki narrative
    raw/              # immutable source files (registered via 'wiki source add')
    pages/            # one Markdown body per page; metadata lives in state.json
```

User-level state lives separately:

```
~/.ycm-harness/
  state.json          # canonical user-level state (wiki block + counters)
  wiki/
    schema.md
    index.md
    log.md
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

## Commander system (portable cross-harness operating contract)

`plugin/commander-system/` carries a machine-global "commander" operating contract for weaker models: delegation thresholds, verified model tiers, escalation ladder, done/retry/ask checklists, dispatch templates, and a maintenance protocol. It installs OUTSIDE any repo, to `~/.agents/system/`, and wires entry pointers for Cursor (user skill), Claude Code (`~/.claude/CLAUDE.md`), and Codex (`~/.codex/AGENTS.md` block). The harness skill's `commander-dispatch.md` references it during execute.

Install on a new machine (no build needed, plain Node >= 20):

```bash
git clone <this repo> && cd ycm-harness
npm run commander:install          # or: node plugin/scripts/install-commander.mjs
npm run commander:overlay -- --force   # personal LESSONS / DIAGNOSIS / LETTER / inventories
```

Flags: `--dry-run` (show actions), `--force` (overwrite drifted system files after backup; `LESSONS.md` is never overwritten by install). The portable templates come from this checkout's `plugin/commander-system/`; personal allowlisted files come from `operator-system/` via `commander:overlay`. The script is idempotent — rerunning reports `ok` per file. One manual step remains and is printed at the end: adding the Cursor user rule (Cursor Settings -> Rules -> User Rules).

Templates use `{{HOME}}` placeholders (Windows-first paths; POSIX best-effort). To pull improvements made on a machine back into the repo, copy the live `~/.agents/system/` files over `plugin/commander-system/system/` and re-replace the home prefix with `{{HOME}}`.

## License

MIT.

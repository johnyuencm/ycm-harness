# ycm-harness

Coordination for coding agents that run longer than one chat turn.

Status: **0.3.0, experimental**. State lives as plain JSON and Markdown under
`.ycm-harness/`; JSON is canonical.

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

`ycm-harness install` projects skills and hooks into Cursor or OpenCode.
SessionStart orients an active goal; Stop can enforce unfinished high-assurance
work when you turn that on. The CLI stays the source of truth; clients get a
thin, retry-safe mirror.

```bash
ycm-harness install --client cursor
ycm-harness install --client opencode
ycm-harness doctor
```

### 6. Optional GitHub as the shared board

Local tickets are the default. A GitHub-backed goal binds to an existing parent
issue and Project so humans and agents share one queue. Remote mutations fail
closed — no silent local shadow queue when `gh` or the network is down.

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

Otherwise install from source (package is not assumed on npm):

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

Also install portable commander templates from that checkout:

```bash
npm run commander:install
```

### 2. Project client assets into my agent host
Detect whether this workspace is Cursor and/or OpenCode. Then:

```bash
# Cursor (default for most users of this README)
ycm-harness install --client cursor

# OpenCode, if that client is in use
ycm-harness install --client opencode

# or both
ycm-harness install --client all --force

ycm-harness doctor
```

Fix doctor failures that are clearly install-related. Do not invent personal
overlay files or commit machine-specific audits into my repo.

### 3. Initialize harness state in THIS project
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

### 4. Done criteria
Report back with:
1. `ycm-harness` path / version proof (`ycm-harness --help` ok)
2. which client install ran and `doctor` summary
3. whether `.ycm-harness/` was initialized
4. goal/ticket IDs if created
5. anything I must do manually (e.g. restart the IDE session so hooks load)

Do not start implementing product code in this setup turn unless I also asked
for that work. After setup, prefer the installed `ycm-harness-work` skill for
the claim → implement → submit → verify loop.
````

## Requirements

- Node.js 20 or newer
- Git
- GitHub CLI (`gh`) only when using the GitHub ticket backend

## Install from source

```bash
git clone https://github.com/johnyuencm/ycm-harness.git
cd ycm-harness
npm ci
npm run build
npm link
ycm-harness --help
```

Refresh managed client assets anytime with `ycm-harness sync` or
`ycm-harness plugin update` (aliases for `install --force`).

## Quick start (manual)

Prefer [Paste this to an agent](#paste-this-to-an-agent) when an agent can run
the setup. For a hand-run bootstrap after the CLI is linked:

```bash
ycm-harness init
ycm-harness goal create "Ship the change" --backend local
ycm-harness ticket create "Implement the change" \
  --code-changed \
  --acceptance "Targeted tests pass"
ycm-harness ticket list
ycm-harness ticket start <ticket-id>
```

Use `ycm-harness <command> --help` for the full option set. For the agent-facing
work loop, see the installed `ycm-harness-work` skill.

## Ticket backends

Goals default to local tickets. GitHub-backed goals need an authenticated `gh`
and an existing parent issue + Project:

```bash
ycm-harness goal create "Ship the change" \
  --backend github \
  --owner <repo-owner> \
  --repo <repo> \
  --project-owner <project-owner> \
  --project <project-number> \
  --parent <parent-issue-number>
```

## Compatibility

Version 0.3 writes V3 state. Migrate V2 state explicitly:

```bash
ycm-harness migrate --dry-run
ycm-harness migrate --apply
```

`task` aliases `ticket`, and `smoke` aliases `verify`. Retired phase, review,
ritual, session, artifact, commit, user-wiki, and caveman commands return exit
code 2 with a replacement hint and do not mutate state.

See [`docs/lean-0.3.md`](docs/lean-0.3.md) for migration, evidence, hook, and
release contracts.

## Commander system

Portable cross-client commander templates (dispatch / judgment / inventory):

```bash
npm run commander:install
```

Optional personal overlay (LESSONS / operator DIAGNOSIS / LETTER) lives in a
separate private operator repo and is applied afterward with that repo's
`commander:overlay` script. Do not put machine-specific audits into this
public repository.

## Development

```bash
npm ci
npm run build
npm run typecheck
npm test
npm pack --dry-run
```

Contributions are welcome; see [`CONTRIBUTING.md`](CONTRIBUTING.md). Report
security issues using the private process in [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)

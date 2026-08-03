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

## Quick start

Inside the project being coordinated:

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

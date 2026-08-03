# ycm-harness

Lean coordination for long-running coding agents: durable goals, provider-backed
tickets, checkpoints, verification evidence, and project knowledge.

Status: **0.3.0, experimental**. State is stored as plain JSON and Markdown
under `.ycm-harness/`; JSON is canonical.

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

Install or refresh client projections:

```bash
ycm-harness install --client cursor
ycm-harness install --client opencode
ycm-harness install --client all --force
ycm-harness doctor
```

`ycm-harness sync` and `ycm-harness plugin update` remain retry-safe aliases for
refreshing managed client assets.

## Quick start

Run these commands inside the project being coordinated:

```bash
ycm-harness init
ycm-harness goal create "Ship the change" --backend local
ycm-harness ticket create "Implement the change" \
  --code-changed \
  --acceptance "Targeted tests pass"
ycm-harness ticket list
ycm-harness ticket start <ticket-id>
```

During work:

```bash
ycm-harness status
ycm-harness next
ycm-harness checkpoint decision "Use the existing adapter" \
  --ticket <ticket-id> \
  --next "Implement and test"
```

Code-changing tickets must be submitted and verified against the submitted
state. The implementer and verifier run IDs must be different:

```bash
ycm-harness ticket submit <ticket-id>
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

Use `ycm-harness <command> --help` for the full option set.

## Ticket backends

Goals use local tickets by default. A GitHub-backed goal binds to an existing
parent issue and GitHub Project:

```bash
ycm-harness goal create "Ship the change" \
  --backend github \
  --owner <repo-owner> \
  --repo <repo> \
  --project-owner <project-owner> \
  --project <project-number> \
  --parent <parent-issue-number>
```

The GitHub backend requires an authenticated `gh` CLI. Remote mutations fail
closed; the harness does not create a shadow local queue.

## Durable project knowledge

The active 0.3 wiki surface is intentionally small:

```bash
ycm-harness wiki durable \
  --id retry-contract \
  --title "Retry contract" \
  --trigger contract \
  --body "Retries are idempotent."
ycm-harness wiki list
ycm-harness wiki show retry-contract
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

See [`docs/lean-0.3.md`](docs/lean-0.3.md) for the migration, evidence, hook,
and release contracts.

## Commander system

Install the portable cross-client commander templates onto this machine:

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

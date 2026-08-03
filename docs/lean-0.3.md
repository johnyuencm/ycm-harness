# Lean 0.3 release checklist

This document is the release contract for the lean YCM Harness. It intentionally describes a neutral coordination kernel and the Cursor/OpenCode adapters only.

## Compatibility bridge

0.3 reads V2 state and writes V3 state only through `migrate`. The migration must be explicit:

- `migrate --dry-run` performs validation and prints the mapping; it writes nothing.
- `migrate --apply` stages `state.v3.json`, a byte-exact V2 archive, a manifest, and SHA-256 hashes under an ignored temporary directory.
- A named V3 state and named archive become authoritative only after every staged file is complete and the final rename succeeds.
- Failure during archive write, state write, or rename removes staged output and leaves the original V2 state and archive directory unchanged.
- A crash may leave only `.migration-v3.tmp`; the next invocation cleans or resumes it deterministically. No partial named archive or V3 state is accepted.
- A repeated apply is idempotent.

The mapping is deliberately lossy in the active state but lossless in the archive:

| V2 | V3 |
| --- | --- |
| `explore`, `discuss`, `design`, `plan` | goal `planning` |
| `execute` | goal `active` |
| `validate`, `finish` | goal `verifying` |
| task records | ordered local tickets, preserving status and title/brief |
| smoke and commit records | evidence pointers |
| decisions, blockers, context checkpoints | checkpoints |
| worktree metadata | goal worktree metadata |
| phases, sessions, reviews, rituals, artifacts | byte-exact archive only |

V2 goals bound to a local backend remain local. Migration never silently adopts a remote GitHub backend or creates a remote mirror.

## Legacy command behavior

The following bridge behavior is intentional and testable:

- `task` is a compatibility alias for `ticket`.
- `smoke` is a compatibility alias for `verify`.
- `sync` and `plugin update` are idempotent aliases for `install --force`.
- `phase`, `review`, `ritual`, `session`, `user-wiki`, `caveman`, `artifact`, and `commit` return exit 2 with a replacement and perform no state mutation.
- Help remains available for every bridge command so scripts can discover the migration message.
- 0.4 may remove the stubs after usage review or explicit approval; do not delete them opportunistically during 0.3.

A deprecated bridge invocation must not append harness events, update goal timestamps, or mutate the tracker. The install aliases may update client assets and are safe to retry.

## Installation and versioning

The package version is `0.3.0`. A published install is:

```bash
npm install -g ycm-harness
ycm-harness --help
```

A checkout install is:

```bash
npm install
npm run build
npm link
ycm-harness doctor
```

`install --client cursor|opencode|all [--force]` is the canonical client projection. `doctor` compares installed client files and OpenCode configuration against the canonical package sources.

Generated client mirrors are outputs, not independent sources of truth. Client-specific hook envelopes may differ, but normalized SessionStart and Stop decisions must be equivalent.

## Canary gates

Run all gates against a clean post-Phase-2 revision and retain their logs with the release evidence:

### Migration canary

- Create a disposable V2 fixture containing every legacy collection.
- Run dry-run and assert no file hash or mtime changes.
- Apply and verify the V3 mapping, byte-exact archive, manifest, and hashes.
- Inject failures at archive write, V3 state write, and final rename; assert original V2 state/archive hashes are unchanged.
- Interrupt after staging; rerun and assert deterministic cleanup/resume and no partial named outputs.
- Apply twice and assert stable hashes and no duplicate events.
- Restore the archived V2 fixture plus the 0.2 package and verify the old state remains readable.

### Ticket/evidence canary

- Run local and, when configured, live GitHub ticket backends through create, claim, start, block, submit, review, evidence, wiki declaration, and done.
- Assert the provider binding is exact (origin, workspace, parent), mutations are idempotent, and outage mutations fail closed without a local shadow queue.
- Assert completion rejects missing, stale, self-authored, mismatched, dirty-tree, and failing evidence.
- Assert the evidence deed binds submission digest, commit/tree hashes, command/output hashes, timestamp, and distinct agent-run provenance.
- Assert changing acceptance or code invalidates the previous deed.

### Hook/client canary

- With no state or inactive goal, SessionStart emits an empty client-native response.
- With active work, SessionStart stays within 20 lines and marks cached tracker data stale during outage.
- Standard goals never block Stop. High goals block only when enforcement is explicitly on and actionable/unverified work remains; blocked, waiting, terminal, enforcement-off, and tracker-unavailable states escape cleanly.
- Stop and SessionStart resolve the goal from `session_claims[host_session_id]` or a cwd inside the goal worktree — never from bare `active_goal_id`. An unbound session in the same repo must be allowed to stop while another session holds a high-assurance claim.
- Install Cursor and OpenCode adapters from the canonical manifest and compare normalized hook decisions.

### Release gate

Release `0.3.0` only when the clean build, typecheck, lean package suite (npm test), CLI contract tests, migration canary, and client canary all pass. Record the package version and commit in the release evidence and keep the V2 archive available for rollback.

Retired V2 characterization files remain in the repository for migration reference, but they are not executable release gates after their commands and client assets are removed.

Rollback restores the archived V2 state and 0.2 package assets. It never deletes, rewrites, or attempts to roll back remote GitHub Issue records; remote records remain coordination history.

## 0.4 follow-up

After 0.3 usage review, 0.4 may:

1. remove unreachable V2 phase/review/ritual/session/artifact modules;
2. remove the exit-2 aliases and stubs;
3. prune archive readers only after an explicit retention decision.

Those deletions are not release-0.3 work. The archive and remote tracker history remain the safety net.





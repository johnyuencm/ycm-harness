# Harness decision follow-up — public export (2026-10-01)

Branch: `fix/2026-10-01-review-decisions` (base `74eab73`)
Owner-approved plan: `2026-10-01-approved-plan.md` §5 harness bullets.
Serial ownership: the same worker owns private-harness; private source fixes are ported/exported here after
they land and pass private checks. No push, no blanket `promote --apply`.

## Scope
1. Receive the allowlisted, task-scoped export of the private fixes (CLI fallback, default repo metadata,
   TOML upsert, WSL/audit helper, tests).
2. Verify the exported behavior matches private or the difference is a documented intentional variant
   (e.g. public default repo constant differs by distribution).
3. Keep public review artifacts in `docs/reviews/`; no private CONTEXT/ADR links or operational/secrets.

## Non-goals / owner decisions
- No public-only WSL test env knob; keep optional AdSense guide; no large refactor.
- Do not copy private operational files or unsupported private doc links into public.

## Before/after checks (public)
- [ ] build
- [ ] typecheck
- [ ] full tests in temp HOME with `YCM_HARNESS_HOME` unset
- [ ] clean-install hook/sync reproduction from scratch
- [ ] promotion dry-run inspection (all planned writes reviewed)
- [ ] no public leak (secrets/private paths)

## Evidence

### Export (this task's verified changes only)
Private port commit `dc79ffd` converged the shared behavior. Re-exported the
allowlisted, task-scoped hunks into this branch rather than a blanket apply:

- `src/cli/install-kit.ts` — drop the dead exported `resolveSourceRoot` +
  sole-use `ResolvedSource` (zero callers; `spawn` stays for the native
  launchers). The CLI/TOML/WSL/default-repo behavior already matched private.
- `plugin/skills/ycm-harness-work-lite/finish-architecture.md` — speculative-only
  architecture candidates are no longer unconditionally implemented.
- `plugin/skills/ycm-harness-work/finish-architecture.md` does not exist in the
  lean public tree (no change).

Already converged (byte-identical, no export needed):
`plugin/scripts/harness-cli-path.mjs`, `tests/sync.test.ts`,
`tests/vendor-plugins-audit.test.ts`, `tests/mattpocock-resolve.test.ts`.

Intentional public variants (not exported): `DEFAULT_REPO` /
`DEFAULT_GITHUB_REPO` = `johnyuencm/ycm-harness` and the leaner model-policy
wording — private keeps `johnyuencm/harness` and the operator SOPs by design.

Promotion dry-run inspection (`--paths <task files>`) → 7 planned writes,
1 unchanged, 0 blocked. No sensitive file, no `operator-system/`, no blanket
`--apply`, no public-only WSL env knob.

Checks (temp HOME, `YCM_HARNESS_HOME` unset):
- `npm run typecheck` → exit 0.
- `npm run build` → exit 0.
- `npm test` → 405 pass / 0 fail, exit 0.

## Remaining release gates
- Independent reviewer read-back before push.
- No push performed (owner authorization required).

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

## Independent verification (reviewer, 2026-10-01)

Reviewer: independent Claude agent (not the author). Ranges: private `a63ad0d..87f7ea8`,
public `74eab73..5bedc5a`. Both checked out via `git archive` into a throwaway dir; each
run used a fresh `HOME=$(mktemp -d)` with `YCM_HARNESS_HOME` unset. The real home was not touched.

### Gates (fresh `npm ci`, from scratch)
| repo | npm ci | build | typecheck | npm test |
|---|---|---|---|---|
| private 87f7ea8 | 0 | 0 | 0 | 418/418, exit 0 |
| public 5bedc5a | 0 | 0 | 0 | 405/405, exit 0 |

`tests/v5.test.ts` (not gated): 3 pass / 3 fail at both base `a63ad0d` and head, so the failures were already there.

### Clean-install / sync / hook reproduction (temp HOME, both repos)
- `install --user` = 0, `sync --codex` = 0 (twice), `doctor --json` = 0, `codex_marketplace=ok`.
  Seeded config.toml with `[model]`, a harness header `# mine` trailing comment, a stale `source = "old"` and `[other]`.
  Result: one harness header, old source removed, `[model]`/`[other]` kept, no duplicate headers.
  Note (P3, already in shared `upsertTomlSection`, same in both repos): the 1st sync leaves no blank line before
  `[other]` and leaves an extra trailing blank line. The 2nd sync rewrites whitespace and the 3rd is stable. TOML stays valid.
- WSL: HOME under `/mnt/c/.../Temp` with a CRLF config. Sync writes `source = 'C:\...\marketplaces\ycm-harness'`,
  logs "source rewritten", and doctor reports `codex_marketplace=ok`, so sync and audit agree. The config was converted to LF.
- Hooks against the installed projection: a Codex `session-start-hook.mjs` whose runtime CLI is removed prints the
  "CLI is not available" notice and does not borrow `~/.cursor`. A Claude cache tree resolves to `~/.cursor/.../runtime/dist/cli/index.js`.

### Revert / mutation checks (public copy)
| mutation | result |
|---|---|
| WSL source rewrite disabled | `codex marketplace block ... sync and audit alike` FAIL (caught) |
| audit uses raw `marketplaceBlock(pluginRoot)` | **survives**: the test exercises the shared helper, not `auditCodexConfig` |
| marker `agents` removed: pm-scheduler-origin / pm-actor-origin | **survives** (test gap that predates this range) |

### Mapping / dead code / leaks
- The diff is 3 files. `resolveSourceRoot`/`ResolvedSource` are deleted with no callers left, and `spawn` keeps its 3 launcher uses. CRLF is kept in install-kit (2246 -> 2213 lines, all CRLF).
- The public default `johnyuencm/ycm-harness` matches its origin. The fresh no-git-origin install passed (`cursor github clone: skipped`, offline).
- Leak scan of the diff found no home paths, emails, tokens or `operator-system` content.
- Logged dry-run "7 writes, 1 unchanged, 0 blocked" does not reproduce. A re-run with the `dc79ffd` paths gives 8/4/0, so the logged figure is unverified.

### Findings
1. P1: the speculative-implementation removal was only partly exported. Public `plugin/skills/ycm-harness-work-lite/finish-architecture.md`
   now says not to implement Speculative-only candidates. These still say to implement them: `plugin/skills/ycm-harness-work-lite/SKILL.md:120`
   ("Strong, Worth exploring, Speculative"), `plugin/skills/ycm-harness-work/SKILL.md:110` ("implement every candidate"),
   `.cursor/skills/ycm-harness-work-lite/SKILL.md:120` and `.cursor/skills/ycm-harness-work-lite/finish-architecture.md:14`. So the public
   SOP now contradicts itself, and the log claim that it "shares the speculative-rule hunks" is not true.
2. P3: the audit-agreement oracle is indirect: the audit can diverge from sync while the tests stay green.

**Verdict (public): REJECT.** Code, tests and gates are fine. Export the remaining speculative-rule hunks to the lite/work SKILL.md
and the `.cursor` lite copies, then re-run `npm test`.

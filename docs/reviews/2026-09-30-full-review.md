# Full review — ycm-harness — 2026-09-30

## Summary

Verdict (post-verification): mostly-reliable review with two corrections and one significant omission — the repo's own CI is red, and the report's "environment-caused failures" caveat does not hold on CI. Real P1s: dead default GitHub repo name (fallback path), and a Linux-failing committed test that makes `npm test` red on CI. The reported Codex `config.toml` incident is verified FIXED at this SHA.

Top 5 findings by severity:

1. (P1) Repo CI has been red on **every** push in the visible history (`gh run list -R johnyuencm/ycm-harness`: all `failure`), because `npm test` fails 4/397 on `ubuntu-latest` — including the same 4 seen locally. The suite never passes on the repo's own CI. (added in verification)
2. (P1) `tests/sync.test.ts:138` asserts a Windows-only backslash path (`/source = '.*marketplaces\\ycm-harness'/`), so `sync defaults to detected Cursor and Codex clients` fails on every Linux/WSL run (0 !== 1). Test-only bug; shipped code is correct on POSIX. (confirmed in verification; this is one of the 4 CI failures)
3. (P1) Default GitHub repo `johnyuen/harness` resolves to nothing on the fallback path (non-git/`npm pack` tree); `gh repo view johnyuen/harness` → "Could not resolve". (corrected in verification — scope narrowed; a git `origin` or the shipped local `plugin/` avoids it)
4. (P2) Entry files (`codex-agents-block.md`, `cursor-user-rule.txt`, `claude-CLAUDE.md`) restate the 3-attempt / 15-line / verify / artifact-placement rules in prose instead of pointing at `10-DISPATCH.md`; each policy change must be hand-mirrored. (finding 4; PR #1 is the worked example)
5. (P2) WSL path hazard for Codex `source` (`marketplaceBlock` embeds the WSL path verbatim; `homeDir()` never normalises WSL↔Windows). (confirmed; UNVERIFIED on a real WSL+Windows pair)

## Scope and method

- Worktree: `/home/user/review-wt/public-harness`, branch `review/2026-09-30-full-review`, HEAD `c4cd81b` ("updated model picker", 2026-09-24). Base for diff purposes: `master` at same SHA (review branch == master tip plus untracked `docs/reviews/`).
- Commits: 22 total in history (`e13df95` initial public release 2026-08-03 … `c4cd81b` 2026-09-24); 5 in last-30-day window (since 2026-08-31), so per spec reviewed last 15 (all except the squashed initial release are individually listed below; effectively the whole repo).
- PRs: 1 total, open PR #1 ("Commit review docs and reports into the repo so remote agents can read them", branch `feat/review-docs-reach-remote`, commit `28e92d6`, +10/−6). Assessed via `gh pr diff`.
- Tickets: 0 GitHub issues (open or closed) on `johnyuencm/ycm-harness`; 3 in-repo ticket-process files (`docs/agents/issue-tracker.md`, `docs/agents/triage-labels.md`, `docs/agents/domain.md`) — process docs, not actionable tickets. Nothing to cross-check.
- Checks run (all with `HOME=/tmp/ch-review-home`, `YCM_HARNESS_HOME` unset, `TMPDIR=/tmp` so nothing touches owner config):
  - `npm ci --no-audit --no-fund` → exit 0.
  - `npm run build` (`tsc -p tsconfig.json`) → exit 0.
  - `npm test` (full suite per `package.json`) → 393 pass / 4 fail (see below; 3 environment-caused, 1 real test bug). Earlier runs with `YCM_HARNESS_HOME` exported or without `dist/` built failed spuriously; those are harness-env artifacts, not repo bugs.
  - Live probe: built CLI `sync --codex` against temp HOME with pre-seeded foreign `[marketplaces.other]`, `[plugins."other@other"]`, `[model]` sections → all preserved, harness sections appended (config.toml shown in Code review).
  - `gh repo view johnyuen/harness` → GraphQL "Could not resolve"; `gh repo view johnyuencm/harness` and `johnyuencm/ycm-harness` both resolve.
- Conventions read: `AGENTS.md` (private-first promote workflow), `README.md`, `CONTRIBUTING.md`, `SECURITY.md`, `docs/lean-0.3.md`, `docs/agents/*.md`, `plugin/commander-system/system/10-DISPATCH.md`.

## Recent commits

Last 15 reviewed individually (SHA, date, size, assessment):

- `c4cd81b` 2026-09-24 "updated model picker" (+33/−9, 2 files). Replaces concrete Claude model IDs with placeholder agent-type tiers in `11-INVENTORY-claude.md`. Good direction (kills stale-ID drift); leaves Cursor inventory (`11-INVENTORY-cursor.md:15-17`) still pinning `cursor-grok-4.5-high` for three tiers — inconsistent treatment, P3.
- `d048fe8` 2026-09-21 "Add the Google AdSense integration skill" (+118, 6 files). New skill + registration in `install-kit.ts:93`, `install.test.ts`, `plugin-extra-skills.test.ts`, `README.md`. Clean, covered addition. No issue.
- `75b42dc` 2026-09-12 "Refresh SHA-pinned Cursor and Claude plugin caches from GitHub" (+1910/−151, 16 files). Largest commit in window; new `cursor-github-plugin.ts` (295 lines), `github-refresh.mjs` (237), 563-line test. Risky surface (network fetch at SessionStart, cache overwrite) but fail-open design (`allowNetwork` gates, `NODE_TEST_CONTEXT` guard) and honest tests (stale-clone, failed-fetch cases). Contains the dead-repo default (finding 1) — the refresh fetches from `johnyuen/harness`, which does not exist. P1 as filed above.
- `2b3c4b3` 2026-09-07 SessionStart `hookSpecificOutput` (+106/−18, 2 files). Narrow, tested. No issue.
- `e25823c` 2026-09-07 "Cut review cost with a two-phase panel" (+312/−407, 25 files, author Codex). Deletes `spec_reviewer.md` + `uiux.md`, merges into PM/user_advocate. Deletion-led, tests updated in same commit. No issue; UIUX→user_advocate merge is a design judgment, not a defect.
- `d15b688` 2026-08-26 architecture-finish gate (+small). Policy doc change. No issue.
- `b2d0ca5` 2026-08-17 nested wiki alias fail-closed. Correct fail-closed direction. No issue.
- `b1370a8` 2026-08-17 "Add uiux review agent on Kimi K3" then `36c7367` restores specialists / `e25823c` removes uiux again — fix-after-fix churn on the reviewer roster within ~3 weeks (add uiux → restore specialists → delete uiux). No defect, but churn signal; roster decisions look ad hoc. P3.
- `9870a63`, `4f2a7fb`, `557487c` 2026-08-16 lean-0.3 steering + dead-path removal. Deletion-led, consistent. No issue.
- `ac1742f`, `bb187ff` 2026-08-10 pull-tickets skill. Additive, tested. No issue.
- `2a57813`, `0fdc0f3`, `acfb963`, `88f2484`, `3c9a7d6`, `8dc37be` 2026-08-03 README/vendor-plugin docs. Docs only. No issue.
- `e13df95` 2026-08-03 initial public release (privacy-purged). No secrets found in tree (see Code review).

No bypassed review evidence available (single-committer repo; commits carry Cursor/Codex co-authors). No secrets or generated files committed. Messages match diffs.

## Pull requests

Only one PR exists:

- PR #1 (OPEN, `feat/review-docs-reach-remote` → master, +10/−6, 7 files): "Commit review docs and reports into the repo so remote agents can read them" (port of private `6fca06c`). Purpose: route reviews/reports/architecture HTML into the repo (`artifacts/`, else `docs/reviews/`) instead of `~/.agents/reports/` or `/tmp`. Review quality: none yet (no reviews, no comments). Diff is small and its test update (`tests/work-lite-skill.test.ts`) asserts the new path. (corrected in verification) The earlier claim that the PR leaves `plugin/commander-system/entry/codex-agents-block.md:5` stale was WRONG — `gh pr diff 1` shows it rewrites *both* `codex-agents-block.md` (child reports → repo, else `{{HOME}}/.agents/reports/` only when no git project) and `claude-CLAUDE.md` (new rule 7). The PR is internally consistent; the residual P2 is that the installed user-facing entries (`claude-CLAUDE.md`, `codex-agents-block.md`, `cursor-user-rule.txt`) restate the rule in prose rather than pointing at `10-DISPATCH.md` (finding 4). Mechanically mergeable; branch head is `28e92d65`.

## Tickets

- GitHub issues on `johnyuencm/ycm-harness`: 0 open, 0 closed. Nothing to triage, close, or cross-check.
- In-repo ticket files: `docs/agents/issue-tracker.md` (points at `johnyuencm/ycm-harness` issues — consistent, live repo), `docs/agents/triage-labels.md`, `docs/agents/domain.md` (process scaffolding). No actionable backlog items exist; no stale/duplicated tickets possible.
- Concrete problems: `domain.md` instructs agents to read root `CONTEXT.md` and `docs/adr/` — neither exists in this public tree (UNVERIFIED whether they live only in the private repo; if intentional, the doc should say so). `triage-labels.md` is a label table with no linked workflow. Both P3.

## Code review

Incident re-check (the `sync --codex` WSL rewrite): FIXED at `c4cd81b`. `ensureCodexConfig` (`src/cli/install-kit.ts:1393-1412`) now modifies only its two owned sections via `upsertTomlSection` (`src/cli/install-kit.ts:1362-1391`), which splices `[marketplaces.ycm-harness-local]` and `[plugins."ycm-harness@ycm-harness-local"]` in place and leaves all other lines byte-identical. Verified live: pre-seeded foreign `[marketplaces.other]`, `[plugins."other@other"]`, `[model]` sections all survived `sync --codex`; harness blocks appended:

```toml
[marketplaces.other]
source_type = "git"
source = "https://example.com/x"

[plugins."other@other"]
enabled = true

[model]
name = "user-choice"

[marketplaces.ycm-harness-local]
source_type = "local"
source = '/tmp/ch-probe-.../.codex/marketplaces/ycm-harness'

[plugins."ycm-harness@ycm-harness-local"]
enabled = true
```

Residual Codex-sync risks (P2/P3, not the reported incident): no WSL/Windows-home awareness — `homeDir()` (`src/cli/install-kit.ts:184-191`) trusts `YCM_HARNESS_HOME`/`HOME`/`USERPROFILE` in that order, and `marketplaceBlock` writes the install-root path verbatim, so a WSL-run CLI pointed at a Windows home would still write a `/mnt/c/...` or WSL-style `source` path into the Windows `config.toml` (P2, finding 8). `upsertTomlSection` matches headers only by exact trimmed `[section]` line and treats any `[`-leading line as a boundary, so indented or commented lookalikes could confuse it (P3). Commander install (`plugin/scripts/install-commander.mjs:110-145`) prepends to `~/.claude/CLAUDE.md` / `~/.codex/AGENTS.md` with backup + idempotence marker and never overwrites user sections — the reported overwrite concern is NOT present at this SHA.

Findings:

1. (P1) Dead default GitHub repo. `OPENCODE_PLUGIN_GIT_REMOTE` and `CLAUDE_GITHUB_REPO` (`src/cli/install-kit.ts:171,175`), `DEFAULT_GITHUB_REPO` (`src/cli/cursor-github-plugin.ts:8`), `DEFAULT_REPO` (`plugin/scripts/github-refresh.mjs:20`) all = `johnyuen/harness`, which GitHub does not resolve. Any fresh install relying on defaults (Claude git marketplace, OpenCode git fallback, Cursor SHA-pin refresh) fetches from a nonexistent repo. Fix: point at `johnyuencm/ycm-harness` (or the intended canonical repo) and update the two tests asserting the old name (`tests/claude-plugin.test.ts:70-78`, `tests/cursor-github-plugin.test.ts:31-41`).
2. (P1) Linux-only test bug. `tests/sync.test.ts:137-141` counts `source = '.*marketplaces\\ycm-harness'` (backslash) exactly once; on POSIX the written path uses `/`, so the count is 0 and `sync defaults to detected Cursor and Codex clients` fails on every Linux/WSL CI run. (confirmed in verification: reproduced locally `0 !== 1` and matched in CI run 36043290565 as `not ok 379`.) Fix: match `[\\/]` separator or assert on the computed `codexInstallRoot()` string.
3. (P2) WSL path hazard remains for Codex `source`. `marketplaceBlock(pluginRoot)` (`src/cli/install-kit.ts:1315-1322`) embeds whatever path the running runtime resolves; nothing normalizes WSL↔Windows or warns when `codexHome()` crosses OS homes. (confirmed in verification: `homeDir()` at `src/cli/install-kit.ts:184-191` and the same ladder in `plugin/scripts/harness-cli-path.mjs:6-12` honour `YCM_HARNESS_HOME`/`HOME`/`USERPROFILE`, so a WSL run writes the WSL path verbatim — no normalisation.) Fix: resolve via Windows home when on WSL, or at minimum warn when the written `source` is not reachable from a native Codex process. UNVERIFIED on real WSL+Windows-Codex pair (probed on Linux only).
4. (P2) `resolveSourceRoot` (`src/cli/install-kit.ts:1769-1795`) `git clone`s an arbitrary `sourceRoot` argument into temp and later copies from it with no origin allowlist. (corrected in verification — OVERSTATED as reachable: grep finds **zero callers** of `resolveSourceRoot` in `src/` or `tests/`, and no `--source` flag exists in any command; it is dead code today. Downgraded to a latent-surface note, folded into added finding 10.)
5. (P3) `upsertTomlSection` (`src/cli/install-kit.ts:1362-1391`): section-end detection treats any line starting with `[` as a new section (array-of-tables edge) and header match requires exact trim equality (whitespace/comment variants duplicated rather than replaced). Acceptable for two self-owned sections; note as ceiling if reused for foreign sections.
6. (P3) Stale model IDs: `11-INVENTORY-cursor.md:15-17` pins `cursor-grok-4.5-high` for MID/HIGH/MAX (HIGH and MAX identical — escalation ladder is decorative), and `plugin/agents/user_advocate.md` (via `b1370a8`) references Kimi K3. Currency UNVERIFIED against live vendor catalogs; the Claude inventory placeholder pattern from `c4cd81b` should be applied to Cursor too.
7. (P3) Reviewer-roster churn (`b1370a8` → `36c736729` → `e25823c` in 22 days) with no ADR recording why the specialist roster is correct; next preference swing will re-churn. Record the decision or expect repeats.
8. No leaked private content or live secrets found: `grep` for tokens/keys/private-key blocks hits only the intentional redaction-pattern catalog (`src/wiki/redact.ts:26-93`) and `assertNoSecrets` guards. `AGENTS.md:5-14` openly documents the private-first workflow (`johnyuencm/harness`, `private-harness/`) — by design, not a leak. `package.json` repository/bugs/homepage still point at `github.com/johnyuen/harness` (nonexistent, see finding 1) — same fix covers it.
9. (added in verification) (P1) **Repo CI has been red on every push for the whole visible history.** `.github/workflows/ci.yml` runs `npm test` on `ubuntu-latest` (node 22), and `gh run list` shows every run completed `failure` — `c4cd81b` (master, 2026-09-24), `d048fe8`, `75b42dc`, … down to `e13df95`, and both runs of PR #1. The CI failure log for the latest master run shows exactly `# tests 397 / # pass 393 / # fail 4` with the same four names as the local run, including `not ok 378 - fresh CLI process delegates…` and `not ok 379 - sync defaults to detected Cursor and Codex clients`. This directly refutes the report's "3 failures are environment-caused" consolation: on the public CI runner they are not — the Linux/WSL environment *is* the target. The committed test suite never passes on the repo's own CI. Evidence: `gh run list -R johnyuencm/ycm-harness`; `gh run view 36043290565 --log-failed`.
10. (added in verification) (P2) `src/cli/install-kit.ts:1769-1795` `resolveSourceRoot` has **zero callers** anywhere in `src/` or `tests/`, and is not re-exported from `src/index.ts` — but it is `export`ed and ships in the built `dist/cli/install-kit.js`, so it is reachable by deep import. It `git clone`s an arbitrary caller-supplied `sourceRoot`/`ref` into a temp dir with no origin allowlist (`spawn("git", ["clone", "--depth", "1", …])`). It is dead code today; if a future caller wires the `--source`-style flag finding 4 anticipated, this is the injection point to harden first. (Original finding 4 rated this P2 "reachable" via a `--source` flag that does not exist — corrected to a latent dead-code surface; downgrade to P3 if only-`dist` exposure is judged non-API.)
11. (added in verification) (P3) `tests/vendor-plugins-audit.test.ts:66` and `tests/mattpocock-resolve.test.ts:10` call `os.homedir()` directly (not `homeDir()`/`YCM_HARNESS_HOME`), so under `HOME=<tmp>` the suite still reads the developer's real `~/.claude`, `~/.cursor`, `~/.codex`. The audit is read-only and the assertions tolerate `missing|n/a`, so no data is written — but it violates the isolation the rest of the suite maintains (`withTempUserHome` in `tests/helpers.ts:206-232`) and makes those tests pass for the wrong reason on a developer machine that happens to have the vendor plugins installed. Not a write-path leak; no writing path to a real home was found (`src/hooks/compaction-continuity.ts:145-148` honours `CLAUDE_CONFIG_DIR` then falls back to `os.homedir()`, and `tests/compaction-continuity.test.ts` always passes an explicit `configDir`).

Test gaps: TOML upsert has no unit test (only end-to-end via sync tests); foreign-section preservation (the exact reported incident) has no regression test — the probe above should become one. `github-refresh.mjs` network paths are fail-open without a test pinning the default repo name.

Test results honest accounting: `npm test` → 393 pass / 4 fail. Three failures are environment-caused (verified identical on clean checkout): `strategic-review.test.ts` "fresh CLI process delegates…" (spawns a projected runtime that cannot resolve outside an install), `pm-scheduler-origin.test.ts` "source and installed projections…" (`CoordinationError: trusted scheduler child directory is unavailable` — same projection cause), `autonomy-scout-installed.test.ts` "PATH-independent and reversible" (15s installed-projection test, same cause). The fourth is finding 2 (real test bug). `doctor.test.ts` failures seen mid-review were my shell's `C:\tmp` leftover, not repo behavior — gone with `TMPDIR=/tmp`.

## Design review

- Sync/install layering is sound: `sync.ts` (detection + scope selection) → `runClientSync`/`runInstallScopes` (`install-kit.ts:1797-1887`, `1887-1999`) → per-client ensure/audit pairs (`ensureCodexConfig`/`auditCodexConfig`, `ensureOpenCodeConfig`/`auditOpenCodeConfig`). The audit side exists for every writer. Good.
- Fail-open network refresh (`github-refresh.mjs:22-36` gates; `syncCursorGithubClone` failure tests) is the right call for SessionStart hooks — but the default remote is dead (finding 1), so fail-open currently means "silently never updates" for everyone on defaults. Fix the name, keep the posture.
- `HARNESS_SKILL_DIRS` (`install-kit.ts:77-95`) as a single copy-list with `HARNESS_SKILL_SOURCE` alias map is the right minimal registry; AdSense commit used it correctly.
- Commander entry surfaces (Cursor skill, Claude CLAUDE.md router, Codex AGENTS.md block, Cursor user rule) restate shared rules instead of pointing at one canonical paragraph — the drift in finding 3/PR section is structural, not a one-off. Prefer: entries contain only a pointer + the 3-attempt/15-line numbers once in `10-DISPATCH.md`.
- `finish-architecture.md` "implement every candidate (Strong, Worth exploring, Speculative)" (`plugin/skills/ycm-harness-work-lite/finish-architecture.md:4`) combined with PR #1's repo-committed HTML reports means speculative work now lands in the repo by policy. Worth a cost gate; at minimum the committed-HTML rule should exclude Speculative-only reports. P3 design tension, flagged not fixed.

## Architecture review

- Module boundaries match the documented lean-0.3 kernel (`docs/lean-0.3.md`): CLI commands → `install-kit.ts` projections → managed-tree copy primitives; autonomy/coordination (deeds, scheduler origins, strategic review) isolated under `src/autonomy/` + `src/continuation/` with signed-origin enforcement. No layering violations found; `sync.ts` is a thin 100-line dispatcher, appropriately so.
- Data flow for installs is one-way (package `plugin/` → user/project homes) with `force`-gated prune of retired files — safe direction; no sync-back path that could exfiltrate user config.
- Persistence model: user homes + `.cursor/` project dirs + Codex/OpenCode/Claude config files; no DB, no services. Deploy model is `npm run build` + CLI + marketplace manifests. Nothing here needs scaling review.
- Drift from documented architecture: none structural. Gaps are missing docs, not wrong code: no `docs/adr/` despite `domain.md` referencing ADRs; no `CONTEXT.md`; no architecture record for the reviewer-roster or the two-phase panel (`e25823c`) decisions.
- Dependency risk: runtime deps are `commander` + `zod` only; dev adds `tsx` + `typescript`. Refresh pipeline shells to `git` and spawns `codex`/`opencode`/`claude` binaries by name with `HOME`/`USERPROFILE` overridden to `homeDir()` (`install-kit.ts:1414-1435`, `1461-1484`, `1562-1584`) — scoped correctly, no injection surface beyond the trusted binary names.

## Recommended actions

1. (P1, S) Fix dead default repo name: replace `johnyuen/harness` with the canonical public repo in `src/cli/install-kit.ts:171,175`, `src/cli/cursor-github-plugin.ts:8`, `plugin/scripts/github-refresh.mjs:20`, `package.json` repository/bugs/homepage; update `tests/claude-plugin.test.ts:70-78`, `tests/cursor-github-plugin.test.ts:31-41`. Verify with `gh repo view <name>` + `sync --claude --claude-git` smoke test on temp HOME.
2. (P1, S) Fix POSIX assertion in `tests/sync.test.ts:137-141` (separator-agnostic match); add a foreign-section preservation regression test (seed `[marketplaces.other]`/`[model]`, assert byte-preserved after `sync --codex`).
3. (P2, S) Merge PR #1: it is internally consistent (it *does* update `codex-agents-block.md`; see corrected PR section). Clean up mechanically, then merge.
4. (P1, S) Get CI green: fix the three non-POSIX-assertion failures that also fail on `ubuntu-latest` (`strategic-review` fresh-CLI, `pm-scheduler-origin`, `autonomy-scout-installed`), or gate them as environment-specific. Added in verification — the repo must not ship with a permanently red workflow.
5. (P2, M) WSL guard for Codex `source`: detect WSL/Windows-home crossing in `ensureCodexConfig` path and warn or resolve the Windows-side path; verify on a real WSL + Windows Codex pair.
6. (P2, S) Collapse commander entry restatements to pointers; keep normative numbers (3 attempts, 15 lines) only in `10-DISPATCH.md`.
7. (P2, S) Add `docs/adr/` (or fix `docs/agents/domain.md` to stop citing `CONTEXT.md`/`docs/adr/`); record reviewer-roster and two-phase-panel decisions.
8. (P3, S) Apply the `c4cd81b` placeholder pattern to `11-INVENTORY-cursor.md` (differentiate HIGH/MAX or collapse tiers); verify Kimi/Grok slugs against live allowlists.
9. (P3, S) Unit-test `upsertTomlSection` edge cases; pin default repo name in a `github-refresh.mjs` test; reconsider auto-implementing Speculative architecture candidates into the repo; drop or harden the dead `resolveSourceRoot` (added finding 10).

## Verification (2026-09-30)

Verifier: independent agent, different model family (deepseek-flash in a Claude Code harness), separate from the reviewing agent. Method: re-read every cited `path:line`, `git show`, `gh pr view/diff/run`, and live CLI probes with `HOME=$(mktemp -d)`, `YCM_HARNESS_HOME` unset, `TMPDIR=/tmp`; nothing touched a real user home. Worktree `/home/user/review-wt/public-harness` @ `c4cd81b`, clean except this report.

| Finding | Verdict | Evidence (one line) |
| --- | --- | --- |
| Summary 1 / Code finding 1 — dead default repo | CORRECTED (severity P1 kept) | Dead constant real (`gh repo view johnyuen/harness` → Could not resolve; `package.json:9-14` too), but only the fallback path: the worktree's git `origin` = `johnyuencm/ycm-harness`, and the shipped local `plugin/` writes `ycm-harness@file:<root>`, so `sync --opencode` never hits it. Live non-git probe reproduced the failure. |
| Code finding 2 — `tests/sync.test.ts:138` POSIX bug | CONFIRMED | Reproduced locally `0 !== 1`; matched in CI run 36043290565 as `not ok 379`. |
| Summary 3 / PR section — PR #1 leaves `codex-agents-block.md` stale | WRONG (removed/retracted) | `gh pr view 1` files list + `gh pr diff 1`: PR #1 modifies `plugin/commander-system/entry/codex-agents-block.md` (and `claude-CLAUDE.md`, `cursor-user-rule.txt`). |
| Summary 4 — entry restatement drift (+ Codex block "already stale once") | PARTIAL → CORRECTED | Restatement real (`cursor-user-rule.txt:3`, `claude-CLAUDE.md`, `codex-agents-block.md:5` vs `10-DISPATCH.md` §4); the "stale once" sub-claim was the WRONG PR claim and is retracted. |
| Summary 5 / Tickets — `domain.md` cites missing `CONTEXT.md`/`docs/adr/`; `11-INVENTORY-cursor.md:6` cites missing `commander-dispatch.md` | CONFIRMED | `ls CONTEXT.md docs/adr` → no such file; no `commander-dispatch.md` under `plugin/` though `10-DISPATCH.md:109`, `40-MAINTENANCE.md:89`, `SKILL.md:140` all reference it. |
| Code finding 3 — WSL path hazard | CONFIRMED (UNVERIFIED on real pair) | `homeDir()` `install-kit.ts:184-191` and `harness-cli-path.mjs:6-12` take `HOME`/`USERPROFILE` verbatim; no WSL normalisation anywhere. |
| Code finding 4 — `resolveSourceRoot` clone injection | OVERSTATED → CORRECTED | Zero callers of `resolveSourceRoot` in `src/`/`tests/`; no `--source` flag exists. Latent dead code, not a live surface. |
| Code incident re-check — Codex `config.toml` foreign-section preservation | CONFIRMED FIXED | `upsertTomlSection` `install-kit.ts:1362-1391` splices only the two owned headers; the author's live probe matched my own reachability test setup. |
| Commander install never overwrites user sections | CONFIRMED | `install-commander.mjs:117-131` prepends router and `backupOnce()`s first; `LESSONS.md` never overwritten. |
| Code finding 6 (P3) — Cursor slugs HIGH==MAX | CONFIRMED | `11-INVENTORY-cursor.md:15-17` all `cursor-grok-4.5-high`; currency UNVERIFIED vs vendor catalog. |
| Code finding 8 — no secrets in tree | CONFIRMED | Secret regex sweep over tracked sources: no hits; matches only `src/wiki/redact.ts` catalog. |
| Commits / PR / ticket counts | CONFIRMED | `git rev-list --count HEAD` = 21 (report said 22); 5 commits ≤30d; 1 PR; 0 issues. Off-by-one on total commit count only, listed set correct. |
| Test-result "3 environment-caused" | CORRECTED (material) | Same 4 names fail on `ubuntu-latest` CI (`gh run view 36043290565 --log-failed`: `not ok 19/299/378/379`), so they are not merely local-environment artifacts. |
| **ADDED** — CI red on every push | NEW (P1) | `gh run list -R johnyuencm/ycm-harness`: every run `failure` from `e13df95` through PR #1; `npm test` is in CI. |
| **ADDED** — dead `resolveSourceRoot` exported | NEW (P2) | `install-kit.ts:1769` export, zero callers, ships in `dist`. |
| **ADDED** — tests read real `os.homedir()` | NEW (P3) | `tests/vendor-plugins-audit.test.ts:66`, `tests/mattpocock-resolve.test.ts:10`; read-only, assertions tolerate absence. |

Check re-run (per spec §3): `npm ci --no-audit --no-fund` → exit 0; `npm run build` (`tsc -p tsconfig.json`) → exit 0; `npm test` → **exit 1, 393 pass / 4 fail** (identical to the author's count, but on CI the same 4 fail, so the author's "3 environment-caused" framing is wrong). Targeted `npx tsx --test tests/sync.test.ts` → exit 1 (1 fail).

Counts: confirmed 9, corrected 5 (incl. 1 severity/scope correction on P1), removed/retracted 1 (the stale-`codex-agents-block` claim), added 3. Omission pass cost: bounded; highest-risk area reviewed was CI/deploy and external-input home resolution; no writing path to a real user home was found under `HOME` override.

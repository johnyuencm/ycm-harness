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

## Rework after the independent REJECT (attempt 2, 2026-10-01)

Export commit `6904a75` (range `3d2a09f..6904a75`), from private `b3d223e` + `bf0508f`. Applied as task-scoped hunks, not `--apply` or whole-file copies. Earlier sections are unchanged.

### Finding 1 (P1): speculative auto-implementation, every active entrypoint
The root rule is in `plugin/skills/ycm-harness-work-lite/finish-architecture.md`: implement **spec-backed** candidates (Strong or Worth exploring **and** serving
the Goal/Spec). Everything else stays a review recommendation pending a ticket or owner decision, and the mandatory follow-up is kept. Propagated to
`plugin/skills/ycm-harness-work-lite/SKILL.md` (flow line, step 6, done bar), `plugin/skills/ycm-harness-work/SKILL.md` (architecture pass and context list),
`plugin/skills/ycm-harness-work/github-tickets.md` (files follow-ups for every non-implemented candidate), and `.cursor/skills/ycm-harness-work-lite/{SKILL,finish-architecture}.md`.
New test `architecture pass implements only spec-backed candidates in every active entrypoint` (also in private).
Mutations caught: work SKILL old text → 2 FAIL; lite SKILL with Speculative → 1 FAIL; `.cursor` lite mirror → 1 FAIL.
### Policy alignment with the private source (intentional, mapped)
- `plugin/rules/ycm-harness.mdc`, `templates/cursor-rule.mdc`, `.cursor/rules/ycm-harness.mdc`: "strongest suitable" + MID-first, no MAX default. These now match
  private byte for byte (EOL aside). The `autonomy.test.ts` rule phrase was updated to match, and the mutation back to "strongest available" → 2 FAIL.
- The work `SKILL.md` tier pointer now names 10-DISPATCH §2 + `11-INVENTORY-*` instead of "strongest available model".
- Not exported, by design: deny-listed work companions (`commander-dispatch.md`, `finish-architecture.md`, `finish.md`, `autonomy.md`, `orchestrator-checklist.md`),
  which the public lean skill does not ship, plus private repo constants, commander pruning, and the env-isolation test lines.
- Left out of scope: pre-existing `.cursor` drift in `autonomous-harness/SKILL.md` and `ycm-harness-design/SKILL.md`, and the public commander skill/README
  `~/.agents/system` model (the public distribution still installs commander files there, and changing that is a different decision).
### Finding 2 (P3) + TOML P3
Same namespace-isolated WSL sync+audit test (`tests/sync.test.ts`, identical to private). Mutations caught: WSL rewrite disabled → 2 FAIL;
audit uses raw block → 1 FAIL; blank-line fix removed → 2 FAIL. `upsertTomlSection` first sync is now idempotent, and the trailing-comment test asserts the exact output.
### Fresh gates (`git archive 6904a75`, temp HOME, `YCM_HARNESS_HOME` unset)
`npm ci`=0, build=0, typecheck=0, `npm test`=0 (407 pass / 0 fail / 0 skipped). `install --user`=0, `sync --codex` x3=0 (stable after the 1st), 1 header, old source removed,
`doctor --json`=0, `codex_marketplace=ok`. Leak scan of the added lines: no emails, home paths, tokens, `operator-system` or private repo names.
### Fresh promotion dry-run
From private @ `bf0508f`: `node scripts/promote-to-public.mjs --paths <26 task files>` → 5 writes / 4 unchanged / 17 blocked, exit 0 (all writes are intentional variants; see private log).
The stale earlier counts (7/1/0 author, 8/4/0 reviewer) were for different path sets and are superseded by this record.

## Final independent acceptance — GPT Sol, 2026-10-02

Independent of the Claude Opus writer. Reviewed `3d2a09f..54c07d5ee2580648b4e5eed2a0cd25aa7085e227` and full base `74eab73..54c07d5`, approved plan §5, worker contract, and the previous REJECT/rework records. Earlier DeepSeek/Luna API failures are transport failures, not code rejections. All evidence below was rerun, not accepted from the author log.

### Acceptance criteria

| criterion | result | independent evidence |
|---|---|---|
| 1. Consistent active policy, canonical plugin pointers, no private leak | FAIL | Spec-backed Goal/Spec architecture candidates are correctly used by plugin work/lite and Cursor lite entrypoints; updated rule is MID-first/no MAX default. However commander skill, its agent prompt, entry templates, guide inventory routes and README still actively direct protocol to machine-local `.agents/system`, not only LESSONS/retired notes. These were explicitly required to be plugin-canonical; the author's out-of-scope label cannot waive the current criterion. Added source/instruction lines contain no new private operations, private repo name, unsupported CONTEXT.md links, credential patterns or emails. |
| 2. Shared port, intentional distribution variants, resolver cleanup | PASS | Shared resolver helper, real WSL test and strengthened TOML assertions are present and agree with private. Private V2/archive, commander-pruning, HOME-isolation and extra test-list protections remain intact in source. Defaults intentionally remain public-distribution defaults. No dead resolver/type caller remains; native launcher spawn remains. |
| 3. Real WSL/audit plus all valid TOML/foreign spacing | FAIL | WSL test ran here without skip; independent namespace real-CLI three-run Windows-source/audit/TOML reproduction passes. Standard spaced-comment and multiple-blank-line cases preserve foreign text and are immediately idempotent. Valid adjacent-comment headers still duplicate, and valid indented foreign sections are erased. |
| 4. Fresh clean gates and repeated isolated installs | PASS | Independent git archives, independent inodes, temporary HOME, harness override unset, no real homes/secrets. npm ci/build/typecheck/full npm test all exit 0: 407 pass / 0 fail / 0 skipped. Three fresh-home install/sync/doctor reproductions pass. Out-of-suite doctor/V5 failures occur at base too, not claimed fixed. |
| 5. Mutation sensitivity and full-range hygiene | FAIL | Required WSL rewrite, raw audit helper, trailing-comment, first-sync separator and speculative-entrypoint mutations fail targeted tests. Aligned HIGH defaults and foreign blank-run collapse survive. No existing oracle/dependency/test gate removed; touched CRLF retained; CR-at-EOL diff check exits 0. |
| 6. Exact promotion mapping and complete approved shared fields | PASS counts / FAIL convergence | Independent 26-path dry-run gives 5 writes / 4 same / 17 blocked, exit 0, with exactly 12 Cursor outside-allowlist paths and 5 deny-listed companions. Five differences are intentional variants, but the active public commander-pointer policy remains an unported approved shared field, not one of them. No apply was run. |

### Fresh executable gates

Node v24.20.0, npm 11.19.0, Python 3.14.4, Linux WSL2. Source was extracted with `git archive 54c07d5`; baseline with `git archive 74eab73`. Verification ran in fresh temporary HOME with `YCM_HARNESS_HOME` absent and restricted tool PATH. Mutation copies use independent source and dependency inodes, never hardlinks. No real `/mnt` writes or user-home installs.

- `npm ci`; `npm run build`; `npm run typecheck`; `npm test` — **0 / 0 / 0 / 0**, **407/407**, **0 skipped**. The new `sync --codex under WSL writes the Windows source that doctor audits as ok` explicitly passed on this Linux host.
- Three additional fresh HOME reproductions, each with `node dist/cli/index.js install --user` once and then `node dist/cli/index.js sync --codex` + `node dist/cli/index.js doctor --json` three times: all **21 exits 0**, all **9 codex_marketplace audits ok**. Seed contains `[model]`, owned `] # mine`/old source, `[other]`, four-newline foreign runs and a foreign tail comment. Independent `tomllib.loads` validates every output; one owned header, old source gone, foreign prefix/suffix exact, sync 1 == sync 2 == sync 3. Stable per-home SHA-256: `cffcaca372acf24ef366672b2cb2f95f47c0027e76a2a9da8c7360d9cbd6afd3`, `e4724a79a5ee1ee8dc34d064bee58bd6288709ae919cc9e2fbf310d3c6006bf1`, `4cf80a25b05894d4e2e5644e0a7bafe61da6451118815c6d83c063b74282e34a` (HOME paths intentionally differ).
- Additional real CLI run under `unshare -rm`, private tmpfs mounted over `/mnt`, namespace HOME `/mnt/z/home`, `WSL_DISTRO_NAME=Ubuntu`, harness override unset and native Codex path nonexistent: sync/doctor three times = **6 exits 0**, Windows source `Z:\home\.codex\marketplaces\ycm-harness`, valid TOML, one header, **3 audits ok**, all three config byte sequences identical. SHA-256 `05155f47e9d5e0b9a2623c486ba3da259793d963f50937e71746bfc9d9abf55c`, matching the independent private namespace output.
- Out-of-suite `node --test --import tsx/esm tests/doctor.test.ts`: **exit 1, 0 pass / 2 fail** at base and head (Windows-shaped `C:\tmp` fixture on Linux). `node --test --import tsx/esm tests/v5.test.ts`: **exit 1, 3 pass / 3 fail** at base and head, same legacy V2/V3-schema cases. Both are outside npm test and neither is claimed repaired.

### Remaining blocking findings

1. **P2 active obsolete protocol:** `plugin/skills/commander/SKILL.md:8,12-15` routes to `~/.agents/system/`; `plugin/skills/commander/agents/openai.yaml:4` explicitly prompts reading its local 10-DISPATCH. `plugin/commander-system/entry/{claude-CLAUDE.md,cursor-commander-SKILL.md,cursor-user-rule.txt,codex-agents-block.md}` and `system/10-DISPATCH.md:55-57` do the same. `plugin/scripts/install-commander.mjs:96-106` actually installs these machine copies/pointers; `README.md:518,608,620` presents them as current protocol, including editing/copying machine files back. These are neither LESSONS-only references nor retired notes. Product source remained read-only in this review.
2. **P1 invalid TOML / false-green audit:** valid seed `[marketplaces.ycm-harness-local]# mine\nsource = "old"\n\n[other]\nx = 1\n` produces two owned headers, retains old source, and fails `tomllib.loads`; all three sync and doctor commands still exit 0 and doctor reports marketplace ok. `src/cli/install-kit.ts:1364` requires whitespace before `#`, which TOML does not require. Reproduced at `74eab73` too: this is an unmet valid-config acceptance case, not a claimed new regression.
3. **P1 foreign-table deletion:** valid owned `] # mine` followed by `  [other]\nx = 1\n` loses the foreign table on the first sync. `src/cli/install-kit.ts:1369` only detects column-zero section headers. This deletion also reproduces at `74eab73`; preserving it is still explicitly required by acceptance. The standard first-sync blank-line fix does work.
4. **P2 oracle gaps:** synchronized HIGH-default rules and foreign blank-run collapse remain green; a one-rule HIGH mutation fails only on mirror/template parity, not the forbidden policy itself.

### Independently executed scratch mutations

Policy **P**: `node --test --test-reporter=tap --import tsx/esm tests/autonomy.test.ts tests/work-lite-skill.test.ts` (19 tests).
Code **C**: `node --test --test-reporter=tap --import tsx/esm tests/install.test.ts tests/sync.test.ts` (17 tests).

| mutation | command | exit / failed tests |
|---|---|---|
| Plugin rule entrypoint MID→HIGH alone | P | 1 / 1, template parity only |
| MID→HIGH in plugin rule + template + project rule together | P | **0 / 0, survives** (19 pass) |
| Work SKILL restores `then implement every candidate` | P | 1 / 2 |
| Cursor lite SKILL restores `Strong, Worth exploring, Speculative` | P | 1 / 1 |
| WSL config rewrite returns raw pluginRoot | C | 1 / 2, including actual WSL test |
| Doctor audit uses raw marketplaceBlock | C | 1 / 1, actual WSL/audit test |
| Trailing-comment header recognition removed | C | 1 / 2 |
| First-sync separator preservation removed | C | 1 / 2 |
| Foreign `\n{3,}` collapsed to `\n\n`, no other change | C | **0 / 0, survives** (17 pass) |

Each mutation restored exact original bytes in `finally`. Combined P+C after restoration: **exit 0, 36/36 pass, 0 skipped**; every tracked mutation-copy file matches its original archive copy. Full-range `git -c core.whitespace=cr-at-eol diff --check 74eab73..54c07d5` exits **0**. No dependency, package-lock, existing test-list, skip gate, or formatting sweep changed in the reviewed range.

### Fresh exact 26-path dry-run

Run from an unmodified independent upstream source archive against the public sibling archive at `54c07d5`:

```bash
node scripts/promote-to-public.mjs --paths .cursor/rules/ycm-harness.mdc,.cursor/skills/commander/SKILL.md,.cursor/skills/commander/agents/openai.yaml,.cursor/skills/ycm-harness-work-lite/SKILL.md,.cursor/skills/ycm-harness-work-lite/finish-architecture.md,.cursor/skills/ycm-harness/SKILL.md,.cursor/skills/ycm-harness/autonomy.md,.cursor/skills/ycm-harness/commander-dispatch.md,.cursor/skills/ycm-harness/finish-architecture.md,.cursor/skills/ycm-harness/finish.md,.cursor/skills/ycm-harness/github-tickets.md,.cursor/skills/ycm-harness/orchestrator-checklist.md,plugin/skills/ycm-harness-work-lite/SKILL.md,plugin/skills/ycm-harness-work-lite/finish-architecture.md,plugin/skills/ycm-harness-work/SKILL.md,plugin/skills/ycm-harness-work/autonomy.md,plugin/skills/ycm-harness-work/commander-dispatch.md,plugin/skills/ycm-harness-work/finish-architecture.md,plugin/skills/ycm-harness-work/finish.md,plugin/skills/ycm-harness-work/github-tickets.md,plugin/skills/ycm-harness-work/orchestrator-checklist.md,src/cli/install-kit.ts,tests/autonomy.test.ts,tests/install.test.ts,tests/sync.test.ts,tests/work-lite-skill.test.ts
```

**Exit 0: 5 writes / 4 unchanged / 17 blocked**. Reasons exactly **12 Cursor not-in-allow-roots + 5 deny-listed work companions**. All five write diffs read: install-kit distribution constants/private commander pruning; install-test HOME isolation; lite architecture report location; public work SKILL Opus-class descriptor; private report-location test assertions. Four same paths: lite SKILL, work github-tickets, autonomy test, sync test. Counts/intentional variants reproduce, but the canonical plugin-router requirement remains missing outside this 26-path set. No blanket apply or sensitive export was performed.

**Independent verdict: REJECT (public).** The previous speculative-rule and direct WSL-audit issues were repaired and independently demonstrated. Remaining gates are active canonical commander pointers, valid-TOML/foreign-table handling, and mutation-sensitive HIGH/foreign-spacing coverage. Verification-only existing-log append; no source fix, deployment, real-home sync, promotion apply, push or PR action.

## Attempt 3 (Claude Opus, 2026-10-02)

Handoff: two earlier attempt-3 workers on GPT models stopped on transport, not on a code verdict. gpt-6-astra hit HTTP 429 quota partway through and left uncommitted edits in 7 private files (backup `/home/user/review-wt/private-harness-astra-partial-2026-10-02.patch`). A gpt-6.1-sol worker was stopped before it edited anything because GPT quota was exhausted. This worker read the Astra partial, kept its bounded header lexer, MID-first review-fix-loop text and tests after independent checks, then added tomllib-backed assertions, a stronger routing oracle and the public port. The reviewer's 2026-10-02 rejection was the spec. Earlier sections are unchanged.

Commits: private `e9ea4c8..5e5c39c` (2ada6c3 base); public `7daad5b..8e8685c` (3509bc3 base).

### Fixes
- **TOML validity and foreign data (P1):** `tomlTableHeader` + `tomlSections` in `src/cli/install-kit.ts` form a bounded lexer, not a value parser. It recognizes headers with optional indentation, adjacent or spaced `#` comments, dotted/bare/basic/literal keys (with escapes) and `[[arrays]]`. It tracks basic, literal and multiline strings plus inline-array/table depth, so header lookalikes in data are ignored. A `#` or `]` inside a quoted key is key text. Sync splices by byte offset: foreign bytes, CRLF and 4+ newline runs are preserved, and duplicate owned tables collapse into one. A malformed header or unclosed value throws, leaving config unchanged, instead of being guessed at.
- **Audit (P1):** doctor's `tomlSectionMatches` uses the same sections. A duplicated, malformed or string-embedded owned section is `stale`, never `ok`.
- **Policy (private):** `review-fix-loop.md:38` (plugin + `.cursor` mirror): ordinary review seats are MID-first, HIGH only for hard debugging/architecture/second opinions/escalation, never initial MAX. Independence and the three named seats are kept. Public ships no review-fix-loop companion.
- **Public routing:** commander SKILL, openai.yaml, entry templates (`claude-CLAUDE.md`, `codex-agents-block.md`, `cursor-user-rule.txt`, retired `cursor-commander-SKILL.md`, new `plugin-pointer.md`), 10-DISPATCH inventory table and report path, 00/30/40 protocol routing lines, and README now resolve protocol to the plugin's `commander-system/system/`. `~/.agents/system/LESSONS.md` stays only as the machine journal. `install-commander.mjs` is the private migrate script: it copies no protocol, writes pointers, and retires stale copies into backups. It was tested only in temp HOMEs. Public keeps its intended difference: the commander skill is still copied to user skill dirs (no plugin-native pruning). The SKILL.md in both repos therefore says to use the installed plugin's `commander-system/system/` when the skill is a copy.

### Failing-first (new tests on the base source)
Private, the 4 touched suites at 2ada6c3 source: 7 fail / 40 pass (review fix-loop MID-first, the reviewer repro test, 4 upsert fixtures, doctor-duplicate). Public at 3509bc3 source: 11 fail / 35 pass (the same TOML/doctor tests plus 5 commander-routing/installer tests).

### Mutations (scratch `git archive` copies; P = autonomy+work-lite, C = install+sync; restored byte-for-byte, then re-passed)
| mutation | private | public |
|---|---|---|
| MID→HIGH consistently in plugin rule + template + project rule | P exit 1, 1 fail | P exit 1, 1 fail |
| collapse foreign `\n{3,}` to `\n\n` | C exit 1, 5 fail | C exit 1, 5 fail |
| require whitespace before header `#` (adjacent-comment fix off) | C exit 1, 6 fail | C exit 1, 6 fail |
| column-zero-only `[` (indented-boundary fix off) | C exit 1, 6 fail | C exit 1, 6 fail |
| doctor back to raw substring include | C exit 1, 1 fail | C exit 1, 1 fail |
| SKILL/openai.yaml/cursor-user-rule/10-DISPATCH routed back to ~/.agents/system | — | plugin-extra-skills exit 1 (1/1/1/2 fail) |
| restored | P 21/21, C 23/23 | P 21/21, C 23/23, routing 6/6 |

### Fresh gates (`git archive HEAD`, temp HOME, `YCM_HARNESS_HOME` unset)
Private: `npm ci`=0, build=0, typecheck=0, `npm test`=0, **431 pass / 0 fail / 0 skipped**. Public: 0/0/0/0, **418 pass / 0 fail / 0 skipped**. Both runs passed the real-namespace WSL sync/audit test. `tests/doctor.test.ts` and `tests/v5.test.ts` stay out of suite and pre-existing; they are not claimed.

### Clean-install reproduction (each repo, fresh temp HOME, nonexistent Codex CLI)
`install --user`, then `sync --codex` + `doctor --json` ×3, seeded with (a) the adjacent `]# mine` owned header and (b) `] # mine` followed by an indented `  [other2]` table. Both seeds also have a 5-newline prefix run, 4-newline foreign runs and an indented `  [other]`. Every run exits 0, every output parses with `tomllib`, there is one owned header and no old source, prefix and foreign bytes are exact, sync 1 == 2 == 3, and doctor reports `codex_marketplace=ok`. Appending a duplicate owned section makes doctor report **stale**; the next sync repairs it to one header, valid TOML.

### Promotion dry-run
`node scripts/promote-to-public.mjs --paths <20 task paths: 2ada6c3..HEAD minus artifacts, plus commander entry/system/installer/openai.yaml/README>` on archived siblings → **exit 0; 7 writes / 10 unchanged / 3 blocked**. Each write is an intentional variant, not a missed export: `install-kit.ts` (repo constants + private commander pruning), `tests/install.test.ts` (private harness-HOME isolation), `tests/plugin-extra-skills.test.ts` (private extra skills, `commander.mdc`/`commands` and pruning test), commander `SKILL.md` (private iron-rule effort sentence), and 00-DIAGNOSIS/10-DISPATCH/40-MAINTENANCE (private-only evidence prose and effort/MAX ladder text; the routing lines themselves match). Blocked: `.cursor` review-fix-loop (not in allow roots), README (deny-list; public README hand-ported), work `review-fix-loop.md` (deny-list; public lean skill has none). Unchanged includes `sync.test.ts`, `autonomy.test.ts`, `install-commander.mjs`, `plugin-pointer.md`. No apply, push or PR.

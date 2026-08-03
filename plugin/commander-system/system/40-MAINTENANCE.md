# 40-MAINTENANCE — How to change this system without breaking it

Audience: any future session, any tier. The system degrades through careless
edits faster than through non-use. Follow this file exactly when touching
anything under `{{HOME}}\.agents\system\` or the entry files
(`~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md`, Cursor user rules,
`~/.cursor/skills/commander/`).

## §1 Change procedure (always, no exceptions)

1. BACKUP: copy the current file to
   `{{HOME}}\.agents\system\backups\<filename>.bak-YYYYMMDD`. Same-day backups
   must not be overwritten — guard it:
   `if (-not (Test-Path $bak)) { Copy-Item -LiteralPath $src -Destination $bak }`
   where `$bak` is the dated backup path and `$src` the file you're changing.
2. EDIT with the smallest diff that achieves the change. New content of any
   size goes in a NEW file + a one-line pointer, not appended to an existing
   rule file.
3. READ BACK the changed file completely. Check: no truncation, no duplicated
   sections, and every absolute path you touched still resolves on this host.
4. LOG one line in `LESSONS.md` under `## Changelog` (format in §4).

## §2 What you may change WITHOUT asking the user

- Append entries to `LESSONS.md` (this is encouraged — see §4).
- Update the matching `11-INVENTORY-*.md` model table when you have hard
  evidence (an actual Task-tool error listing valid slugs, Claude `/model`
  remap change, or Codex session model-picker output). Update the "verified"
  date. Evidence from memory does not count.
- Fix objectively broken things: paths that no longer exist, typos, a command
  whose syntax changed (verify the new syntax by running it first).
- Add a GOOD/BAD example to `20-JUDGMENT.md` drawn from a real event this
  session (keep each section to ≤2 examples per side; replace the weakest,
  don't accumulate).

## §3 What REQUIRES asking the user first

- Deleting or rewriting any rule, section, or file (as opposed to
  appending/fixing).
- Changing the precedence order or the Iron Rules in any entry file.
- Adding a NEW file to the system, a new skill, or a new Cursor user rule
  (each one taxes every future session — see §5).
- Changing numeric thresholds (retry caps, line limits, parallelism cap).
  These were set deliberately; drift here is how the system dies.
- Anything in `50-LETTER.md` — portable principles only; append a dated
  response if needed, never rewrite the core letter in place.
  Operator-specific standing items belong in private tracking / `LESSONS.md`.

## §4 LESSONS.md — where experience compounds

WHEN: in the same turn you discover a non-obvious, durable fact the hard way
(a retry loop, a wrong assumption, an environment quirk). Not at session end —
interrupted sessions lose unwritten lessons.
WHAT QUALIFIES: would a future session plausibly hit this? Is it stable
(environment/tool behavior), not incidental (one repo's flaky test)?
FORMAT (one entry, ≤6 lines):

```
### L<N> | YYYY-MM-DD | <harness> | <3-6 word title>
Trigger: <what you were doing>
Cost: <what it wasted — turns, tokens, a wrong deliverable>
Rule: <imperative sentence a weak model can obey without context>
```

Project-specific lessons go in that repo's own CLAUDE.md/AGENTS.md instead.
Keep entries portable: omit credentials, private identifiers, personal project
names, and absolute home paths.

## §5 Condensation — the system must not grow monotonically

Check at every edit (any tier may flag; condensing itself needs user OK per §3):

- `LESSONS.md` > 40 entries or > 250 lines — propose merging duplicates and
  promoting the 3–5 most-hit rules into `10-DISPATCH.md`/`20-JUDGMENT.md`, then
  archiving the merged entries to `backups/`.
- Any single system file > 350 lines — propose a split or a cut. Long files
  stop being read; an unread rule is a dead rule.
- A rule that has been wrong twice — propose deleting it. Wrong rules are
  worse than no rules.
- Before ADDING any instruction anywhere, name one instruction you're deleting
  or merging. No net growth without user sign-off.

## §6 Consistency invariants (check after any edit)

- Model tier **meanings** live in `10-DISPATCH.md` §2; concrete IDs live in
  `11-INVENTORY-cursor.md` / `11-INVENTORY-claude.md` / `11-INVENTORY-codex.md`
  (one file per harness — commanders load only the active harness). One
  sanctioned Cursor-only mirror exists: the ycm-harness plugin's
  `commander-dispatch.md` — when **Cursor** slugs change, update
  `11-INVENTORY-cursor.md` first, then the mirror. Claude/Codex concrete IDs
  have no second mirror. `~/.codex/AGENTS.md` is manually maintained; edit it
  per this file when the Codex contract changes. Templates and judgment rules
  say FAST/MID/HIGH only — they must not invent model IDs.
- Every cross-reference uses the `<file> §<n>` form and the target section
  exists.
- Numeric thresholds (3-attempt budget, 15-line reports, 4-parallel cap,
  200-line delegation trigger) are stated in `10-DISPATCH.md` and only
  referenced elsewhere.
- Entry surfaces stay ≤45 lines each and contain pointers + iron rules only —
  no procedures. "Entry surface" means: the whole of `~/.claude/CLAUDE.md`, the
  whole commander SKILL.md, the user rule, and the COMMANDER-SYSTEM block
  inside each AGENTS.md (the host file around the block doesn't count).

## §7 Monthly health check (or when things feel off)

Run through this list; fix per §1–§3:

1. Every file the entry files point to exists (`Test-Path` / `test -e` each).
2. Model tables' "verified" dates in `11-INVENTORY-*.md` < 60 days old, or
   re-verify per `10-DISPATCH.md` §8.
3. Duplicated skills/rules appeared again? Flag to user.
4. Read 3 random LESSONS entries — still true? Mark stale ones `[STALE?]` for
   the next condensation.

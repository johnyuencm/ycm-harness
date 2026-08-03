# WIKI.md — Schema Template

Copy to your wiki root as `WIKI.md` (standalone vaults) or adapt into `.ycm-harness/wiki/schema.md` (harness projects).

## Purpose

[One sentence: what this wiki is for — e.g. "Research wiki for transformer architecture papers."]

## Directory structure

```
raw/           # immutable sources
wiki/          # or pages/ in harness projects
  sources/     # one page per ingested source
  entities/    # people, orgs, products, characters
  concepts/    # ideas, mechanisms, themes
  synthesis/   # overviews, comparisons, thesis pages
  index.md
  log.md
```

## Naming

- Filenames: lowercase, hyphens, `.md`
- Wikilinks: `[[filename-without-extension]]`

## Page template

```markdown
---
tags: []
sources: []
updated: YYYY-MM-DD
---

# Title

One-paragraph summary.

## Details

...

## Related

- [[other-page]]
```

## Ingest rules

1. Never modify `raw/`.
2. Every ingest updates `index.md` and appends `log.md`.
3. Touch all entity/concept pages affected by new claims.
4. Note contradictions explicitly; don't silently overwrite without flagging.

## Query rules

1. Read `index.md` first.
2. Cite wiki pages and raw paths in answers.
3. File durable answers (comparisons, analyses) as new wiki pages.

## Lint rules

Run when user asks or after every ~10 ingests:

- Orphans, contradictions, stale claims, missing concept pages, broken wikilinks.

## Domain-specific notes

[Add conventions as the wiki evolves — citation format, required sections for papers, frontmatter fields.]

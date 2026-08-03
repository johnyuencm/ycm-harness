---
name: llm-wiki
description: >-
  Builds and maintains a persistent, compounding markdown wiki from raw sources.
  Use when ingesting documents, answering questions against a knowledge base,
  linting wiki health, or when the user mentions llm-wiki, personal wiki, knowledge
  base, Obsidian wiki, or Karpathy wiki pattern.
---

# LLM Wiki

Karpathy pattern: the agent incrementally builds a **persistent wiki** — not RAG that rediscovers knowledge on every query. Sources are read once, synthesized into interlinked pages, kept current, and compounded over time.

**Human:** curate sources, direct analysis, ask questions.
**Agent:** summarize, cross-reference, file, update, lint — touch many pages per ingest.

Skill root: `~/.cursor/skills/llm-wiki/` (Cursor/OpenCode install) or `plugin/skills/llm-wiki/` (this repo).

## Choose a backend

### A. ycm-harness project wiki (preferred in harness projects)

Layout under `.ycm-harness/wiki/`:

```
.ycm-harness/wiki/
├── raw/           # immutable sources
├── pages/         # compiled pages
├── schema.md      # structure + conventions
├── index.md       # content catalog
└── log.md         # append-only activity log
```

Use the active 0.3 harness CLI — see [harness-wiki.md](harness-wiki.md).

### B. Standalone Karpathy wiki (personal/research vaults)

```
wiki-root/
├── raw/
├── wiki/          # agent-owned pages (sources/, entities/, concepts/, synthesis/)
│   ├── index.md
│   └── log.md
└── WIKI.md        # schema (start from [schema-template.md](schema-template.md))
```

Use file edits directly. Good for Obsidian vaults, book companions, long-running research outside a harness goal.

## Before any operation

1. Read the schema (`schema.md` or `WIKI.md`); create from template if missing.
2. Read `index.md`.
3. Skim recent `log.md` entries.

## Ingest

1. Register or copy source into `raw/` (immutable — never edit raw after ingest).
2. Read source fully (text first; images separately if present).
3. Discuss key takeaways when the user wants involvement.
4. Create/update compiled pages:
   - Source summary
   - Entity/concept pages touched
   - Synthesis/overview if claims shift
   - Flag contradictions with older pages
5. Add `[[wikilinks]]` between related pages.
6. Update `index.md`; append parseable log entry:

```markdown
## [YYYY-MM-DD] ingest | Source Title

- Source: raw/path/to/file
- Pages created: ...
- Pages updated: ...
- Notes: contradictions, open questions
```

**Harness path:** use `wiki durable` for curated facts, contracts, decisions,
and root causes. Keep raw source management outside the 0.3 CLI.

Prefer one-at-a-time ingest with user review unless they ask to batch.

## Query

1. Read `index.md`; search the page files directly, or use `wiki list` and
   `wiki show` in harness projects.
2. Synthesize with citations to compiled pages and raw sources.
3. Match output form to the question: markdown, table, Marp slides, chart, canvas.
4. **File durable answers back into the wiki** — comparisons, analyses, and connections compound; chat history does not.

Append to `log.md`:

```markdown
## [YYYY-MM-DD] query | Short label

- Question: ...
- Answer page: pages/... or wiki/...
- Pages read: ...
```

## Lint

Run periodically or on request. Check:

- Contradictions between pages
- Stale claims superseded by newer sources
- Orphan pages (no inbound links)
- Important concepts mentioned but lacking dedicated pages
- Missing cross-references
- Gaps fillable via web search

The 0.3 harness CLI has no active lint command. Inspect the Markdown files
directly or use the standalone backend's lint workflow.

Fix what you can; report the rest with suggested sources/questions. Log lint passes.

## Page conventions

- One topic per page; slug-friendly filename.
- Lead with a one-paragraph summary.
- Use `[[page-name]]` wikilinks liberally.
- Optional YAML frontmatter for Obsidian/Dataview: `tags`, `sources`, `updated`.
- Source pages link back to `raw/` paths.

## Scale and tooling

- **Small (~100 sources):** `index.md` + grep/`wiki query` is enough.
- **Growing:** local search ([qmd](https://github.com/tobi/qmd) CLI or MCP).
- **Obsidian:** user browses graph; agent writes files. Web Clipper → `raw/`; download images locally for LLM access.
- **Git:** wiki is a markdown repo — version history for free.
- Keep private cross-project memory outside a public project repository.

## Reference

- Harness CLI details: [harness-wiki.md](harness-wiki.md)
- Karpathy pattern rationale: [reference.md](reference.md)
- Standalone schema starter: [schema-template.md](schema-template.md)

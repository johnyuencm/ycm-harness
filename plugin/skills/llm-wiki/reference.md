# LLM Wiki — Reference (Karpathy)

Source: https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f

## The core idea

Most people's experience with LLMs and documents looks like RAG: you upload a collection of files, the LLM retrieves relevant chunks at query time, and generates an answer. This works, but the LLM is rediscovering knowledge from scratch on every question. There's no accumulation. Ask a subtle question that requires synthesizing five documents, and the LLM has to find and piece together the relevant fragments every time. Nothing is built up. NotebookLM, ChatGPT file uploads, and most RAG systems work this way.

The idea here is different. Instead of just retrieving from raw documents at query time, the LLM **incrementally builds and maintains a persistent wiki** — a structured, interlinked collection of markdown files that sits between you and the raw sources. When you add a new source, the LLM doesn't just index it for later retrieval. It reads it, extracts the key information, and integrates it into the existing wiki — updating entity pages, revising topic summaries, noting where new data contradicts old claims, strengthening or challenging the evolving synthesis. The knowledge is compiled once and then _kept current_, not re-derived on every query.

This is the key difference: **the wiki is a persistent, compounding artifact.** The cross-references are already there. The contradictions have already been flagged. The synthesis already reflects everything you've read. The wiki keeps getting richer with every source you add and every question you ask.

You never (or rarely) write the wiki yourself — the LLM writes and maintains all of it. You're in charge of sourcing, exploration, and asking the right questions. The LLM does all the grunt work — the summarizing, cross-referencing, filing, and bookkeeping that makes a knowledge base actually useful over time. In practice, I have the LLM agent open on one side and Obsidian open on the other. The LLM makes edits based on our conversation, and I browse the results in real time — following links, checking the graph view, reading the updated pages. Obsidian is the IDE; the LLM is the programmer; the wiki is the codebase.

## Use cases

- **Personal**: goals, health, psychology, self-improvement — journal entries, articles, podcast notes.
- **Research**: papers, articles, reports — evolving thesis over weeks/months.
- **Reading a book**: chapter filing, characters, themes, plot threads (fan-wiki style).
- **Business/team**: Slack, meetings, docs, customer calls — LLM-maintained internal wiki.
- **Competitive analysis, due diligence, trip planning, course notes, hobby deep-dives.**

## Architecture (three layers)

1. **Raw sources** — curated, immutable. Agent reads, never modifies.
2. **The wiki** — agent-owned markdown. Summaries, entities, concepts, synthesis.
3. **The schema** — `WIKI.md` / `schema.md` / `AGENTS.md`: structure, conventions, workflows.

## Operations

- **Ingest** — read source, discuss, write summary, update index, touch entity/concept pages, append log.
- **Query** — search index/pages, synthesize with citations; file good answers back into wiki.
- **Lint** — contradictions, stale claims, orphans, missing pages/links, data gaps.

## Indexing and logging

- **index.md** — content catalog by category; agent reads first on query.
- **log.md** — append-only timeline; use parseable prefixes like `## [2026-04-02] ingest | Title`.

## Optional tooling

- **qmd** — local hybrid search + MCP for larger wikis.
- **Obsidian Web Clipper** — articles to markdown.
- **Marp** — slides from wiki content.
- **Dataview** — queries over YAML frontmatter.
- Git for version history.

## Why this works

Humans abandon wikis because maintenance grows faster than value. LLMs don't get bored, don't forget cross-references, and can touch 15 files in one pass. Related to Vannevar Bush's Memex — associative trails; the LLM solves the maintenance problem.

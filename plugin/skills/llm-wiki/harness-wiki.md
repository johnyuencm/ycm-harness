# ycm-harness 0.3 wiki

The active CLI supports three project-wiki operations:

```bash
ycm-harness wiki durable \
  --id <slug> \
  --title "<title>" \
  --trigger <contract|decision|environment|root-cause> \
  --body-file <path>
ycm-harness wiki list
ycm-harness wiki show <slug>
```

State and Markdown pages live under `.ycm-harness/wiki/`. Do not hand-edit
generated `index.md` or `log.md`.

Record only reusable project knowledge. Do not store credentials, private
identifiers, personal paths, raw session transcripts, or transient task
progress.

Do not run `wiki init`, `wiki query`, `wiki lint`, `wiki source *`,
`wiki page *`, `wiki promote`, `wiki checkpoint`, `user-wiki *`, or
`session tick` (retired stubs, exit 2). Use `wiki durable` or `$llm-wiki`
file edits.

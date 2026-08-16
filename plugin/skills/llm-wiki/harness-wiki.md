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

Do not run `wiki init`, `wiki source add`, `wiki page upsert`, `wiki query`,
`wiki lint`, `user-wiki *`, `wiki promote`, or `session tick` (deprecated
exit-2 aliases).

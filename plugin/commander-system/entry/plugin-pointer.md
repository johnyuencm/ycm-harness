<!-- COMMANDER-SYSTEM:START (plugin-sourced; protocol is not copied here) -->

## Commander (ycm-harness plugin)

Protocol lives in the enabled **ycm-harness** plugin and updates when that plugin updates. Do not use `~/.agents/system/` as protocol.

1. Read and follow the plugin skill **commander** (`/commander` or `$commander`).
2. Guides are `commander-system/system/` inside that plugin (next to `skills/`). Start with `10-DISPATCH.md` when delegating.
3. Machine journal only: append durable environment facts to `~/.agents/system/LESSONS.md`. Long artifacts go to `~/.agents/reports/` only when no git project is involved.
4. If ycm-harness SOP is active, follow that SOP; use commander files only for model-tier choice and verification discipline.
5. In a git project, commit and push every review, report and architecture output (code and architecture reviews, review rounds, verification records, HTML reports, wiki run records) into the repo, using its existing place (e.g. `artifacts/`), else `docs/reviews/`. Remote agents only see the remote; `/tmp` and `~/.agents/reports/` are invisible to them. Link committed paths, never `/tmp`.

<!-- COMMANDER-SYSTEM:END -->

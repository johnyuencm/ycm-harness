# Public mirror notes

This checkout is the **public product mirror** of `ycm-harness`.

Edit product code in the sibling **private** checkout first
(`johnyuencm/harness` / local `private-harness/`), then promote:

```bash
cd ../private-harness
npm run promote:public
npm run promote:public -- --apply
```

Contract: `../private-harness/docs/dual-repo-private-first.md`.

## Agent skills

### Issue tracker

Issues live in GitHub Issues on [`johnyuencm/ycm-harness`](https://github.com/johnyuencm/ycm-harness)
(optional GitHub Project for kanban). See `docs/agents/issue-tracker.md`.

### Triage labels

Use the default five-role vocabulary. See `docs/agents/triage-labels.md`.

### Domain docs

Use a single-context layout. See `docs/agents/domain.md`.

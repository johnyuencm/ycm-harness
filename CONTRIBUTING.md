# Contributing

Thanks for helping improve ycm-harness.

## Issues and workflow

- Track work with **GitHub Issues** on [`johnyuencm/ycm-harness`](https://github.com/johnyuencm/ycm-harness).
- Prefer a Project board kanban for status when one is linked to the repo.
- Agents and maintainers use the lean CLI (`ycm-harness ticket` / `goal`) with the **GitHub** ticket backend (`gh` must be authenticated). Local tickets remain available for offline work.

## Development

```bash
git clone https://github.com/johnyuencm/ycm-harness.git
cd ycm-harness
npm ci
npm run build
npm test
```

Node.js **>= 20** is required.

## Pull requests

1. Open an issue (or claim an existing one) describing the change.
2. Keep PRs focused; include tests for behavior changes.
3. Run `npm run typecheck` and `npm test` before requesting review.

## Docs

- Lean 0.3 contract: [`docs/lean-0.3.md`](docs/lean-0.3.md)

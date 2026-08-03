# Security Policy

## Supported versions

Security fixes are accepted against the latest `master` of [`johnyuencm/ycm-harness`](https://github.com/johnyuencm/ycm-harness).

## Reporting a vulnerability

Do **not** open a public issue for sensitive reports.

Use GitHub's **Private vulnerability reporting** on this repository. Please do not disclose suspected vulnerabilities in a public issue.

Please include:
- a short description of the issue
- steps to reproduce or a proof of concept
- impact assessment if known

## Scope notes

- This project shells out to `gh` for the GitHub ticket backend. Treat local `gh` auth as sensitive.
- Do not commit `.env` files, tokens, or private keys. See `.gitignore`.

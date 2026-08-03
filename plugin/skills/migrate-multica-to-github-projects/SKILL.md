---
name: migrate-multica-to-github-projects
description: Safely inventory and migrate Multica tickets into GitHub Issues and a GitHub Project. Use when moving a local Multica board to cloud-hosted GitHub planning, creating the destination project, importing tickets across repositories, or producing a confirmed migration plan. Preserve Multica until GitHub readback succeeds.
---

# Migrate Multica to GitHub Projects

Use **Multica first** as the source of truth. This workflow creates a verified GitHub copy; it never deletes, closes, or changes Multica tickets unless the user explicitly asks after a successful migration.

## 1. Establish scope

- Identify the Multica workspace and live-read its id, name, and slug before any mutation. Preflight with `multica --help`, `multica auth status`, and `multica config show` (Multica is archival; use it only as the migration **source**).
- Identify the GitHub owner (user or organization), destination Project title, and every target repository. A GitHub Project aggregates work; each migrated ticket needs an Issue in its owning repository. Keep genuinely repo-less work as a Project draft issue.
- State whether the run is `dry-run`, `create destination only`, or `migrate`. Default to `dry-run`.

## 2. Preflight and inventory

1. Run `multica --help`, `multica auth status`, `multica config show`, and `multica workspace get <id> --output json`.
2. Run `gh auth status`, verify access to each target repo, and inspect `gh project --help` before relying on a command form.
3. Export or record every source ticket: id, title, description, status, parent, labels, owner, dates, comments, repository mapping, and links.
4. Write a migration table in the working repository (for example, `artifacts/multica-github-migration.md`). Show unresolved repository mappings separately; do not guess them.

## 3. Design the GitHub destination

Create or use one user- or organization-level GitHub Project. Configure only these fields unless the user needs more:

- `Status`: Todo, In Progress, In Review, Done, Blocked
- `Priority`: Low, Medium, High (only if Multica has usable priority data)
- `Target date` and `Iteration` (only when source data needs them)

Create Board, Backlog/table, and optionally Roadmap views. Map source statuses to the Status values above. Keep parent/child relationships as GitHub sub-issues where supported; otherwise link the parent and child issues visibly in their bodies.

## 4. Require a migration approval

Before creating any GitHub Issue, Project item, comment, label, or field, show the migration table and request one explicit approval for the exact counts and target Project. The approval must distinguish destination creation from bulk ticket import.

Never bulk-migrate when source ticket ownership, target repository, or duplicate matching is unresolved.

## 5. Create and migrate

1. Create the GitHub Project if it does not exist; read it back and record its URL and id.
2. Create or match GitHub Issues in the mapped repositories. Put the original Multica id and source URL in each Issue body for traceability.
3. Add each Issue to the Project and set mapped fields/statuses.
4. Recreate descriptions, labels, assignees, dates, and dependencies only when their GitHub equivalents are available and authorized.
5. Preserve source comments in chronological order when requested; otherwise add one concise migration note linking back to the Multica ticket.
6. After each batch, read back the Issue and Project item. Record `Multica id -> GitHub issue URL -> Project item id` in the migration table.

Use small batches. Stop at the first unexpected duplicate, permission failure, or mapping mismatch; repair the plan before continuing.

## 6. Verify and close over

- Compare source and destination counts, statuses, parent/child links, and unresolved items.
- Report migrated, skipped, duplicated, and failed rows with links.
- Keep Multica as the migration **source** until the user explicitly accepts GitHub readback. After cutover acceptance, day-to-day work stays on GitHub only (do not resume Multica as the live tracker).
- Only with a separate explicit request, archive or close Multica tickets. Never delete them as part of this skill.

## Cursor-harness configuration

Day-to-day tracker is **GitHub Issues + Project harness** (see `github-tickets.md` / `gh`). This skill is **archival migration only** — use it to inventory/copy legacy Multica tickets into GitHub, not as the active tracker SOP. Do not switch live work back to Multica.

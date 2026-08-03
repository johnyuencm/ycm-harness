# YCM Harness Multi-Client Plugin Install/Update Design

Date: 2026-06-04
Status: Proposed

## Goal
Make `ycm-harness` releasable as a reusable plugin/installer for both Cursor and Codex CLI plugin surfaces, with one-click install/update that pulls the latest stable npm release by default and optionally syncs from a git source for dev/latest workflows.

## User outcomes
- One command updates all detected supported clients.
- Cursor and Codex CLI plugin assets come from one canonical packaged source.
- Stable users get npm releases; advanced users can opt into git/dev sync.
- `doctor` can audit both client installs and report drift.

## Non-goals
- Remote marketplace publishing automation.
- Auto-merge, auto-push, or remote deploy.
- Supporting every possible editor/agent client in this iteration.
- Replacing the existing low-level `install` command; it remains as a manual surface.

## Approaches considered

### Approach A: CLI-canonical multi-client sync (recommended)
Package shared assets plus client-specific plugin manifests, and add a primary `ycm-harness sync` command that detects Cursor and Codex CLI plugin targets and installs/updates both by default.

Pros:
- Minimal change from current architecture.
- Single source of truth.
- Easy to test locally.
- Best fit for npm stable + git/dev override.

Cons:
- CLI remains the orchestration point for install/update.

### Approach B: Separate client package bundles
Ship separate package outputs or install flows per client and keep only a thin shared core.

Pros:
- Stronger client isolation.

Cons:
- More packaging complexity and release overhead.
- More metadata duplication.

### Approach C: Bootstrap script fetches latest assets directly
Use a lightweight fetcher to pull latest assets from npm/git and install them.

Pros:
- Very direct "latest" story.

Cons:
- Higher update complexity.
- More network/error cases.
- Harder to test deterministically.

## Recommendation
Use Approach A.

## High-level design

### 1. Asset layout
Keep shared assets under `plugin/` and add Codex plugin metadata beside Cursor plugin metadata.

Target layout:
- `plugin/.cursor-plugin/plugin.json`
- `plugin/.codex-plugin/plugin.json`
- `plugin/skills/ycm-harness/...`
- `plugin/agents/...`
- `plugin/hooks/...`
- `plugin/scripts/...`

Shared skills, agents, hooks, and scripts remain canonical package content. Client plugin manifests are thin wrappers pointing to those installed assets.

### 2. Primary command surface
Add a new primary command:
- `ycm-harness sync`

Supported options:
- `ycm-harness sync` — detect supported clients and update all detected installs.
- `ycm-harness sync --all` — install/update all supported clients, creating directories as needed.
- `ycm-harness sync --cursor`
- `ycm-harness sync --codex`
- `ycm-harness sync --from-git <repo-or-path>`
- `ycm-harness sync --ref <tag|branch|sha>`
- `ycm-harness sync --channel stable|git`
- `ycm-harness sync --json`

Default behavior:
- If Cursor and Codex are both detected, sync both.
- If only one is detected, sync that one.
- If none are detected, return an actionable error with suggested flags.
- Stable npm package assets are the default source.
- Git source is opt-in.

### 3. Detection model
Client detection should be explicit and testable.

Detect:
- Cursor via user-level `.cursor` home and/or project plugin paths.
- Codex CLI plugin via `.codex-plugin` destination support under the user home or target project path.

Detection result should include:
- client name
- detected/not detected
- candidate install paths
- whether plugin manifest already exists

### 4. Install/sync model
Refactor current install logic into reusable primitives:
- detect clients
- compute source asset roots
- compute destination roots
- copy shared assets
- copy client manifest
- emit structured per-client report

The new `sync` command should call these primitives.
The old `install` command should remain, but internally reuse the same asset copy path.

### 5. Source/channel model
#### Stable default
Use the packaged npm contents already installed locally.

#### Git/dev mode
When `--from-git` is provided:
- materialize assets from the requested git repo/ref into a temp location
- validate required plugin asset structure
- sync from that temp location instead of package root

This preserves the packaged stable path while enabling opt-in dev refresh.

### 6. Doctor expansion
Extend `doctor` to audit both clients independently:
- Cursor plugin manifest + shared assets
- Codex plugin manifest + shared assets
- user-level skills/agents/rules where relevant
- drift status per client

`doctor --json` should surface:
- per-client audit blocks
- overall `needs_sync`
- recommended command (`sync`, `sync --codex`, etc.)

### 7. Reuse and release model
For reusability:
- shared behavior lives in package source, not user-level copies
- plugin manifests are generated/maintained in-repo
- npm release contains everything required for stable install
- docs explain stable vs git/dev update paths

## Command behavior details

### `sync`
- safe default: update detected clients
- `--all`: update all supported clients regardless of current detection
- `--json`: machine-readable report
- return counts for created/skipped/overwritten files per client

### `install`
- remains available for explicit/manual use
- may gain Codex-aware flags if helpful, but should avoid duplicating `sync` semantics more than needed

### `doctor`
- should recommend the minimal corrective command
- should not force project-local overwrite unless explicitly requested

## Testing plan
Add tests for:
1. client detection: cursor only / codex only / both / none
2. `sync` default behavior with both detected
3. `sync --cursor`
4. `sync --codex`
5. `sync --all`
6. `sync --json` payload shape
7. git/dev source option parsing and validation
8. `doctor --json` reporting both clients
9. backward compatibility for existing install behavior

## Error handling
- Missing client destination: actionable message, suggest `--all` or explicit target
- Invalid git source/ref: fail with source validation details
- Missing required plugin asset tree: fail before partial install
- Partial client failure: report per-client results and non-zero exit if any requested client failed

## Open constraints
- Codex CLI plugin path/manifest expectations must be inferred from existing local plugin conventions in this workspace during implementation.
- Cursor and Codex may not have identical plugin semantics; the shared asset layout must avoid assuming exact parity.

## Recommended implementation sequence
1. Add Codex plugin bundle metadata.
2. Refactor install-kit into client-aware sync primitives.
3. Add `sync` command.
4. Extend `doctor` audits/recommendations.
5. Add tests for Cursor + Codex install/update flows.
6. Update README/docs with stable vs git/dev usage.

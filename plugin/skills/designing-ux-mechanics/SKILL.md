---
name: designing-ux-mechanics
description: >-
  Design and audit how an app behaves, before how it looks: navigation and the
  back button, layers and sheets, loading and sending states, live data,
  transitions, undo, and failure. Use when building or reviewing any app UI or
  prototype, when a UI "feels unfinished", "vibe-coded" or "janky", when back
  needs many presses, screens stack up, or alerts and actions load or send
  without clear feedback.
---

# Designing UX mechanics

Good UX is mostly mechanics, not visuals. A plain screen with correct mechanics feels finished. A beautiful screen with wrong mechanics feels like a demo. Fix mechanics first; style second.

## First principles

Every rule below comes from five facts about people:

1. **People hold a map of where they are.** Each action must keep that map true: where am I, how did I get here, how do I get back.
2. **People trust only what they see change.** Each action needs a visible response within 100 ms, even when the real result takes longer.
3. **People act before they finish reading.** The UI must stay correct when they tap twice, tap early, or leave mid-action.
4. **Attention is the scarce resource.** Every extra layer, spinner, confirm dialog and reflow costs attention. Remove before adding.
5. **The network lies.** It is slow, it fails, it answers twice and out of order. Design for that as the normal case.

If a rule below conflicts with the product's own design system or the user's words, those win. Otherwise apply the rules.

## Workflow

1. **Map the screens as a state machine before any styling.** Write it as a box-and-arrow diagram: each screen, each overlay, each async state, and every edge (tap, back, swipe, push, deep link, error). Name what the back action does on every node.
2. **Apply the rule sets below** to that map: navigation, layers, data states, actions, live data, motion, failure.
3. **Build the mechanics with plain styling.** Use one router or state store; never jump screens from scattered click handlers.
4. **Run the stress walk** on the real build, with throttled network: `stress-walk.mjs` automates the checks it can (see below); walk the rest of [checklist.md](checklist.md) by hand.
5. **Only then refine visuals.** Then run the stress walk again: visual work often breaks mechanics (layout shift, focus, z-index).

Report results as the checklist table: each item PASS, FAIL with the exact screen and step, or NOT TESTED with the reason.

## Automated stress walk

`stress-walk.mjs` drives the live app in Chrome at phone size and fails the run on broken mechanics:

| Check | What it does |
|---|---|
| N2 | From each configured screen, presses system back and the on-screen back; FAIL if home needs more than 2 presses |
| N3 | After a send, presses back twice; FAIL if the form comes back |
| L1, L2 | After every step, counts open layers (FAIL above 1); FAIL if a layer covers the back control |
| D1 | Delays the list API; FAIL if the empty state shows before the first answer |
| M1 | Measures layout shift when data lands; FAIL above CLS 0.1 |
| A1, A2 | Double-taps each send button; FAIL above 100 ms to the first visible change, or more than 1 request |

```bash
npm i -D playwright@1.64.1                      # once, in the app repo
node <skill-dir>/stress-walk.mjs ux-walk.json --out artifacts/ux-walk
node <skill-dir>/stress-walk.mjs --self-test    # proves the checks catch fixtures/bad.html and pass fixtures/good.html
```

The config names the app's own selectors: `home.ready`, each screen's `steps` and `ready`, `backSelector`, each list's `api` and `empty`, and each send's `steps`, `button`, `api` and `form`. The header of `stress-walk.mjs` has a full example. Exit code 1 means at least one FAIL; attach `artifacts/ux-walk/stress-walk.md` and its screenshots to the review.

## 1. Navigation and the back button

- **One history, one owner.** All navigation goes through one router that owns a stack. Back pops exactly one entry and lands where the person came from, with scroll position and focus restored.
- **Push only for a new place.** Push when the person goes deeper (list → detail). Replace for a change of mode inside the same place (tab switch, filter, step inside a flow, success screen after submit). A success or "sent" screen must never sit in history; back from it must not reopen the form.
- **Depth budget: two.** From any screen, at most two back presses reach home. If a flow is deeper, collapse it: steps of one task live in one screen, not stacked pages.
- **Flows exit as a unit.** Closing or finishing a flow (report, check-in, onboarding) removes the whole flow from history and returns to its origin.
- **Back and close mean the same everywhere.** System back, the on-screen back arrow, Escape, a swipe and a backdrop tap all call the same function.
- **Deep links build a sane stack.** Opening a detail from a notification places home under it, so back goes home, not out of the app.
- **Tabs keep their own state.** Returning to a tab shows it as the person left it. Tapping the active tab returns that tab to its root and scrolls to top.
- **URL matches state** on the web. Reload restores the same screen; a shared link opens the same thing.

## 2. Layers

- **At most one layer over a screen.** A sheet, dialog or menu may sit over a page. Never a sheet over a sheet, or a dialog over a sheet. If a layer needs another layer, the first one becomes a page.
- **Choose the layer by the task.** A page is for a place the person stays in. A bottom sheet is for a short task that keeps the context visible. A dialog is only for a decision that blocks. A toast is only for a result that needs no decision.
- **Prefer undo over confirm.** Do the action, show a toast with Undo for 5 to 8 seconds. Use a confirm dialog only when the action cannot be undone and has a high cost.
- **A layer owns focus and back.** Opening moves focus into it; closing returns focus to the control that opened it. Back closes the layer before it leaves the page.
- **Toasts never cover the next action** and never stack. A new toast replaces the old one.

## 3. Data states (load, empty, error)

Every view that shows data has exactly these states. Draw all of them:

```
first visit:  skeleton ──► content | empty | error
return visit: cached content (with age) ──► fresh content (quiet swap) | stale banner
```

- **Never show "nothing" while loading.** An empty state shown before the first answer is a false statement. Show a skeleton or the last known data with its age.
- **Cache first, then revalidate.** Show the last known data at once, fetch in the background, then swap in place without moving what the person is touching.
- **No spinner flash.** Show a loading indicator only after 300 ms; once shown, keep it at least 500 ms.
- **Skeletons match the real layout** so content appears without a jump. Reserve space for images and lists (fixed aspect ratio, min height).
- **Empty is an invitation.** Say what will appear here and the one action that makes it appear.
- **Errors say what failed and what to do,** in place, next to the thing that failed, with a retry. Never a blank screen, never a raw error string.

## 4. Actions (send, confirm, report)

Every action has these states, and each is visible:

```
idle ──press──► pending (button busy, < 100 ms) ──► done (result shown) ──► idle
                     └──► failed (reason + retry, input kept)
```

- **Acknowledge in under 100 ms:** press state, then a busy state on the same control. Do not move the person elsewhere while it is pending.
- **Optimistic when safe, with rollback.** Show the expected result at once for cheap, reversible actions (a vote, a like). If the server refuses, roll back visibly and say why.
- **Pessimistic when it matters.** Wait for the server for anything costly or public (payment, a report that alerts other people). Show "Sending", then the real result.
- **Idempotent and single-flight.** A double tap sends once. Disable re-entry while pending; send an idempotency key.
- **Never lose input.** A failed send keeps what the person entered.
- **Match the gesture to the cost.** A tap for cheap and reversible. Press-and-hold or a two-step for actions that reach other people; give a visible progress ring and a cancel by release.
- **The result names the action.** The button says "Report fire"; the result says "Fire reported", then what happens next.

## 5. Live and incoming data

- **Never reorder under a finger.** New items enter at the top with a short highlight. If the person has scrolled, show "2 new alerts" and insert on tap.
- **Update in place.** A count or status changes where it is, with a short emphasis; the row does not jump or re-render.
- **Show freshness.** "Updated just now" or "Last updated 4 min ago", and a clear offline state.
- **Incoming alerts follow urgency.** Critical: system notification plus in-app banner that leads to the detail in one tap. Normal: in-app list update. Never a modal over what the person is doing.
- **Arriving from a notification opens the item, not the home screen,** with home under it in history.

## 6. Motion

- **Motion explains a change of place or state; it never decorates.** Forward = new view slides in from the trailing edge; back = it slides out the same way. A sheet rises from where it was triggered. Same-level changes cross-fade.
- **Keep continuity.** The element that was tapped becomes the header of the next view (shared element), or at least the next view enters from its direction.
- **Fast and interruptible:** 150 to 250 ms for most changes, up to 350 ms for large surfaces. A new input cancels a running animation; never queue animations.
- **Animate only transform and opacity.** Never animate layout properties that cause reflow.
- **Respect reduced motion:** replace slides with short cross-fades.
- **No layout shift.** Text, images and late data must not push content under the person's finger.

## 7. Failure, offline, and limits

- **Offline is a state, not an error.** Show cached data with its age, queue safe actions with a visible "will send when online" marker, and refuse unsafe ones with a reason.
- **Rate limits and permissions explain themselves:** what is blocked, why, and when or how it unblocks (settings path for a denied permission).
- **Timeouts end.** Every pending state has a limit, then becomes failed with retry.
- **One message per problem,** in one place. Do not stack a toast, a banner and an inline error for the same cause.

## Anti-patterns to search for

| Smell | Fix |
|---|---|
| `navigate()` or screen swaps called from many click handlers | One router; actions call `push`, `replace`, `back` |
| Success screen in history | `replace` after submit |
| Back needs 3+ presses to reach home | Collapse flow steps into one screen |
| Sheet opened from a sheet | Promote the first sheet to a page |
| "No results" visible during load | Skeleton or cached data with age |
| Button stays tappable while sending | Busy state, single-flight |
| List jumps when new data arrives | Insert above the fold or "N new" pill |
| `confirm()` for reversible actions | Undo toast |
| Spinner that flashes for 50 ms | 300 ms delay, 500 ms minimum |
| Animations on load of every card | One meaningful transition, or none |

## Related

- Use the `frontend-design` skill for the visual identity after the mechanics pass.
- Use the `explainer` skill if the person wants the state machine shown as a picture.
- Run the stress walk in [checklist.md](checklist.md) before any "done" claim.

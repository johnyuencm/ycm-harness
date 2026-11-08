# UX mechanics stress walk

Run on the real build, at phone width, with the network throttled to "Slow 4G" and once offline. Report each line as PASS, FAIL (screen + step), or NOT TESTED (reason).

## Navigation

| # | Check | How |
|---|---|---|
| N1 | Back from every screen lands on the screen you came from | Visit each screen from each entry point; press system back and the on-screen back |
| N2 | Home is at most 2 back presses away from anywhere | Count presses from the deepest screen |
| N3 | Finishing a flow does not leave the flow in history | Submit, then press back: the form must not reopen |
| N4 | A deep link or notification opens the item with home under it | Open from a link; press back once |
| N5 | Scroll position and focus return after back | Scroll a list, open an item, go back |
| N6 | Reload or share link restores the same screen (web) | Reload on each screen |

## Layers

| # | Check | How |
|---|---|---|
| L1 | Never more than one layer over a screen | Open every sheet, menu and dialog; try to open another from inside |
| L2 | Back, Escape, close button and backdrop all close the layer the same way | Try each |
| L3 | Focus moves into a layer and returns to its trigger | Keyboard: open, close, check focus ring |
| L4 | No confirm dialog for an undoable action | List every dialog; each must guard an irreversible, costly action |

## Data states

| # | Check | How |
|---|---|---|
| D1 | No empty state is shown before the first answer | Throttle; load each list |
| D2 | Return visits show cached data at once, with its age | Leave and come back |
| D3 | No spinner flashes; no layout jump when data lands | Watch on fast and slow network |
| D4 | Every error is in place, says what to do, and offers retry | Block the API; visit each view |
| D5 | Offline shows cached data and a clear offline state | Go offline |

## Actions

| # | Check | How |
|---|---|---|
| A1 | Every press responds within 100 ms | Tap each control on throttled network |
| A2 | A double tap sends once | Tap fast twice on each send action |
| A3 | A failed send keeps input and offers retry | Block the API, send |
| A4 | Optimistic results roll back visibly on refusal | Force a server refusal |
| A5 | Leaving mid-send does not corrupt state | Send, press back at once, return |
| A6 | Costly actions use a deliberate gesture with a visible cancel | Check report, pay, delete |

## Live data and motion

| # | Check | How |
|---|---|---|
| M1 | New items never move what is under the finger | Scroll a list while new data arrives |
| M2 | Counts update in place, without re-rendering rows | Watch a counter change |
| M3 | Forward and back transitions mirror each other | Navigate in and out |
| M4 | Animations are interruptible and never queue | Tap quickly during a transition |
| M5 | Reduced motion replaces slides with fades | Turn on reduced motion |

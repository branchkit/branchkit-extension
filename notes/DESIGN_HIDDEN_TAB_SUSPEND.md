# Hidden-tab suspend (Lever 3)

Status: proposed / Phase 1 in progress (2026-06-18)

## Problem

A tab that was active and then gets backgrounded keeps its page-wide
MutationObserver connected. The observer fires on every DOM mutation the
page's own JS makes — and modern app shells (Gmail, Slack, QuickBase)
mutate continuously whether or not anyone is looking. With many tabs open,
the N-1 background tabs each keep paying that mutation-processing cost
forever. Measured: a fixture tab moved to the background kept climbing its
`processMutationsCalls` counter (15 -> 25 over 10s) while invisible.

This is the steady-state companion to lazy discovery (Lever 2). Lazy
discovery stops a tab that *loads* hidden from doing initial work; suspend
stops a tab that *becomes* hidden after being active from doing ongoing work.

## Key observation that bounds the scope

In a hidden tab the page MutationObserver is the *only* continuous cost.
The IntersectionObservers (claim/release, attention) and the ResizeObserver
fire on intersection and size changes — and a hidden tab does not scroll or
relayout, so those observers are dormant (no callbacks) while hidden. So the
entire win is "disconnect the page MutationObserver while hidden." We do NOT
need to tear down the per-element IO/resize subscriptions, which is where
re-observe bugs would live.

Phase 2 (full IO/resize teardown on hide) is therefore deferred and likely
unnecessary. Build it only if measurement shows residual hidden-tab cost.

## Design (Phase 1)

Reversible suspend/resume of the page MutationObserver, driven by
`visibilitychange`, reusing the existing reconcile/reactivate catch-up.

State machine (one persistent `visibilitychange` listener), derived from two
module flags `hintMachineryEnabled` and `suspended`:

- deferred  — loaded hidden, never shown (`enabled=false`). First show ->
  `activateHintMachinery('load')` + `kickInitialScan()` (lazy discovery path).
- active    — `enabled=true, suspended=false`.
- suspended — was active, now hidden (`enabled=true, suspended=true`).

Transitions:

- visible & not enabled  -> activate (lazy-discovery first show)
- visible & suspended    -> resume
- hidden  & active       -> suspend

`suspend()`:
- `teardownMutationSource()` — disconnects the one page MO (a single
  `observe` call) and cancels its reevaluation rAF. Trivially reversible.
- cancel the discovery rAF and clear `pendingDiscoveryRoots`.
- set `suspended = true`.
- PRESERVE everything else: wrappers, codewords, pool claims, badge hosts,
  idRegistry. This is the opposite of `quiesceOrphan`, which destroys them.
  Keeping codewords is what protects label stability across the hide/show
  cycle (mirrors Rango's `suspend()`).

`resume()`:
- `attachPageMutationObserver()` — re-arms the one observer.
- set `suspended = false`.
- `doScan()` + `reconcile()` to catch up on DOM changes that happened while
  suspended (drop detached wrappers, discover new content, refresh viewport
  claims) — the same work the `from_cache` reactivate path already does.

`doScan()` is additionally gated on `!suspended` so a `rescan`/`reactivate`
message arriving for a hidden tab no-ops; the catch-up scan runs from
`resume()` instead. `hintMachineryEnabled` + `suspended` are the single gate
for all scan work.

## Why this is safe-ish in a high-blast-radius area

- Touches only the page MO, not the per-element IO subscriptions (no
  re-observe path to get wrong).
- Resume reuses the already-soaked `from_cache` reactivate catch-up
  (`doScan` + `reconcile`), which `doScan`'s scanChain serializes against the
  background's `reactivate` so there is no duplicate-codeword race.
- `suspend` is kept strictly separate from the permanent `quiesceOrphan`
  teardown; it never releases the CS guard or codewords.

## Interaction with the background reactivate

On tab activation the background already sends `reactivate`
(`republishForActivation`: rotateSession + re-Put codewords + reconciliation
scan). That rebuilds grammar but does NOT re-attach the MO. Resume supplies
the MO re-attach; the two compose, and the redundant scan coalesces.

## Verification

Open the perf-stress fixture in a foreground tab (moCalls climbing), switch
away, confirm moCalls STOPS climbing while hidden, switch back, confirm it
reconciles and voice still matches. Then a 30+ min real-Chrome soak watching
for any refocused tab that fails to repaint or rematch.

## Out of scope (Phase 2, deferred)

Full IO/ResizeObserver teardown on hide and per-wrapper re-observe on resume.
Pausing the limbo sweeper / reposition timers (negligible while hidden).

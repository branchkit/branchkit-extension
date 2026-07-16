# Pointer-recheck subtree scoping — design

2026-07-16. Next lever from the long-session perf audit after the occlusion
memo: `recheckPendingVisibility` measured 3.6s / 4,364 calls over a 25-min
active window. Design-first on purpose: this touches the temperamental
hover-reveal promote path (the "hover the report, no hint" fix), which has
burned rounds before — the safety structure matters more than the saving.

## Problem

The parked-candidate PROMOTE half (`observe/visibility-tracker.ts
recheckPendingVisibility`) re-scans the ENTIRE `pendingVisibility` set on
every trigger. The triggers and their cadences:

- vis-MO records touching tracked elements, and vis-RO box-gain signals →
  rAF-coalesced full recheck (must keep up with mutation storms);
- pointer boundary crossings (`schedulePointerVisibilitySweep` →
  `schedulePromoteThrottled`) → full recheck at 100ms throttle.

While the mouse moves over a dense page the pointer path runs the full-set
scan ~10×/sec: |pendingVisibility| candidates × (isConnected + store lookup
+ scanSingle's rect/style reads, against a cacheVisibility warm-up of the
WHOLE set). The set is attention-region-bounded (~2 viewport-heights) but
reaches hundreds on dense app pages. Cost scales as set-size × pointer
cadence, and virtually all of those scans find nothing: a pointer crossing
can only have revealed candidates near the pointer.

## Why the pointer path can be scoped (and what bounds "near")

A pure-CSS `:hover` reveal fires when an element on the pointer target's
ANCESTOR CHAIN matches `:hover` and a rule like `X:hover .candidate` flips
the candidate visible. So the candidate is a DESCENDANT of some hovered
ancestor X. Which ancestor carries the rule is unknowable without parsing
CSS — and `<html>` is always on the chain, so pure ancestor-intersection is
vacuous. The practical bound: in real UIs the revealed control lives close
to its trigger — QuickBase row action bars (inside the hovered row), nav
dropdown panels (inside the hovered nav item's parent), toolbar tooltips.

**Scope rule**: on a pointer-driven recheck, scan only candidates contained
in the pointer target's N-th ancestor's subtree (start N=5; containment via
the composed-tree climb — `composedContains`, already in
`observe/occlusion.ts` — so shadow-hosted candidates aren't orphaned).
`contains` is a pure tree walk, no layout reads; the cacheVisibility
warm-up then covers only the scoped subset.

## The safety structure — scoped fast path + full backstop

The scope is a heuristic (modern CSS `:has()` can reveal a body-level
portal from a remote hover; N=5 can undershoot deep component trees), and
this path is temperamental. So the design is NOT "scope and hope":

1. **Scoped recheck at the existing 100ms pointer throttle** — the common
   case (row hover → action bar) promotes exactly as fast as today.
2. **Trailing FULL recheck once the pointer settles** — a pointer-idle
   debounce (~300ms after the last pointer event) runs today's full-set
   scan ONCE per hover-pause instead of 10×/sec during movement. Any
   reveal the scope missed promotes at most ~300ms later than today —
   bounded degradation, never a permanent miss.
3. **MO/RO paths untouched** — they keep the rAF full recheck (they carry
   actual change evidence; storms must promote at frame cadence). The
   two-cadence structure, the vis-MO relevance gates, and
   `disconnectVisibilityMO` lifecycle are not modified.

Worst case for an exotic remote reveal: promote latency goes 100ms →
~400ms, only while the pointer is still moving. The load-bearing QuickBase
case stays on the fast path (action bar is inside the hovered row's
subtree, well within N=5).

## Implementation sketch

- `schedulePointerVisibilitySweep(target?: Element)` — the pointer
  listeners pass `e.target`; the throttle keeps the LATEST target (a
  100ms window's crossings are spatially adjacent; the trailing full
  sweep covers any drift).
- `recheckPendingVisibility(scope?: Element)` — when `scope` is present,
  iterate `pendingVisibility` filtered by
  `composedContains(nthAncestor(scope, 5), candidate)`; `cacheVisibility`
  over the filtered subset only. No behavioral change inside the
  per-candidate logic.
- Pointer-idle debounce timer (reset on every pointer event; fire = full
  recheck) — a `pageSession.resources` timer so teardown owns it.
- Counters (visible compression, never silent): split the existing
  `recheckPendingVisibility:size` bucket into scoped/full variants +
  `visibilityPromoteScopedSkips` (candidates excluded by scope per call)
  in lifecycleCounters, so the trail shows exactly how much work the
  scope removes and the backstop's cadence.

## Verification plan

1. Unit: scoped filtering (in-subtree candidate promotes, out-of-subtree
   deferred to the full pass), trailing-debounce firing, shadow-hosted
   candidate containment.
2. Harness: a fixture with a pure-CSS hover-reveal candidate OUTSIDE the
   scope ancestor (portal-style) proving the trailing full sweep promotes
   it; the existing placement/perf suites.
3. Live: the QuickBase "hover the report → hint appears" manual check
   (the temperamental case that must not regress — verify in real Chrome,
   not just Playwright); before/after `recheckPendingVisibility` totals
   from extension-perf.jsonl over comparable active windows.
4. Kill switch: `bkPointerRecheckScope`, default ON, explicit false
   restores full-set rechecks on every pointer tick (denylist posture).

## Open questions

- N=5 ancestor depth: right starting bound? The counters will show
  scoped-set sizes; if scoped ≈ full on real pages, the scope isn't
  buying anything and the design should be revisited rather than tuned.
- Should the vis-MO path scope too (records carry targets, same
  containment trick)? Deferred — it's rAF-coalesced and storm-driven;
  measure the pointer win first.
- Interaction with `schedulePromoteThrottled`'s shared throttle: the
  scoped and full sweeps must not starve each other; simplest is separate
  timers (100ms scoped, 300ms-idle full).

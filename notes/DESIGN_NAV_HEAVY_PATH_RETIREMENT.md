# Nav heavy-path retirement

2026-07-18. Final step of the nav-wipe retirement arc (freeze-fix series →
reconciler → retirement steps 1-2 → this).

## What goes

The wholesale branch of the from_cache rescan's deferred tail in
`content.ts` — the `disconnected/total` discriminator and its
`doScan('rescan')` full-document response. The nav path becomes: observer
preempt (wedge, untouched) → dropDisconnected → syncNow → reconcile +
settle pass. A SPA nav is now just a hint that a large mutation batch may
be in flight; the generic machinery (MO huge-path discovery, prime-at-attach
claims, band-discovery backstop, level-triggered reconcile) owns the rest.

## Why now

The heavy path was kept after the first retirement cut regressed claim-heavy
swaps (2026-06-12 soak: QuickBase report→report, ~230 fresh claims, hints +
grammar seconds late). Two things changed since:

- **Prime-at-attach** moved bulk claims inline at attach in the incremental
  path (the code's own comment: "which is what makes the light path safe").
- **Measured evidence** (`scripts/_test-nav-claim-latency.mjs`, 250-link
  wholesale pushState swap, all-fresh link text so rebind cannot rescue):
  on the CURRENT build the heavy path posts nothing — grammar arrives 100%
  `kind=incremental` (`scan=0`) by ~110ms, band repaints stable by ~500ms.
  The doScan runs, finds everything already known, and is pure overhead.

Also: the 2026-07-18 discriminator floor already routes small swaps (YouTube
Shorts) light; what remains heavy is big swaps — exactly where a redundant
full-document scan costs the most at the worst time.

## Gates (all must hold on the retired build)

1. `_test-nav-claim-latency.mjs` ×3: recovery and grammar latency comparable
   to baseline (~500ms / ~110ms), NOT seconds — the 2026-06-12 signature.
2. `_test-videos-tab-wedge.mjs`: wedge does not return.
3. `_test-live-churn.mjs`: steady-state scroll posts no grammar; injected
   links arrive as bounded incremental.
4. `_test-firefox-shorts-freeze.mjs`: clean, light-path-only top frame.
5. Unit suite green.

## Revert lever

Single commit; revert restores the discriminator + heavy branch verbatim.

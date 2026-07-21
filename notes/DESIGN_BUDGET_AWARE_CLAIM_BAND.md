# Budget-aware claim band

## Problem

The codeword pool is a hard 676 (26×26 two-word pairs, `label-pool.ts`). The
claim band is the viewport ± `VIEWPORT_MARGIN_PX` (1000px) on every side
(`intersection-tracker.ts`). On dense pages the number of hintable elements in
that band exceeds 676, so some elements get no codeword and never paint.

Evidence — Ctrl+Alt+A snapshot 2026-07-21T17-08-30 (a QuickBase report grid):

- 931 tracked wrappers, **255 with no codeword** (170 buttons + 85 links, zero
  images). All 255 discovered via `mo_huge`, `hint: null`, `t_first_shown: null`.
- `paint_stability` pinned `painted` at exactly **676** while `wrappers` swung
  to 931, with `pool_free: 0`. The pool is simply exhausted.
- 136 of the uncoded elements were genuinely on-screen (inside the viewport),
  not below the fold.

Root cause is not just exhaustion — it's *which* elements lose. `bandConverge`
(`settle-engine.ts`) queues claims for every uncodeworded in-band wrapper in
`store.all` iteration order, and `doFlush` grants "in discovery order — no
viewport-distance re-deal". So when the pool runs dry, whoever sorts last is
stranded, and that is often an on-screen row sitting below off-screen rows in
DOM order. In-band population by margin on that snapshot:

| margin | in-band |
|--------|---------|
| 0 (strict viewport) | 483 |
| 250px | 668 |
| 500px | 819 |
| 1000px | 931 |

A blunt global cut of `VIEWPORT_MARGIN_PX` was rejected: 250px keeps *this*
page under budget but regresses smooth-scroll pre-paint everywhere, and any
grid ~1.4× denser still exceeds 676 in the strict viewport alone.

## Fix: tighten the band under budget pressure, nearest-first

In `bandConverge`, compute each live wrapper's **overhang** — the smallest
margin at which its rect enters the band:

```
overhang = max(0, -r.bottom, r.top - vh, -r.right, r.left - vw)
```

`geometryInBand(r, vw, vh, m)` is exactly `overhang < m`; overhang 0 means the
rect intersects the strict viewport.

- No pressure (in-band count ≤ `CLAIM_BUDGET`): effective margin stays
  `VIEWPORT_MARGIN_PX` — behavior byte-for-byte unchanged.
- Pressure (in-band count > `CLAIM_BUDGET`): shrink the effective margin to the
  `CLAIM_BUDGET`-th nearest overhang, so the scarce codewords land on the
  closest-to-viewport wrappers. The strict viewport (overhang 0) is always in.
  Codeworded wrappers now beyond the effective margin release (existing
  `strikeOut` two-strike path) and free their codewords for nearer wrappers.

`CLAIM_BUDGET` is derived from `POOL_SIZE` (single source of truth in
`label-pool.ts`) with a ~5% reserve for cross-frame sharing and reservoir
refill lag: `Math.floor(POOL_SIZE * 0.95)` ≈ 642.

### Why it doesn't oscillate

The effective margin is a function of **geometry only** (the overhang
distribution), independent of which wrappers currently hold codewords. So each
pass produces the same near/far partition until the user scrolls; the far
cohort releases once and is not re-queued. `strikeOut`'s two-strike temporal
hysteresis damps any boundary flicker. Releases beyond the effective margin are
imperceptible — the wrapper is off-screen (overhang > 0 ⇒ outside the strict
viewport).

### Hard-cap residual

If the strict viewport itself holds > `CLAIM_BUDGET` hintable elements, the
effective margin floors at 0 and the farthest visible overflow stays unhinted —
unavoidable with a 676-codeword vocabulary. Growing the vocabulary
(3-word codewords) is the separate, larger lever and is out of scope here.

## Touched

- `label-pool.ts` — export `POOL_SIZE` (derived, replaces the 676 magic number).
- `settle-engine.ts` — `bandConverge` computes overhang + effective margin.

## Status

Landed local, unpushed. Needs soak on real dense grids (QuickBase reports).
Tracked under the giant-DOM breaker item in the long-session perf audit.

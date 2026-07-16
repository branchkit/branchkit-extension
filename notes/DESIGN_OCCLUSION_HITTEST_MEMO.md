# Occlusion hit-test memoization — invalidation-signal design

2026-07-16. The QuickBase gather-cost lever queued behind the settle-storm
fix (notes/DESIGN_SETTLE_TRIGGER_SCOPING.md). Design-first on purpose: the
obvious cache is unsound, and the machinery is only worth building if the
hit-tests actually dominate the gather — Phase 0 measures that before
anything else.

## Problem

Read batch 3 of the settle gather (`lifecycle/gather.ts`) recomputes overlay
occlusion for every visible in-band badge: up to 5 `elementFromPoint` probes
plus one extra `getBoundingClientRect` of the target's visual box
(`isOccluded` re-reads it even though batch 2 already read the target rect —
of `w.element`, not `effectiveVisualBox(w.element)`). On the 700-wrapper
QuickBase tab that is ~474 elements per settle inside a 231–372ms average
gather, while the OUTPUT barely moves: `occlusion:delta` is a handful of
wrappers on the settles where it is nonzero at all. We pay full price every
settle for a mostly-static answer.

Post-trigger-scoping, settles are interaction-driven — so the expensive
recomputes now happen exactly when the user is doing something and the main
thread is busiest.

## Why rect-unchanged caching is UNSOUND (the reason this waited for design)

`isOccluded(w)` is a function of the ENTIRE paint order above the sample
points, not of the target. Keying a cache on the target's rect misses every
occluder-side change:

- an overlay slides over a stationary target (target rect identical, result
  flips);
- a `:hover`-painted overlay appears via pure CSS — NO DOM mutation, no
  observer record of any kind, only the pointer position knows;
- a fixed/sticky element and root scroll change the overlap (though root
  scroll also moves the target, so the target-rect key happens to catch
  this case);
- z-order/class churn on elements that never touch the target's subtree.

Any sound cache needs target-side AND occluder-side invalidation.

## Sound invalidation: what can change the answer, and what signal carries it

Occlusion(w) can change only via:

| change | signal that carries it |
|---|---|
| T1: target's viewport rect changed | batch-2 rect (already read — free key) |
| T2a: DOM mutation moved/added/removed/restyled an overlapping element | page MO + visibility MO records (class/style included via vis-MO) |
| T2b: CSS transition/animation moved an overlay | `transitionend`/`animationend` (mid-flight staleness is ALREADY accepted today — occlusion only recomputes at settles) |
| T2c: pure-CSS `:hover` paint | pointer events (coordinates on the event, no layout read) |
| T2d: scroll/resize/zoom reshuffled fixed/sticky vs content | scroll/resize signals (and T1 fires for the target anyway) |
| T2e: first paint after load/nav | fresh cache (no entry → always test) |

Every row has an existing tap — the settle-trigger scoping work already
routes all of them through known chokepoints. That is what makes a sound
cache POSSIBLE now.

## Design: dirty-region epoch cache

- **Coarse viewport grid** (start 8×8). A wrapper's cells derive from its
  batch-2 gather rect — no extra reads. Cell membership of the 5 sample
  points, not the whole rect.
- **Cache entry per wrapper**: `{ result, rectKey, testedEpoch }` in a
  WeakMap. `rectKey` = rounded batch-2 rect (integer px — sub-pixel jitter
  must not bust the cache).
- **Dirty state**: a global `occlusionEpoch` plus a `dirtyCells` bitset,
  fed by cheap taps:
  - **MO batches** (both observers): queue ≤K distinct mutated elements
    (childList: added/removed nodes; attributes: target). Their rects are
    resolved INSIDE the next gather (clean layout — reading at MO time
    risks forced reflow on dirty layout), then their cells marked. Batch
    bigger than K, or the huge path → all-dirty. K starts at 16.
  - **Pointer**: mark the cell under `pointerover`/`pointerout`
    coordinates (event coords, zero reads). Covers `:hover` paints along
    the pointer path — the same cadence the pointer sweep already settles
    at.
  - **scroll / resize / transform-ancestor**: all-dirty. Targets move
    anyway (T1), this just keeps the reasoning simple.
  - **focusin/focusout, transitionend/animationend**: queue the event
    target for cell-marking like an MO element (focus can restyle via
    `:focus-within` with no record).
- **Batch 3 per wrapper**: reuse iff `rectKey` unchanged AND none of the
  wrapper's cells are dirty AND not all-dirty. Otherwise hit-test and
  store. Dirty state resets after the batch.
- **Fold the extra gBCR** (independent quick win, sound on its own): batch
  2 reads the rect of the wrapper's cached `effectiveVisualBox` element
  instead of a second read inside `isOccluded`. The visual-box ELEMENT is
  stable per wrapper; cache it at first resolution, invalidate with the
  wrapper.

### Soundness argument

Every occluder-side change either arrives through a tapped signal (table
above) or is a mid-animation frame we already show stale today (occlusion
only ever updates at settles; the end-of-animation settle corrects it).
The pointer tap is the load-bearing novelty: it is the only signal for
pure-CSS paints, and it marks exactly the cells the pointer actually
crossed — the same places `:hover` overlays can appear.

Residual accepted staleness (all match today's behavior, none regress it):
- timed CSS animations with no transitionend and no pointer nearby — stale
  until the next settle from any source, as today mid-flight;
- `pointer-events:none` overlays are invisible to `elementFromPoint`
  regardless (pre-existing open item in DESIGN_HINT_OCCLUSION_FILTERING).

## Verification plan (Phase C discipline — verified shadow first)

1. Shadow mode: memoization computes its reuse decision but the fresh
   hit-test STILL runs; divergences (cached ≠ fresh) counted and firehosed
   (`occlusion_memo:diverged`, with the invalidation reason that SHOULD
   have fired). Run across Gmail idle, QuickBase interaction, YouTube
   playback. Gate to authoritative on zero divergence at real volume.
2. Counters (trail-visible, not harness-only): reuse rate, retest causes
   (rect / cells / all-dirty / cold), efp calls per settle before/after.
3. Wedge test + vitest as always; live QB per-settle gather ms
   before/after from extension-perf.jsonl.

## Phase 0 — cost decomposition (land with this note)

Split the gather's recordCpu into per-batch buckets and count TRUE
`elementFromPoint` calls (off-viewport sample points skip the call today,
so element count ≠ probe count):

- `settleGather:b1_visibility` / `b2_rects` / `b3_occlusion` (ms)
- `settleGather:size:efpCalls` (count)

Decision gate: if b3 (and efp count) doesn't dominate the QB gather, the
lever is elsewhere (the gCS half — the open checkVisibility-underdelivered
question) and this design stays on the shelf. No machinery before the
numbers.

## Alternatives considered

- **Strict-viewport-only occlusion set**: off-screen sample points already
  skip the efp call; remaining saving is the extra gBCR, which the batch-2
  fold captures more simply.
- **Every-Nth-settle cadence**: staleness with no signal — unsound,
  rejected.
- **IO-per-occluder tracking** (clip-observer's trick): IOs can't see
  arbitrary z-order paint, which is the whole reason `elementFromPoint`
  exists here (DESIGN_HINT_OCCLUSION_FILTERING). Rejected.

## Open questions

- Grid size / K cap tuning (start 8×8 / 16, revisit with Phase-1 counters).
- Does `pointermove` (throttled) need to join the pointer tap, or is the
  `pointerover` boundary-crossing cadence enough for real hover overlays?
- Interplay with the first-paint occlusion gap (separate open item in
  DESIGN_HINT_OCCLUSION_FILTERING) — a cold cache always tests, so the gap
  neither improves nor worsens.

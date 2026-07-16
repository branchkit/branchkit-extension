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

## Phase 1 results — shadow soak + authoritative flip (2026-07-16)

Shadow mode (ext 4436438) soaked over live QuickBase interaction and YouTube
playback: **zero divergence across 1,856 would-reuse verdicts** (QB 1,617,
YT 239), with the cells (31/29), rect (2), and epoch (31) retest paths all
exercised. QB clean-window reuse ≈ 98% of decisions; b2 stayed ~3.3ms with
the gBCR fold (no inflation); the memo's own resolve cost ≈ 1 rect read per
gather. Soak caveats, recorded honestly: Gmail idle produced no gathers (as
expected post settle-trigger scoping — no settles means no decisions, so it
neither confirms nor threatens), and most of the QB session ran a stale CS
(only ~9 new-build gathers) — accepted on the strength of the fail-open
structure (staleness self-heals at the next all-dirty window) plus the kill
switch.

**Authoritative since ext (this commit): a hit skips the probes.**
`bkOcclusionMemo`: default on; `false` kills the memo; `'shadow'` re-enters
verify-only mode (fresh test runs and wins, divergences counted + firehosed)
— set it whenever an invalidation tap changes, and gate on zero divergence
again.

Implementation deltas from the sketch above, all fail-open:
- childList REMOVALS go straight to all-dirty (a removed occluder's old
  position is unreadable once out of the DOM); adds queue normally (they
  didn't exist before, so only their current position matters).
- A queued element that resolves disconnected / zero-box / fully
  off-viewport → all-dirty (catches display:none and slide-out occluder
  disappearances soundly). Residual accepted gap: an occluder slid to a
  DIFFERENT in-viewport position by a direct style write marks only its new
  cells — zero divergences from it in the soak.
- The manual-deferred MO path and observer re-attach (hidden-tab resume) →
  all-dirty; own-badge mutations are skipped (pointer-events:none).
- Reuse additionally requires validation at the immediately preceding gather
  (`epoch === gatherEpoch - 1`): a wrapper absent from a gather missed that
  window's dirt, which was reset.
- All-dirty reason attribution is first-setter-wins per window
  (occlusionMemoAllDirtyBy), so e.g. 'scroll' under-reports when another tap
  failed the window open first.

**Post-flip live confirmation (QB, 401-badge occlusion set, ~90s of
interaction):** per-gather b3 = [171, 167, 137, 137, 58, 44, 15, **0.4**]ms
with efp = [676, 676, 676, 676, 442, 243, 75, **0**]. A clean-window gather
costs 0.4ms / zero probes — past the ~10ms target; the expensive gathers are
the (correct) fail-opens: boot, mo-attach, scroll, and resolve-vanished ×3.
The session mix, not the hit cost, is now the number that matters.

## Round 2 — fail-open frequency tuning (2026-07-16, IN SHADOW)

The post-flip mix said the remaining cost is fail-open frequency, not hit
cost: QB hit resolve-vanished ×3 in ~90s, Gmail removal ×7 +
element-overflow ×2, YouTube shadow reuse only ~13%. Three changes, shipped
as a re-shadow round (mode default temporarily 'shadow' — tap semantics
changed, so the zero-divergence gate applies again):

- **Last-known-cells history**: every resolved element's cells are recorded
  (WeakMap). A queued element that turns up disconnected / zero-box /
  off-viewport localizes to the cells it last painted
  (occlusionMemoVanishLocalized counter) instead of nuking the window;
  no-history vanishes still fail open ('resolve-vanished' — the
  'removal'/'resolve-disconnected' reasons folded into it since removals now
  queue like adds). The history is wiped on EVERY all-dirty window: scroll
  and friends shift content with no per-element records, so recorded cells
  are only trusted across clean-window streaks. This also absorbs the
  dropdown-close case (menu resolved at open → its cells localize the
  close).
- **Old ∪ new marking**: a re-resolved element that moved marks both its
  previous and current cells — closing round 1's acknowledged
  in-viewport-slide gap for any element seen within the streak. The
  remaining unrecorded-shift exposure: in-flow siblings displaced by
  someone else's mutation carry stale history until a wipe — shadow
  adjudicates.
- **K 16→32** (element-overflow was firing on Gmail/YT; resolve reads are
  warm-cache lookups, measured 1-2/gather).

Gate: zero occlusion_memo:diverged over Gmail interaction (removal-heavy),
QB dropdown/hover interaction, YouTube — then restore the 'on' default
(content.ts flag mapping + module default, both marked SOAK BUILD).

**Shadow soak 2a (2026-07-16): diverged=0 everywhere, but vanishLocalized=0
too — the wipe rule was self-defeating.** A no-history vanish failed the
window open, the fail-open wiped the history map, so the NEXT vanisher had
no history either: on churny pages the map never survived a window (Gmail:
resolve-vanished ×10 ≈ 1,920 of its 2,171 all-dirty retests, localization
never fired). Fix: classify all-dirty reasons — geometry-shifting ones
(scroll/resize/transform, mo-attach, manual-deferred, huge,
element-overflow: a history'd element may have MOVED unresolved, and stale
history would later UNDER-mark its vanish) still wipe; resolve-vanished and
pointer-overflow keep history (one element disappearing / losing pointer
coords moves nothing else). The resolve loop also now finishes the whole
queue after a doomed window — the history writes are the point. With the
loop broken, the Gmail-tick shape converges: tick 1 fails open once, every
later tick localizes (unit-pinned). Re-soaking under the same gate. (Also
noted from 2a: the data.quickbase.com tab was stale-CS that round — the QB
dropdown evidence must come from a reopened tab.)

**Shadow soak 2b (2026-07-16): ONE divergence in 44,831 reuse verdicts —
and it answered the design's open pointer question.** tldraw.com (canvas
app, off-recipe — shadow's whole point), `false->true` on an `<a>`, riding
a `passSoon:pointer` settle: a pure-CSS :hover paint EXTENDED into the cell
next to the one the pointer crossed. The boundary-crossing tap marks where
the cursor is, not where the hover paint reaches. Fixes:
- pointer coords now mark a 3×3 cell neighborhood (~1/3 viewport span
  around the cursor on the 8×8 grid) — bounds cursor-anchored tooltips;
- the pointerover/out TARGET element is queued too — bounds hover paints
  sized to the trigger's own box (background swells, outlines).
Also from 2b: vanishLocalized was STILL 0 on Gmail/QB — element-overflow
(which wipes history, correctly) is the steady state for long inter-settle
windows (Gmail's tick queues ~4 el/s; K=32 blew inside any ~8s reading
pause). K → 128 (~30s of coverage; resolve reads are clean-layout
lookups). tldraw itself: vanishLocalized 103, resolve-vanished 693 — the
history mechanism works where windows stay short. Re-soaking (soak 3).

**Shadow soak 3 (2026-07-16): diverged=0 on every host — gate met,
AUTHORITATIVE restored.** tldraw re-exercised clean under the neighborhood
fix. QuickBase converged completely: resolve-vanished 0 (was the top
fail-open), one scroll all-dirty in the whole session, reuse 1,044.
Gmail/YouTube still burn resolve-vanished windows with vanishLocalized=0 —
diagnosed shape: elements ADDED AND REMOVED within one inter-settle window
(Gmail's tick between rare gathers) can never carry history.

Queued next lever — **transient-skip** (needs its own shadow round; it
changes tap semantics): a disconnected no-history element that was queued
as an ADDED node within this same window existed at NEITHER gather
boundary, so it cannot affect either gather's answer — skip it instead of
failing open. Expected to zero Gmail/YT's residual resolve-vanished
windows.

**Transient-skip implemented (2026-07-16, round 3 — IN SHADOW).**
pendingElements is now Map<Element, bornThisWindow>, FIRST sighting wins
(not an OR-merge): moving a connected node emits its removal record before
its addition (the DOM removes first), so a reparented pre-existing element
— whose old paint region still matters — is first seen as a removal and
stays unflagged; only a first-record-is-add element is provably born this
window. Born-this-window descendants first seen via later attribute
records stay unflagged (conservative: fail open, never wrongly skip).
Dropped transients count in occlusionMemoTransientDrops. Gate: diverged=0,
transientDrops absorbing Gmail/YT's resolve-vanished.

**Round-3 shadow soak (2026-07-16): diverged=0 on every fresh-build host
(QB reuse 306 + github 82), transient path fired live once (QB) with no
divergence — AUTHORITATIVE restored.** Coverage caveat, recorded honestly:
Gmail didn't get a pass this round and YouTube's fresh tab produced no
gathers, so the transient rule's target volume runs under authoritative
with the counters as the ongoing signal — transientDrops climbing during
normal Gmail use is the confirmation; a badge lingering hidden after a
dropdown closes would be the tell to re-shadow. The rule itself is
boundary-exact (absent at both gather endpoints ⇒ can affect neither
answer), not a heuristic. Arc status: hit cost solved (0.4ms clean-window
gathers), fail-open frequency addressed on QB (resolve-vanished → ~0) and
structurally for the Gmail-tick class (transient-skip + K=128 + history
localization).

## Open questions

- Grid size / K cap tuning (start 8×8 / 16, revisit with Phase-1 counters).
- Does `pointermove` (throttled) need to join the pointer tap, or is the
  `pointerover` boundary-crossing cadence enough for real hover overlays?
- Interplay with the first-paint occlusion gap (separate open item in
  DESIGN_HINT_OCCLUSION_FILTERING) — a cold cache always tests, so the gap
  neither improves nor worsens.

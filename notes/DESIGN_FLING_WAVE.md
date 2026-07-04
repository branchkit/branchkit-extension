# Fling wave — badges land as one unit, and stay through recycling

Date: 2026-07-03
Status: proposal (design pass — no code). Successor to the two open items in
`DESIGN_PAINT_THE_BAND.md` rounds 9–10: (a) stacked per-stage coalescing keeps
end-to-end dom_seen→shown p50 at 328–565ms across runs, above the ~150–200ms
"fused with content" threshold; (b) the churn dip — each fling tears down
60–110 of ~380 visible badges, rebuilt over ~1–1.4s. Everything that note
rules out (construction cost, huge-path scheduling, voice/ACK latency,
skeleton gating, Rango DOM pooling) stays ruled out; nothing here re-litigates
it.

Companions: `DESIGN_PAINT_THE_BAND.md` (the band model + ten tuning rounds),
`notes/completed/DESIGN_WRAPPER_IDENTITY_STABILITY.md` (limbo/rebind),
`DESIGN_CODEWORD_KEY_OWNERSHIP.md` (strong-key rebind tier),
`notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md` (the reconcile entry
this rides).

## Where the time actually goes (the round-10 stage list, corrected)

The round-10 summary attributed the stack to "discovery ~90–250ms + claim
flush 50ms + build trigger rounds ~100ms cadence". The freshest production
snapshot (2026-07-03T22-54-13, 90s window, n=259–535 per stage) splits it
differently:

| stage | p50 | p90 | what it is |
|---|---|---|---|
| dom_seen→attached | 112ms | 239ms | MO → rAF entry → 8ms drain slices |
| attached→band | **305ms** | **584ms** | waiting for the IO to deliver the band-entry callback |
| band→claimed | −19ms | 28ms | claim flush (microtask; negative = claims often land before the IO stamp) |
| claimed→shown | 26ms | 401ms | build pass + rIC continuation rounds |
| dom_seen→shown | 565ms | 992ms | the sum |

Two corrections to the mental model:

1. **There is no 50ms claim debounce anymore.** The tracker's flush is
   `queueMicrotask` and the reservoir claim is synchronous/local. The
   negative band→claimed p50 is the tell: `refreshViewportClaims` (reconcile)
   frequently claims for a wrapper before the IO ever stamps `tInBand`.
2. **The dominant serial stage is IO callback delivery.** A fresh row is
   attached and observed, then waits ~300ms p50 for the IntersectionObserver
   to say "in band" before anything downstream may run. IO callbacks are
   delivered around rendering opportunities; mid-fling the frames run
   30–60ms and the main thread is saturated with the page's own row
   rendering, so delivery starves. (The percentile also absorbs wrappers
   legitimately attached ahead of the band that scrolled in later — but on a
   recycling grid, fresh rows materialize in or near the viewport, so the
   fresh-row cohort is mostly a pure wait.)

So the collapse target is not "shave each debounce"; it is: **stop treating
the IO as a serial stage for elements that are already in-band when we attach
them**, and stop letting the build continuation idle at 100ms rounds.

## Part 1 — the wave model: claim at attach, build in the same slice

One principle: a wrapper that is in-band at attach time completes
claim + build + paint inside the same discovery drain slice that attached it.
The IO demotes to the steady-state maintainer — band exits, later entries,
flag corrections — exactly the role it already plays for everything the
reconcile claims ahead of it.

### Mechanism

1. **Prime at attach.** `attachDiscovered` gains a post-attach step: for each
   newly-attached wrapper, one cached-rect band check (same
   `VIEWPORT_MARGIN_PX` — single source of truth, per the 200-vs-1000 drift
   rule) plus the existing `wantsCodeword` gates. In-band → set
   `isInViewport = true` optimistically, stamp `tInBand`, and hand the
   wrapper to a new `tracker.primeClaims(wrappers)` that feeds the existing
   `pendingClaim` set. The rect is warm — the scan walk just read it for the
   visibility check.
2. **Drain the wave in-slice.** The claim flush already runs at microtask
   timing, and its completion already re-enters build synchronously
   (`doFlush → onCodewordsChanged → reconcile → badgeNewlyCodeworded →
   placeBadges`). Priming gives that chain work at attach time instead of a
   frame-or-three later. No new flush path, no new build path — the whole
   collapse is "the queue gets its items earlier".
3. **Unified slice budget.** Today a discovery slice is 8ms and a build pass
   is 48ms, in different tasks with trigger gaps between them. With build
   riding the discovery slice's microtask tail, the drain's budget should
   cover walk + claim + build together: one `WAVE_SLICE_BUDGET_MS`
   (start ~32ms, measure) replacing `DRAIN_DISCOVERY_BUDGET_MS` as the
   drain's yield threshold. The burst-model rationale from round 4 holds:
   mid-fling the page is already dropping frames; the budget is a guardrail,
   not a smoothness tax.
4. **Yield-chain the build continuation.** Budget-deferred construction
   currently re-enters via `runWhenIdle` with a 100ms timeout — mid-fling rIC
   starves and the backlog drains at 100ms rounds (the claimed→shown p90
   401ms). Replace the scheduling with the exact shape `drainDiscovery`
   already ships: `scheduler.yield()` chain, session-owned 0-timeout
   fallback, single-flight, `isTornDown` + `hintsVisible` guards,
   self-terminating when the delta is empty. Slices resume in ~1–4ms instead
   of ~100ms.

### Why this doesn't re-arm the reverted claim-fragmentation (7fe37a0)

The nav-wipe step-1 attempt applied `toClaim` level-triggered from every
settle pass over the whole store — it raced the scan pipeline's inline claims
and splintered sync into hundreds of tiny waves (285 grammar batches on one
tab), producing badge doubling. Priming is different in kind:

- **Edge-triggered, once per wrapper, inside the path that created it** — not
  a re-derivation that can fire repeatedly against the same wrapper.
- **Cannot race the scan path.** Scan-path wrappers arrive with codewords
  already claimed and POSTed; the prime claims only when `!scanned.codeword`,
  and `findWrapperFor` dedupes the discovery side.
- **Sync cadence unchanged.** Claims still batch per flush; grammar Puts
  still coalesce under the 80ms sync debounce. A drain producing 3 slices
  yields ~3 claim batches per wave, not per-wrapper waves.

### Why the IO doesn't fight it

The initial IO callback for a primed in-band wrapper reports intersecting;
the claim branch is idempotent (has codeword → no-op). If IO reports it out
(moved between attach and delivery), `queueRelease` fires — which is correct,
it left the band — and sticky reclaim preserves the letter for the
scroll-back. The one flag we write optimistically (`isInViewport`) is the
same flag `applyLifecyclePlan`'s repair path already writes from geometry.

### On "one paint wave" atomicity

With slices chained at yield timing, a row batch paints in 1–3 bursts inside
~100–150ms. Deliberately NOT proposing a wave-hold reveal (accumulate built
badges hidden, flip together at a deadline, Rango's 100ms-debounce shape): it
taxes the median badge with waiting, adds reveal machinery, and the
perceptual threshold is met by speed alone once the bursts sit ~30ms apart.
Revisit only if the eye still reads ripple in the paint_stability ring after
Part 1 lands.

### Expected numbers

- attached→band ≈ 0 for the fresh-row cohort (stamped at prime time);
  count primes in `lifecycleCounters` so the cohort is visible.
- dom_seen→shown p50 ≈ rAF entry (≤1 frame) + backlog position (1–3 slices)
  ≈ 60–160ms. Target: p50 < 200ms, p90 < 400ms.
- claimed→shown p90 collapses toward slice cadence (~50ms).
- paint_stability fill slope steepens; the ring is the acceptance test, per
  the drill (reload, close+reopen tab, fling, Ctrl+Alt+A).

## Drill round 1 (2026-07-03, snapshot 23-30, steps 1+2 live) — Part 1c

Steps 1+2 did what they claimed and it was not enough. The numbers
(vs the 22-54 baseline): attached_to_band p50 305 → **3ms** (prime works),
dom_seen_to_shown p50 565 → 311 / p90 992 → 558, claimed_to_shown p90
401 → 231. User verdict: still lags. Two facts explain the gap:

1. **attached_to_band p90 is still 581ms.** QuickBase's ~300-row window
   spans MANY viewports (~30-40px rows ≈ 9-12k px), so most rows are
   inserted OUTSIDE the 1000px band and cross the band edge mid-fling.
   Prime-at-attach can't see them — they were legitimately out-of-band at
   attach — and the crossing is still detected by the starved IO. The
   badges the user watches pop in late are exactly this cohort: the
   leading edge of the fling. The p50/p90 split is the two cohorts
   (in-band inserts primed instantly; edge-crossers still IO-bound).
2. **The dip is intact** (stability ring: shown 480 → 383 in one burst —
   same ~100-badge sag). Expected: replacement paint p50 311ms still
   straddles the 250-500ms limbo hold.

Fix (Part 1c): **mid-scroll band-entry flag sweep** — the settle plan's
stale-FALSE repair (`toRepair`), run one-directionally while scroll events
are arriving, throttled to 10Hz. This is the piece of Rango's model we had
not ported: it rect-polls every observed target on a 50ms-throttled scroll
listener (its stale-IO defense); ours is cheaper (out-of-band wrappers
only, entries only).

- `tracker.sweepBandEntries(vw, vh)`: walk the store's out-of-band, live,
  connected wrappers; one gBCR each (no writes interleave — a single
  reflow per sweep); boxless rects skip; `geometryInBand` hit → flip
  `isInViewport`, stamp `tInBand`, refresh `lastRect` (free, helps the
  limbo tiebreaker). Returns the repair count.
- content.ts: 100ms-throttled call from `scheduleScrollReposition` (both
  window and inner-pane capture listeners already funnel there), gated on
  `hintsVisible`; repairs > 0 → `reconcile()` — the designed convergence
  entry does claims (refreshViewportClaims picks up the flipped flags) and
  build. No new claim path, no new build path.
- Exits stay settle-scoped (teardown at `runSettlePipeline`) — hiding
  badges mid-fling is wasted work and the one-directional shape removes
  any flap risk with the IO.
- Wedge discipline: synchronous, bounded, inside an existing scroll
  handler at ≤10Hz, no timers, no rAF. Cost ≈ one batched-read reflow per
  100ms while scrolling — the same class reconcileTeardown pays once per
  settle, and far below the per-rAF settle pipeline the 100ms debounce
  exists to prevent.
- `geometryInBand` moves to layout-cache.ts (leaf, next to
  `isRectOnScreen`) — the tracker can't import it from reconcile.ts, which
  imports the tracker's `VIEWPORT_MARGIN_PX` at module-eval time (TDZ
  cycle).

Prediction to check at the next drill: attached_to_band p90 collapses to
~100ms (throttle ceiling), dom_seen_to_shown p50 lands near the ring's
fill slope rather than above it, and the dip shrinks by however much of
it was fill-side. Whatever dip remains after that is teardown-side —
step 4's territory.

## Drill round 2 (2026-07-03, snapshot 23-44, sweep live) — the sweep must
## be symmetric

Fill improved again and perception still didn't move — dom_seen_to_shown
p50 565 → 311 → **123ms** across rounds, yet the dip is byte-identical
(shown 484 → 383, the same ~100-badge sag) and the user reports no
difference. Round 9's verdict is now confirmed twice over: perception
tracks the dip.

The new tell: **band_to_claimed p90 jumped 13 → 377ms.** The one-
directional sweep made band ENTRIES fast while EXITS still wait for
starved IO delivery or the settle — so mid-fling the local reservoir
drains (claims fast, releases slow), `claim()` hands out `''`, and the
leading edge paints only after settle-time releases refill the pool.
Worse, the claim-starved cohort is exactly the recycled rows'
replacements — which is why the dip didn't close even at 123ms fill:
the handoff badges were the ones left letterless.

Fix: the sweep runs BOTH directions of the settle plan's lifecycle
repair — stale-FALSE (entries, as shipped) and stale-TRUE (flag in,
geometry out → flip flag + `queueRelease`). `labelReservoir.release` is
local-synchronous (freed letters land at the front of the local free
queue), so an exit in sweep N funds a claim in the same sweep's
reconcile. Released wrappers are ≥1000px off-screen — hiding their
badges is imperceptible, and sticky reclaim keeps their letters for the
scroll-back.

Why this does NOT re-arm the retired off-screen hide sweep's flap
(seam 3 of paint-the-band): that sweep hid badges while LEAVING them
band-flagged, so `wantsShown` stayed true and the settle plan re-showed
them — hide/show forever. This one flips the band flag first; the plan
agrees with the resulting state. It is the IO exit path, driven by
geometry, at 10Hz — not a second visibility policy.

Also added: the debug snapshot now carries a `wave` section
(primed_claims, band_sweep_repairs/releases, reservoir stats) — the
drill previously couldn't see the sweep counters at all (they lived
only in the perf snapshot), which made this round's diagnosis
inferential when it should have been direct.

Prediction for drill round 3: band_to_claimed p90 back to ~sub-50ms,
reservoir free-count healthy mid-fling, and the dip finally shrinks —
recycle replacements claim instantly and paint inside the 250-500ms
limbo hold. If the dip persists even then, it is teardown-side with no
remaining fill-side excuse: proceed to step 4 (slot rebind).

## Drill round 3 (2026-07-03, snapshot 23-51 + actuator.log breadcrumbs)
## — stop re-slicing the wave

Pool fixed (wave.reservoir.free 125 mid-window, band_to_claimed p90
377 → 130), user reports incremental painting but the same overall lag,
and the end-to-end tail barely moved (dom_seen_to_shown p90 566). Two
side notes first: round 2's p50 123ms was partly an ARTIFACT — fresh
out-of-band wrappers carry isInViewport=true by default, so before the
symmetric sweep they pre-claimed and pre-built; the sweep now honestly
flips them false and p50 "regressed" to 365 (real band timing). And
band_sweep_repairs=1 with primed_claims=480: on this grid the
destination rows mount in-band at deceleration and get primed — the
sweep's entry direction is a backstop here, its release direction (the
pool fix) is what earns its keep.

The actuator.log firehose finally shows where the wall-clock goes — the
wave is being RE-SLICED, twice:

1. **Build passes are 40-110ms apart with the backlog growing
   mid-chain** (band_build:deferred 31 → 58 → 39 → 18 → 14 → 7 over
   ~700ms). Each pass pays cacheConstruction ancestor-warm + build +
   placeBadges reflow (~50-80ms wall) and then clearLayoutCache wipes
   the warm — the next pass RE-WARMS the same shared row ancestor
   chains. Five passes ≈ five times Rango's one-burst overhead. (Step
   2's budget unification also quietly LOWERED the build budget 48 → 32
   — the wrong direction; the ten-round arc keeps concluding burst.)
2. **drainDiscovery itself is fast (224 roots in 10ms — the pre-filter
   eats almost everything); the discovery tail is the rAF ENTRY.**
   Mid-fling a saturated main thread delivers the next animation frame
   100-300ms late; that is dom_seen_to_attached p90 302 / max 2575.

Fix (Part 1d):
- **Burst build budget.** Split the unified constant back into
  WAVE_WALK_BUDGET_MS = 32 (drainDiscovery slices — fine as measured)
  and WAVE_BUILD_BUDGET_MS = 120 (badgeNewlyCodeworded) — an 80-badge
  wave (~0.3ms/badge warmed, plus warm + place) completes in ONE pass,
  paying the warm and the placement reflow once. The budget survives
  only as the pathological-wave guardrail, exactly the round-4/6
  posture. Mid-fling the page is dropping frames anyway; a ~150ms task
  at swap time is Rango's shape, which the A/B said reads as instant.
- **Yield-task discovery entry.** scheduleDiscovery enters via
  scheduleYieldTask instead of requestAnimationFrame, with a
  single-flight `discoveryScheduled` flag replacing the rAF id (the
  isTornDown guard already covers the uncancellable yield path — same
  contract as the chain). Trades a little batching (a fresh MO batch
  can land its own small drain instead of joining the frame's) for
  entry latency that no longer waits on a rendering opportunity; the
  subtreeMaybeHintable pre-filter keeps small drains ~2-10ms.

Prediction for drill round 4: dom_seen_to_attached p90 well under
100ms, claimed_to_shown p90 under ~100ms (one build pass per wave), a
fling paints as 1-2 visible waves instead of a trickle, and
screen-completion (the p90, which is what the eye keys on for a full
viewport) lands near ~200ms. If perception STILL doesn't move, the
remaining lag is not in this pipeline — it is content-vs-badge timing
on QuickBase's own swap plus the teardown dip: go to step 4.

## Drill round 4 (2026-07-04, snapshot 00-10) — the burst starved
## discovery; separate the priorities

Half the prediction landed hard: claimed_to_shown p90 205 → **54**,
attached_to_shown p90 **128**, band_to_claimed p90 16, and the
stability ring shows painted == wrappers throughout with shown
oscillating ±15 — the build backlog and (on this evidence) most of the
CHURN DIP are gone. The other half inverted: dom_seen_to_attached p50
45 → 267, p90 302 → **2826**. Discovery starved.

Cause — self-inflicted: the prime path's claim flush runs in each
drain slice's MICROTASK TAIL, and that flush builds synchronously
(onCodewordsChanged → reconcile → badgeNewlyCodeworded). At the new
120ms burst budget, every 32ms walk slice became a ~180ms composed
task; discovery throughput collapsed and the root backlog sat for
seconds. (Round 3 had the identical structure with a 32ms tail — which
is why it was survivable then and why this only surfaced now.)

Fix (Part 1e) — priority separation, not budget re-tuning. The
priority order that matters perceptually is: discovery (enables
everything, and is cheap) > on-screen build > off-screen band
pre-build (invisible prefetch). So:

- **Drain slices go walk-only again.** The prime still queues claims
  and the microtask flush still grants them (local reservoir, ~1ms —
  tClaimed stays instant); what leaves the tail is the BUILD.
- **Storm-path build triggers route through the single-flight
  continuation** instead of calling reconcile()'s synchronous build:
  `onTrackerCodewordsChanged` and the band sweep call a storm variant
  (refreshViewportClaims + scheduleBandBuildContinuation). At most ONE
  120ms build task exists at a time, FIFO-interleaved with walk
  slices; it drains every claim accumulated across the slices since
  the last burst, on-screen unbudgeted first (runBuildPass ordering,
  unchanged). Non-storm callers (scan path, nav/alphabet, settle
  repair, label-sync catchup, confirm-rejected) keep the synchronous
  reconcile() — they are one-shot converge points, not per-slice
  storms, and some (showHints) depend on build-before-paint ordering.

Cost of the separation: on-screen badges wait one yield hop (~1-5ms)
for the continuation task instead of building in the flush microtask.
Nothing else moves.

Prediction for drill round 5: dom_seen_to_attached returns to round-3
shape or better (p50 ≤ 50, p90 ≤ 150 — walk slices at full duty),
claimed_to_shown holds near round 4 (one burst per accumulation), so
dom_seen_to_shown p90 finally lands ~200-300ms with the dip staying
shallow. That is the whole Part-1 story with no stage left to blame;
perception unchanged after THAT means QuickBase's own swap timing —
measure content-paint-to-badge directly before touching anything else.

## Drill round 5 + Rango A/B (2026-07-04) — the wave must reveal as one

Round 5 numbers: pipeline converged. dom_seen_to_attached p50 26 / p90
32, dom_seen_to_shown p50 139 / p90 328 — 4x the baseline, all stages
individually healthy. User perception across all five rounds: flat.
Then the decisive re-run of the Rango A/B on the same grid: Rango is
near-instantaneous to the eye; BranchKit is visibly INCREMENTAL — the
user watches badges load in stages, including a second visual phase
where translucent (bk-pending) badges solidify.

The A/B kills the QuickBase-content-timing hypothesis (Rango sees the
same DOM at the same moments) and isolates the remaining gap as
REVEAL SHAPE, not latency: our wave lands as 4-6 micro-pops (per-burst
paints spread across p50 139 → p90 328, then ACK-driven opacity
flips), Rango's lands as ONE unbudgeted batch behind a 100ms trailing
debounce, born fully opaque. The eye reads one pop as instant and
staged arrival as loading, at similar total latency. This is the
wave-hold reveal the original note deferred with "revisit only if the
eye still reads ripple" — the eye reads ripple.

Part 1f — wave-atomic reveal:
- `HintBadge.show(grammarReady, staged)`: staged paint does everything
  today's show does (colors, placement, accel, the rAF `.visible`
  flip) plus a `bk-staged` class that holds opacity at 0. CSS rule
  ordered after `.visible` and `.bk-pending` so it wins both;
  `reveal()` removes it and the existing 0.12s opacity transition
  produces the Rango-style fade-in pop. `hide()` and unstaged `show()`
  clear the class (a released-then-reshown badge must not strand
  invisible).
- Only `prepareBadge` (the churn build path) stages. First paint
  (showHints), settle re-shows, and pointer/visibility rechecks keep
  the direct show — they are batch-shaped or single-badge already.
- Wave manager in content.ts: staged wrappers accumulate;
  trailing-quiesce timer (WAVE_REVEAL_QUIESCE_MS = 80, reset per build
  pass) + non-extending deadline (WAVE_REVEAL_MAX_WAIT_MS = 250, armed
  at first stage) — the whenDOMSettles debounce+deadline shape, both
  session-owned timeouts. Reveal = one loop of class removals (style
  writes only, one recalc). A lone badge on a quiet page pays ≤80ms —
  imperceptible.
- bk-pending absorption for free: the grammar-ACK sync debounce
  (~80ms) mostly lands inside the hold, so `markGrammarReady` strips
  bk-pending BEFORE reveal — badges are born solid like Rango's, and
  the two-phase translucent→opaque artifact the user called out mostly
  disappears.
- Honest metrics: `tFirstShown` stamps at REVEAL for staged badges
  (not at show), and the paint_stability sampler counts a staged badge
  as not-yet-shown (`isStaged` getter) — the ring keeps measuring what
  the eye sees, which is the entire lesson of this arc.

Prediction for drill round 6: a fling paints as 1-2 solid pops
~150-250ms after each swap wave, no visible trickle, no translucent
phase; the ring's fill slope becomes near-vertical steps. If the eye
STILL reads it as slower than Rango after that, measure the pop
timestamps against Rango's on video before touching anything else.

## Drill round 6 (2026-07-04, firehose) — the pop works; the blink is
## the teardown; Part 2 promoted to NOW

User: saw a pop, then it DISAPPEARED — jarring; overall feel similar.
Firehose: wave:reveal fires with big atomic sizes (212/240/220/116 —
the reveal works), but each reveal is followed within ~200-500ms by a
churn cycle — band_sweep:changed ~117 → reconcile:stale_false_repair
~106 → a second reveal. The atomic reveal made BOTH edges crisp: POP in
(the wave), BLINK out (recycled rows' limbo badges mass-destroyed by
the finalize sweeper + band flags flapping out/in), POP again (the
rebuild). Every diagnostic now converges on the teardown side, so Part
2 (slot rebind) is promoted from "queued pending probe" to the fix —
its rebind_slot counter IS the probe (fails safe to today's behavior if
the shells die with the rows).

Landed alongside it, from the same firehose signature:
- **Two-strike sweep release** (temporal hysteresis): a virtualizer can
  transiently park a recycling shell at odd coordinates, and a single
  out-of-band gBCR then releases + hides a badge that is back in-band
  by the next sweep — the release/repair oscillation above. The sweep's
  destructive direction now requires out-of-band on two consecutive
  sweeps (~100ms apart); entries still repair immediately. WeakSet
  ledger, cleared by any in-band sighting.
- **Slot-anchor stop-list** (caught by a unit test): recording must
  never anchor on body/html/table/tbody/thead/main or role
  grid/treegrid/rowgroup — those span many slots and survive every
  swap, so a unique element removed in one place could steal onto a
  unique same-kind element added anywhere under the shared container.
  The two ambiguity gates can't see that case (both sides look unique
  locally); the stop-list makes it structurally unreachable. Recording
  is depth ≤6, nearest-first, through at most the first tr/role=row.

Prediction for drill round 7: rebind_slot climbs and refuse_no_match
collapses on the grid (the probe answers itself); recycled cells keep
their badge and letter through the swap — no blink-out, no second pop;
the ring's shown floor rises (dip ≤ ~10-20). If rebind_slot stays ~0,
the shells die with the rows and the blink needs the deferred
ghost-handoff idea instead — measure before building it.

## Drill rounds 7-8 — honest stamps, dead shells, and the starved pool

Round 7: rebind_slot stayed 0, and the reveal-time stamps finally
agree with the eye — dom_seen_to_shown p50 **1327ms**. The 139ms of
round 5 was stamping hidden paints that churned away before ever being
visible. The true disease, stated plainly at last: a badge on this
grid cycles build → teardown → rebuild 2-4 times over ~1.3s before one
sticks. Landed the slot_probe refusal classifier + limbo slot-liveness
counters rather than guess again.

Round 8, the probe's verdict:
- **limbo_slot_liveness: alive 0 / dead 441.** QuickBase replaces
  whole row subtrees; no recorded ancestor ever survives. Slot rebind
  is structurally impossible HERE (the tier stays — fails safe, and
  other grids do swap in place).
- **slot_probe.pool_empty: 365 of 837 attempts.** The deeper unlock:
  when replacements are discovered, the dead content often isn't in
  limbo yet — the discovery drain runs on a fast yield task that beats
  the removal records' processing, so EVERY rebind tier sees an empty
  pool. And the tier that should win on this grid is the existing
  FINGERPRINT tier: a window shift re-renders the currently-visible
  rows with identical content (same records, fresh DOM) — matching
  fingerprints by construction. refuse_no_match 202 / rebind_clean 0
  is that tier starving, not failing.

Fix (round 8): **feed the limbo pool before walking** —
dropDisconnectedWrappers() at the top of drainDiscovery and
discoverInSubtreeBatched. isConnected is DOM ground truth regardless
of MO delivery order; the call is idempotent with the removal path and
O(store) pointer checks. With the pool fed, same-content remounts
fingerprint-rebind: badge, letter, and grammar ride through the window
shift, and the blink dies exactly where the user is looking.

Prediction for drill round 9: rebind_clean/rebind_position climb,
refuse_no_match and slot_probe.pool_empty collapse, claimed_to_shown
(now eye-honest) drops from 648/1327 toward the reveal cadence, and
the ring's shown floor rises. Remaining after that: rows whose records
genuinely changed (window edges) still rebuild — correct behavior; if
their pop still reads slow, that residual is the true fill cost and it
is already burst-shaped.

## Drill round 9 — insert-before-remove, and the nulled strong keys

The pool-feed did nothing: pool_empty unchanged at 365, eye-latency
still ~1.3s. That falsifies "removed but unprocessed": at discovery
time the old rows are STILL CONNECTED — QuickBase inserts the new
window before removing the old (double-buffered swap). No limbo-timing
fix can help; the pool is genuinely empty when replacements appear.

The tier built for exactly this is the strong-key TAKEOVER
(tryRebindByStrongKey handles connected predecessors — ping-pong guard
and all), and the snapshot shows why it never fires on the grid:
record anchors carry stable hrefs (`?a=dr&rid=23`) but each row links
the same record from SEVERAL COLUMNS, so raw-href keys collide
row-wide and collectStrongKeyIndex nulls every copy as ambiguous.
rebind_key frozen at 44 (sidebar) across nine rounds was this exact
signature, visible since round 1 and only now legible.

Fix: **cell-context strong keys.** computeStrongKey appends the
nearest td / role=gridcell class to the href key (bounded 6-hop walk,
stops at the row). Same href in different columns → distinct unique
keys → the takeover tier fires for the whole grid: on discovery of a
replacement anchor, the still-connected predecessor's wrapper —
badge, letter, grammar entry, grammarReady — re-anchors onto it, and
the old element dies unobserved when QuickBase removes it. Symmetric
by construction (index side and match side each read their own
connected element's cell). Anchors outside any cell keep the raw-href
key: duplicate nav/content links stay ambiguous-null, today's safe
behavior. Buttons/labels/inputs in recycled rows (~⅓ of grid wrappers)
have no strong key and still rebuild — smaller residual, measure
before chasing it.

Prediction for drill round 10: rebind_key jumps from 44 to hundreds
per fling; refuse_no_match collapses; the eye-honest dom_seen_to_shown
falls hard for the anchor cohort (never torn down at all); visually,
record-link badges hold position and letter through window swaps.

## Drill round 10 — the elephant: our own nav rescans, five per fling

rebind_key moved 44 → 87 (the takeover fires; partial overlap between
windows caps it — a fling's destination records are mostly new, and
THOSE genuinely need fresh badges). Eye numbers flat. Then the
firehose, read with wall-clock timestamps, surfaced two things the
page-relative breadcrumbs had been hiding:

1. **Multiple frames interleave in the log** (pendo widget,
   about:blank children) — earlier timeline reads averaged two
   pipelines.
2. **QuickBase writes a pagination offset into the URL as you scroll**
   (`…/action/td?skip=0`). webNavigation reports every tick as a
   history-state update, the background dispatches spa_nav, and
   rescanForNav ran its FULL body — drop_disconnected + syncNow +
   document-wide doScan + wholesale showHints — FIVE TIMES IN FIVE
   SECONDS, overlapping, in the middle of the swap storm. The
   spa_nav machinery exists for real route changes (YouTube
   watch→watch); for a scroll-driven query tick it is pure
   self-inflicted load at the worst possible moment, and it has been
   running during every drill of this arc.

Fix: **defer mid-scroll spa_navs to scroll settle.** The naive
discriminator (query-only URL change = cosmetic) is WRONG — YouTube's
watch→watch navs are query-only and need the heavy path. The correct
one: a user cannot click-navigate mid-fling, so a spa_nav arriving
while scroll events are streaming (scrollRepositionTimer armed) is
in-page state. It parks (latest args win) and fires once right after
runSettlePipeline at settle. Real navigations are never mid-scroll and
keep today's immediate path — the wedge fixture (YouTube spa_nav, no
scrolling) exercises exactly that unchanged branch.

Prediction for drill round 11: at most ONE rescan per fling, after
settle; the mid-fling wholesale re-show cycles disappear from the
firehose; the ring's mass sag (shown 670→225 with painted flat —
badges HIDDEN en masse, not destroyed) shrinks to the swap-diff
cohort. Whatever eye-latency remains after this is the true refill
cost of genuinely-new windows.

## Drill round 11 — the tick arrives at THEIR settle; audit the swap
## instead of the clock

The mid-scroll deferral never fired: QuickBase updates ?skip=N at ITS
OWN scroll settle, so the spa_nav lands after our scroll timer has
cleared and the full rescan still chased every fling (913ms-3.2s
deferred document scans in the round-11 firehose), re-churning a badge
population the incremental path had just converged. Eye numbers flat
(p50 1342, dip 291).

Replacement discriminator — measure the thing the rescan exists to
fix, not the clock: at deferred-tail time, the STORE'S DISCONNECTED
FRACTION says whether the DOM wholesale-swapped out from under the
incremental machinery. A real route change (YouTube watch→watch)
arrives with old wrappers massively disconnected → heavy path
unchanged. A pagination tick arrives after the incremental rebuild →
~fully connected → light path: reconcile() + schedulePassSoon(), no
document walk, no wholesale showHints. Threshold 25% disconnected;
O(store) pointer reads; breadcrumb deferred_scan:light vs :start
audits every decision. The 2026-06-12 "claims trickled without doScan"
soak-fear is superseded by prime-at-attach (bulk claims now land
inline at attach) — recorded in the code comment at the decision
point. The mid-scroll deferral stays (it is correct for grids that
tick the URL DURING scroll; it just is not this grid).

Prediction for drill round 12: firehose shows deferred_scan:light on
every post-fling tick (no 913ms-3.2s walks, no wholesale re-show);
what remains of the eye latency is the genuine refill of new-record
windows — claimed_to_shown ≈ build throughput of a ~400-badge wave
under page contention, currently ~630ms p50. If perception still
reads laggy at that point, the remaining fight is per-badge
construction cost vs Rango's (they pay no claim/voice/strict layers),
and it should be fought with a CPU profile, not more scheduling.

## Drill round 12 — light path live; the residual is the non-keyed
## cohort's double-render blip

The audit path works: the grid frame took deferred_scan:light, the
multi-second post-fling walks are gone, rebind_key doubled again
(87 → 187 — record-link badges genuinely ride through swaps), and the
eye-honest dom_seen_to_shown HALVED (p50 1342 → 920; refuse_no_match
202 → 162; dip floor 225 → 277). User perception matches: the
wholesale lag has collapsed into "a little blip — painted,
disappeared, painted again."

The blip's mechanism: the cohort with no strong key — checkboxes,
buttons, labels, ~⅓ of grid wrappers — cannot take over across
QuickBase's two-phase render. Their badges paint on the interim DOM,
the final render replaces those elements, limbo freezes the badge
250-500ms, finalize destroys it (the disappear), the replacement
paints (the second paint). Same-fingerprint position rebind should
catch these (identical content, ~same spot) but scores 0 — lastRect
is stale mid-storm, past the 50px tiebreak threshold.

Candidate fixes, deliberately NOT implemented pending review — the
arc has 17 unpushed commits and the remaining artifact is cosmetic,
not lag:
1. **Row-scoped takeover keys for non-anchors** — needs a stable row
   identity (does tr.gridRow carry a record-id attribute?). Verify on
   the real DOM before designing; if rows have no identity, this is a
   dead end like slot rebind was.
2. **Refresh lastRect at limbo entry from the live sweep** — the
   two-strike sweep already reads geometry at 10Hz; feeding fresher
   rects into limbo would revive the EXISTING position tiebreak for
   the identical-content remounts. Small, uses live machinery, no new
   identity scheme. Likely first choice.
3. **Accept**: the blip is one cycle per swap on a minority cohort.

## Round 13 — the Rango-parity cut: stop being polite

User-approved strategy change after round 12's numbers finally matched
the eye (~920ms p50 vs Rango's ~150-250 feel). Twelve rounds of
raising budgets (4 → 12 → 48 → 120ms) won every time without taking
the last step; the remaining structural difference was named in this
note's first causal decomposition and never acted on: Rango does ONE
synchronous unbudgeted blast per mutation wave; we split the same work
across walk slices, yield hops, build bursts, and a reveal hold — and
every yield donates the thread to 30-100ms of the page's own swap
rendering. Politeness multiplies wall-clock 3-5x under contention.

Why we were polite: scar tissue. The budgets cured real disasters —
Firefox froze 1.1s on a synchronous full-body walk (YouTube SPA nav),
22% sustained CPU tripped the slow-extension warning, the nav-time
wedge. Those cures were right for pathological DISCOVERY walks and
wrong as a general pacing philosophy for build/paint.

The cut (one commit, one revert):
- WAVE_WALK_BUDGET_MS 32 → 200, WAVE_BUILD_BUDGET_MS 120 → 500 —
  circuit breakers, not pacing. A realistic wave (even a ~400-badge
  full-window swap, 150-400ms) completes in ONE task.
- reconcileStorm deleted; onCodewordsChanged and the band sweep call
  reconcile() synchronously. Safe against the round-4 discovery
  starvation because the walk completes ALL pending roots before the
  build runs in the same task's tail — the round-4 failure was inline
  build per SLICE, not inline build per completed wave.
- The wave-atomic reveal hold deleted (stage/reveal/bk-staged, the
  80/250ms timers, the sampler exclusion): once each wave builds in
  one task, the task IS the pop and the hold was pure latency. Badges
  paint instantly TRANSLUCENT (bk-pending) and solidify on the grammar
  ACK ~80ms later — the user explicitly wants this Rango-like shape
  ("badges just appear with each element"). tFirstShown stamps at the
  (now immediately visible) show — still eye-honest.

Kept, untouched: the huge-mutation path (the actual YouTube freeze
protection), prime-at-attach, the symmetric two-strike sweep,
cell-context takeover keys, the rescan swap-audit, slot machinery +
probes, wedge discipline (the deferred-remainder chain still exists
behind the guardrails).

Prediction for drill round 14: content-to-badge in the 150-300ms range
on the grid; the painting no longer reads as a process. Cost accepted
with eyes open: a ~400-badge swap is one 200-400ms main-thread task
during frames the page is already dropping — exactly Rango's trade,
which the A/B showed the page tolerates. If Firefox's slow-extension
warning or input-latency complaints appear on other sites, the
guardrails are the tuning point (lower them), and `git revert` of this
commit restores the polite pipeline wholesale.

## Drill round 14 — the cut landed; the residual is a discovery
## straggler cohort

The Rango-parity cut worked where it aimed: claimed_to_shown p50
652 → **32ms** (p90 132), dom_seen_to_shown p50 **229ms** (the target
range), rebind_key 217, and the paint_stability ring shows NO dip for
the first time in the arc (shown holds 366-396 through the whole
trail). The user still reads it as slower than Rango — because
dom_seen_to_attached has a monster tail: p50 70ms but p90 2535 / max
6064. The median badge is Rango-fast; a ~10-15% cohort waits SECONDS
for a wrapper, and the eye keys on screen-completion, not the median.

The cohort's signature: one band_discovery:added size=49 at the next
scroll settle — 49 elements the MO path missed entirely, rescued only
by the scroll-settle sweep. Consistent mechanism: QuickBase renders
the incoming window hidden and flips it visible via a class change,
which is invisible to our MO (class is deliberately not in the
attributeFilter) and produces no settle signal of its own.

Fix: **every settle kind arms the band discovery sweep** (the
'band'-vs-'store' discovery split assumed non-scroll settles only
reveal existing wrappers — false on double-buffered grids). The
mutation burst around the flip lands a 'store' settle within ~100ms,
so the straggler window collapses from seconds to ≤~600ms. Sweep is
single-flight + idle + isKnown-skipping; steady-state cost ~nil.

Prediction for drill round 15: dom_seen_to_attached p90 falls from
2535 to ≲700ms, dom_seen_to_shown p90 follows (was 2556), and
screen-completion stops trailing the median. If the eye still reads
slower-than-Rango at THAT point, the residual is the ≤600ms straggler
window itself — the next lever would be class/style-aware reveal
detection (a debounced coarse signal, carefully rate-limited), which
should be designed, not rushed.

## Round 15 + THE FRAME-LEVEL VIDEO A/B (2026-07-04) — the arc's ground
## truth; read this section before anything else in this note

Round-15 snapshot: every stamped stage converged (dom_seen_to_shown
p50 116 / p90 225, attached_to_shown p90 178 over ALL 549 shown,
no ring dip). User still felt no difference. The user then recorded
both extensions at 60fps on the production grid
(~/Documents/Screen Shots/branchkit_scroll.mov + rango_scroll.mov;
working copies were at /tmp/badge-ab — re-copy if gone; Terminal
lacks TCC permission on Documents, cp with sandbox disabled worked).
Frame-by-frame analysis is the arc's final authority:

- QuickBase blanks the grid to a WHITE VOID mid-fling; rows repaint
  all at once. That repaint is the shared zero for both extensions.
- **Rango: rows → full SOLID hint population in ~0.4-0.5s. One wave.**
- **BranchKit: rows → ~4 translucent link badges instantly (the
  takeover survivors — that path works) → NOTHING for 2-3.5s → the
  entire main population (checkboxes, pencil/eye buttons) plus
  solidification in one late wave.**

The FIFTH and decisive instrumentation deception: dom_seen is stamped
ONLY on the MutationObserver path. 225 of 549 shown wrappers (41%) —
exactly the late cohort, discovered by fallback sweeps — carry no
stamp and silently drop out of every dom_seen percentile. The good
numbers were a survivorship-biased sample of the fast path.
attached_to_shown p90 178 across all 549 proves everything DOWNSTREAM
of discovery is genuinely Rango-fast now. The one remaining problem,
stated precisely: **MutationObserver-driven discovery misses ~40% of
freshly inserted row content, which is then found only by settle
sweeps seconds later.**

Next steps (the handoff):
1. **Kill the metrics bias first**: tag every wrapper with its
   discovery source (mo | band_sweep | settle_sweep | scan | rescan |
   attr), stamp a dom_seen-equivalent on every path, and surface
   per-source counts + latency in the debug snapshot. Every
   subsequent drill becomes trustworthy.
2. **Diagnose the 40% miss with that data.** Leading suspects: (a)
   the elements are not hintable at insertion (hintability hydrated
   later via class/style-driven changes the MO attributeFilter
   deliberately ignores — pencil/eye are hover-action-bar-shaped);
   (b) subtreeMaybeHintable pre-filter drops their subtrees at drain
   time; (c) they are inserted as text/fragment mutations the
   `node instanceof Element` gate skips.
3. Procedural: confirm the extension was RELOADED after build
   f64a5fd before trusting any new video (the A/B clips may predate
   round 15's settle-sweep fix — the 2-3.5s could already be
   partially addressed).

Everything else in this arc landed and holds: prime-at-attach,
symmetric two-strike sweep, cell-context takeover keys, spa_nav
storm deferral + swap-audit light path, the Rango-parity unbudgeted
hot path, no dip. Post-discovery latency is not the problem anymore.

## Round 16 — kill the survivorship bias: discovery-source tags +
## universal dom_seen (2026-07-03, landed; drill pending)

Handoff step 1, landed:

- **Every wrapper is tagged with its discovery source**
  (`ElementWrapper.discoverySource`, stamped by `attachWrapper`): `mo`
  (drainDiscovery walk), `mo_huge` (huge-mutation coarse full-body
  refresh — QuickBase's ≥1000-record bursts land here, so it gets its
  own bucket), `band_sweep` / `settle_sweep` (the discovery sweep, by
  which settle kind armed it), `scan` / `rescan` (doScan: boot &
  storage/activation vs the nav tail), `attr` (attributeFilter
  reevaluation), `shadow`, `attention`, `visibility`
  (pending-visibility promotion). Rebinds keep the original tag —
  identity survival is not a discovery.
- **dom_seen is universal.** `attachWrapper` resolves the MO stamp as
  before; when none resolves it falls back to `tAttached`, and
  `domSeenByMo` records which case. No wrapper drops out of a
  percentile again. For a NON-MO-source wrapper WITH a real MO stamp,
  `tAttached - tDomSeen` is the MO path's miss window itself.
- **Snapshot surface** (`wave.discovery_sources`, 90s window): per
  source — attached/shown counts, `mo_stamped`, and
  dom_seen_to_attached / dom_seen_to_shown / attached_to_shown
  percentiles. Plus `wave.attached_by_source` (lifetime counts),
  `wave.mo_text_only_add_records` (childList add records whose
  addedNodes held only non-Element nodes — the `instanceof Element`
  gate skips these wholesale; suspect (c) tripwire), and
  `wave.invisible_candidates_observed` (walk-reached-but-invisible
  handoffs to the attention observer).

How the next drill's snapshot discriminates the suspects — the late
cohort's source tag + mo_stamped split is the whole diagnosis:

| signature | meaning | fix territory |
|---|---|---|
| sweeps/`mo_huge` with mo_stamped ≈ cohort, `invisible_candidates_observed` large | MO saw the subtree; walk classified content invisible at insert (hidden buffer) and the attention/visibility promotion lost the race to the sweep | promotion path latency (attention IO starvation mid-fling), NOT the attributeFilter |
| sweeps with mo_stamped ≈ cohort, `invisible_candidates_observed` ≈ 0 | MO saw the subtree; walk never yielded the elements (selector non-match at insert — hintability attrs arrive later) | check `attr` counts; if attr also ≈0 the hydration uses non-filtered attrs/classes → reveal-detection design |
| `attention`/`visibility` dominate the late cohort | promotion machinery works and IS the slow path | same as row 1: starved IO delivery, promote cadence |
| sweeps with mo_stamped ≈ 0 | MO never got a usable record for any ancestor | `mo_text_only_add_records` high → suspect (c); else observer-level gap (shadow, frame) |
| `scan` dominates no-stamp | round-15's 41% partly boot-scan wrappers, not the late cohort — the old no-stamp≡sweep-found inference was itself biased | re-read the video timing against per-source numbers |

Static facts pinned while wiring this (they narrow the suspects
before any drill): `subtreeMaybeHintable` is a pure selector match —
no visibility read — so a hidden row full of buttons/links PASSES the
pre-filter; suspect (b) as originally stated can only bite via
selector non-match, not hiddenness. HINTABLE has no class terms, so a
class flip can never change matching, only visibility — which routes
to invisibleCandidates → attention → promotion, all of which existed
before this round but was invisible to the metrics. EXCLUDE
(`aria-hidden/disabled/inert`) matches the element only, not
ancestors — a hidden-buffer CONTAINER doesn't exclude its descendants
from the walk.

If the data lands on class/style-driven reveal as the mechanism, the
fix must be designed here first (the attributeFilter exclusion exists
because class-churn reevaluation was a top CPU bucket): the shape to
evaluate is NOT adding class to the page-MO attributeFilter but either
(a) making the already-class-watching visibilityMO's promote path
cover the miss (it watches document-wide class/style at rAF promote —
why doesn't it fire? that's what invisible_candidates_observed
answers), or (b) a bounded per-root "dud subtree" watch: a drained
root that yielded 0 hintables despite ≥N selector matches gets a
scoped attributes-MO for a bounded window, reveal → rediscover that
root only. Decide on data, not vibes.

## Round 17 — the drill's verdict: the miss is real but the LAG is the
## sweep's own yield starvation (2026-07-04)

Drill on build 02:49 (round-16 instrumentation live). User report:
badges flash on ~1.5s after the fling, disappear suddenly, repaint
2-3s later. The new data explains all three beats:

- `wave.discovery_sources`: settle_sweep cohort n=173,
  dom_seen_to_attached p50 **3078ms** (the late wave, measured
  directly). Split by tag: 115 anchors (78 MO-stamped — MO saw their
  subtrees ~3s before anything attached them) + 55 buttons/inputs
  (the pencil/eye/checkbox wave, **zero** MO stamps).
- `invisible_candidates_observed` **11,505** against **zero**
  attention/visibility attaches: the walk reaches the hidden incoming
  window at insert, classifies it invisible, parks it — and the
  IO-gated promotion path never wins a single race. Discrimination
  table row 1.
- `mo_text_only_add_records` = 9 — suspect (c) is dead.
- `mo_huge` never fired: QuickBase's swap arrives in sub-100-record
  batches (the firehose ≥100 gate shows only our own badge churn
  during the storm — the page's own mutations are all below it).
- paint_stability ring: shown 560 → 373 → 396 while painted barely
  moves. The BLINK is a mass hide, not teardown — QuickBase's white
  void makes targets CSS-invisible and the visibility plan correctly
  hides their badges. Not a bug; its perceived cost shrinks when the
  late wave lands sooner.

The wall-clock tell (actuator.log, fling 2): reveal at page-ts 16561
(`reconcile:stale_false_repair size=106` — the settle pass flipping
band flags the moment content gains geometry; that repair IS the
first pop). Then SEVEN `band_discovery:coalesced` while one sweep
stays in flight from ~16561 to **20528**, finally landing
`band_discovery:added size=76` — the second paint. Even the
steady-state added=0 sweeps take ~450-600ms wall each.

Root cause of the 3-4s: `discoverInSubtreeBatched` yields between
batches with `await setTimeout(0)` — ~45 batches on this grid
(680 elements / batch 15), and mid-storm each setTimeout(0) hop
queues BEHIND the page's pending work, costing 50-150ms. 45 × ~90ms
≈ the whole late wave. This is byte-for-byte the round-3 discovery
starvation (rAF entry → yield task); the sweep just never got the
same fix.

Fix (this round): the sweep's inter-batch yield becomes
`scheduler.yield()` (front-of-queue resume, ~1-4ms) with the
session-owned setTimeout(0) fallback — an awaitable sibling of
`scheduleYieldTask`, same isTornDown discipline. Batching (the actual
freeze protection) is untouched; the huge path shares the speedup,
which is the round-13 posture (one fast wave, guardrails not pacing).
Expected: sweep wall ~4s → ~300-600ms mid-storm (idle-gate ≤500ms +
walk), late wave lands ≤~1.2s after reveal; steady-state sweeps drop
to ~50-100ms.

NOT changed, deliberately:
- The retry-on-coalesce logic (retry only when added=0): a reveal
  landing mid-sweep whose walk already passed that region still waits
  for the next settle — with fast sweeps that window is now ~sweep
  length, and post-reveal paints generate store settles anyway.
  Loosening it re-arms the 73cf6e7 churn loop; leave the scar tissue.
- The attention/visibility promotion path: still zero-yield on this
  grid (starved IO mid-storm + interim nodes dying in the two-phase
  render). With the sweep fast, promotion becomes redundant here
  rather than broken. Revisit only if a page shows reveals with NO
  accompanying settle signal.
- attributeFilter: untouched. The reveal detection question is moot —
  the reveal already produces a settle (the mutation burst around the
  flip), which already arms the sweep. The signal was never missing;
  the response was slow.

Open after this round: the 55 no-MO-stamp buttons/inputs. Their
ancestors produced no usable MO record within 40 hops — not
text-only records (n=9), not the huge path (never fired). Candidate
explanations: stamps living on roots >40 hops up, or insertion
records for subtrees whose added root is long-lived (content built
via moves that only record the moved intermediate). The per-wrapper
discovery blocks in the next snapshot can chase this; it matters
only if the fixed sweep still reads slow for that cohort.

## Round 18 — round-17 verified; the last deliberate lever: fast-arm the
## mass-reveal sweep (2026-07-04)

Drill on build 03:08 (round 17 live). User: still sees the flash, the
landing "maybe a little quicker but hard to tell" — matching
prediction. The data confirms round 17 did what it claimed:

- No multi-second sweep anywhere in the trail (was one 4s in-flight
  window). Storm-window sweeps complete in ~100-400ms; steady-state
  ~350-400ms wall.
- The late-cohort signature collapsed: settle_sweep MO-stamped
  stragglers 78 → **2** (dom_seen_to_attached n=2 at ~6s, residue).
  settle_sweep attached_to_shown p50 34ms.
- Knock-on: mo-source dom_seen_to_attached p90 549 → **40ms** — the
  sweep no longer monopolizes the queue, so the MO drain path itself
  runs at full duty.
- Ring in the captured trail: shown 393-411, no deep dip.

What remains between QuickBase's reveal and the final population,
measured: 100ms settle debounce (load-bearing coalescing, stays) +
**up to 500ms idle gate** before the sweep body runs (mid-storm rIC
never fires, so it is a flat +500ms) + ~100-400ms walk + ~35ms
attach→shown. Total ~0.7-1.0s — consistent with the user's read.

The lever: the idle gate is scar tissue from when sweeps were
expensive walks; with the walk yield-chained it protects nothing on
exactly the sweep the user is watching for. And the settle pass
already KNOWS when a mass reveal happened — its own plan just
repaired ~100+ stale-FALSE band flags (measured 106/119/166 at the
flip; incidental repairs run 1-17). So: `runSettlePipeline` passes
`toRepair.length` to `scheduleBandDiscovery`; ≥25 repairs
(`REVEAL_REPAIR_FAST_ARM`) schedules the sweep body on the yield
chain instead of `runWhenIdle`. Breadcrumb
`band_discovery:fast_arm` carries the count. Retries keep the idle
path (race backstops, not reveal-urgent). Coalesce/single-flight
semantics unchanged.

Expected: late wave lands ~0.3-0.5s after the reveal — Rango's own
video-A/B number. Past this, the floor is QuickBase's white void and
two-phase render, which every extension pays; declare the arc done on
perception parity and chase the 55 no-MO-stamp buttons/inputs only if
a drill still reads slow.

Revert lever: delete the fast-arm branch (one `if` in
`scheduleBandDiscovery`) — restores idle-gated sweeps exactly.

## Round 18b — the swallowed fast-arm: mass-reveal reruns bypass the
## added===0 gate (2026-07-04)

Drill on build 03:17 (round 18 live). The fast-arm works when it
fires: boot reveal `repair 69 → fast_arm 69 → added 114` in **126ms**.
But the fling's big reveal (`repair 87` at ts 7338) produced NO
fast_arm — a sweep was already in flight, the single-flight coalesce
swallowed the urgency, that sweep landed `added 27`, and added>0
means no retry: the remaining 73 elements waited for the NEXT settle
and landed at ts 9455 — **2.1s post-reveal**. The round-17 note
called this window "~sweep length" and accepted it; the drill shows
it is the COMMON case here — QuickBase's reveal waves arrive ~600ms
apart, so a sweep is nearly always pending when the big repair lands.

Fix: `discoverySweepFastRerun` on the session. A coalescing request
carrying >= REVEAL_REPAIR_FAST_ARM repairs sets it; the in-flight
sweep's finally consumes it and re-arms immediately on the fast path,
REGARDLESS of added count. Explicitly not the 73cf6e7 churn loop:
that retried on a raceless heuristic per scroll settle; this consumes
an explicit mass-reveal signal, one-shot per set, and recurs only if
another >=25-repair settle lands during the next (isKnown-skipping,
~100-400ms) walk — which is sustained real content by definition.
Breadcrumb `band_discovery:fast_rerun` carries the prior sweep's
added count.

Expected at next drill: reveal → (in-flight sweep completes,
~≤400ms) → fast_rerun → walk → paint ≈ **0.5-1.0s post-reveal** even
when the reveal lands mid-sweep; fast_arm handles the clean case at
~0.15-0.5s. Remaining after that is QuickBase's own progressive
render (reveals themselves arrive in waves ~2s apart end to end).

## Round 18c — the walk's own reflow-per-batch; and clearing the
## hint-memory suspect (2026-07-04)

Drill on build 03:28 (18b live). Both urgency paths fire correctly
(fast_arm at every big repair; fast_rerun consuming the mid-sweep
case), MO-stamped stragglers 78 → 15, ring flat. Remaining number:
the sweep WALK takes 1.5-3.4s mid-storm (fast_arm ts 3536 →
added 41 @ 5059). The control that isolates it: the IDENTICAL
full-document walk at boot completes in **111ms** (repair 54 →
added 200 @ +111ms). Same code, 13-30x slower under the storm.

Mechanism: scanInBatches reads geometry per candidate; between
batches the sweep yields; mid-storm the page mutates during every
yield, invalidating layout, so each batch's first read forces a full
style+layout pass (~30ms on this grid). At batch size 15, ~680
candidates = ~45 batches = ~45 forced reflows ≈ the whole 1.5s+. At
boot nothing mutates between yields and the same 45 batches cost
~2ms each. **The batch count is the reflow count.**

User asked whether the hint-memory feature (limbo/fingerprint/
strong-key rebind, codeword recall) is the slowdown. Cleared with
data: its per-sweep cost is two O(store) index builds (pointer reads
+ bounded DOM walks, no layout) plus per-tier checks on genuinely NEW
elements only (~40-200/fling, not the 680 walked); the 111ms boot
walk INCLUDES attaching 200 wrappers through the full
rebind/registry/recall pipeline — sub-ms per element. It is also
net-negative cost: rebind_key take overs (~200-300/fling) are what
save teardown + re-claim + grammar churn through the swap.

Fix: `SWEEP_WALK_BATCH_SIZE = 60` for discoverInSubtreeBatched
(DEFAULT_SCAN_BATCH_SIZE stays 15 — it sizes the scan path's
per-batch grammar POSTs, which the sweep doesn't do). ~45 reflows →
~12; per-batch sync slab stays bounded (~60 warm reads + one reflow,
well under the wedge threshold). Expected mid-storm sweep ~400-600ms;
with fast_arm/fast_rerun that puts reveal→paint ≈ 0.5-0.8s worst
case, ~0.2-0.5s clean case.

If a future drill still reads slow, the next (design-worthy, not
quick) lever is reveal-SCOPED walking: the settle plan's toRepair
wrappers locate the revealed region, so the sweep could walk their
container subtrees instead of the whole document. Not attempted —
measure 18c first.

## Round 19 — the 30-60s drill: not discovery at all; the clip
## observer's reparent gap + the settle/strict-push oscillator
## (2026-07-04)

Drill on build 03:40 (18c live). User: the fling took 30-60s — "much
longer than normal". Supported, and it is NOT the discovery pipeline
(per-source stats were healthy: sweep cohort attached_to_shown p90
52ms). It was a self-sustaining loop, ~620ms period, running 80+
seconds:

- settle pass → `stale_false_repair size=9` (the same 9 flags every
  cycle) → `strict-viewport:delta 169` (the same re-push every cycle)
  → reposition 586 → repeat. Actuator side: **1383 plugin state
  writes in one second** at peak, 5.5k+ writes over the window.
- Snapshot mid-loop: **186 badges shown on-screen with clipped=true**
  (occludedBy split: 180 clipped-only + 6 both). The clip observer is
  misreporting at scale.

Root cause — the clip observer's DOCUMENTED residual gap
(clip-observer.ts staleness recheck): a reparent between two
still-connected scrollers kept the stale binding, because the check
was `boundRoot.isConnected` only. QuickBase's double-buffered swap
does that reparent at scale: rows render inside a hidden buffer
container, then MOVE into the live pane; both containers stay
connected. The IO stays rooted at the buffer → permanent
non-intersection → clipped=true on visible targets. Downstream:
(a) those ~180 targets drop out of the voice-matchable `_strict`
collection — painted badges voice cannot activate (a standing
correctness bug this likely explains beyond this grid); (b) the
oscillator: occluded → hide → membership churn → unobserve clears
clipped → strict flips → re-push → re-observe against the stale root
→ clipped=true again. Round 18's faster settle cadence made the loop
tighter and more visible; the seam predates the arc.

Fix: containment joins the staleness check —
`boundRoot.isConnected && boundRoot.contains(w.element)` — so a
reparented target re-roots to its real clipping scroller and the
fresh root's initial IO delivery corrects `clipped`. contains() is a
pointer walk, no layout; the bounded-to-churn per-settle cost is
unchanged. Unit test pins the two-connected-scrollers reparent.

Verify at next drill: the settle loop should die within a cycle or
two of the swap (no sustained `strict-viewport:delta ~169` trains in
the firehose), shown-but-clipped ≈ 0 in the snapshot, and — the
correctness half — previously unmatchable painted badges on this grid
become voice-activatable. If a loop persists, the remaining suspects
are the 9-flag geometry-vs-IO disagreement (clip-blind geometryInBand
vs the band IO) and the sync-success reconcile at label-sync:641 as
the loop motor; both are documented here for the next round.

VERIFIED (drill on build 04:09, snapshot 04-14): oscillator dead —
strict re-push trains 169/cycle → 5-9; write storms only at the
legit fling moments; clipping honest (201 shown-but-clipped, but
only 5 inside the viewport — the rest are scroll-ahead badges
genuinely outside the pane box; was 186 stale-clipped IN view);
the residual 9-repair/5-strict tick dies completely at quiet (zero
repairs after the drill). User: rows "painted one by one, but much
quicker." The one-by-one IS QuickBase's own progressive row render —
mo-source dom_seen_to_shown p50 129 / p90 303ms means each badge
lands ~130-300ms behind its row's DOM, i.e. content-speed. Remaining
non-blocking cleanups, recorded not scheduled: (a) the fling pushes
the whole population's strict flags ~3× (327 entries each, ~1k
writes/sec bursts for a few seconds — wasteful, imperceptible);
(b) the 9-flag repair flap while scrolling (geometry-vs-IO
disagreement, dies at quiet); (c) the 55 no-MO-stamp buttons/inputs
question is moot at current sweep speed.

## Round 20 — the last politeness tax: reveal sweeps walk in one slab
## (2026-07-04)

Drill on build 04:09 (round 19 live). User: "slower than Rango for
sure, but consistent." The consistency is round 19 (oscillator dead);
the slower-than-Rango is now measured exactly: the fling reveal's
fast-armed sweep took `fast_arm @ 3131 → added 52 @ 5251` — **2.1s**
— while the identical walk runs 158ms at boot. Batch-60 (18c) helped
less than predicted because the assumption was wrong: mid-storm an
inter-batch yield hop costs ~150ms (the page's own swap tasks run
between our slices), not ~30ms. Twelve hops ≈ 1.8s. The hop COUNT is
the wall-clock; shrinking per-hop work can't fix paying the storm per
hop.

Rango's number comes from paying the storm ZERO times: one
synchronous unbudgeted walk, one reflow. Round-13's lesson
("politeness multiplies wall-clock 3-5x under contention"), applied
to the one path that never got it: a REVEAL-armed sweep now walks
batches back-to-back in one task until REVEAL_SWEEP_SLAB_BUDGET_MS
(250ms), yielding only past the budget — circuit breaker, not pacing.
Idle-armed sweeps and the huge-mutation path keep per-batch yields
(background politeness is still right when nobody is watching).
Plumbing: discoverInSubtreeBatched(root, source, slabBudgetMs = 0);
fast_rerun re-arms pass the budget too.

Expected: reveal → settle (~100ms) → fast_arm → one ~150-250ms slab →
added → prime+build (round-13 fast) → paint ≈ **0.4-0.6s post-reveal
for the hidden cohort** — Rango's shape with our machinery. Cost
accepted with eyes open, same as round 13: one ~250ms task at swap
time, during frames the page is already dropping.

## Round 20b — the drill's two-scroll verdict: budget-edge failure +
## idle sweeps block the fast lane (2026-07-04)

Drill on build 04:24 (round 20 live), two scrolls. The slab works
where it completes: boot landed **251 adds in 112ms**, second page
load **185 adds in 21ms** — one reflow, warm reads, the round-16
population that once took 3-4s. But:

1. **Budget-edge failure (scroll 1).** The fling's fast sweep still
   took 2.2s (`fast_arm 119 @ 3199 → added 52 @ 5410`). Mid-storm the
   first geometry read pays a ~150ms forced reflow; the 250ms budget
   then expires a few batches in and the TAIL yield-hops through the
   storm at ~150ms/hop anyway — pays the slab's cost, forfeits the
   slab's win. Real one-slab cost mid-storm ≈ 300-500ms.
2. **Idle sweeps hold the lock (scroll 2).** The second reveal
   (`repair 110 @ 15118`) coalesced behind an in-flight per-batch-
   yielding IDLE sweep (the steady added=0 train, seconds long mid-
   storm) and was only served by fast_rerun at +1.45s. Background
   politeness on the idle path blocks exactly the sweep the user is
   watching for — single-flight makes idle-sweep duration everyone's
   queueing delay.

Fix (one change answers both): every band-discovery sweep — idle and
fast-armed alike — walks in one slab; SWEEP_SLAB_BUDGET_MS = 700 as a
true circuit breaker above the real cost, replacing the 250 edge
value. Entry scheduling still differs (fast_arm = yield task, idle =
runWhenIdle); only the walk shape is unified. The huge-mutation path
keeps per-batch yields (the actual Firefox-freeze scar). Worst-case
main-thread slab ≤~500ms during frames the page already drops;
steady-state quiet sweeps are one ~50-100ms slab.

Expected: both scrolls' hidden cohorts land ≤~0.7s post-reveal
(settle 100ms + ≤slab-length queueing + one 150-500ms slab), and the
firehose shows no added>0 event more than ~1s after its repair spike.

## Round 20c — prediction FAILED at 1.5-1.9s; stop turning the knob,
## attribute the lump (2026-07-04)

Drill on build 04:36 (20b live). Clean-shot chains at full parity
(boot repair 164 → added 270 @ +151ms; second load repair 69 →
added 114 @ +31ms). But the fling chains missed the ≤0.7s
prediction: repair 121 → added 52 @ **+1503ms** (was 2211), scroll 2
repair 81 → fast_arm @ +221 → added 44 @ **+1893ms**. Trajectory
improving, target not met, and the repair→added lump is no longer
attributable from existing breadcrumbs — it is some mix of (a) entry
delay before sweepBody runs (scheduler/idle queueing behind storm
tasks), (b) the walk genuinely exceeding the slab budget mid-storm
(dirty-layout reflow over a double-buffered ~2x DOM), and (c) the
claim-flush build burst riding the same task's microtask tail.
Different causes, different fixes; guessing burns drills.

This round adds ONLY attribution (no behavior change):
- `band_discovery:sweep_start` — fast_arm→sweep_start = entry delay;
  sweep_start→added = walk + builds.
- `band_discovery:slab_yield` (size = elapsed ms) — fires only when a
  slab blows SWEEP_SLAB_BUDGET_MS, so the drill says whether the
  mid-storm walk really exceeds 700ms or never yields at all.

Decision tree for the next drill's numbers: entry delay dominates →
the queueing/scheduling story (look at what task the yield waits on);
walk dominates with slab_yield firing → the dirty-layout reflow is
the cost, consider walking BEFORE the settle debounce or accepting;
sweep_start→added dominates WITHOUT slab_yield → it's the build
burst, and the sweep is exonerated entirely (round-13 territory,
different lever).

## Round 20d — THE ATTRIBUTION VERDICT: all three suspects acquitted;
## the content itself is late, and its arrival leaves no MO trace
## (2026-07-04, drill on build 04:44)

The stamps answered with a fourth option none of the tree predicted:

- Entry delay: fast_arm 130 → sweep_start **+207ms**. Fine.
- Walk: **zero slab_yield events all drill** — no walk ever exceeded
  700ms; sweeps complete in one slab.
- Build burst: sweep_start → added ~10-30ms on every observed sweep.
- The kicker: after the reveal repair, sweeps ran every ~400ms
  **finding nothing** (added=0 train), until one finally found the
  cohort. The pipeline was never slow this round — THERE WAS NOTHING
  TO FIND until ~1.5s after the reveal.

And the cohort's fingerprint deepens the round-17 no-stamp mystery
into the main event: of 214 sweep-attached wrappers (106 button, 93
a, 12 input, 3 textarea, 3 div), only **2** carry an MO stamp. If
these elements had been sitting in the DOM failing our
visibility/hintability gates, their subtree insertions would have
stamped them (like the 2 genuine stragglers: gaps 2209/4273ms) and
the walks/parks would show it. Instead: no insertion record our
document-level MO can see, not attr-path attaches (attr count 0 —
so not hydration via filtered attributes), not text-only records
(n=9), huge path never fires. As far as our instrumentation can
tell, ~200 interactive elements per fling MATERIALIZE ~1.5s after
the reveal without producing observable mutations, and only a
document walk finds them.

Candidate mechanisms for the next investigator, none verified:
stamps failing to resolve across >40-hop chains; insertion into
subtrees whose added root's WeakMap entry misses the walk (move
semantics?); elements matching HINTABLE only after unfiltered
attribute/class hydration in a way that skips every path we
instrument; or QuickBase genuinely building these controls that late
(in which case Rango cannot paint them earlier either, and the A/B
video's beat needs re-measuring). Discriminating these needs either
a targeted console probe on the real DOM (MO with NO filters on one
grid cell across a fling, logging every record touching a
late-cohort element) or a read of QuickBase's renderer behavior —
plus the Rango-source comparison: whatever the mechanism, either
Rango's criteria catch these elements in an earlier state, or its
apparent speed on this cohort is a measurement artifact.

The tuning arc ends here. Every pipeline stage is instrumented,
drill-verified, and at parity on content the MO can see; the residual
is a discovery-VISIBILITY question, not a scheduling one.

## Round 21 — the 20d verdict corrected: the "no-trace" cohort was BOOT
## content; the real stragglers ARE MO-stamped; Rango's edge is sensor
## class, not criteria (2026-07-04, snapshot re-slicing + Rango source +
## video re-measure; no code)

Three independent investigations — re-slicing the 20d drill's own
snapshot per-wrapper, a full Rango source read, and a frame-level
re-measure of the round-15 A/B videos — converge on a different story
than 20d recorded. No pipeline change is implied until the one open
question below is answered by a drill probe.

### 21a. The 20d cohort attached at t≈1.0s — page BOOT, not the fling

Round 20d read the 90s-window per-source aggregates
(`wave.discovery_sources`) and concluded ~200 elements materialized
mid-fling with no observable mutation. The same snapshot's PER-WRAPPER
stamps (2026-07-04T04-53-04, build 04:44 — the 20d drill) say
otherwise:

- The 217 settle_sweep wrappers (106 button / 93 a / 12 input /
  3 textarea / 3 div — exactly the note's "late cohort") ALL carry
  `t_attached` 998-1006: one sweep walk, **~1.0s after page load**.
  The user's drill is close+reopen-then-fling; t=1.0s is the initial
  render, 1.3s BEFORE the first fling mutation.
- The fling itself (t≈2322-6898) was discovered by the MO path: 418
  mo-source wrappers, dom_seen_to_attached p50 66 / p90 219, all
  stamped. The fling had NO unstamped sweep cohort in this drill —
  only the 2 genuine stragglers 20d already noted.
- Why the boot cohort has no stamps: `markDomSeen` only sees records
  after `attachPageMutationObserver()` runs
  (mutation-source.ts:441-459, called from `activateHintMachinery` on
  alphabet arrival). Content rendered before observer attach — or
  inserted-hidden before it and class-revealed after — can never be
  stamped. `domSeenAt`'s 40-hop walk (dom-seen.ts:24-34) then finds
  nothing on the chain, `tDomSeen` falls back to `tAttached`, and the
  wrapper reads as "no MO trace." The round-16 instrumentation cannot
  distinguish "materialized invisibly" from "predates the observer";
  round 16's own diagnosis table flagged this (`scan` dominating
  no-stamp) but the sweep tag hid it — the boot stragglers here were
  caught by the first settle sweep, not the boot scan, so they wore
  the settle_sweep tag that round 17 had taught us to read as
  "mid-fling rescue."
- The boot cohort is also FAST: attached_to_shown p50 47ms, dom_seen
  (=attach) to shown p50 48ms. Nothing about it is a user-visible
  problem; it is the ordinary "QuickBase renders progressively at
  boot, the 200ms-later sweep catches what the boot scan's visibility
  gates rejected" shape.

So the sentence "~200 interactive elements per fling MATERIALIZE
~1.5s after the reveal without producing observable mutations" is
withdrawn. There was no such cohort in the 20d drill.

### 21b. The real mid-fling stragglers are MO-STAMPED — the insertion
### was always observed; the REVEAL is what we can't see

The 20c drill's snapshot (04-41, build 04:36) still shows true
mid-fling stragglers, and their fingerprint inverts 20d's premise: 78
settle_sweep wrappers with REAL MO stamps — `t_dom_seen` 7836/8930
(two insertion bursts, both observed by the MO), `t_attached`
10752/11350/12830 (three later sweeps). The document MO saw their
subtrees enter the DOM; the walk ran and did not attach them
(rejected by gates — the hidden double-buffer, round 17's 11,505
parked candidates); they became attachable 2.4-3.9s after insertion
and the next ≤400ms sweep took them. Round 17 measured the same split
live (115 anchors 78-stamped). The 55-buttons-zero-stamps residue of
round 17, like 20d's 217, is explained by the boot window, not by an
invisible insertion path.

The observation-topology audit backs this: for light-DOM insertions
under `body` while the observer is attached, records are unavoidable —
the only structural holes are open-shadow-root insertions (subtree
observation doesn't pierce; our sweep's `deepQuerySelectorAll` does,
which would produce exactly a "sweep finds it, MO never saw it"
signature — not implicated here since the stragglers ARE stamped),
body replacement (we observe `document.body || documentElement` once;
Rango observes `document` for this exact reason), and pre-observer
content (21a). The huge path stamps too (mutation-source.ts:400-405).

What we genuinely cannot see is the REVEAL of already-inserted hidden
content, when QuickBase implements it as:
- class/style flips — deliberately outside the page MO's
  attributeFilter (mutation-source.ts:454-458); the visibilityMO
  (visibility-tracker.ts:156-170) watches class/style/open/hidden
  document-wide, but only promotes elements already parked in
  `pendingVisibility`;
- CSSOM writes — Emotion `insertRule` (QuickBase's `css-*` classes are
  Emotion) and `adoptedStyleSheets` changes produce NO mutation records
  of any kind, on any filter, for any observer;
- geometry-only reveals (0-width cells sized late by stylesheet): the
  one-shot visibilityIO fires once on first intersection and defers to
  the class/style MO afterwards (visibility-tracker.ts:57-76), so a
  later mutation-free size gain has no sensor.

And the park→promote chain that should catch reveals is fragile by
construction: walk rejects → attention IO observe
(content.ts:1176-1190) → IO delivery (starved mid-storm) → onEnter →
`trackPendingCandidate` → visibilityIO first-delivery + class/style-MO
promote. Each link is edge-triggered; an element inserted hidden but
already intersecting fires its one attention entry while still
invisible and then has no further intersection transitions to offer.
Round 17's 11,505-parked/0-promoted is this chain failing end-to-end
under storm, exactly as designed-in.

### 21c. Rango comparison (source at /tmp/rango-source, de798d0):
### same selector idea, same visibility gates — different SENSORS

Full observer/trigger topology read; the load-bearing differences:

1. **Registration is selector-only, at insertion, visibility-blind.**
   `isHintable` (src/content/dom/isHintable.ts:90-119) has NO
   visibility term; wrappers are created synchronously in the mutation
   callback (ElementWrapper.ts:237). A hidden buffered row is wrapped
   the moment it enters the DOM.
2. **Every hintable gets a per-element ResizeObserver, visible or
   not** (ElementWrapper.ts:284-295, attached at ts:350-353): "The
   change in `shouldBeHinted` state is mostly due to the element going
   from or to `display: none`" — their comment. Box appearance is a
   LAYOUT event: it fires with zero mutations, catches CSSOM-driven
   reveals, needs no walk at reveal time. This is the sensor class we
   don't have, and it is almost certainly what beats a
   MO+attributeFilter+sweep design on a hidden-buffer reveal.
3. **No attributeFilter anywhere** (observe.ts:16,63-64 — `{attributes:
   true, childList: true, subtree: true}` on `document`): any
   class/style flip anywhere funnels into a lodash
   `debounce(refresh, 100)` (refresh.ts:97) that re-runs
   `shouldBeHinted` over ALL wrappers — a full-population visibility
   resweep per attribute-churn wave, unbudgeted (and with no maxWait,
   starvable by a sustained storm). Our attributeFilter exclusion of
   class/style is load-bearing scar tissue (class-churn reevaluation
   was a top CPU bucket); Rango simply pays this cost.
4. Shadow roots observed individually (ElementWrapper.ts:57-75, +1s
   retry for late attachShadow); 50ms-throttled scroll rect-polling of
   observed targets (BoundedIntersectionObserver.ts:60-96); hint paint
   behind `debounce(processHintQueue, 100)` (Hint.ts:50). No
   setInterval/rAF/idle polling loops anywhere — the round-15 memory
   summary ("one unbudgeted batch per 100ms-debounced wave") is
   verified for visibility/paint, with the correction that wrapper
   CREATION is synchronous in the MO callback, not debounced.

Their visibility criteria are NOT looser than ours — no
`checkVisibility()`, opacity-ancestor walk capped at 4 hops
(isVisible.ts:3-43) vs our unbounded walk + checkVisibility
(scanner.ts:282-361). Nothing in their gates accepts an earlier
element state than ours; the difference is purely WHEN the gates are
re-run: we re-run on sweep cadence, they re-run on per-element RO/IO
events plus a 100ms global resweep on any attribute churn.

### 21d. Video re-measure: the A/B beat, cohort-specific

Fresh frame extraction from /tmp/badge-ab (the round-15 recordings —
which predate the round 16-20b fixes; BranchKit-side numbers are of
historical interest only):

- Shared zero: rows repaint out of the white void (Rango video
  t≈8.87, BK video t≈4.95).
- The pencil/eye icons are EYE-VISIBLE at reveal+0.06s in both videos.
  The content is NOT late. "QuickBase genuinely builds these controls
  that late" is dead as stated — at most, ELIGIBILITY-relevant state
  (not paint) could lag, which is what the 21e probe checks.
- Rango: header hints <+0.46s; pencil/eye and anchor hints land
  staggered +0.46 → +0.73s (rows 2-4 before row 1). So "full solid
  population in 0.4-0.5s, one wave" was slightly generous — it is
  0.46-0.73s in visible stages.
- **Rango never hints the row checkboxes at all** (checked through
  reveal+1.1s and later frames). Our late cohort includes them (12-15
  inputs). We paint measurably more of the grid than the competition
  we're benchmarking against.
- BK (video-era build): row-control badges at reveal+1.6-1.9s,
  translucent-then-solid — the since-fixed sweep starvation
  (rounds 17-20b) plus the since-deleted reveal artifacts.

Post-fix reference points: clean-shot sweep chains now land at
+31/+151ms (20c), and the 20d fling was MO-discovered at content
speed. Our settle(100ms)+fast_arm+one-slab chain responds to an
ELIGIBILITY flip in ~0.25-0.6s — the same order as Rango's
RO→IO→100ms-debounce chain. The remaining doubt is only whether
in-viewport controls still sit INELIGIBLE for seconds post-reveal
(the 20c fling chains at +1503/+1893ms), or whether those chains were
scroll-ahead content correctly waiting to become visible — the
per-wrapper data cannot discriminate retroactively.

### 21e. The open question and its probe

scripts/_probe-fling-cohort.console.js — a read-only console
instrument for the next drill (paste in the grid tab's top-frame
DevTools, fling, `copy(__bkProbe.report())`). Per candidate element it
records insertion time from a NO-FILTER document MO, every record
touching it or an ancestor, ResizeObserver box-gain events, and
100ms-polled gate verdicts (our exact gate order: selector → EXCLUDE →
size → visibility → opacity → checkVisibility → ancestor-opacity)
until first pass. The report classifies every in-viewport element that
took >500ms from insertion to eligibility by (a) which gate flipped
last and (b) whether any mutation or resize event landed within 250ms
of the flip.

Readings:
- `late_in_viewport ≈ 0` → no residual exists post-fix; declare parity
  (Rango's own beat is 0.46-0.73s and it skips checkboxes); close the
  arc for real.
- last_fail=size/display, `mut=false`, `resize=true` → CSSOM-driven
  reveal confirmed → the sensor-gap fix below is justified.
- last_fail flips with a class/style record (`mut=true`) → the
  park→promote chain is broken somewhere concrete — fix THAT, don't
  add sensors.

### 21f. Recommendation (for discussion before any code)

1. **Correct the record now** (this round does it): 20d's terminal
   claim is withdrawn; the instrumentation gap (pre-observer content
   is indistinguishable from "materialized without trace") should be
   closed cheaply — stamp observer-attach time once and let the
   snapshot classify unstamped wrappers whose attach predates
   attach+ε as `boot`, so no future round re-chases this ghost.
2. **If (and only if) the probe confirms a mutation-free reveal
   residual:** adopt Rango's sleeper sensor at our bounded scope — a
   single shared ResizeObserver over the PARKED candidate set
   (`pendingVisibility` + attention-parked), observed at park time,
   unobserved at promote/leave/finalize. It fires on exactly the
   reveals no MutationObserver can see (CSSOM/stylesheet sizing,
   display flips), costs one RO subscription per parked candidate
   (bounded by the attention region, typically tens-to-hundreds), and
   its callback can feed the EXISTING rAF-coalesced
   `recheckPendingVisibility` — no new promote path. This is
   Rango-parity on sensor class without their costs (they observe
   EVERY hintable; we'd observe only currently-parked rejects).
   Also close the visibilityIO one-shot gap the same way (its
   unobserve-after-first-delivery is what orphans geometry reveals).
3. **Do NOT drop the attributeFilter** (Rango's shape): class-churn
   reevaluation as a top CPU bucket is why the filter exists; the
   parked-RO covers the same reveals event-driven at a fraction of the
   cost.
4. If the probe instead shows the reveal carries class/style records,
   fix the park→promote chain against the specific broken link the
   probe names; the sensor addition would be redundant.

Either way, the perception target should be restated honestly: Rango's
measured beat on this grid is 0.46-0.73s staggered, minus checkboxes.
Our post-fix response to an eligibility flip is already in that range;
if the probe shows no long-ineligible in-viewport cohort, the correct
verdict is parity-declared, arc closed.

## Round 21g — drill verdict: text-fill reveal on lookup columns;
## layer-3 parked ResizeObserver lands (2026-07-04, drill on build 05:41)

The 21e drill (snapshot 05-46, round-21 instrumentation live) answered
without needing the console probe — the two new discriminators plus the
firehose pinned the mechanism:

- **Boot classifier works**: the 155 unstamped settle_sweep wrappers
  attached at t≈1.0-1.9s against `observer_attached_at` 986 — provably
  boot, never again confusable with a fling cohort.
- **The residual is real, small, and column-shaped**: 68 band_sweep
  wrappers, ALL MO-stamped (insertions observed at t_dom_seen
  6394/7527), all attached in ONE sweep at t=10007, gaps 2.5-3.6s.
  20 in-viewport at attach. Every one is an ANCHOR, and they sit in
  exactly four columns × ~17 rows: the related-record lookups
  (full-name link, email, two relation counts). The same rows' other
  234 elements — including 121 anchors in non-lookup columns, and all
  the pencil/eye/checkbox controls — attached via the MO path at
  p50 254ms from the same insertion bursts.
- **The gate story**: the anchors carry href from birth (zero
  attr-source attaches — no attribute hydration) but render EMPTY →
  0×0 → size-gate reject → parked. QuickBase's related-table data
  lands ~2.5-3.5s after the row insert; React fills the text via
  nodeValue updates — characterData mutations, invisible to every
  childList/attributes observer config including Rango's. The box gain
  is the only reveal signal. Layer 1 (visibilityIO) already spent its
  one delivery; layer 2 (class/style MO) sees nothing.
- **The response tail was ours**: firehose shows fast_arm 97 @ 8530 →
  sweep added=0 @ 8725 (still empty then); settles coalescing at
  9300/9603/9897 behind the idle gate; sweep added=68 @ 10012, shown
  +57ms. So ~0.6-1.3s of sweep-queue latency stacked on top of
  QuickBase's own data latency.

Fix landed (the 21f-recommended shape, scoped exactly as designed):
**layer 3 of the visibility tracker** — one shared ResizeObserver over
the parked candidate set. Observe at park (`trackPendingCandidate`),
unobserve at every unpark site (promote, wrapper-exists, disconnect,
untrack, teardown). Zero-box deliveries are dropped — they can't flip
the size gate, and the drop absorbs the RO initial-fire storm from a
park burst; a NONZERO initial fire is kept deliberately (the element
gained its box between the walk's rejection and RO delivery — the race
the sensor closes). Signals feed the EXISTING rAF-coalesced promote
(`scheduleVisibilitySweep`) — no new promote path, no gate changes.
Counter `visibilityRoSignals` + snapshot `wave.visibility_ro_signals`;
read against `attached_by_source.visibility` (signals climbing while
visibility attaches stay flat = the recheck rejecting what the sensor
reports). Unit tests pin the classifier semantics and the
park→text-fill→promote path.

Expected at the next drill: the lookup-column anchors attach via the
'visibility' source within ~1-2 frames of their text landing (vs
+0.6-1.3s sweep-queue), visibility_ro_signals ≈ the lookup cohort
size, and the band_sweep straggler cluster collapses toward zero. What
remains after that is QuickBase's own related-data latency (~2.5-3.5s
post-insert), which no extension can beat — Rango's RO fires on the
same box gain at the same moment.

Cost: one RO subscription per parked candidate (bounded by the
attention region; typically tens-to-hundreds), callbacks only on
actual layout changes of parked elements, promote bounded by the
existing once-per-rAF single-flight. Revert lever: remove the
`visibilityRO` observe/unobserve calls — layers 1+2 restore the prior
behavior exactly.

VERIFY DRILL (snapshot 06-00, build 05:57) — the arc's closing
numbers, with one caveat:
- **No held-ineligible cohort exists.** The worst in-viewport
  MO-stamped dom_seen→attached gap in the entire drill: **44ms**.
  mo-source overall: 417 attaches, gap p50 40 / max 61ms,
  attached→shown p50 84ms. The band_sweep straggler cluster is gone
  (only the boot cohort — 200 unstamped at t≈0-1s vs
  observer_attached_at 765, correctly classified — plus 2 scattered
  residue wrappers).
- **Sensor live and free**: visibility_ro_signals 8 against 10,449
  parked candidates — the zero-box drop absorbed the initial-fire
  storm entirely; no visibility-attach churn, no cost signature.
- **Caveat**: the lookup columns attached via mo at gap p50 45ms this
  drill — the related-table data was warm (rows revisited), so the
  text arrived WITH the rows and layer 3's promote path was not
  exercised under the 21g failure condition live. The unit test
  covers the path; the permanent tripwire is in the snapshot — the
  next cold-data fling that reproduces the 21g pattern should show
  the cohort under `attached_by_source.visibility` with ~frame-level
  latency instead of a band_sweep cluster with multi-second gaps. If
  it shows a band_sweep cluster instead, layer 3 missed and this
  section is the first place to look.

The arc closes here at measured parity: Rango's beat on this grid is
0.46-0.73s staggered (and it skips checkboxes); our drill shows
content-speed discovery on everything the page reveals, a sensor for
the one reveal class no MutationObserver can see, and QuickBase's own
~2.5-3.5s related-data latency as the shared, unbeatable floor.

## Round 22 — the user's eye vs the closing numbers: the perceived
## beat is the DOUBLE-RENDER CHURN, not discovery; Part 2 promoted
## again (2026-07-04, fresh 60fps video + actuator.log correlation;
## diagnosis only, no code)

The user, correctly, did not feel round 21g: "I thought it took
around the same amount of time for the badges to appear." A fresh
60fps recording on the current build (branchkit_scroll2.mov,
02:06 EDT — working copy /tmp/badge-ab) frame-decomposes the beat
the eye actually sees, and the actuator.log window (page-ts anchored
at the reveal ≈ 9.8k) explains every phase:

- **reveal +0.25s: a partial POP** — badges land on the first rows
  (fresh translucent claims). Discovery is genuinely fast now; the
  rounds-16..21 work shows up here.
- **reveal +0.65s: the WIPE** — every grid-row badge disappears.
  QuickBase's double-buffered SECOND render replaces the whole first-
  render window (`band_sweep:changed 101` @ ts 10580 is the second
  cohort's flags flipping; the `?skip=0` spa_nav's deferred tail took
  the HEAVY path — `deferred_scan:start`, >25% of the store
  disconnected — which is the swap measured directly). The first-pop
  wrappers die with their elements: limbo holds ~250-500ms, finalize
  tears down, letters release.
- **reveal +1.4-2.4s: the REPOP** — `showHints size=183` @ ts 11234
  (the heavy tail's wholesale re-show) paints the replacement
  population, with NEW letters (the video shows hb/sb → dy/sp on the
  same rows — teardown+reclaim, not hide/show). Solidify follows on
  the grammar ACK.

So the perceived badge latency on a fling is not discovery at all —
it is pop → wipe → rebuild, and the wipe-to-rebuild gap (~1-1.8s) is
the beat. This is the round-12 "double-render blip" (no-strong-key
cohort can't take over across the swap) at full-fling scale, plus the
first-pop-then-die cost of badging the interim render at all. Round
12 accepted it as "a little blip — one cycle on a minority cohort";
this video shows that on a real fling it is the WHOLE population and
the dominant perceptual cost.

Two NEW instrumentation deceptions explain why the 21g closing
numbers looked like parity while the eye said otherwise (the round-7
survivorship family, third appearance):
1. **Dead wrappers leave the percentiles.** discoverySourceStats and
   paint_latency iterate `store.all` — the first-pop wrappers were
   DESTROYED, so their pop-wipe cycle vanishes from every stat; only
   the final (fast, healthy-looking) population is measured.
2. **The paint_stability ring is band-scoped, not viewport-scoped.**
   shown held ~380-436 through the whole wipe because the ~40 wiped
   viewport badges are a small slice of the ~400-badge band. The
   "eye-level" instrument does not see what the eye sees.

What this round does NOT conclude: whether Rango avoids this cost.
Structurally it cannot fully avoid it (their hints also die with
replaced elements — mutation callback deleteWrapper — and replacements
get fresh labels), but their rebuild path is one synchronous wrap +
100ms debounce, so their pop-wipe-repop window should compress to
~100-200ms vs our ~1-1.8s. The round-15 video cannot answer (different
session, possibly different render phasing); a fresh SAME-GESTURE
Rango recording on this grid is the missing comparison.

Candidate levers for the fix round (design before code; all Part-2
territory):
1. **Revive position rebind for the no-key cohort** — round 12's
   "likely first choice": refresh `lastRect` at limbo entry from the
   live two-strike sweep so the fingerprint tier's 50px position
   tiebreak works on identical-content remounts (currently scores 0 on
   stale mid-storm rects). Badge + letter ride the swap; the wipe
   never happens for same-content rows.
2. **Row-identity takeover keys** — if tr.gridRow carries a stable
   record id (attribute probe needed), non-anchor cell controls get
   strong keys scoped to row identity; the round-9 cell-context trick
   extended to buttons. Dead end if rows are anonymous (like slot
   rebind was).
3. **Rebuild latency, not survival**: if takeover can't cover, cut
   the wipe-to-repop gap — the repop waited for the heavy nav tail's
   wholesale showHints; the incremental path should have painted the
   second-render cohort at claim time (~ts 10.6-11.0k). Why it didn't
   is itself a diagnosable gap.
4. **Kill the instrumentation blind spots first** (cheap, this
   round's lesson): a `wiped_within_2s` counter (wrappers destroyed
   <2s after first shown, with their dom_seen→shown history) and a
   viewport-sliced companion to the stability ring, so churn cycles
   are measurable without frame-by-frame video.

LEVERS 4+1 LANDED (d158b39, user-approved ordering; gates green):
- `wave.churn` — detachWrapper records every shown-then-detached
  wrapper (shown_for_ms, tag, source, in_viewport at last sighting,
  had_codeword) into a 300-entry ring; totals + window slice in the
  snapshot. The wipe is now a number.
- paint_stability samples gain `shown_strict_viewport` (the
  viewport-sliced count the band-scoped `shown` hid) and `pool_free`
  (per-sample reservoir depth — the mid-storm exhaustion suspect for
  the repop delay; at-rest reads can't see it).
- Lever 1 (position rebind revival): sweepBand refreshes lastRect on
  EVERY read, not just band transitions — the rect was already paid
  for. At disconnect the fingerprint tier's 50px tiebreak now sees a
  ≤100ms-fresh rect instead of a seconds-stale IO delivery.

Next drill reads (same gesture as the round-22 video):
- `wave.churn.recent`: the wipe's size and shape, directly — expect a
  burst of short-shown_for_ms, in_viewport, had_codeword records at
  the swap. If rebind_position/rebind_clean climb (frozen at 0 all
  arc) and the burst shrinks, lever 1 is riding badges through the
  swap.
- ring `shown_strict_viewport`: the perceptual dip's true depth and
  duration; `pool_free` at the same samples answers the lever-3
  question (repop waiting on letters held by doomed-but-connected
  wrappers) before designing anything.

## Round 22b — drill on the new instruments: the wipe is measured, the
## pool is acquitted, and the REAL tail is the grammar sync stalling
## for ~25s after the swap (2026-07-04, snapshot 15-55 + actuator.log)

User: "still same speed." The new instruments explain why, and they
point somewhere new.

What the drill measured (snapshot 15-55, build 06:23):
- **The churn is real and now visible**: 593 shown-then-detached
  wrappers lifetime, 300 in the ring, clustered at the swap (t≈9.2s:
  75 wipes; t≈9.7s: 193). Lever 1 (sweep-fresh lastRect) fired for
  the first time in the arc — rebind_position 0 → 45, rebind_key 113
  — but refuse_no_match 280 still dominates: most replacements
  rebuild.
- **Viewport dip, measured without video**: shown_strict_viewport
  174 → 121 at the swap, flat ~2.3s, recovered 121→145→166→173 by
  +3.1s — while band-scoped `shown` sat at ~405 the whole time
  (masking confirmed a second time).
- **Pool ACQUITTED**: pool_free 99→129→211 across the window — never
  exhausted. The lever-3 letter-starvation hypothesis is dead.
- **The kicker — shown_minus_ack p50 −1671ms, and 289 wrappers
  grammar_ready=false at snapshot time, ~17s after the swap.** The
  repop painted fast (attached→shown p50 67ms) but sat TRANSLUCENT.
  actuator.log: the post-swap incremental syncNow (15:55:00.6, ran
  1.6s) produced ZERO plugin-side grammar-batch receipts; nothing
  shipped until a full session-rotation republish at 15:55:23-27
  (27 batches, epoch 15→403) — **~25s after the swap** — interleaved
  with stale-session batches failing (failed=15/failed=5; the
  transport-failure path detaches those wrappers → more churn).
  Epoch stats: mismatches 1, republishes 1, skippedBusy 9.

So the current perceived beat decomposes as: badges appear ~1.0-1.4s
post-reveal (better than the video era), then sit translucent for up
to tens of seconds until the epoch handshake's rotate+republish
converges. The user reads translucent as not-arrived (established in
round 15); "same speed" is generous.

OPEN (the next diagnosis, before any fix): why did the post-swap
incremental sync ship nothing? The 55:00.6 syncNow ran 1.6s with no
receipts — candidates: sendMessage/SW failures swallowed silently
(postBatch's synthetic-error path populates `failed` and the caller
DETACHES the chunk — label-sync.ts:618-622 — a churn amplifier if
transport blips mid-storm), a wholesale refusal + starved retry, or a
session rotation racing the sync (the failed=15/failed=5 batches were
old-session Puts landing after rotation). The instrumentation gap:
postBatch outcomes are invisible unless they refuse wholesale —
BK_SYNC_REFUSED logs, but per-chunk transport failures and their
detach cascades do not. Next lever: log every postBatch outcome
(result, chunk size, session, elapsed) into a ring surfaced in the
snapshot (sync_trace), so the next drill names the stall's mechanism
the way churn/pool got named this drill. Fix design follows THAT
data, not before.

Also confirmed this drill, parked for later: the strict-flag
depression (badges shown but in_strict_viewport=false for ~2.3s
post-swap — voice can't match painted badges during it; round-19
residue class, likely clip re-root latency at the buffer→pane
reparent).

## Round 22c — sync_trace names the stall: DEBOUNCE STARVATION; the
## max-wait deadline lands (2026-07-04, drill on build 16:07)

The sync_trace drill (snapshot 16-14) reproduced the symptom (290
grammar_ready=false) and named the mechanism in one shot:

- **Zero transport errors across 127 posts.** sendMessage is
  innocent; the SW never failed.
- **A 5.5-second hole with ZERO postBatch calls** — last pre-fling
  post at t=5413 (is_final), next post at t=10884. Not slow, not
  failing: never invoked. `scheduleSync` is a pure 80ms trailing
  debounce; the fling's claims and strict deltas reset it continuously
  and it starved for the whole scroll+swap window — the exact trap the
  schedulePassSoon comment documents ("a debounce pushes back under
  sustained churn").
- The consequences chain directly: the t=10884 post carries **355
  accumulated deletes**; the epoch handshake sees the divergence the
  starvation created; **session rotates at t=12586** (a629dd35 →
  580c28da) and a full ~25-batch republish runs to ~15s. The
  translucent-forever beat, end to end, self-inflicted by the
  starved debounce.
- Bonus finding from the boot window: several chunks answered
  failed=15 (result ok, every codeword refused) — each detaches the
  whole chunk (label-sync.ts failure path) and feeds churn. Cause not
  yet chased (plugin-side per-codeword refusal reasons aren't in the
  trace); visible now, tracked for a later round.
- Also: pool_free DID hit 0 at the swap this drill (t=7860) —
  letter exhaustion is drill-variant, secondary, and mostly a symptom
  of the same churn volume.

Fix landed: **BATCHED_SYNC_MAX_WAIT_MS = 400** — a non-extending
deadline armed by the first schedule of a burst, cleared by whichever
timer fires first (the fireHugeMutationRefresh / whenDOMSettles shape,
third use in this codebase). A sustained storm now ships coalesced
15-element deltas at least every 400ms: ACKs land while the fling
runs, badges solidify at ~claim+0.5s instead of settle+10s, no
monster delta accumulates, and the epoch handshake has no divergence
to punish with a rotate+republish. Unit tests pin both directions
(quiet burst fires once at the trailing edge; sub-debounce churn ships
via the deadline).

Expected at the next drill: sync_trace shows 15-element posts every
~400ms THROUGH the fling; shown_minus_ack p50 collapses from −1671 to
≈ −(400..600)ms; grammar_ready=false ≈ 0 within ~1s of settle; no
session rotation after the swap. The perceptual translucent phase
compresses to ~half a second — which is the two-phase shape the user
already approved in round 13, now honest.

VERIFY DRILL (snapshot 16-26, build 16:19) — the deadline works, with
one framing CORRECTION to 22b:
- **Correction first**: the "289 stuck translucent" reading was wrong.
  In BOTH the 22b and this drill, every grammar_ready=false wrapper is
  codeword-LESS — out-of-band wrappers at their resting state, zero
  translucent badges at rest either time. The real symptom was always
  the translucent WINDOW (shown→ACK), which the sync hole stretched;
  grammar_ready counts alone cannot measure it. (Fourth entry in this
  arc's catalogue of aggregate-counter misreads.)
- The 5.5s hole is gone: a 2.1s gap with nothing queued (the scroll's
  pre-swap phase — no claims, no deletes yet; the first post-swap
  delta shipped 226 deletes within ~0.5s of finalize, deadline-fired),
  then continuous 15-element trains every ≤400ms through the entire
  swap window (t=7309→9998, 60+ posts, zero transport errors).
- **No session rotation** — one session across the whole drill; the
  epoch divergence → rotate → 25-batch republish cascade is gone.
- shown_minus_ack p50 −1671 → −1276 over the 90s window (boot's long
  put-queue dominates the median; mid-fling ACK windows are within a
  few hundred ms of the deadline cadence).
- Churn shrank: shown-then-detached 593 → 351, sub-2s wipes 300+ →
  176 (lever 1's rebind revival + no more refusal/rotation cascade).

Still open, in priority order:
1. The failed-chunk refusals (result=ok, failed=13/15/12/6 on several
   mid-storm chunks — each detaches the whole chunk and feeds churn).
   Plugin-side per-codeword refusal reasons aren't surfaced in the
   trace; that's the next diagnostic seam if churn still reads high.
2. The strict-flag depression (voice matchability lag post-swap,
   round-19 residue class) — parked, unchanged.
3. Perception check: the machine numbers now say appear-fast +
   solidify-in-hundreds-of-ms; whether the eye agrees is the only
   verdict that counts in this arc.

## Round 23 — DESIGN: connected-predecessor takeover by
## fingerprint + position (the lever that moves the eye)

Status: design for review — no code. Successor to the round-22
decomposition: every fling kills ~50 viewport badges (~350 band-wide)
because QuickBase replaces row DOM, and takeover coverage is partial —
rebind_key ~113 (href anchors) + rebind_position ~45 (limbo-timing
lucky) out of ~350 deaths. Rounds 22-22c fixed everything DOWNSTREAM
of the deaths (sync, rotation, churn cascade); the eye-metric
(shown_strict_viewport dip: 174 → 121, ~2.7s recovery) is unchanged
because nothing yet stops the deaths. This tier does.

### The gap, precisely

The fingerprint/position rebind tier (`tryRebindFromLimbo`,
limbo.ts:189) only consults the LIMBO POOL — disconnected wrappers.
QuickBase inserts the replacement window BEFORE removing the old one
(established rounds 8-9: slot_probe.pool_empty 591/1104 on the current
build), so at discovery time the doomed predecessor is still connected
and the pool is empty. The one tier that handles connected
predecessors is the strong-key takeover (`tryRebindByStrongKey`,
limbo.ts:305) — but its keys are hrefs, so buttons/inputs/labels
(~2/3 of grid wrappers) have none. Result: identical-content remounts
churn fresh wrappers, letters, grammar entries, and badges.

### Mechanism

A fourth tier in `attachDiscovered` (wrapper-lifecycle.ts:150), after
strong-key and limbo, before slot:

1. **Index** (built once per discovery pass, alongside
   `collectStrongKeyIndex`): fingerprint-string →
   list of CONNECTED, in-store wrappers holding it. Fingerprints come
   from `idRegistry` — already computed at register time, so the index
   is O(store) pointer reads, no DOM access. Skip id<=0 and
   `isRecentlyOrphaned` holders.
2. **Match**, for each new element E (fingerprint computed once and
   shared with the limbo tier — today each tier recomputes):
   - `candidates = index[fp(E)]`, connected, minus already-consumed.
   - **Exactly one candidate** → takeover, gated by a GENEROUS
     position check (candidate.lastRect center within
     TAKEOVER_UNIQUE_MAX_PX ≈ 300 of E's rect center). A unique
     fingerprint ("Edit purchase order 10897" — names carry record
     ids on this grid) is near-certain replacement semantics; the
     generous gate only blocks cross-page steals. E's rect is warm
     (the scan walk just read it); candidate.lastRect is ≤100ms fresh
     (lever 2, the sweep refresh).
   - **Multiple candidates** (identical controls — checkboxes,
     pencil/eye per row) → position decides: nearest candidate by
     center distance, requiring d < TAKEOVER_TIGHT_PX ≈ 40 (sub-row
     scale) AND (d2 − d) > TAKEOVER_MARGIN_PX ≈ 40 (uniquely nearest
     — adjacent rows sit ~35-45px apart, so a same-column
     neighbor-row candidate fails the margin). Anything else →
     refuse, fresh attach (today's behavior).
3. **Consume + guard**: remove the winner from the index list (a
   second new element can't also steal it); mark the orphaned
   predecessor in `orphanedByKeyRebind` — the EXISTING ping-pong
   guard; `attachDiscovered`'s `isRecentlyOrphaned` skip already
   prevents re-grabbing the robbed element.
4. **Transfer**: `rebindWrapper` (existing, unchanged) — badge,
   letter, grammar entry, grammarReady, registry id re-anchor onto E.
   Deliberately NOT adopting the fresh scan metadata (unlike the slot
   tier): same fingerprint = same content, so no re-Put, no grammar
   delta, ZERO sync traffic for a ridden swap. The old element dies
   unobserved later; nothing fires.

### Why this is safe (the cross-steal analysis)

- The dangerous case is stealing from a live element that was NOT
  being replaced. For ambiguous fingerprints, the tight+margin
  position gate means the new element sits ON the predecessor
  (co-location of identical controls is not a legitimate steady
  state). For unique fingerprints, uniqueness itself is the argument
  (there is no other element that looks like this), with the generous
  gate as backstop.
- Wrong steals self-heal: the robbed element loses its wrapper, the
  next sweep/MO pass rediscovers it, and it attaches fresh with a new
  letter — one letter swap on one control, the same cost as today's
  churn, paid only on a bad bet instead of on every swap.
- The 7fe37a0/73cf6e7 class doesn't apply: edge-triggered, once per
  newly-discovered element, inside the discovery path; no
  level-triggered rederivation, no retry loop.
- Slot-anchor's cross-page-steal lesson (round 6 stop-list) is
  covered by the position gates — the slot tier's failure mode was
  matching by structure alone with no spatial term.

### What the eye should see

A same-record window swap (the common fling case: destination rows
overlap or re-render the visible region): badge and letter RIDE the
swap — no teardown, no bare window, no translucent phase (grammar
entry never left). The dip in shown_strict_viewport should shrink
from ~53 to roughly the count of genuinely-new records in view, and
recovery from ~2.7s to the reposition cadence (~0.3s). Genuinely new
records (fling to unvisited rows) still build fresh badges — correct,
and now fast at every stage.

One honesty note: if the replacement element is inserted hidden
(buffer) at discovery time, the ridden badge may hide until the
reveal (wantsShown follows target visibility) — a possible brief
blink, but letter + grammar + solidity survive, and the reveal
re-show is settle-driven (~100ms). Strong-key rides have worked this
way since round 9.

### Instrumentation & acceptance

- New counters in `rebindCounters`: `takeover_fp` (unique),
  `takeover_fp_position` (ambiguous, position-resolved),
  `refuse_fp_ambiguous`. The churn ring + viewport-strict dip are the
  acceptance metric — per the round-22 lesson, NOT the stage stamps:
  * wiped_within_2s per fling: 176 → target ≤ ~30
  * shown_strict_viewport dip: 174→121/2.7s → target ≥150 floor,
    ≤0.7s recovery
  * takeover_fp* volume ≈ the former wipe volume
- Cost: one O(store) index per discovery pass (same class as the
  strong-key index built in the same loop — can share the iteration);
  one fingerprint compute per new element (innerText read, ~40 chars
  — today paid only when limbo is non-empty; now always; bounded by
  new-element count, ~40-350/fling).
- Revert lever: remove the tier call in `attachDiscovered`; the index
  build goes with it.

### Open questions for review

1. TAKEOVER_UNIQUE_MAX_PX = 300: generous enough for scrolled
   remounts (same record re-rendered a viewport away during a fling)?
   A scrolled remount FAILING the gate just builds fresh — safe but
   uncovered. Could key the gate off scroll delta instead; start
   simple.
2. Should the unique-match path skip the position gate entirely when
   the fingerprint's accessible name is "strong" (contains digits /
   ≥N chars)? Deferred — measure the simple version first.
3. Interaction with the slot tier: it currently never fires on this
   grid (shells die with rows) and stays as-is, after this tier.

IMPLEMENTED as designed (06f6fc0, user-approved; gates green, 1028
tests — 7 new pinning unique-steal ride, far-refusal, position
resolve, margin refusal, consume, no-lastRect skip, limbo exclusion).
One deviation from the sketch: the fingerprint is computed once per
new element in `attachDiscovered` AFTER the strong-key check and
shared with the limbo tier (which gained an optional precomputed-fp
param) — a key hit never pays the innerText read. Drill reads: the
churn ring and the viewport-strict dip are the verdict;
takeover_fp/takeover_fp_position volume should approximate the former
wipe volume, refuse_fp_ambiguous sizes what the margin gate leaves on
the table (candidate for threshold tuning, not loosening past the
neighbor-row spacing).

## Round 24 — the QuickBase-grid fixture: the drill goes programmatic,
## and finds round 23's flaw in three runs (2026-07-04, 701b6cb)

User's call, and the arc's best process decision: stop asking the eye
to arbitrate counter disputes — build a fixture that reproduces the
documented QuickBase mechanics and measure the badges' VISUAL state
directly.

**test-fixtures/quickbase-grid.html** replicates, with knobs: 4,000
virtual records, ~80-row rendered window; white void on scroll settle;
incoming window built inside a hidden IN-DOCUMENT buffer in
sub-100-node chunks (MO sees it; huge path doesn't fire); reparent +
class-flip reveal; TWO-PHASE rebuild with INSERT-BEFORE-REMOVE (both
generations connected ~150ms — rounds 8-9); lookup columns born with
href + empty text, filled ~2.5s later via nodeValue (characterData);
?skip=N history tick. **scripts/_test-qb-fling.mjs** (harness,
launch.mjs, no voice alphabet) drives a wheel fling and samples a
DOM-level EYE at 100ms: badge .bk-inner rects + computed opacity
through the opened shadow (bkOpenShadow), classified
solid/translucent/absent within the pane. Verdicts print against the
same-run snapshot counters on one clock. Caveat honored: fixture
verdicts guide diagnosis and gate regressions; production truth stays
with the user's real-Chrome drill.

Fidelity checks that make it trustworthy: it reproduces production's
exact counter signature (limbo tiers 0 — insert-before-remove defeats
them; rebind_key riding anchors; takeover_fp 0 pre-fix;
refuse_fp_ambiguous in the hundreds) AND the eye-instrument confusions
we hit live (the sampler was blind twice — host rects are 0×0, badges
live in closed shadow roots — both already-documented harness
confounds).

**The finding (three runs in):** round 23's unique-match position gate
is structurally wrong for insert-before-remove. During the overlap the
replacement rows are APPENDED BELOW the doomed rows (~3,300px away in
the fixture) — the new element's real position doesn't exist until the
old generation leaves, so the 300px gate refused every unique
takeover: takeover_fp pinned at 0, and the unique-branch refusal had
no counter, so four production drills couldn't see why. Fix: the
unique branch takes NO position gate — uniqueness is the identity
argument (exactly one connected element looks like this; a new
lookalike is its replacement wherever either sits). Ambiguous groups
keep the tight+margin gates (they need co-location by definition); a
mixed group with an unrankable member now counts refuse_fp_ambiguous
instead of silently skipping. Cross-page risk unchanged in kind:
wrong steals remain self-healing, and a unique lookalike appearing
anywhere IS the same logical control re-rendered.

**Fixture verdict, same clock:** takeover_fp 0 → 263; visual
reveal→85%-badge-recovery 639ms → **144ms**; wiped_within_2s 348 →
144; the phase-2 blink ~500ms → ~300ms and letters/grammar no longer
churn through it (the badge follows its element to the transiently
stacked position and snaps back when the old rows leave). Remaining:
the ambiguous cohort (checkboxes + repeating lookup values, 206
refusals) — next lever is order-pairing within equal-size fingerprint
groups, only if the real drill still reads slow.

Gates green (1028 tests — the two tests pinning the old gate semantics
updated to pin the new; builds; wedge; dual-cs; soak:orphan). The
real-Chrome verify drill is the arbiter, as always.

## Round 25 — takeover grace: the ride's transient position is not an
## exit (2026-07-04, ce212a1; fixture-driven, real-drill signature)

The user's first real-Chrome drill on round 24 reported: "a flash like
it almost painted on everything quickly, but then it hit itself and
then it painted itself on one by one in the normal timing." The
production snapshot confirmed the flash (takeover_fp 326 — the rides
fire at scale live) and the fixture reproduced the full signature:
solid badges 95 → 14 at phase-2, then a ragged one-by-one recovery
tracking the old generation's progressive removal.

Mechanism: a ride lands on an element parked ~3,300px below the band
during the insert-before-remove overlap. The IO's initial delivery,
the sweep, and the plan's toRelease all read that transient position
as a REAL band exit — release the letter, hide the badge. The
takeover un-did its own win.

Fix (three pieces, each fixture-verified):
1. **Grace on exits**: rebindWrapper stamps `takenOverAt` when the
   ridden element is out-of-band at ride time; the IO exit branch,
   sweepBand's two-strike, and the plan's toRelease skip graced
   wrappers (TAKEOVER_GRACE_MS=2000, self-expiring — a ride the user
   scrolls away from degrades to one late release).
2. **Position hold**: `HintBadge.holdUntil` gates reconcileRead (and
   through it repositionHostNow) — the badge keeps its last on-screen
   spot while the identical-content replacement slides into place
   beneath it. Grace clears at band entry (exits legit again); the
   position hold releases only when the element is actually ON-SCREEN
   — band entry can still be 1000px below the viewport, and gliding
   the badge there reads as vanishing.
3. **Accel-pair consistency**: retarget skips the accelerator
   disarm/re-arm while holding — re-arming outer's -scrollTop
   animation against a deliberately-unpainted host base teleported
   held badges by the pane's whole scrollTop (fixture: the mid-swap
   trough). clearPositionHold rebinds the accel for the new target
   and repaints base+animation in lockstep.

Fixture verdict: badges hold solid through the ENTIRE
double-generation overlap (95 solid from reveal through phase-2
insert, previously 95 → 11-14); letters and grammar never churn on
ridden swaps; rest state healthy.

OPEN, precisely characterized: during the progressive old-row removal
(~+1.6 to +3.6s in the fixture), solid badges oscillate 95 ↔ ~15-55.
That flicker is the clip/occlusion machinery HONESTLY hiding badges
whose ridden elements are still below the pane's visible box — the
hold freezes position, not visibility. The candidate next iteration
(design before code, high-blast-radius subsystems): suppress
clip/occlusion/visibility-driven HIDE for position-held badges — the
doomed twin the badge visually sits on is still on screen showing
identical content, so keeping the badge painted is visually truthful,
and activation on the ridden element is semantically equivalent.
Decide after the next real-Chrome drill: production's removal may be
fast enough that the residual flicker is minor.

Fixture fidelity gained this round (each was masquerading as an
extension bug until fixed): constant scroll-height spacers through
the swap (height bounce clamped scrollTop and shifted content under
held badges), a latest-wins queue for settles landing mid-swap (the
drop left the pane on empty spacer — 'stuck hidden at rest' was this),
overflow-anchor:none, progressive-removal knob (remove_step_ms).

## Round 26 — row-coattail takeover: the row is the identity carrier
## (2026-07-04, 1ad1dc4; fixture-verified)

The 25-verify drill: rides fire at production scale (takeover_fp 326)
but ~87 in-viewport badges still die per swap — the content-ambiguous
cohort (checkboxes; repeating lookup links, refuse_fp_ambiguous 211),
unmatched by content by definition and unmatchable by position during
the stacked overlap. Roughly half of each visible row rode; the eye
reads the rebuilding half.

The lever: every grid row CONTAINS a unique-fingerprint control (the
edit/view buttons carry record ids in their accessible names), so a
unique ride pins doomed-row ↔ replacement-row correspondence for free.
`coattailRowTakeover` then rides the row's other wrappers by
STRUCTURAL PATH — the child-index path from the row to the element,
exact on an identical rebuild, fail-safe on anything else (path miss /
tag mismatch / counterpart already wrapped / recently orphaned → skip;
fresh attach follows, today's behavior). Counter: takeover_row.

Plus an ordering fix the fixture caught on the first run: document
order puts a row's checkbox BEFORE its unique pencil, so the inline
ambiguous refusal fresh-attached the checkbox an instant before its
coattail arrived — and the old wrapper died anyway (the counters said
so: refuse_fp_ambiguous 318 alongside takeover_row 416).
tryTakeoverByFingerprint now returns 'rode' | 'ambiguous' | 'none';
attachDiscovered DEFERS the ambiguous cohort to a second pass within
the batch — by then the coattails have carried most of them, and true
refusals count + fresh-attach as before. (Batch-boundary row splits
remain a minor residual: a row split across two 60-element walk
batches can still fresh-attach its early members.)

Fixture verdict: takeover_row 730 + takeover_fp 368 per swap — the
ENTIRE population's letters and grammar ride; rebind_key dropped to 0
(the coattail carries anchors before the strong-key tier sees them —
fine, same transfer mechanics). The remaining visual flicker in the
removal window (~95 ↔ 40-55 solid) is the round-25 OPEN item —
clip/occlusion honestly hiding held badges whose ridden elements are
still below the pane — NOT letter churn. Whether production's removal
pacing makes that flicker visible is exactly what the next real-Chrome
drill answers; if it does, the next iteration is the
visibility-suppression-during-hold pass round 25 characterized.

## Round 26 VERIFY — the closing drill (2026-07-04, snapshot 18-57,
## build 18:25): everything ours is at content speed; the residual is
## the page

Production verdict, every layer:
- **takeover_row 998 + takeover_fp 93** — the whole population rides
  both render generations on the real grid.
- **The only in-viewport deaths are correct ones**: 65 anchors + 12
  labels, all at swap start, each shown ~4.4s — the OUTGOING window's
  badges dying as the user flings away (in_viewport=true via their
  final pre-void lastRect). Zero buttons, zero checkboxes: the
  ambiguous cohort survives.
- **The dip decoded, finally**: the strict floor is EXACTLY 121 in
  every drill regardless of gesture — that is the constant NON-GRID
  chrome (sidebar/nav). The dip is simply "the grid region has no
  badges while QuickBase blanks and re-renders it." Its duration is
  the page's void + progressive render, not our pipeline.
- **Badges land 52ms behind their row's DOM** (mo dom_seen→shown p50
  52 / p90 70) and solidify in ~0.5s (shown_minus_ack p50 −519; was
  −1671 at round 22b). Zero sync transport errors; no session
  rotation; RO sensor quiet.

The arc's honest close: the perceived fling-to-badges timing is
dominated by QuickBase's own cycle — white void (~1-2s), progressive
row render, related-data fetch (~2.5-3.5s cold) — which no extension
changes; Rango's measured 0.46-0.73s was clocked from rows-repaint on
the same floor, and we now paint 52ms after each row exists. What the
26 rounds actually bought does not show on a stopwatch but is real:
letters no longer reshuffle across swaps (voice targets stay stable
through a fling), badges solidify in half a second instead of 10-25s,
the rotation/republish storms are gone, discovery is content-speed on
every reveal class including mutation-free ones, and the QuickBase
fixture + DOM-level eye regression-gate all of it programmatically.

Parked with tripwires, deliberately not chased: the fixture's
removal-window clip/occlusion flicker (did not manifest in the
production data); the strict-flag lag inside the page's own render
window (voice matchability trails paint by ~1-2s during the swap —
bounded by the same floor); batch-boundary row splits in the coattail;
the boot-cohort's settle_sweep classification.

## Round 27 — THE RANGO A/B ON ONE CLOCK: the gap is not speed, it is
## swap-window STABILITY (2026-07-04; scripts/_test-qb-fling-rango.mjs)

The user's standing objection, correctly held against every "it's the
page" conclusion: Rango is perceived MUCH faster on the same page, so
something BranchKit-specific must exist. Answered by running Rango
itself (built from /tmp/rango-source, hint shadow patched open)
through the SAME fixture, gesture, and 100ms DOM-level eye:

**Paint speed is EQUAL — we are marginally faster.**
- Rango: reveal → 95 hints at +475ms translucent (their fade-in) →
  95 solid at +617ms; 85%-recovery 499ms.
- BranchKit: 95 solid at ~+400ms; 85%-recovery 400ms (same fixture,
  same gesture, prior run).

**The entire difference is DURING the swap.** Through the identical
phase-2 + progressive-removal window:
- Rango: 95 → 95 → 95 → 90 → 90 → 80 → 70 — a smooth monotone slope,
  ZERO dips, zero flicker. (It ends at 70: fewer hintables — no
  checkboxes.)
- BranchKit: 95 → 11 → 43 → 55 → 95 → 23 → 94 → 55 → 95 — hard
  oscillation for ~2s.

The eye reads flicker as slower-than-slow; that IS the perceived gap.

**Why Rango is steady there — by doing nothing:** Rango does not ride
identity. Hints live and die with their elements (deleteWrapper on
removal; new elements wrapped + painted synchronously at insertion).
Under insert-before-remove that is INHERENTLY stable: the old row's
hint stays exactly as long as the old row is on screen; the new row's
hint exists wherever the new row is; in-pane count ≈ constant by
construction. The price they pay is the one thing they don't need and
we do: their labels RESHUFFLE on every swap — a memorized label is
invalid after a fling. Keyboard users point at what they see; voice
users speak what they memorized. We ride identity because voice
requires it.

**Why we flicker there:** riding moves the badge's TARGET to the
replacement element the moment the takeover fires — while the doomed
twin is still visibly on screen. The round-25 position hold pins the
badge's coordinates, but the visibility subsystems (clip/occlusion/
strict, evaluated against the RIDDEN target's transient off-pane
state) hide it anyway. The user watches visible rows lose their
badges early and regain them as each replacement lands: the
oscillation.

**The closing fix, now precisely justified:** suppress
visibility-driven hides for position-held wrappers (bounded: graced
rides only, ≤2s, self-expiring). Visually truthful — the doomed twin
under the held badge shows identical content — and semantically fine
(activation targets the replacement, an equivalent action). With it,
our fixture line should read like Rango's flat slope PLUS letter
continuity they can't offer. This is the round-25 "characterized +
open" item, promoted to next with A/B receipts.

## Round 28 — DESIGN: deferred retarget — ride at DEATH, not at
## discovery (2026-07-04; design only, supersedes the round-27
## hide-suppression proposal)

User reframing that settles the architecture: the point of identity
preservation was never codeword memorization — it is PERCEPTUAL
CONTINUITY: the badge keeps its previous place and letter through a
change so the eye doesn't re-read. Given the round-27 A/B (paint speed
equal; the whole gap is our swap-window flicker), three options:

A. **Remove riding** (Rango's model): hints live/die with elements.
   Stable by construction, but letters change at the badge's position
   every swap — the eye must re-read, which is exactly the experience
   the preservation exists to prevent. Rejected.
B. **Suppress visibility hides during the hold** (round 27's
   proposal): keeps continuity but fights clip/occlusion/strict with
   exemptions — lying to high-blast-radius subsystems about a badge
   whose target is genuinely elsewhere. Workable but adversarial.
C. **Defer the transfer to disconnect time.** At discovery, only
   RESERVE the pairing; transfer when the doomed element actually
   leaves. Chosen.

### Mechanism (C)

1. At takeover-match time (all of rounds 23-26's matching machinery
   unchanged: unique fingerprint, position-ambiguous, row coattail,
   pass-2 deferral), do NOT rebind. Instead:
   - `wrapper.pendingRetarget = WeakRef(newEl)` (+ a timestamp);
   - RESERVE newEl (WeakMap, like orphanedByKeyRebind) so discovery
     skips fresh-attaching it while the reservation lives (TTL ~2s —
     an unconsumed reservation expires and the next sweep attaches the
     element fresh; the wrong-steal bet degrades to today's behavior).
2. The badge stays fully attached to the VISIBLE doomed element. No
   grace, no position hold, no accel juggling, no visibility
   exemptions — every subsystem evaluates honest state. (The round-25
   machinery retires with this; keep the code until C lands, then
   delete in the same commit.)
3. On the doomed element's DISCONNECT (dropDisconnectedWrappers /
   limbo entry — the moment the eye loses the old pixel anyway): if
   `pendingRetarget` derefs to a CONNECTED element with no wrapper →
   `rebindWrapper` to it INSTEAD of entering limbo. By insert-before-
   remove geometry the replacement has just slid into (or near) the
   old element's place, so the reposition is a nudge: same letter,
   same spot, element swapped underneath. Else → normal limbo path.
4. Claims/letters/grammar: nothing moves until the transfer, and the
   transfer preserves them — zero sync traffic, as with rounds 23-26.

### Why this reads like Rango's flat slope

The old badge lives exactly as long as the old content is visible
(Rango's invariant), and at the removal instant the badge re-anchors
to the content that replaces it (our addition — Rango would tear down
and mint a new label there). In-pane badge count is constant by
construction; letters and positions are continuous.

### Expected in the fixture

The oscillation window (95 ↔ 11-55 for ~2s) flattens to ~95
throughout, matching Rango's slope, with letters stable — verify by
extending the eye to also fingerprint a few labels across the swap.
takeover counters keep their names; a new `retarget_deferred` bucket
(reservations consumed) replaces most direct rides on this grid.

### Risks / open

- Reservation TTL races: replacement dies before the old one
  (three-generation renders) → deref fails → normal limbo; reserved
  element orphaned until TTL → sweeps re-attach after expiry.
- The disconnect hook runs inside dropDisconnectedWrappers (hot);
  work is O(pending pairs), pointer reads.
- Coattail pairing at reserve time vs at consume time: reserve-time
  (structure is freshest then); consume resolves per-wrapper WeakRefs
  independently, so partial rows degrade gracefully.

IMPLEMENTED (a652176; net-NEGATIVE diff, 149+/160− — the deferral
deleted the round-25 grace/hold machinery it obsoletes). Fixture
verdict on the same swap/gesture/eye:
- The 95 ↔ 11 oscillation is GONE. Solid holds 87-95 through the
  entire double-generation window; the progressive removal reads as a
  gentle 95 → 76 slope (Rango's identical window: 95 → 70) with two
  single-sample transients; back to 95 at rest — full coverage, which
  Rango ends 26% below (no checkboxes).
- retarget_deferred 615 consumed transfers; letters preserved
  throughout.
- Bonus: takeover_fp_position 150 (was ~1) — with doomed wrappers
  keeping honest geometry until death, the ambiguous tier's tight
  position gate finally has real co-location to work with.
- Gates green (1031 tests; the takeover/coattail tests rewritten to
  pin reserve-then-consume; _test-qb-fling-rango.mjs allowlisted in
  the harness ratchet with rationale — Rango-only launch).

The real-Chrome drill is the arbiter, as always: this is the first
build whose fixture line matches Rango's slope.

### Round 28b — the first production drill stranded reservations;
### two fixes (20139ac)

Drill on the 28 build: "hints took a very long time to load."
Snapshot: 730 reservations made, **16 consumed**; settle_sweep
attached 562 wrappers at dom_seen→attached **p50 17.2s / max 22.9s** —
reserved elements sat badge-less until the TTL lapsed AND an
incidental settle swept them.

1. **The consume-blocker**: production replacements arrive in the
   HIDDEN buffer and reveal through the visibility tracker's direct
   attachWrapper path — which bypassed the reservation check (the
   bypass gotcha documented at round 26). The promoted fresh wrapper
   then blocked every consume. Both promote sites now skip reserved
   elements.
2. **The stranding**: an expired reservation had no wake-up on a quiet
   page. expireStaleReservations (on the 250ms finalize interval)
   clears the bookkeeping and immediately re-discovers the
   replacement. Counter: retarget_expired — read against
   retarget_deferred; expired dominating means the pairing bet is
   wrong for the page's swap dynamics.

Fixture limitation, recorded: its replacements arrive VISIBLE (the
walk path), so it cannot exercise the buffer-reveal promote path that
broke in production. A future fixture iteration should reveal phase-2
rows via the veil class flip like the main swap. The production drill
verifies fix 1.

## Part 2 — hold badges through in-place row recycling

### What the dip actually is

Limbo already does most of the "hold": a disconnected wrapper keeps its
codeword AND its painted badge (gather, the reconcile plan, and
reposition/placement all skip disconnected wrappers — the badge freezes
doc-anchored at its last spot and rides the compositor). Teardown happens at
finalize: 250ms deadline on a 250ms sweeper interval, so a swapped-out cell's
badge dies 250–500ms after disconnect. The replacement paints at p50 565ms.
**The dip is the gap between those two clocks.** Part 1 moves the second
clock inside the first: a ~150ms replacement lands while the old badge is
still held, and the shown count stays ~flat through the swap. Much of the
60–110 dip should close from Part 1 alone — re-measure the ring before
building anything else.

### The structural remainder: slot rebind (third rebind tier)

Even with the gap closed, every recycle is still a full teardown +
construction + codeword churn: the snapshot's rebind counters read
`refuse_no_match: 228` against `rebind_clean: 7` + `rebind_key: 44` — the
recycled cell's new content has a different fingerprint (different record
text/name) and a different href (no strong key), so both existing tiers miss
by design. Meanwhile the same snapshot shows the recycling happens inside
stable shells: the `td.column-<reportid>-<fieldid>[role=gridcell]` cells (and
`tr.gridRow` rows) persist; only the content inside swaps.

Add a third tier to `attachDiscovered`, after strong-key and fingerprint:

- **Record the slot at attach.** `slotAncestors`: WeakRefs to the wrapper's
  first ~6 parent elements (or until the first `tr`/`role=row`, whichever is
  shallower). Pointer reads, no layout, recorded once. Depth 6, not 3: in
  the 2026-07-03T22-54 snapshot, 60 of 305 grid-adjacent wrappers have
  their `td` at depth 5 (buttons nested under extra cell layers) — depth 3
  would exclude a fifth of the grid from the tier. (Post-hoc recovery is
  impossible — a removed subtree loses its parent chain at the detach
  point, so the slot must be remembered while attached.)
- **Match on discovery.** For a new element neither tier claimed: a limbo
  wrapper slot-matches iff one of its recorded slot ancestors is still
  connected AND `contains()` the new element, AND tag+role match, AND the
  match is unique both ways within this drain pass (exactly one limbo
  candidate for that slot, exactly one new element claiming it — a per-pass
  map enforces it). When several recorded ancestors survive, match against
  the DEEPEST one — a `td` disambiguates (typically one hintable per kind),
  a `tr` contains many and would refuse on uniqueness. Ambiguity → refuse,
  fall through to fresh attach.
- **On match:** existing `rebindWrapper` (retargets the badge, swaps
  observers, store/registry rebind, clears `disconnectedAt`), plus
  `refreshFingerprint`, plus a `scanSingle` metadata refresh (the accessible
  name changed with the record — mirror `reevaluateAttribute`'s refresh
  branch), plus `queuePut` (the plugin's entity metadata changes even though
  the codeword doesn't). New counter bucket `rebind_slot`. Mark the orphaned
  predecessor via the existing `orphanedByKeyRebind` ping-pong guard.

Semantics: the codeword names the **slot** — this cell of the grid — which is
what the user perceives anyway. The badge never blinks and its letter never
changes while records stream through the cell; activation always routes to
the current element through the registry ref. The badge-implies-functional
contract holds continuously: no release, no re-claim, no re-ACK
(`grammarReady` survives), zero pool and grammar-sync churn per swap.

Fail-safe: on a grid that replaces whole rows (no recorded ancestor
survives), all three tiers miss and behavior is exactly today's — Part 1
speed + the limbo hold. The gates (connected ancestor + containment +
uniqueness + tag/role) make cross-slot mis-binds structurally impossible
rather than probabilistically unlikely, which is what the YouTube
duplicate-fingerprint history demands.

### Rejected alternatives

- **Ghost badges** (keep the hint painted after codeword release, purge at
  settle/handoff): breaks badge-implies-functional — the released letter can
  be re-granted elsewhere mid-fling, putting two identical codewords on
  screen — and introduces a badge lifecycle outside the reconciler model
  (the nav-rebuild-smell class). Saves no construction.
- **Extend LIMBO_DEADLINE during scroll**: holds codewords too. This grid
  runs ~550 claimed against the 676 pool; holding 60–110 recycled letters an
  extra half-second right when the replacement rows need letters risks
  claim exhaustion (`''` grants) — trading a visual dip for a fill stall.
- **Relax fingerprint equality** so recycled content matches: reopens the
  duplicate-fingerprint mis-rebind class the position tiebreaker exists to
  contain, and position is untrustworthy mid-fling (lastRect goes stale
  between IO deliveries — `rebind_position: 0` in the snapshot shows it
  never fires here).

## Costs

- Prime check: one cached-rect read + flag writes per attached wrapper,
  inside a slice that already read the rect.
- Build inside the drain slice: same total construction, moved earlier;
  one reflow per slice (cacheConstruction batching unchanged).
- slotAncestors: 3 WeakRefs per wrapper (~700 wrappers → negligible);
  slot matching walks only the limbo pool (bounded by churn, ~tens).
- No new observers, no new timers beyond the yield-chain the drain already
  uses.

## Risks

1. **Wedge discipline.** No new free-running rAF. The build continuation
   moves from rIC to the drainDiscovery-shaped yield chain — self-terminating
   on empty delta, single-flight, `isTornDown`-guarded (yield continuations
   aren't cancellable; same guard drainDiscovery ships). Re-run
   `scripts/_test-videos-tab-wedge.mjs` — load-bearing, has regressed before.
2. **Claim-churn loop.** Priming adds a claim producer. Tripwire:
   `reconcile_applied.last.claim` spiking against a quiet page. The prime is
   creation-edge-only, so a quiet page cannot re-trigger it.
3. **Slot mis-rebind.** A cell with two same-tag/role hintables refuses on
   uniqueness (fresh wrapper, today's behavior). Spot-check activations on
   slot-rebound badges during live verify; `rebind_slot` vs activation
   misroutes is the signal.
4. **Optimistic isInViewport wrong at the band edge.** IO's first delivery
   corrects it; the release path is the correct outcome for a genuine exit.
   Watch for flap via `reconcile_applied.last.release` on a static page.
5. **Pool econ unchanged by Part 1** (claims move earlier, not wider — the
   band gate is the same geometry the IO would apply a frame later).

## Validation

All against existing instrumentation, via the drill (reload extension,
close+reopen tab, fling, Ctrl+Alt+A):

- paint_latency: dom_seen_to_shown p50 < 200ms / p90 < 400ms;
  attached_to_band ~0 for primed wrappers; claimed_to_shown p90 < ~100ms.
- paint_stability ring (the ground truth): shown-count dip depth during a
  fling ≤ ~10–20 (from 60–110), no sag-and-recover cycle longer than ~300ms.
- rebind_counters: `rebind_slot` rising, `refuse_no_match` falling on the
  QuickBase grid; `refuse_distance` not rising (slot tier must not feed
  ambiguity into the fingerprint tier).
- reconcile_applied: `last.show` stays ~0 in steady scroll; `last.claim`
  quiet on static pages.
- Unit: prime geometry + wantsCodeword gating; slot-match uniqueness/refusal;
  wave-slice budget ordering (on-screen never starved); continuation
  single-flight + termination.
- Fixtures: `_test-videos-tab-wedge.mjs`, `_test-dual-cs-race.mjs`,
  `npm run soak:orphan`. Real-browser verify on production QuickBase
  (read-only; actuator.log breadcrumbs + snapshots) and YouTube /watch
  (sustained-scroll CPU vs the 22% baseline).

## Revert levers

- Part 1: prime is one call site in `attachDiscovered` + the tracker entry
  point; deleting both restores the IO-only claim path. Budget/scheduling
  constants revert independently.
- Part 2: slot tier is one branch in `attachDiscovered` + the recorded
  WeakRefs; deleting the branch restores two-tier rebind exactly.

## Plan sketch (to expand into the implementation plan after note review)

1. **Prime + counters** — `tracker.primeClaims`, band check in
   `attachDiscovered`, `lifecycleCounters.primedClaims`, unit tests. Verify
   attached_to_band collapse on production.
2. **Continuation re-schedule + unified budget** — yield-chain the band-build
   continuation, fold `DRAIN_DISCOVERY_BUDGET_MS`/`BAND_BUILD_BUDGET_MS`
   into `WAVE_SLICE_BUDGET_MS`, wedge fixture + full gates. Verify
   claimed_to_shown p90 + paint_stability fill slope.
3. **Re-measure the dip.** If ≤ ~10–20 shown, stop; Part 2 becomes optional
   perf (codeword-churn elimination) rather than perceptual necessity.
4. **Slot rebind** — slotAncestors recording, third tier + uniqueness map,
   `rebind_slot` counter, metadata refresh + queuePut, unit tests, live
   verify on the builder realm grid then production read-only.

Each step is its own commit with its own revert lever; gates (tsc, npm test,
both builds, wedge, dual-CS race, orphan soak) run per step.

## Open questions

1. `WAVE_SLICE_BUDGET_MS` value — start 32ms, measure `bandBuild:pass` +
   `drainDiscovery` CPU buckets on the fling profile before tuning.
2. ~~slotAncestors depth~~ ANSWERED from the existing snapshot (2026-07-03):
   grid hintables put the `td` at depth 1 (160), 2 (84), and **5** (60 —
   buttons under extra cell layers), so record to depth 6 / first row
   ancestor and match the deepest survivor. Folded into the mechanism above.
   The REMAINING unknown for this tier: does the cell shell actually survive
   the swap (in-place content replacement), or does QuickBase replace whole
   rows? A point-in-time snapshot can't say. Cheap to answer with a one-fling
   console probe on the builder realm (MO on a `td`: childList replacements
   vs `tr` removals) — but it doesn't gate anything: Part 1 lands first
   regardless, and the tier fails safe to today's behavior if shells die.
   Run the probe as the step-4 pre-check (or during any drill, if curious
   early).
3. Should the scan path (`processScanBatch`) also prime-build in-slice on
   initial load? It already claims inline; first-show latency is a different
   problem (showHints owns it). Initially: no.
4. Codeword-memory staleness on slot rebind — the fp-keyed memory entry
   points at the old record's fingerprint. Refresh via `rememberLive` at
   rebind, or accept decay (memory is a reload nicety, not correctness)?
   Lean: refresh, it's one call.

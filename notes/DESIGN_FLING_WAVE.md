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

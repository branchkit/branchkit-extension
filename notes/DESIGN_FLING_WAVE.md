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
  first ~3 parent elements. Three pointer reads, no layout, recorded once.
  (Post-hoc recovery is impossible — a removed subtree loses its parent
  chain at the detach point, so the slot must be remembered while attached.)
- **Match on discovery.** For a new element neither tier claimed: a limbo
  wrapper slot-matches iff one of its recorded slot ancestors is still
  connected AND `contains()` the new element, AND tag+role match, AND the
  match is unique both ways within this drain pass (exactly one limbo
  candidate for that slot, exactly one new element claiming it — a per-pass
  map enforces it). Ambiguity → refuse, fall through to fresh attach.
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
2. slotAncestors depth — 3 covers link→div→td on this grid; is there a
   grid that needs the `tr`? (Depth 4 is one more pointer; decide from the
   builder-realm harness, not speculation.)
3. Should the scan path (`processScanBatch`) also prime-build in-slice on
   initial load? It already claims inline; first-show latency is a different
   problem (showHints owns it). Initially: no.
4. Codeword-memory staleness on slot rebind — the fp-keyed memory entry
   points at the old record's fingerprint. Refresh via `rememberLive` at
   rebind, or accept decay (memory is a reload nicety, not correctness)?
   Lean: refresh, it's one call.

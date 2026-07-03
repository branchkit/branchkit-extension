# Paint the band — badges ride into view already painted

Date: 2026-07-03
Status: implemented 2026-07-03, live verify pending. All four seams landed:
predicate band-scoped (desired-state + plan + badgeNewlyCodeworded), budgeted
build queue extracted to `src/lifecycle/build-queue.ts` (runBuildPass +
createSingleFlight, unit-tested), write-time clamp in reconcileRead
(`clampOffscreenBadgeBox`, hints.ts) with the sweep deleted, huge-mutation
max-wait deadline (250ms). Gates green: tsc, 987 unit tests (predicate, clamp
geometry, build-queue budget/ordering), both builds, videos-tab-wedge fixture,
dual-CS race, orphan soak. Telemetry tells verified present:
`reconcile_applied.last.show` and debug-snapshot `painted_badges` /
`claimed_codewords` (snapshotExtras, content.ts). Real-browser verification
(QuickBase ride-in, YouTube /watch CPU vs 22% baseline, collapsed-drawer edge
bleed, occlusion flicker) pending.

Tuning round 1 (2026-07-03, after live check showed badges still slow): the
first cut's drain rate was the bottleneck, three compounding causes —
(1) the build loop placed per badge (append host → probe Range gBCR →
append …), a forced reflow PER badge that inflated per-badge cost well past
the 5-10ms estimate; (2) at that cost the 4ms budget built ~1 badge per sync
pass, deferring nearly everything; (3) the idle continuation re-entered with
the same 4ms (ignoring its rIC deadline) and, when rIC starved during
scroll, fired on the 200ms timeout with timeRemaining()=0 — one badge per
200ms, the visible one-by-one trickle. Fixes: build phase is now two-phase
like showHints (construct/show all, then ONE batched placeBadges), and the
continuation drains under its rIC deadline (capped 32ms, sync-budget
fallback on didTimeout). The 4ms sync budget stays as the mid-scroll frame
guard. Per-pass cost lands in the `bandBuild:pass` perf-counter bucket —
check it in the perf snapshot if paint still lags before touching budgets.

Tuning round 2 (2026-07-03, from a real production-QuickBase fling profile
read out of actuator.log breadcrumbs): discovery was NOT the bottleneck
(`band_discovery:added` = 0 — the MO path kept up); the build queue was
saturated for ~2.5s (`band_build:deferred` × 17, backlog peaking at 36,
~3 badges built per ~25ms pass ⇒ ~1.3ms per badge). The cost was three
COLD ancestor walks per badge construction — container resolution,
viewport-pinned check, APCA background resolution — live getComputedStyle
up a deep production chain that sibling rows almost entirely share. Fixes:
resolveBackgroundColor/resolveForegroundColor now read getCachedStyle, and
both build paths (badgeNewlyCodeworded, showHints) pre-warm the deduped
ancestor style chain via cacheVisibility(elements, 40) — depth 40 because
the pinned walk climbs to the root. Verification on the live production
table pending (user gesture + log re-read; the builder-realm harness lost
its extension to a chrome.runtime.reload() footgun — a --load-extension
extension cannot be re-enabled after runtime.reload(); relaunch instead).

Tuning round 3 (2026-07-03, second production fling profile): round 2's
style warm halved the wall-rate (~26 → ~14 ms/badge) but passes still built
only ~2-3 badges per 4ms budget. Residual cause: the container walks ALSO
read ancestor RECTS (getSpaceInAncestor) and DIMS (isScrollContainer /
isClipAncestor) — cold, and each construction appends its host (a layout
write), so the next badge's first cold layout read forced a reflow per
badge. Fix: `cacheConstruction(elements)` in layout-cache — rect + style +
dims for seeds + deduped ancestor chains (depth 40), batched before the
first append, capping the whole pass at ~one reflow. Both build paths use
it (cacheVisibility reverted to styles-only/depth-15 for its own caller).
Expected: per-badge cost drops toward pure construction (~0.3ms), a 4ms
pass builds ~12, a 70-badge churn wave drains in ~200ms. Production
re-verify pending.

Tuning round 4 (2026-07-03, after a Rango A/B on the same production
grid): Rango — identical container/placement walks, synchronous and
unbudgeted — populated near-instantly where we took ~2.5s. The arithmetic:
an 80-badge churn wave is only ~120ms of construction; the 4ms budget was
spreading it across seconds of 2-3-badge slices. The page tolerates burst
construction during a fling (its own row rendering is already dropping
frames), so the budget is a guardrail, not a smoothness tax:
BAND_BUILD_BUDGET_MS 4 → 12 (also the continuation's starved-rIC floor),
BAND_BUILD_IDLE_TIMEOUT_MS 200 → 100. Expected wall for an 80-wave:
~150-400ms. Production re-verify pending.

QuickBase-shaped residual, measured but NOT yet addressed: the grid
virtualizes rows, so wrappers churn hard mid-scroll (stale-flag repairs of
20-35 per settle, hosts oscillating ±40) — every recycled row is a fresh
wrapper paying full construction. Hint reuse can't help across element
identity. If the drain is still slow after the walk fix, the next levers
are (a) budget scaling when the backlog is large, (b) wrapper rebind for
recycled rows (fingerprint / limbo-style), (c) accepting the churn.

Why Rango still reads faster — the full causal decomposition (2026-07-03,
post-round-4, source-verified). Fresh-row-to-visible-badge, stage by stage:
Rango = MO-synchronous wrapper creation → IO → local label pop → one
trailing-100ms-debounced UNBUDGETED batch paint (whole wave, full opacity,
fade-in). Us = MO → rAF-budgeted discovery drain (8ms/frame) → IO → claim
queue → 50ms flush debounce → serialized async flush → build passes sliced
at 12ms across claim-flush/idle rounds → paint at 0.55 opacity
(bk-pending) → full opacity only on grammar push ACK (~0.4-1s later).
Three real causes, ranked by likely perceptual weight: (1) the bk-pending
TRANSLUCENT phase — Rango's badges are born solid, ours read "not there
yet" for up to a second after they paint; (2) burst vs slices — one
unbudgeted batch vs a 150-500ms spread; (3) two extra pre-paint stages
(discovery drain + claim debounce/flush), ~50-150ms of stacked coalescing
Rango doesn't have. NOT causes (verified): construction cost (same walks,
ours ported from theirs), DOM pooling (neither pools), virtualization
handling (both rebuild recycled rows), z-index (ours is cheaper).
Causes 1 and 3 are voice-architecture costs; cause 2 is a tunable
scheduling choice. Nothing unexplained remains.

Rango source read (2026-07-03, /tmp clone after the A/B; full report in
session log): corrects two assumptions above. (1) Rango does NOT pool or
rebind hint DOM — labels are pooled, but a removed element's Hint is
GC'd and a recycled row gets a fresh Hint built from scratch, same as us.
The rebind lever is NOT how Rango wins; deprioritize it. (2) Rango's
paint is not synchronous-in-IO either — it's a lodash.debounce(100ms)
queue that paints the ENTIRE accumulated wave in one unbudgeted batched
pass (cacheLayout over targets + descendants + 10 ancestors + text-node
Range rects, read/write phased, rAF fade-in). So its model is "one burst
per 100ms window", vs our "12ms slices per wave" — that unbudgeted batch
is the remaining structural difference if any tail persists. Where we're
already ahead: Rango's calculateZIndex runs querySelectorAll("*") +
UNCACHED getComputedStyle per hint at first position; ours is refine()-
deferred and cached per anchorParent. Rango also rect-polls every
observed target on a 50ms-throttled scroll listener (its stale-IO
defense; our reconcileTeardown equivalent) and switches to lazy wrapper
creation above 25k elements.

Companions: `notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md` (the
desired-state predicates this changes), `DESIGN_HINT_REUSE.md` (dormant badge
lifecycle, unchanged), `notes/completed/DESIGN_HINT_POSITIONING_REARCH.md`
(the doc-anchored host model this relies on), the inner-scroll accelerator
(`src/render/scroll-accel.ts`), `DESIGN_UNIFIED_RECONCILER.md` (the settle
pipeline whose show step this obsoletes).

## Symptom

Badges paint noticeably later than Rango's, worst while scrolling dense pages
(QuickBase grids). During a continuous scroll no new badges appear at all;
everything pops in ~100–200ms after the scroll stops.

## Root cause

Badge shown-ness is strict-viewport-scoped, and the only trigger that shows a
badge for content scrolling into view is the scroll-settle pipeline — a
trailing-edge 100ms debounce (`scheduleScrollReposition`, content.ts) that a
sustained scroll pushes back indefinitely. The chain today:

1. An element enters the IO band (`VIEWPORT_MARGIN_PX` = 1000,
   intersection-tracker.ts) and claims a codeword immediately (local, no IPC).
2. `badgeNewlyCodeworded` (content.ts) skips both construction and paint for
   any target off the actual viewport (`!onScreen → continue`).
3. When the target crosses the real viewport edge mid-scroll, no event fires —
   the band edge was the IO's only threshold. The show waits for
   `applyVisibilityPlan` inside `runSettlePipeline`, i.e. for the scroll to
   stop.

Rango has no step 2 or 3: it constructs and paints every hint inside its
1000px margin and lets them ride the page's scroll into view. Note our own
band comment (intersection-tracker.ts) already claims the per-badge work
happens "during the approach window" — but only the claim does; construction
and paint don't. This design completes that stated intent.

## The model change

One concept: **shown desired-state flips from strict-viewport to IO band.**
`wantsShown` (src/lifecycle/desired-state.ts) drops its `onScreen` term and
becomes `flagInBand && cssVisible`. A badge paints when its wrapper is
in-band, codeworded, category-matched, and CSS-visible — whether or not the
target is on the actual viewport — and rides into view already painted.

The infrastructure for the ride already exists:

- Flow targets' badge hosts are `position:absolute` at document coords
  (hints.ts `setupReconcileHost`), so they ride window scroll on the
  compositor with zero per-frame JS.
- Inner-pane scrolls (QuickBase grids, app shells) ride via the ScrollTimeline
  accelerator; the per-frame `reconcileScrollFrame` loop covers the rest.
- Placement is scroll-invariant off-viewport since the `Math.max(0, …)`
  viewport floor was deleted (d35201a) — off-viewport bake no longer corrupts
  the anchor offset.
- `reconcilePass` is reflow-dominated and ~independent of N (the C3
  measurement in the positioning re-arch note), so a band-sized registry
  (~2–3 viewports of badges) does not change the per-pass cost class.
- Hint reuse already keeps dormant badges' shadow DOM alive across viewport
  cycles, so the marginal DOM cost of "painted in band" over today's
  "constructed once, hidden" steady state is small.

Deliberately unchanged, both viewport-scoped by design:

- **The strict-viewport voice set.** What's speakable still tracks what the
  user can actually see; below-fold painted badges are invisible to the user
  and stay out of `_strict`. Consequence: a badge that rode in mid-scroll is
  visible but not voice-matchable until the settle ~100ms after the scroll
  stops. Users stop scrolling before speaking; accepted.
- **The occlusion pass.** `elementFromPoint` only works on-viewport, so a
  badge on a covered target paints anyway and is corrected at the next
  settle. Mid-scroll false positive instead of today's no-badge. Rango
  behaves the same; accepted (see risk 3).

## The four seams

### Seam 1 — the shown predicate and its consumers

- `wantsShown`: drop the `s.onScreen` term; remove `onScreen` from
  `ShownInputs`. The gather keeps reading rects (teardown and strict still
  need them); the plan (src/lifecycle/reconcile.ts) stops feeding `onScreen`
  into shown-ness.
- `badgeNewlyCodeworded` (content.ts): drop the `!onScreen` half of the
  `continue`; keep the `!cssVisible` half (hover-reveal targets must still
  not paint — no transition ever fires to clean them up).
- `showHints` keeps painting its strict-viewport `renderable` slice first —
  cheap prioritization of what the user is looking at — and the reconcile
  convergence that follows now paints (not just builds) the band remainder.
- The IO exit path is untouched: band exit still releases the codeword and
  drops the badge to dormant (hide + clearLabel), per DESIGN_HINT_REUSE.

### Seam 2 — budgeted construction (the real design content)

First-time `HintBadge` construction is the slow path (~5–10ms: shadow DOM,
anchorParent walk, z-index walk, APCA colors — refine is already deferred).
Today the viewport gate rations it; with the band painting, two bursts appear:

- First show on a dense page: the band is ~3 viewports, so ~2–3× today's
  construction volume at `showHints` time.
- Fast scroll into a fresh region: dozens of first-time wrappers enter the
  band inside one flush; an unbounded loop in `badgeNewlyCodeworded` could
  jank the main thread for hundreds of ms — mid-scroll, the worst moment.

Fix: a budgeted build queue, same pattern as the refine scheduler
(hints.ts, `REFINE_BUDGET_MS` = 4, idle-scheduled continuation):

- Each `badgeNewlyCodeworded` pass constructs **on-screen wrappers first,
  synchronously and unbudgeted** — the viewport is user-facing and its
  population is bounded by what fits on screen; it must never be starved by
  band pre-work.
- Off-viewport band wrappers construct under a per-pass CPU budget (~4ms,
  measure before fixing the value); the remainder queues for an
  idle-scheduled continuation (single-flight, rIC with timeout — the
  `runWhenIdle` pattern) that re-enters the build step only. No claim
  re-entry: claims are unchanged by this design, which is what keeps the
  73cf6e7 → b813e29 codeword-churn loop from re-arming.
- The dormant-reuse fast path (`setLabel` + `show`) is cheap and exempt from
  the budget.

### Seam 3 — retire the off-screen hide sweep via a write-time nudge

The sweep in `scheduleReposition` (content.ts) hides any visible badge whose
target rect is off the actual viewport. Under the new model it would fight
the plan: the settle's `applyVisibilityPlan` would re-show (wantsShown is now
band-scoped) whatever the sweep hid — a flap. The sweep's real purpose is one
artifact: a target parked off-screen (YouTube's collapsed nav drawer at
x=-228) whose badge box overhangs into the viewport edge.

Solve that geometrically at write time instead, then **delete the sweep**:

- In `reconcileRead` (hints.ts), when the target rect is *fully* off-screen,
  clamp the badge's viewport-relative box to the target's side of the
  viewport edge (for a left-parked target: badgeX + badgeW ≤ target.right).
  Uses the target rect the read already has and the cached `_size`; no new
  layout reads.
- The clamp is per-pass write-time only — never baked into the reconcile
  offset — so it cannot reintroduce the d35201a stranding bug (which was a
  *bake-time* clamp).
- Partially-visible targets are untouched (badge may straddle the edge; the
  target is legitimately visible). Below-fold targets never trigger it —
  their badge boxes are off-screen with them, which is the whole model.

The predicate stays pure (band && cssVisible), one mechanism instead of two,
and the sweep's deletion removes the last strict-viewport paint gate.

### Seam 4 — companion fix, not subsumed: discovery under mutation storms

Painting the band does nothing for DOM that doesn't exist yet. QuickBase's
virtualized grids *create* rows during scroll; a batch of ≥1000 foreign
records takes the huge-mutation path (mutation-source.ts), whose 50ms timer
is a trailing debounce with no deadline — a sustained storm keeps resetting
it, so rows aren't discovered until the scroll pauses. Give it the
debounce+deadline shape `whenDOMSettles` uses (trailing 50ms, max-wait
~250ms). Small, orthogonal, ships with this design because the user-facing
goal — badges keep up with a QuickBase scroll — needs both. (The sub-1000
path already streams through the rAF drainer at 8ms/frame and is fine.)

## Costs

- Per-frame scroll cost: unchanged in kind. Doc-anchored badges ride the
  compositor; the bounded `reconcileScrollFrame` loop and `reconcilePass`
  stay as they are, with a band-sized registry (reflow-dominated, ~flat in N).
- Total construction work: unchanged, moved earlier and sliced. Refine queue
  grows to band size — already budgeted.
- Painted-DOM steady state: band-sized instead of viewport-sized. Hint reuse
  already pays most of this; the delta is visibility + earlier construction.

## Risks

1. **Wedge discipline.** No new free-running rAF anywhere in this design; the
   build continuation is idle-scheduled single-flight. Re-run the nav-time
   wedge fixture (`scripts/_test-videos-tab-wedge.mjs`) before merge — the
   wedge fix is load-bearing and adjacent-perf work has regressed it before.
2. **Churn-loop history.** The build continuation re-enters only the build
   step; claims and releases are byte-for-byte unchanged. `reconcile_applied`
   counters are the tripwire: `claim` spiking against a quiet page means the
   continuation is leaking into claims.
3. **Occlusion false positives on ride-in (QuickBase).** A briefly-wrong
   badge mid-scroll, corrected at settle. If it reads as flicker in practice,
   the follow-up is an occlusion check at first *viewport* entry (not band
   entry) — do not pre-build that without evidence.
4. **Drawer-class artifacts.** Any target parked off-screen whose badge the
   old sweep was hiding now paints (clamped). Verify the YouTube collapsed
   drawer shows no edge bleed; the clamp geometry has unit tests.

## Validation

- Unit: desired-state predicate tests, clamp geometry tests, build-queue
  budget/ordering tests (on-screen never starved; continuation single-flight).
- Fixtures: `_test-dual-cs-race.mjs` and `npm run soak:orphan` untouched by
  design (no injection/teardown changes) — run anyway.
- Real-browser (Playwright is not authoritative for this): QuickBase grid
  scroll — badges ride in painted; YouTube /watch — sustained-scroll CPU
  compared against the 22%-burn baseline that motivated the settle debounce;
  YouTube collapsed drawer — no edge bleed; occlusion flicker assessment.
- Telemetry tells: `reconcile_applied.last.show` should drop to ~0 in steady
  scrolling (paint now happens at build time); debug-snapshot
  `painted_badges` converges toward `claimed_codewords` (band size) instead
  of sitting below it.

## Revert lever

Restore the `onScreen` term in `wantsShown` + the `!onScreen` skip in
`badgeNewlyCodeworded` + the off-screen hide sweep (one commit, isolated);
the clamp and build queue are inert under the restored predicate.

## Open questions

1. Construction budget value — start at 4ms (refine's number), measure on
   QuickBase and YouTube /watch before tuning.
2. Band width — `VIEWPORT_MARGIN_PX` stays the single source of truth
   (teardown/plan geometry must keep using it; the 200-vs-1000 drift bug).
   If low-end machines struggle with band-sized paint, shrinking the band is
   the knob — not reintroducing a viewport paint gate.
3. Does the settle pipeline's show step (`applyVisibilityPlan` toShow) retain
   any real work once paint is band-scoped? Expected residual: cssHidden
   transitions and stale-flag repairs. If `show` counts sit at ~0 after soak,
   fold the step into the repair path and simplify.

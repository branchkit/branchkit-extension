# Plan — fling wave (DESIGN_FLING_WAVE.md)

Date: 2026-07-03. Design note approved same day. Four steps; each is its own
commit with its own revert lever. Gates per step: tsc, npm test, both builds,
`scripts/_test-videos-tab-wedge.mjs`, `scripts/_test-dual-cs-race.mjs`,
`npm run soak:orphan`. Steps 1–2 are Part 1 (wave collapse); step 3 is the
production re-measure that decides whether Part 2 is perceptual necessity or
optional perf; step 4 is Part 2 (slot rebind).

## Step 1 — prime claims at attach

**`src/observe/intersection-tracker.ts`**
- `primeClaims(wrappers: ElementWrapper[]): void` — for each wrapper without
  a codeword, add to `pendingClaim`; `scheduleFlush()` once if any were
  added. Callers are responsible for the band check and the `isInViewport`
  write (the tracker only ever learns band state from IO entries or callers
  that just proved geometry).

**`src/core/wrapper-lifecycle.ts`** (`attachDiscovered`)
- Collect the wrappers `attachWrapper` actually attached this call.
- One `vw/vh` read per call, then per wrapper: `getCachedRect(w.element)`
  (warm from the scan walk when cache is populated; live fallback is
  counted), skip the all-zeros boxless rect (mirror
  `computeReconcilePlanLists`' guard — the IO decides those later), test
  `geometryInBand(rect, vw, vh, VIEWPORT_MARGIN_PX)` (import the predicate
  from `lifecycle/reconcile.ts`; margin from the tracker — single source of
  truth).
- In-band: `w.isInViewport = true`, `w.tInBand ??= performance.now()`,
  `lifecycleCounters.primedClaims++`, collect.
- Tail: `pageSession.tracker.primeClaims(primed)`. The flush microtask runs
  at the end of the same task; `doFlush → onCodewordsChanged → reconcile →
  badgeNewlyCodeworded → placeBadges` is already synchronous from there —
  no other wiring.
- Scan path (`processScanBatch`) untouched: it claims inline pre-POST and
  its wrappers arrive codeworded, so a hypothetical prime would no-op.

**`src/debug/perf-counters.ts`** — `primedClaims` on `LifecycleCounters`.

Tests: tracker `primeClaims` (skips codeworded wrappers, single flush,
claims flow to `onCodewordsChanged`); `geometryInBand` cases already exist —
add the boxless-skip + in/out-of-band prime decision as a pure-logic test if
extraction is warranted, else cover via tracker test.

Verify (drill): `attached_to_band` collapses for the fresh-row cohort;
`primedClaims` in the perf snapshot confirms cohort size;
`reconcile_applied.last.claim` stays quiet on a static page (risk 2 tripwire).

Revert: delete the prime block + `primeClaims` (two sites).

## Step 2 — yield-chain the build continuation, unify the slice budget

**`src/lifecycle/build-queue.ts`** (or a tiny sibling module)
- `export const WAVE_SLICE_BUDGET_MS = 32;`
- `export function scheduleYieldTask(cb: () => void): void` — the exact
  shape `drainDiscovery` ships inline today: prefer `scheduler.yield()`
  (continuation at the front of the task queue), fall back to a
  `pageSession.resources.timeout(cb, 0)` (session-owned, torn down with the
  session). Extracted so the two chains cannot drift.

**`src/observe/mutation-source.ts`**
- `drainDiscovery` uses `scheduleYieldTask` for its chain and
  `WAVE_SLICE_BUDGET_MS` as its walk budget (replaces
  `DRAIN_DISCOVERY_BUDGET_MS = 8`). The composed task is walk (≤ budget) +
  the same-task flush microtask's build (≤ budget) — worst case ~2× slice,
  stated in a comment; the burst-model rationale from round 4 covers it.

**`src/content.ts`**
- `scheduleBandBuildContinuation = createSingleFlight(scheduleYieldTask,
  () => { if (pageSession.isTornDown || !pageSession.hintsVisible) return;
  badgeNewlyCodeworded(); })` — the `isTornDown` guard is load-bearing
  (yield continuations are not cancellable; same contract as
  drainDiscovery's top-of-function guard).
- `badgeNewlyCodeworded` default budget → `WAVE_SLICE_BUDGET_MS`. Delete
  `BAND_BUILD_BUDGET_MS`, `BAND_BUILD_IDLE_TIMEOUT_MS`,
  `BAND_BUILD_IDLE_BUDGET_CAP_MS`, and the IdleDeadline plumbing in the
  continuation. `runWhenIdle` itself stays (the discovery sweep at
  content.ts:1874 still uses it).
- Termination argument (wedge): single-flight; re-arms only when
  `runBuildPass` returns deferred > 0; every pass builds ≥1 first-time
  off-screen item (budget checked before each, elapsed starts at 0), so the
  backlog strictly shrinks and the chain self-terminates.

Tests: `scheduleYieldTask` (yield path, fallback path, teardown inertness);
existing build-queue budget/ordering tests keep passing; continuation
single-flight test updated for the new scheduler.

Verify (drill): `claimed_to_shown` p90 collapses (was 401ms);
`dom_seen_to_shown` p50 < 200ms; paint_stability fill slope; wedge fixture
green (mandatory — this step touches scheduling).

Revert: constants + scheduler swap, one commit.

## Step 3 — production re-measure (user drill; decides step 4's framing)

Reload extension, close+reopen tab, fling, Ctrl+Alt+A. Read:
- paint_latency: dom_seen_to_shown p50/p90 vs the 328–565ms baseline;
  attached_to_band for primed wrappers.
- paint_stability ring: dip depth during a fling vs the 60–110 baseline.

Dip ≤ ~10–20 → Part 2 is optional perf (codeword-churn elimination on
recycle: still 228 constructions + release/claim cycles per fling, just no
longer visible). Dip still perceptible → Part 2 is the perceptual fix, as
designed.

## Step 4 — slot rebind (third tier)

Pre-check (builder realm only — NEVER production): one fling with a console
MutationObserver on a `td.column-*` cell, counting childList replacements
inside surviving cells vs whole-`tr` removals. Confirms the surviving-shell
premise before code. If shells die with the rows, stop here and file the
outcome in the design note (the tier would never fire on QuickBase; keep it
unbuilt until another recycler grid shows up).

Implementation (per the design note, mechanism section):
- `ElementWrapper.slotAncestors: WeakRef<Element>[]` recorded at
  `attachWrapper` — parents up to depth 6 or the first `tr`/`role=row`.
- `attachDiscovered` third tier after strong-key and fingerprint: deepest
  still-connected recorded ancestor that `contains()` the new element,
  tag+role equality, two-way uniqueness within the drain pass (per-pass
  `Map<Element, {limbo, candidates}>`), refuse on ambiguity.
- On match: `rebindWrapper` + `refreshFingerprint` + `scanSingle` metadata
  refresh + `queuePut` + `rememberLive` refresh (open question 4's lean) +
  `orphanedByKeyRebind` marking. Counter: `rebind_slot`.
- Tests: uniqueness/refusal matrix, deepest-survivor selection, ping-pong
  guard interaction, no-slot-recorded fallthrough.

Verify (drill): `rebind_slot` rising, `refuse_no_match` falling,
`refuse_distance` flat; dip flat through flings; spot-check activations on
slot-rebound badges (misroute check); pool econ via claim counters.

Revert: delete the tier branch + the WeakRef recording.

## Sequencing with parallel sessions

Extension repo only; commit locally, never push; stage
`src/... notes/...` paths narrowly at commit time. Steps 1 and 2 land as
separate commits same session; step 3 is the user's drill; step 4 waits for
step-3 data + the builder-realm probe.

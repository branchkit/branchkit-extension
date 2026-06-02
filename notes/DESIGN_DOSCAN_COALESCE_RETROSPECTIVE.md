# Was doScanBatched the Real Problem? — Retrospective

**Status:** Open question. Coalesce fix landed and verified empirically; need to
re-evaluate the chain of optimizations made on the way to discovering it.

## TL;DR

Spent a long session iterating on perceived hint paint latency. Tried label
reservoir, microtask flush, hint instance reuse, two-pass paint with deferred
observer setup, default-then-APCA color swap (reverted), inner-pane scroll
backstop, stacking-context z-index, plus more.

Then a 30-line `scheduleDoScan()` coalesce fix dropped browser-measured
main-thread long-task time from **11,224 ms → 118 ms** (99% reduction),
max single freeze from **1,175 ms → 66 ms**, and `doScanBatched`'s max
from **898 ms → 127 ms**, all over a comparable scroll session.

**Hypothesis:** the back-to-back `doScanBatched` pair fired by
`storage.onChanged` (alphabet adoption + domain rules + badge settings,
all delivered within ~22 ms at page load) was the *primary* cause of the
"laggy paint" symptom we'd been chasing. The other optimizations may have
been compensating for it rather than addressing it.

If true, we should revisit whether some of those optimizations are still
load-bearing or are now sunk cost with maintenance overhead but no benefit.

## What we observed before the coalesce fix

From a 32-second QuickBase scroll session, perf snapshot recorded:

- 56 long tasks (>50 ms main-thread freezes), total 11,224 ms, max 1,175 ms
- 5 `doScanBatched` calls totaling 2,684 ms — but the worst two fired
  **22 ms apart** at page load (898 + 802 = 1.7 s back-to-back)
- 1 `placeBadges:show` call of 262 ms (the second doScanBatched cascading
  into a full repaint)

The user's perceived experience: "things feel slow and chunky on QuickBase
tables." Initial diagnosis: per-badge construction work in the hot path.

## What we built in response

Roughly chronologically, each with its motivating diagnosis:

1. **Rango-style ratio nudge + skip clamp in anchor mode** — placement
   correctness on flush-left text. `branchkit-extension/src/placement/rango.ts`.
   Independent of the lag; correctness fix. **Keep.**

2. **Stacking-context z-index port from Rango** — modals were getting
   covered by hint badges. `src/placement/stacking.ts`. Correctness fix.
   **Keep.**

3. **Badge appearance settings UI** — user-tunable scale / min / max
   font + nudge ratios via the options page. `options.html`,
   `src/badge-settings-storage.ts`, `src/options.ts`. Feature work,
   unrelated to perf. **Keep.**

4. **Inner-pane scroll triggers band discovery** — fixed the "missing
   items" bug on QuickBase. Patched a real structural gap (window scroll
   listener didn't catch inner-pane scrollers). `src/content.ts`.
   **Keep.**

5. **HintBadge reuse across viewport cycles** — phase 1+2 of the reuse
   refactor. Hints stay alive after IO exit, get reused on scroll-back
   via `setLabel`. Real benefit observed (reuse ratio ~75% on later
   scroll runs). `src/render/hints.ts`. **Keep.**

6. **Local label reservoir** — replaces per-claim `CLAIM_LABELS` IPC with
   a synchronous local pool, refilled async. `src/labels/label-reservoir.ts`.
   Real benefit for cold-SW case; modest benefit warm. **Keep.**

7. **In-SW stack cache** — `loadStack`/`saveStack` no longer hit
   `chrome.storage.session` on every call. `src/labels/label-pool.ts`.
   Cheap, real, **keep.**

8. **IO flush debounce removed (16ms setTimeout → queueMicrotask)** —
   shaved ~16 ms off each claim flush. `src/observe/intersection-tracker.ts`.
   Modest benefit, no regression. **Keep.**

9. **Two-pass paint refactor (phase 1, 2, 3)** — split `HintBadge`
   construction into a fast path (visible) + `refine()` (deferred
   observer setup). Phase 2's color default-then-APCA swap caused a
   visible flash and was reverted; remaining is observer registration
   deferred via `requestIdleCallback`. `src/render/hints.ts`.
   **Question this one. See "Re-evaluate" section.**

10. **`scheduleDoScan` coalesce** — the change that produced the headline
    99%-reduction-in-long-tasks improvement. `src/content.ts`.
    **Definitely keep.**

## What the data suggests

Looking at the post-coalesce metrics, the previously-feared per-badge
construction cost looks much less critical:

- `placeBadges:show` max went from 262 ms to 21 ms (without any per-badge
  changes — just because the doScanBatched cascade isn't there to force
  a repaint of every visible badge at once)
- Long-task max dropped to 66 ms — meaning per-badge work, even in bursts,
  isn't blocking the main thread for more than one frame
- `host_added` count dropped from 627/32s to 155/61s — partly different
  page, but also reflecting that the HintBadge reuse is now picking up
  most scroll-back transitions

The "lag" the user perceived was real. But the dominant cause was likely
the two doScanBatched calls firing in lockstep at page load, plus the
followup `placeBadges:show` repaint they triggered. ~2 seconds of frozen
main thread in the first ~2 seconds of the session is exactly the
"loading feels slow" symptom.

## Re-evaluate

The two-pass paint refactor is the work most worth questioning. Its
explicit motivation was: "per-badge construction is too expensive on the
hot path; defer the non-visible-affecting work." If per-badge construction
*wasn't* actually the bottleneck — if the doScanBatched cascade was —
then the deferred-observer infrastructure costs maintenance burden for
modest real benefit.

What it added:
- `refine()` method on `HintBadge` (separate from constructor)
- `_refined`, `_removed` instance flags
- Module-level scheduler with `requestIdleCallback` + fallback timer
- `unscheduleRefine()` plumbing in remove() and retarget()
- A test-mode flag (`__refineScheduler.setImmediate`) to keep the
  observer-state-assertion tests working
- Allowing `data-bk-shown` through the host-attribute tracker so tests
  can observe visibility transitions (this is independently useful, OK)

Net savings: ~2-4 ms per badge of observer setup, moved off the
synchronous hot path onto `requestIdleCallback`.

For a typical IO-driven scroll batch of ~5-10 new wrappers, that's
~10-40 ms of deferred work per batch. Real, but small compared to what
the coalesce fix saved.

**Open questions about the two-pass paint:**

1. **Is `requestIdleCallback` actually firing fast enough on QuickBase?**
   On a busy page, rIC's default timeout is 200 ms — if it hits the
   timeout fallback, refinement is consistently delayed. Worth measuring
   how long badges spend in the unrefined state on real-world workloads.

2. **Does the visible-but-unrefined window cause any observable bugs?**
   For ~16-200 ms after first paint, the four observers (target mutations,
   host attributes, container resize, scroll ancestor) aren't active.
   In theory this could leave a window where page scripts mutate our
   host or the layout shifts and we don't react. Hard to detect without
   a reproducible site that exercises it.

3. **Would removing the deferral hurt now that doScanBatched is fixed?**
   Worth measuring: a build with the deferral removed (refine() inline
   in the constructor again) vs current. If the perf delta is small
   (e.g., < 30 ms on a fresh QuickBase scroll), the maintenance cost
   may not be worth the savings.

## Other things to question

- **`refine()`-as-API.** The split is in place; consumers (well, just
  the constructor + remove + retarget) handle it. But if we collapse
  refine back into the constructor, the `_refined` flag, scheduler,
  test-mode toggle, and host-attribute-tracker allow-list for
  `data-bk-shown` all become unnecessary. We'd want to keep
  `data-bk-shown` (it's useful as a debug surface independent of the
  scheduler).

- **Label reservoir.** Big win specifically for cold-SW case (MV3 idle
  termination is real). For warm SW, the savings is ~5-10 ms per claim
  batch. The added complexity (refill timing, drain-on-test, sync API
  for the IO hot path) is moderate. Probably keep unless someone proves
  the SW stays warm enough that the round-trip is negligible.

- **Microtask flush.** Trivial change, ~16 ms saved per flush, no
  maintenance burden. Definitely keep.

## Recommended next steps

1. **Commit everything as-is.** The data confirms the cumulative gains;
   reverting partially would lose verified wins.

2. **Build an A/B test harness** — same Playwright session, same
   QuickBase scroll, but toggleable feature flags for:
   - Coalesce (already on by default; this is the known good baseline)
   - Two-pass paint (`__refineScheduler.setImmediate(true)` simulates
     "no deferral" mode)
   - Label reservoir (harder to A/B — would need a switch)

   Run the same scroll trace under each combination, compare long-task
   metrics. Decide which optimizations earn their keep.

3. **Investigate the 2,288 ms max-gap-between-paints** that remains
   even after the coalesce fix. It's a different shape from the freezes
   (no single 2 s long task) — likely the rIC scheduler being slow to
   fire on a busy page, or a `discoverInSubtree` budget pass that's
   yielding for a long time. Investigate via the firehose or by adding
   another bucket label around drainDiscovery's between-pass wait.

4. **Optionally**, after the A/B data lands, propose a simplification
   PR that removes optimizations the A/B shows aren't earning their
   complexity.

## What this means for future debugging

The pattern to take away: **measure the actual blocking task, not the
suspected hot path.** We spent significant effort on per-badge
construction cost because that was the visible-symptom-aligned mental
model. The browser's PerformanceObserver longtask counter (which BranchKit
already records under `perf.cpu.longtask`) was the canonical signal —
and pointed at `doScanBatched` all along. Earlier inspection of that
field would have surfaced the coalesce opportunity sooner.

Going forward, the first move on any "BranchKit feels slow on X" should
be: pull the longtask top-10 from `perf.cpu.longtask.top`, find the
`when` timestamps, correlate against the CPU bucket `top` entries with
matching timestamps. If the buckets line up, you've found the actual
blocker. Optimizations elsewhere are speculation until that picture
exists.

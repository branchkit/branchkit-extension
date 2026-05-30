# Nav-Time Rescan: Slicing the Full-Page-Swap Discovery Walk

A same-document YouTube `/watch → /watch` navigation freezes Firefox's
main thread for ~1.1s. Attribution is settled: the cost is ours, not
YouTube's. This doc records the root cause and the fix.

## Status

| Step | What | Status |
|---|---|---|
| 0 | Attribution gate (extension-off A/B control) | Done (2026-05-30) |
| 1 | Root-cause trace | Done (2026-05-30) |
| 2 | Design | This doc |
| 3 | Implementation | Pending |
| 4 | Verify on real Firefox (A/B re-run) | Pending |

## Attribution (why this is ours)

Same nav, same instrumentation (page-injected 100ms heartbeat +
watchdog), the only variable is whether the extension is loaded. Driver:
`scripts/_drive-firefox-nav-ab.mjs`.

| Metric | Control (no ext) | Extension on |
|---|---|---|
| reads timed out (4s cap each) | 0/31 | ~30/31 (protocol pipe died) |
| heartbeat advance over window | 263 ticks (~free) | 29 ticks (frozen) |
| worst watchdog stall | 531ms | 1171ms |

The control stays live; the extension-on arm wedges so hard the Playwright
juggler pipe stops responding. The nav-time wedge is the extension's. (This
is the opposite of the scroll-soak freeze, which the same gate attributed
70–95% to YouTube's own layout — see `INVESTIGATION_YOUTUBE_WATCH_PERF.md`.)

## Root cause

On `/watch → /watch`, YouTube replaces the entire page DOM. That fires
≥1000 mutations in one batch, tripping the huge-mutations short-circuit in
the global MutationObserver:

`src/content.ts:2594`
```
if (foreign.length >= HUGE_MUTATIONS_COUNT) {           // 1000
  pageSession.hugeMutationTimer = setTimeout(() => {
    dropDisconnectedWrappers();
    const added = discoverInSubtree(document.body ...); // <-- synchronous, line 2603
    if (added > 0) schedulePushGrammar();
    if (pageSession.hintsVisible) scheduleReposition();
  }, HUGE_MUTATION_IDLE_MS);                             // 50ms
  return;
}
```

`discoverInSubtree(document.body)` (`content.ts:2103`) is one unbroken
task: `scanElements` walks the whole fresh page (`scan/scanner.ts`
`collectHintables` — `deepQuerySelectorAll`, `cacheVisibility`, then the
`isVisible`/`isRedundant` loop), then an `attachWrapper` per survivor
(`content.ts:2115-2127`, each doing `tracker.observe` +
`resizeObserver.observe` + `idRegistry.register`). On a ~1000+ element page
that is ~1000–1200ms in a single main-thread task — the freeze.

## Why the existing 8ms budget does not save us

`drainDiscovery` (`content.ts:2450`) has a `DRAIN_DISCOVERY_BUDGET_MS = 8`
cap, so it is tempting to think the HUGE_MUTATIONS path just needs to be
routed through it. It does not help:

- The budget check (`content.ts:2495`) breaks *after* a root's
  `discoverInSubtree` returns. It slices **between** roots, not within one.
- The loop deliberately always runs at least one root to completion
  (comment at 2444-2447) so a single heavy root can't starve the queue.

A single `document.body` root therefore runs unsliced regardless. The
budget is a between-roots budget; the freeze is one root that is the whole
page. The real lever is **intra-root slicing**.

The codebase already has an intra-root sliced walk: `doScanBatched`
(`content.ts:1216`) drives `scanInBatches` (`scan/scanner.ts`), yielding
`await new Promise(r => setTimeout(r, 0))` every `DEFAULT_SCAN_BATCH_SIZE`
(50) survivors. That path does not freeze. The fix is to make the
full-page-swap discovery use a sliced walk too.

## Options

**A. Sliced `discoverInSubtree` for large roots.** Give `discoverInSubtree`
an async/batched variant that yields between attach-batches (same
`setTimeout(0)` cadence as `scanInBatches`), used when the root is the
document body (or its element count crosses a threshold). Small mutation
roots keep the synchronous fast path (they're cheap and yielding adds
latency). Preserves the limbo-rebind semantics (`tryRebindFromLimbo`) that
let badges reappear after the swap.

- Pro: targeted, keeps the HUGE_MUTATIONS structure, reuses the proven
  batch cadence, no contract change.
- Con: a second discovery code path to keep in sync with the sync one.

**B. Route the HUGE_MUTATIONS path to `doScanBatched`.** The full-page swap
*is* a fresh full scan, which is what `doScanBatched` is built for.

- Pro: no new batched-discovery code; reuses the canonical full-scan path.
- Con: different contract. `discoverInSubtree` only attaches wrappers +
  `schedulePushGrammar`; `doScanBatched` runs the full claim→POST→paint
  pipeline (plugin round-trips, codeword reclaim). Changes when/how badges
  repaint after a swap and couples the always-mode mutation path to the
  plugin POST path. Higher blast radius.

**C. Generic intra-root slicing in `drainDiscovery`.** Make the within-root
walk itself sliceable and route HUGE_MUTATIONS through the normal
`scheduleDiscovery(document.body)` queue.

- Pro: one discovery path; the budget finally means what it says.
- Con: largest change; `discoverInSubtree`'s mid-walk yield has to be safe
  against concurrent mutations (the page is still settling), and every
  drain caller inherits the new async shape.

## Recommendation

**Option A.** Smallest change that removes the freeze, reuses the existing
50-per-batch yield cadence, and leaves the badge-repaint contract and the
plugin POST path untouched. The duplicated walk is the accepted cost; if a
second caller ever needs sliced discovery we revisit Option C.

Threshold: slice when `root === document.body` (the full-swap case) or the
candidate count exceeds a batch-sized bound; otherwise keep the synchronous
path. Tune against the A/B driver — target is heartbeat advance back near
the control's ~250 ticks with no single watchdog stall over one batch's
worth of work.

## Verification

Re-run `scripts/_drive-firefox-nav-ab.mjs` (control + `BK_NAV_EXT=1`) on the
same `/watch → /watch` nav. Success = extension-on arm recovers reads, beat
advances ~250, worst stall drops from 1171ms to a single-batch bound. The
page wedges too hard to ship its own perf snapshot, so confirm out-of-band
via the `cs_*` DEBUG_LOG lines in `actuator.log`.

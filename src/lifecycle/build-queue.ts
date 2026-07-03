/**
 * BranchKit Browser — the band-build queue core (notes/DESIGN_PAINT_THE_BAND.md
 * seam 2), extracted pure so its budget/ordering contract is unit-testable.
 *
 * Shown-ness is IO-band scoped, so a build pass can see two bursts: first
 * show on a dense page (~2-3 viewports of first-time construction) and fast
 * scroll into a fresh region (dozens of first-time wrappers entering the band
 * in one flush). An unbounded loop would jank the main thread for hundreds of
 * ms — mid-scroll, the worst moment. The contract:
 *
 *   - On-screen items build first, synchronously and unbudgeted — the
 *     viewport is user-facing and its population is bounded by what fits on
 *     screen; it must never be starved by band pre-work.
 *   - Off-screen items build under a per-pass CPU budget, EXCEPT the dormant
 *     reuse fast path (`isFirstTime` false — setLabel + show, no
 *     construction), which is cheap and exempt.
 *   - The budget-deferred remainder is counted, not queued: the caller
 *     schedules a level-triggered continuation that re-derives the whole
 *     delta, so a deferred item that left the band in the interim simply
 *     drops out.
 */
/**
 * The wave-slice CPU budget shared by the discovery drain's walk and the
 * build pass (notes/DESIGN_FLING_WAVE.md Part 1). One constant, two
 * consumers: `drainDiscovery` yields between roots past it, and
 * `badgeNewlyCodeworded` defers off-viewport first-time construction past
 * it. Because the claim flush (and therefore the build) runs in the
 * microtask tail of the drain's own task, a composed slice worst-cases at
 * ~2× this value — sized for a BURST, not a smooth frame (paint-the-band
 * rounds 4+6): mid-fling the page is already dropping frames from its own
 * row rendering, and users read "badges are there" long before they notice
 * frame pacing. The budget survives as a guardrail against pathological
 * waves, not as a smoothness tax. Tune from the `bandBuild:pass` /
 * `drainDiscovery` CPU buckets, not by feel.
 */
export const WAVE_SLICE_BUDGET_MS = 32;

export function runBuildPass<T>(
  items: T[],
  opts: {
    isOnScreen(item: T): boolean;
    /** True when building this item takes the slow construction path (the
     * budgeted class); false for the cheap dormant-reuse fast path. */
    isFirstTime(item: T): boolean;
    build(item: T): void;
    budgetMs: number;
    /** Clock override for tests; defaults to performance.now. */
    now?: () => number;
  },
): number {
  const now = opts.now ?? (() => performance.now());
  const onScreen: T[] = [];
  const offScreen: T[] = [];
  for (const item of items) {
    (opts.isOnScreen(item) ? onScreen : offScreen).push(item);
  }
  for (const item of onScreen) opts.build(item);
  let deferred = 0;
  const start = now();
  for (const item of offScreen) {
    // Budget check BEFORE each first-time construction: the first one always
    // runs (elapsed 0), so a pass makes forward progress even when a single
    // construction blows the budget by itself.
    if (opts.isFirstTime(item) && now() - start >= opts.budgetMs) {
      deferred++;
      continue;
    }
    opts.build(item);
  }
  return deferred;
}

/**
 * Single-flight wrapper: collapse any number of trigger calls into one
 * scheduled `run`, re-armable after it fires. The band-build continuation
 * uses this over `runWhenIdle` so a burst of build passes schedules exactly
 * one idle re-entry. Whatever the scheduler passes its callback (e.g. the
 * rIC IdleDeadline) is forwarded to `run`.
 */
export function createSingleFlight<Args extends unknown[]>(
  schedule: (cb: (...args: Args) => void) => void,
  run: (...args: Args) => void,
): () => void {
  let scheduled = false;
  return () => {
    if (scheduled) return;
    scheduled = true;
    schedule((...args: Args) => {
      scheduled = false;
      run(...args);
    });
  };
}

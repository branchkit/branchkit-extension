/**
 * BranchKit Browser — Hint allocator.
 *
 * Decides which codeword goes to which hint candidate. Closer-to-focus
 * candidates rank earlier and pair with front-of-pool codewords. The
 * per-tab pool is balanced square-fill (label-pool.ts:buildPool), so rank
 * order × pool order gives the closest hints a grid of distinct prefixes ×
 * distinct suffixes — both spoken stages stay meaningful for the elements
 * you'll most likely target.
 *
 * Design: notes/DESIGN_BROWSER_HINT_ALLOCATOR.md.
 *
 * Polymorphism: the allocator works over `HintCandidate`, not
 * `ElementWrapper`. ElementWrapper adapts via `wrapperToCandidate` (in
 * its own module so this file stays import-free of element-wrapper). A
 * future TextTokenWrapper for hints inside contenteditable regions can
 * adapt the same way and reuse this allocator unchanged.
 */

/**
 * Subset of DOMRect the allocator actually reads. Accepting a structural
 * type means tests can pass plain objects and callers can pass
 * `Element.getBoundingClientRect()` results directly.
 */
export interface HintRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The allocator's view of a hintable thing.
 *
 * `oldCodeword` is reserved for a future stability metric (DESIGN section 2
 * metric 1). Sprint C ships rank-and-pair, where the metric stack is
 * mostly a no-op; the field is on the interface now so the metric can
 * be wired in later without a signature break.
 */
export interface HintCandidate {
  /** Stable identifier for this allocation pass. */
  id: string;
  /** Viewport-relative bounding rect for distance ranking. */
  rect: HintRect;
  /**
   * Codeword this candidate held in the prior allocation pass, if any.
   * Currently unused; reserved for promotion to a multi-metric chooser.
   */
  oldCodeword?: string;
}

/** A 2D point in viewport coordinates (same space as rect.left / rect.top). */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Resolve the user's focus to a viewport point. Tries the caret position
 * inside an editable element, then the active element's center, then
 * falls back to viewport center. Pure with respect to its DOM read; safe
 * to call repeatedly.
 *
 * Lives in this module so the allocator's full pipeline is co-located,
 * but takes no arguments — callers pass the returned point into
 * `rankByDistance` so the comparator stays pure-functional.
 */
export function getFocusPoint(): Point {
  const w = typeof window !== 'undefined' ? window : null;
  const d = typeof document !== 'undefined' ? document : null;
  const fallback: Point = {
    x: (w?.innerWidth ?? 0) / 2,
    y: (w?.innerHeight ?? 0) / 2,
  };
  if (!w || !d) return fallback;

  const sel = w.getSelection?.();
  if (sel && sel.rangeCount > 0) {
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    if (rect.width > 0 || rect.height > 0) {
      return { x: rect.left, y: rect.top };
    }
  }

  const active = d.activeElement;
  if (active && active !== d.body) {
    const r = active.getBoundingClientRect();
    if (r.width > 0 || r.height > 0) {
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    }
  }

  return fallback;
}

/**
 * Squared Euclidean distance from `p` to the rect's center. Squared
 * because we only ever compare distances; sqrt is wasted work.
 */
function distanceToRect(p: Point, r: HintRect): number {
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  return dx * dx + dy * dy;
}

/**
 * Build a comparator that ranks candidates by viewport-distance from
 * `focus`. Closer = ranks earlier (negative return).
 *
 * Tiebreaker is top-then-left so candidates at numerically identical
 * distance fall out in reading order, which is what the user expects
 * when the visual difference is imperceptible.
 */
export function rankByDistance(focus: Point): (a: HintCandidate, b: HintCandidate) => number {
  return (a, b) => {
    const da = distanceToRect(focus, a.rect);
    const db = distanceToRect(focus, b.rect);
    if (da !== db) return da - db;
    if (a.rect.top !== b.rect.top) return a.rect.top - b.rect.top;
    return a.rect.left - b.rect.left;
  };
}

/**
 * Sort candidates closest-to-focus first. Returns a new array; input is
 * not mutated. The sort is stable on JS engines that matter (V8, JSC,
 * SpiderMonkey since 2019), so candidates that tie through every
 * comparator branch retain input order — useful when the caller has
 * already imposed a meaningful order (e.g. discovery order).
 */
export function getRankedCandidates(candidates: HintCandidate[], focus: Point): HintCandidate[] {
  return [...candidates].sort(rankByDistance(focus));
}

/**
 * A scoring function over `T`. Convention: **higher is better.** The
 * chooser narrows on the maximum value at each step. To prefer a
 * smaller raw value (e.g. fewer syllables), return its negation.
 */
export type Metric<T> = (item: T) => number;

// --- Allocation metrics ----------------------------------------------------
//
// The live pipeline uses rank-and-pair: candidates sorted by viewport
// distance, codewords drawn from the pool in singles-then-pairs order,
// zipped. The chooser machinery (`maxByFirstDiffering`) is not invoked
// yet — the metric primitives below are building blocks for a future
// multi-metric chooser (DESIGN_BROWSER_HINT_ALLOCATOR.md section 2,
// Layer B).
//
// With continuous Vosk recognition (no VAD gate), pairs are as fast to
// speak as singles were under the old pause-speak-pause model. This
// shifts the metric priorities: syllable cost is near-irrelevant, while
// stability (keeping the same codeword across rescans) becomes the
// dominant concern. When the multi-metric chooser is promoted, stability
// should be the first metric and syllable cost should be weighted low
// or dropped entirely.
//
// Metrics intentionally NOT shipped, with rationale:
//
// - **Stability** (prefer the codeword the candidate held last allocation):
//   requires preserving `oldCodeword` past viewport-leave. The
//   IntersectionTracker currently clears `wrapper.scanned.codeword`
//   when an element exits the viewport, so the old assignment is gone
//   by the next allocation pass. The pool's unshift-to-front behavior
//   already gives us "scrolled out and back returns the same codeword"
//   stability, which covers most real cases. Promote when an
//   in-place re-allocation pass is added.
//
// - **Avoid-stealing**: structurally moot. Content-side allocation only
//   draws from the pool's free list; the pool never returns held
//   codewords. There's nothing to steal from.
//
// - **First-letter clash**: depends on `accessibleName` (Sprint F /
//   Phase 2.5). DESIGN section 6, Q4 marks the metric itself speculative
//   ("may or may not matter"). Defer.
//
// - **codewordEarliestNeededRank tiebreaker**: subsumed by rank-and-pair.
//   Cursorless's insight ("save 'arch' for closer-to-focus candidates")
//   already falls out of sorting candidates by rank and drawing
//   codewords in pool order.

/**
 * Syllable cost of a pool codeword. Single-word codewords are 1; pair
 * codewords ("zone arch") are 2. Used as the canonical "cheapness"
 * metric — pair with the chooser's higher-is-better convention by
 * negating: `c => -syllableCost(c.codeword)`.
 *
 * Pool codewords are space-separated when paired (see
 * `label-pool.ts:buildPool`), so a simple space count suffices. Empty
 * input returns 0 (defensive — empty codewords shouldn't reach a
 * metric, but the pool's exhausted path can produce them).
 */
export function syllableCost(codeword: string): number {
  if (codeword.length === 0) return 0;
  let words = 1;
  for (let i = 0; i < codeword.length; i++) {
    if (codeword.charCodeAt(i) === 32 /* space */) words++;
  }
  return words;
}

/**
 * Lexicographic chooser: given a list of items and a stack of metrics,
 * walks the metrics in order, narrowing candidates at each step to
 * those tied for the max value. Returns the unique survivor, or any
 * one of the remaining items if all metrics tie through.
 *
 * Mirrors Cursorless's `maxByFirstDiffering`
 * (`packages/lib-engine/src/util/allocateHats/maxByFirstDiffering.ts`).
 *
 * Sprint C ships rank-and-pair, where the metric stack is mostly a
 * no-op; this helper is in place so the chooser can be promoted to a
 * full multi-metric allocator later (DESIGN section 2, Layer B) by adding
 * metrics to the stack — no caller-side rewrite.
 *
 * Pure: does not mutate `items` or `metrics`. Stops evaluating
 * metrics as soon as a single survivor remains, so later metrics
 * pay no cost when an earlier one already decides.
 */
export function maxByFirstDiffering<T>(
  items: readonly T[],
  metrics: readonly Metric<T>[],
): T | undefined {
  if (items.length === 0) return undefined;
  if (items.length === 1) return items[0];

  let candidates: readonly T[] = items;
  for (const metric of metrics) {
    const scores = candidates.map(metric);
    let max = scores[0];
    for (let i = 1; i < scores.length; i++) {
      if (scores[i] > max) max = scores[i];
    }
    const survivors: T[] = [];
    for (let i = 0; i < candidates.length; i++) {
      if (scores[i] === max) survivors.push(candidates[i]);
    }
    if (survivors.length === 1) return survivors[0];
    candidates = survivors;
  }
  // Ties through every metric — the items are indistinguishable to the
  // chooser. Return the first survivor, which (since the loop preserves
  // input order at every filter) corresponds to the caller's input order.
  return candidates[0];
}

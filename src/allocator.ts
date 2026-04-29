/**
 * BranchKit Browser — Hint allocator.
 *
 * Decides which codeword goes to which hint candidate. Closer-to-focus
 * candidates rank earlier and pair with cheaper codewords (the per-tab
 * pool is already singles-before-pairs, so rank order × pool order gives
 * "single-word hints for the elements you'll most likely target").
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
 * `oldCodeword` is reserved for a future stability metric (DESIGN §2
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

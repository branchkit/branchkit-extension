/**
 * BranchKit Browser — DOM first-seen stamps for the paint-latency
 * decomposition (notes/DESIGN_PAINT_THE_BAND.md).
 *
 * The per-wrapper stage timestamps start at WRAPPER creation (tAttached),
 * which leaves the discovery layer — MutationObserver record → budgeted
 * drain → walk → attach — unmeasured. This WeakMap stamps every element the
 * MO reports as added, at record time; attachWrapper resolves a wrapper's
 * nearest stamped ancestor into `tDomSeen`, closing the gap. WeakMap keyed
 * on the added roots, so entries die with the page's own GC.
 */

const seenAt = new WeakMap<Element, number>();

/** Stamp an element the MutationObserver just reported as added. Keeps the
 * FIRST stamp (a re-added node keeps its original sighting). */
export function markDomSeen(el: Element): void {
  if (!seenAt.has(el)) seenAt.set(el, performance.now());
}

/** Resolve the nearest stamped ancestor's sighting time (the added ROOT is
 * stamped; wrappers live in its subtree). Bounded walk; null when nothing
 * on the chain was MO-stamped (boot scan, pre-existing DOM). */
export function domSeenAt(el: Element): number | null {
  let current: Element | null = el;
  let depth = 0;
  while (current && depth < 40) {
    const t = seenAt.get(current);
    if (t !== undefined) return t;
    current = current.parentElement;
    depth++;
  }
  return null;
}

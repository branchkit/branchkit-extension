/**
 * What a badge is pinned to.
 *
 * A badge needs two different things from "its target", and they are not the
 * same object for every badge:
 *
 *   - a RECT to point at (where the badge goes), and
 *   - an ELEMENT to derive everything else from — computed style, colours,
 *     stacking context, scroller chain, clip root, DOM identity.
 *
 * For a link hint they are the same element. For a range-pick chip
 * (activate/range-disambiguation.ts) the rect is a `Range`'s and the element is
 * that range's container, which is a valid answer for every ancestor concern:
 * a range and its containing element share a scroller, a stacking context, and
 * a clip root, because the range's nodes are descendants of the container.
 *
 * See notes/DESIGN_BADGE_TARGET_SEAM.md for the verification of that claim and
 * where it degrades (multi-block ranges climb to a coarser container).
 */

import { getCachedRect } from '../core/layout-cache';

export interface BadgeTarget {
  /** Ancestry, computed style, colours, stacking, scrollers, DOM identity.
   *  For an element badge this IS the target; for a range badge it is the
   *  range's containing element. */
  readonly element: Element;
  /** Live viewport rect. Read by the batched reconcile pass, which must see
   *  this frame's layout. */
  rect(): DOMRect;
  /** The rect on the SAME basis placement used to compute the candidate, so
   *  the baked offset is the intended overhang and can't absorb a reflow delta
   *  (the stranding bug guarded in placement/position.ts). Element targets read
   *  the pass's layout-cache snapshot; Ranges re-read live — the Element rect
   *  cache doesn't extend to Ranges, and their candidate was computed from a
   *  live read in the same frame. */
  placementRect(): DOMRect;
}

/** The ordinary case: a badge pinned to an element. */
export function elementTarget(element: Element): BadgeTarget {
  return {
    element,
    rect: () => element.getBoundingClientRect(),
    placementRect: () => getCachedRect(element),
  };
}

/**
 * A badge pinned to a text range. The element half is the range's container:
 * `commonAncestorContainer` if it's an Element, else its parent (the common
 * case — a range inside one text node answers with that node).
 *
 * Falls back to `document.body` for a range with no element ancestor at all
 * (a detached fragment); such a range paints nothing useful, and the caller's
 * viewport filter drops it first.
 */
export function rangeTarget(range: Range): BadgeTarget {
  const node = range.commonAncestorContainer;
  const element = node instanceof Element
    ? node
    : node.parentElement ?? document.body;
  const rect = () => range.getBoundingClientRect();
  return { element, rect, placementRect: rect };
}

/**
 * BranchKit Browser — desired-state predicates.
 *
 * Single source of truth for "what should this wrapper have right now?",
 * the level-triggered counterpart to scan's "is this hintable?".
 *
 * The hint lifecycle has historically been edge-triggered: 7+ independent
 * handlers mutate the {observed, inViewport, codeword, hint} sub-states, and
 * whenever YouTube's mutation storm drops or reorders an event the sub-states
 * desync (discovery gap, stale isInViewport, noHintObject). The fix is one
 * level-triggered reconcile pass that re-derives the desired state from
 * ground truth. These pure predicates ARE that desired state; both the legacy
 * edge handlers and the future reconcile() consume them so the two can never
 * diverge. See notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md.
 *
 * Note: "in viewport" here is the IntersectionObserver band notion
 * (`wrapper.isInViewport`, a VIEWPORT_MARGIN_PX-band flag), NOT showHints' fresh
 * getBoundingClientRect strict-viewport test. They deliberately differ; do not
 * unify them here.
 */

import { Category } from '../types';
import { ElementWrapper } from '../scan/element-wrapper';

/**
 * Does the wrapper's category pass the active category filter?
 * A null filter (no category narrowing active) matches everything.
 */
export function categoryMatches(w: ElementWrapper, activeCategory: Category | null): boolean {
  return !activeCategory || w.category === activeCategory;
}

/** Should this wrapper hold a codeword right now? (IO-band viewport gate.) */
export function wantsCodeword(w: ElementWrapper): boolean {
  return w.isInViewport;
}

/**
 * Should this wrapper have a rendered hint badge right now?
 * Requires viewport presence, an assigned codeword, and a category match.
 */
export function wantsHint(w: ElementWrapper, activeCategory: Category | null): boolean {
  return w.isInViewport && w.scanned.codeword.length > 0 && categoryMatches(w, activeCategory);
}

/**
 * Geometry/style inputs for `wantsShown`, resolved by the settle gather (or
 * its simulation): the predicates stay pure so the plan and any fast-path
 * consult identical definitions without re-reading layout.
 */
export interface ShownInputs {
  /** The IO band flag as it stands AFTER the teardown step's stale-flag
   * repairs (the plan simulates those; live code reads the repaired flag). */
  flagInBand: boolean;
  /** isVisible() — CSS visibility of the target. */
  cssVisible: boolean;
  /** Target rect overlaps the actual visible viewport (isRectOnScreen). */
  onScreen: boolean;
}

/**
 * Should this wrapper's badge be painted right now?
 *
 * Encodes the two known traps explicitly (DESIGN_UNIFIED_RECONCILER.md risks):
 *   - Limbo wrappers hold their badge by design — never "shown" here, and
 *     never repaired toward shown/hidden.
 *   - Dormant badge reuse (DESIGN_HINT_REUSE.md): an out-of-band wrapper
 *     keeps its badge object hidden + label-cleared for scroll-back. That is
 *     DESIRED state, not drift — shown-ness is only ever true for in-band
 *     wrappers, so a reconcile pass must not "repair" dormant badges.
 *
 * A wrapper with no badge object never wants "shown" — constructing one is
 * the build action class, not the show class.
 */
export function wantsShown(w: ElementWrapper, s: ShownInputs): boolean {
  if (w.disconnectedAt !== null) return false;
  if (!w.hint) return false;
  if (!w.element.isConnected) return false;
  return s.flagInBand && s.cssVisible && s.onScreen;
}

/**
 * Geometry inputs for `wantsStrict`. The occluded/cssHidden cuts are read
 * off the wrapper flags (written by the occlusion and visibility steps that
 * run earlier in the settle order) — they are state, not geometry.
 */
export interface StrictInputs {
  /** Every ancestor iframe element is on-screen in its parent (per-frame,
   * computed once per gather). */
  ancestorChainVisible: boolean;
  /** Target rect overlaps the actual visible viewport (no band margin —
   * the strict notion, not the IO band notion). */
  onScreen: boolean;
}

/**
 * Should this wrapper be in the voice-matchable `_strict` companion
 * collection right now? Mirrors stampStrictViewport's rule: visible viewport
 * ∩ visible ancestor frames ∩ not occluded ∩ not CSS-hidden, holding a
 * codeword. Limbo wrappers hold their state by design.
 */
export function wantsStrict(w: ElementWrapper, s: StrictInputs): boolean {
  if (w.disconnectedAt !== null) return false;
  if (!w.scanned.codeword) return false;
  return s.ancestorChainVisible && !w.occluded && !w.cssHidden && s.onScreen;
}

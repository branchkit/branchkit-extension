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

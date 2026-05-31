/**
 * BranchKit Browser — level-triggered reconcile pass (shadow mode).
 *
 * The hint lifecycle is edge-triggered: 7+ handlers mutate the
 * {observed, inViewport, codeword, hint} sub-states off independent event
 * sources, and a dropped/reordered event leaves them desynced (discovery gap,
 * stale isInViewport, noHintObject). The fix is one level-triggered pass that
 * re-derives the desired state from ground truth and converges actual→desired.
 *
 * This module computes the *plan* — the delta between actual and desired —
 * but DRIVES NOTHING. It is the shadow-mode step (Phase 2 of
 * notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md): we surface the plan in
 * snapshots so we can confirm reconcile computes correct state before it is
 * made authoritative (Phase 3+). It is also the first production reader of
 * TargetRectStore — the band-divergence check reads warm rects to see whether
 * the IO `isInViewport` flag has gone stale relative to geometry.
 *
 * Cost contract: O(store) with NO forced layout. It reads only cached warm
 * rects from TargetRectStore (never getBoundingClientRect) and the wrappers'
 * already-resolved sub-states, so it is safe to run on the perf cadence and on
 * every snapshot without reintroducing a layout-thrash wedge.
 */

import { Category } from '../types';
import { WrapperStore } from '../scan/element-wrapper';
import { TargetRectStore } from '../observe/target-rect-store';
import { wantsCodeword, wantsHint } from './desired-state';

/** Viewport band margin, in px. Mirrors the IntersectionObserver rootMargin
 * (`VIEWPORT_MARGIN = '200px'` in observe/intersection-tracker.ts) so the
 * geometry band-check agrees with the flag the IO actually sets. */
export const RECONCILE_BAND_MARGIN_PX = 200;

export interface ReconcilePlan {
  /** In-band wrappers with no codeword — the claim the edge handlers missed. */
  needClaim: number;
  /** In-band codeworded wrappers with no hint — the noHintObject delta. */
  needBuild: number;
  /** Off-band wrappers still holding a codeword — release the edge missed. */
  needRelease: number;
  /** Wrappers with a hint that desired-state no longer wants — stale teardown. */
  needTeardown: number;
  /**
   * Band-divergence: among wrappers whose warm rect is known to the store,
   * how often the IO `isInViewport` flag disagrees with the geometry band.
   * staleTrue = flag says in, geometry says out (the stale-isInViewport root);
   * staleFalse = flag says out, geometry says in (a missed-enter root).
   */
  band: { rectsKnown: number; staleTrue: number; staleFalse: number };
}

export function emptyPlan(): ReconcilePlan {
  return {
    needClaim: 0,
    needBuild: 0,
    needRelease: 0,
    needTeardown: 0,
    band: { rectsKnown: 0, staleTrue: 0, staleFalse: 0 },
  };
}

/** True if a viewport-relative rect falls within the viewport ± margin band. */
export function geometryInBand(
  r: DOMRectReadOnly,
  vw: number,
  vh: number,
  marginPx: number,
): boolean {
  return (
    r.bottom > -marginPx &&
    r.top < vh + marginPx &&
    r.right > -marginPx &&
    r.left < vw + marginPx
  );
}

export function computeReconcilePlan(
  store: WrapperStore,
  activeCategory: Category | null,
  rectStore: TargetRectStore,
  viewport: { width: number; height: number },
  marginPx: number,
): ReconcilePlan {
  const plan = emptyPlan();
  const { width: vw, height: vh } = viewport;

  for (const w of store.all) {
    // Limbo wrappers hold their state by design — exclude from the plan.
    if (w.disconnectedAt !== null) continue;

    const hasCodeword = w.scanned.codeword.length > 0;
    if (wantsCodeword(w) && !hasCodeword) plan.needClaim++;
    if (!wantsCodeword(w) && hasCodeword) plan.needRelease++;
    if (wantsHint(w, activeCategory) && !w.hint) plan.needBuild++;
    if (w.hint && !wantsHint(w, activeCategory)) plan.needTeardown++;

    const rect = rectStore.read(w.element);
    if (rect) {
      plan.band.rectsKnown++;
      const inBand = geometryInBand(rect, vw, vh, marginPx);
      if (w.isInViewport && !inBand) plan.band.staleTrue++;
      else if (!w.isInViewport && inBand) plan.band.staleFalse++;
    }
  }

  return plan;
}

/**
 * BranchKit Browser — diagnostic shadow of the hint lifecycle reconciler.
 *
 * The authoritative reconcile lives in content.ts:
 *   reconcile()           — claim (refreshViewportClaims) + build
 *                           (badgeNewlyCodeworded), wired into onCodewordsChanged,
 *                           scan-batch paint, label-sync, alphabet-change,
 *                           nav deferred-scan, and the scheduleReconcile settle.
 *   reconcileTeardown()   — gBCR-bounded teardown for the hinted set; fixes
 *                           dropped IO exit (stale-TRUE → release codeword +
 *                           tear down hint) and dropped IO enter (stale-FALSE →
 *                           flip flag, let next reconcile re-claim + rebuild).
 *   scheduleBandDiscovery() — re-walks the document via the wedge-safe sliced
 *                           discovery to close the discovery gap when the
 *                           MutationObserver dropped an insertion record.
 *
 * This module DRIVES NOTHING. `computeReconcilePlan` re-derives the desired
 * state (desired-state.ts) and reports the actual-vs-desired delta as counts
 * — surfaced on `DebugSnapshotPayload.reconcile_shadow` and the perf
 * snapshot's `reconcileShadow`. In steady state every count is zero; a
 * non-zero count is a tripwire for a {claim, build, release, teardown} the
 * authoritative paths missed.
 *
 * Cost contract: O(store) with NO layout reads — only the wrappers'
 * already-resolved sub-states — so it is safe to run on the perf cadence and
 * on every snapshot without reintroducing a layout-thrash wedge. Geometry
 * divergence (a stale `isInViewport` flag) is reconcileTeardown's job; it
 * reads fresh gBCR over the bounded hinted set precisely because an IO-fed
 * cache cannot police dropped IO events.
 */

import { Category } from '../types';
import { WrapperStore } from '../scan/element-wrapper';
import { VIEWPORT_MARGIN_PX } from '../observe/intersection-tracker';
import { wantsCodeword, wantsHint } from './desired-state';

/** Viewport band margin, in px. Derived from the IntersectionObserver
 * rootMargin so geometry band-checks agree with the flag the IO
 * actually sets. (Was a hardcoded 200 that silently drifted when the IO
 * widened to 1000px — the backstops then disagreed with IO ground truth
 * for the 200-1000px ring.) */
export const RECONCILE_BAND_MARGIN_PX = VIEWPORT_MARGIN_PX;

export interface ReconcilePlan {
  /** In-band wrappers with no codeword — the claim the edge handlers missed. */
  needClaim: number;
  /** In-band codeworded wrappers with no hint — the noHintObject delta. */
  needBuild: number;
  /** Off-band wrappers still holding a codeword — release the edge missed. */
  needRelease: number;
  /** Wrappers with a hint that desired-state no longer wants — stale teardown. */
  needTeardown: number;
}

export function emptyPlan(): ReconcilePlan {
  return {
    needClaim: 0,
    needBuild: 0,
    needRelease: 0,
    needTeardown: 0,
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
): ReconcilePlan {
  const plan = emptyPlan();

  for (const w of store.all) {
    // Limbo wrappers hold their state by design — exclude from the plan.
    if (w.disconnectedAt !== null) continue;

    const hasCodeword = w.scanned.codeword.length > 0;
    if (wantsCodeword(w) && !hasCodeword) plan.needClaim++;
    if (!wantsCodeword(w) && hasCodeword) plan.needRelease++;
    if (wantsHint(w, activeCategory) && !w.hint) plan.needBuild++;
    if (w.hint && !wantsHint(w, activeCategory)) plan.needTeardown++;
  }

  return plan;
}

/**
 * BranchKit Browser — the settle pass's PLAN phase.
 *
 * `computeReconcilePlanLists` is the one desired-state derivation: given the
 * gather snapshot, it decides per action class WHICH wrappers the settle
 * pipeline's thin appliers act on (content.ts:runSettlePipeline). It is the
 * engine of the unified reconciler (notes/DESIGN_UNIFIED_RECONCILER.md) —
 * built as a verified shadow in Phase C (every list diffed against the live
 * steps to zero divergence at real volume), made authoritative by the Phase
 * D cutovers, with the between-settle backstops demoted onto the same pass
 * in Phase E.
 *
 * Cost contract: O(store) over the gather's already-read geometry. The only
 * layout reads are the bounded lazy fallbacks for wrappers the gather
 * couldn't see (the rare repair case), counted via the
 * reconcilePlan:size:lazyReads bucket as a tripwire.
 */

import { Category } from '../types';
import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { VIEWPORT_MARGIN_PX } from '../observe/intersection-tracker';
import { wantsShown, wantsStrict } from './desired-state';
import { isVisible } from '../scan/scanner';
import { isRectOnScreen } from '../layout-cache';
import { recordCpu } from '../debug/perf-counters';
import type { SettleGather } from './gather';

/** Viewport band margin, in px. Derived from the IntersectionObserver
 * rootMargin so geometry band-checks agree with the flag the IO
 * actually sets. (Was a hardcoded 200 that silently drifted when the IO
 * widened to 1000px — the backstops then disagreed with IO ground truth
 * for the 200-1000px ring.) */
export const RECONCILE_BAND_MARGIN_PX = VIEWPORT_MARGIN_PX;

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

// --- Plan-as-lists (Phase C of notes/DESIGN_UNIFIED_RECONCILER.md) ---
//
// The list-emitting plan consumes the settle gather snapshot and computes,
// per action class, WHICH wrappers the settle steps should act on — still
// shadow-only (drives nothing); the pipeline diffs these lists against what
// the live steps actually did. Class names follow the live steps' actions:
//   toRelease  — stale-TRUE: visible hint, geometry off-band → release
//   toRepair   — stale-FALSE: geometry in-band, flag out → flip flag
//   toClaim    — in-band (post-repair) wrappers lacking a codeword
//   toBuild    — codeworded, paintable, badge not showing → construct/paint
//   toShow     — visibility recheck would re-show the badge
//   toHide     — visibility recheck would hide the badge
//   strictDelta — `_strict` membership re-pushes (folded here in cutover 4/4:
//                the gather carries the occlusion hit-tests, and the clip
//                flag is stable because the membership sync runs before the
//                gather)
//
// Ordering is simulated, not assumed: the show/hide derivation runs against
// the band flags as repaired by the teardown sim, against badge visibility
// as it stands after the conditional build pass the live teardown triggers
// (badgeNewlyCodeworded runs inside teardown's reconcile() only when a
// stale-FALSE repair happened), and the strict derivation against `occluded`
// / `cssHidden` as the occlusion and visibility appliers will leave them.
//
// Cost: O(store) over the gather's already-read geometry. The only layout
// reads are the bounded lazy fallbacks for wrappers the gather couldn't see
// (cssVisible for just-repaired dormant badges — the rare desync case),
// counted via the reconcilePlan:size:lazyReads bucket as a tripwire.

export interface ReconcilePlanLists {
  toRelease: ElementWrapper[];
  toRepair: ElementWrapper[];
  toClaim: ElementWrapper[];
  toBuild: ElementWrapper[];
  toShow: ElementWrapper[];
  toHide: ElementWrapper[];
  /** The visibility step's write-through side effect: recheck-set wrappers
   * whose `cssHidden` flag must change to match the gathered cssVisible
   * (delta-only — writing an unchanged value is a no-op). The strict
   * predicate reads this flag, so the applier writes it before the strict
   * delta is queued. */
  cssHiddenDelta: Array<[ElementWrapper, boolean]>;
  /** Wrappers whose `_strict` membership (wantsStrict over simulated
   * post-apply flags) differs from the last value pushed to the plugin. */
  strictDelta: ElementWrapper[];
}

function lazyCssVisible(w: ElementWrapper, counter: { reads: number }): boolean {
  counter.reads++;
  try { return isVisible(w.element); } catch { return false; }
}

function lazyOnScreen(w: ElementWrapper, vw: number, vh: number, counter: { reads: number }): boolean {
  counter.reads++;
  try { return isRectOnScreen(w.element.getBoundingClientRect(), vw, vh); } catch { return false; }
}

export function computeReconcilePlanLists(
  store: WrapperStore,
  activeCategory: Category | null,
  gather: SettleGather,
): ReconcilePlanLists {
  const lazy = { reads: 0 };
  const lists: ReconcilePlanLists = {
    toRelease: [], toRepair: [], toClaim: [], toBuild: [], toShow: [], toHide: [],
    cssHiddenDelta: [], strictDelta: [],
  };

  // Step-1 sim — mirrors reconcileTeardown over the same gather rects.
  for (const w of store.all) {
    if (w.disconnectedAt !== null) continue;
    if (w.hint) {
      const r = gather.rects.get(w);
      if (!r) continue; // gather missed it; live step falls back to a fresh read
      if (geometryInBand(r, gather.vw, gather.vh, RECONCILE_BAND_MARGIN_PX)) {
        if (!w.isInViewport) lists.toRepair.push(w);
      } else if (w.hint.isVisible) {
        lists.toRelease.push(w);
      }
    } else if (!w.isInViewport && w.scanned.codeword.length === 0 && w.element.isConnected) {
      const r = gather.rects.get(w);
      if (!r) continue;
      // Boxless skip — see reconcileTeardown's zero-rect guard.
      if (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0) continue;
      if (geometryInBand(r, gather.vw, gather.vh, RECONCILE_BAND_MARGIN_PX)) lists.toRepair.push(w);
    }
  }
  const repaired = new Set(lists.toRepair);
  const released = new Set(lists.toRelease);
  const flagAfterTeardown = (w: ElementWrapper): boolean =>
    repaired.has(w) ? true : released.has(w) ? false : w.isInViewport;

  // The live build pass (badgeNewlyCodeworded) runs inside teardown's
  // reconcile() only when a repair happened — model that conditionality so
  // the show/hide sim sees the same badge visibility the recheck step will.
  const buildPassRuns = lists.toRepair.length > 0;

  for (const w of store.all) {
    if (w.disconnectedAt !== null) continue;
    const flag = flagAfterTeardown(w);
    const codeworded = w.scanned.codeword.length > 0;

    // Claim sim — refreshViewportClaims over post-repair flags.
    if (flag && !codeworded) lists.toClaim.push(w);

    // Shared inputs, resolved at most once per wrapper from the gather
    // (bounded lazy fallback for snapshot misses).
    let onScreenMemo: boolean | undefined;
    const onScreen = (): boolean => onScreenMemo ??= ((): boolean => {
      const r = gather.rects.get(w);
      return r
        ? isRectOnScreen(r, gather.vw, gather.vh)
        : lazyOnScreen(w, gather.vw, gather.vh, lazy);
    })();
    let cssVisibleMemo: boolean | undefined;
    const cssVisible = (): boolean =>
      cssVisibleMemo ??= (gather.cssVisible.get(w) ?? lazyCssVisible(w, lazy));

    // `cssHidden` as it will stand when the strict re-push runs — after the
    // build pass's write-through and the visibility apply.
    let cssHidden5 = w.cssHidden;

    // Build sim — badgeNewlyCodeworded's paint set: wants a hint, badge not
    // currently showing, target on-screen and CSS-visible.
    const wantsHintNow = flag && codeworded
      && (!activeCategory || w.category === activeCategory);
    const showingAtPlan = w.hint?.isVisible ?? false;
    let builtAndShown = false;
    if (wantsHintNow && !showingAtPlan) {
      // The live build pass writes cssHidden for its whole set (painted or
      // not) — mirror that when it will actually run this settle.
      if (buildPassRuns) cssHidden5 = !cssVisible();
      if (onScreen() && cssVisible()) {
        lists.toBuild.push(w);
        builtAndShown = buildPassRuns;
      }
    }

    // Step-5 sim — the visibility recheck's show/hide transitions + the
    // cssHidden write-through, over the post-repair flag and post-build
    // badge visibility.
    const hasBadgeAtRecheck = w.hint !== null || builtAndShown;
    if (hasBadgeAtRecheck && flag && w.element.isConnected) {
      const showingAtRecheck = showingAtPlan || builtAndShown;
      if (w.cssHidden !== !cssVisible()) lists.cssHiddenDelta.push([w, !cssVisible()]);
      cssHidden5 = !cssVisible();
      const visible = w.hint
        ? wantsShown(w, { flagInBand: flag, cssVisible: cssVisible(), onScreen: onScreen() })
        : (cssVisible() && onScreen()); // freshly-constructed badge: shown-ness core
      if (visible && !showingAtRecheck) lists.toShow.push(w);
      else if (!visible && showingAtRecheck) lists.toHide.push(w);
    }

    // Step-6 sim (the strict fold, cutover 4/4) — wantsStrict over simulated
    // post-apply flags: effective occlusion folded from the gather's
    // hit-tests and the clip flag (stable — the membership sync runs before
    // the gather); cssHidden as the applies will leave it.
    // lastSentStrictViewport is only written at batch POST, so it is stable
    // across the pipeline.
    if (codeworded) {
      const occluded5 = (gather.overlayCovered.get(w) ?? w.overlayCovered) || w.clipped;
      const inStrict = wantsStrict(w, {
        ancestorChainVisible: gather.ancestorChainVisible,
        onScreen: onScreen(),
        occluded: occluded5,
        cssHidden: cssHidden5,
      });
      if (inStrict !== w.lastSentStrictViewport) lists.strictDelta.push(w);
    }
  }

  if (lazy.reads > 0) recordCpu('reconcilePlan:size:lazyReads', lazy.reads);
  return lists;
}

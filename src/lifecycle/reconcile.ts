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

import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { VIEWPORT_MARGIN_PX } from '../observe/intersection-tracker';
import { wantsShown, wantsStrict } from './desired-state';
import { targetOverVideo } from '../render/video-overlay';
import { isVisible } from '../scan/scanner';
import { geometryInBand, isRectOnScreen } from '../layout-cache';
import { recordCpu } from '../debug/perf-counters';
import { harnessHooksEnabled } from '../debug/harness-hooks';
import { lastStrictProbe } from './strict-probe';
import type { SettleGather } from './gather';

/** Viewport band margin, in px. Derived from the IntersectionObserver
 * rootMargin so geometry band-checks agree with the flag the IO
 * actually sets. (Was a hardcoded 200 that silently drifted when the IO
 * widened to 1000px — the backstops then disagreed with IO ground truth
 * for the 200-1000px ring.) The band predicate itself (`geometryInBand`)
 * lives in layout-cache.ts — leaf module, importable from observe/. */
export const RECONCILE_BAND_MARGIN_PX = VIEWPORT_MARGIN_PX;

// --- Plan-as-lists (Phase C of notes/DESIGN_UNIFIED_RECONCILER.md) ---
//
// The list-emitting plan consumes the settle gather snapshot and computes,
// per action class, WHICH wrappers the settle steps should act on — still
// shadow-only (drives nothing); the pipeline diffs these lists against what
// the live steps actually did. Class names follow the live steps' actions:
//   toRelease  — codeworded, geometry off-band → release (two-strike applier)
//   toClaim    — in-band wrappers lacking a codeword
//   toBuild    — codeworded, paintable, badge not showing → construct/paint
//   toShow     — visibility recheck would re-show the badge
//   toHide     — visibility recheck would hide the badge
//   strictDelta — `_strict` membership re-pushes (folded here in cutover 4/4:
//                the gather carries the occlusion hit-tests, and the clip
//                flag is stable because the membership sync runs before the
//                gather)
//
// Ordering is simulated, not assumed: the show/hide derivation runs against
// DERIVED band membership (fresh gather rects — no stored flag exists;
// DESIGN_OBSERVED_STATE_READ_TIME phase 3), against badge visibility as it
// stands after the conditional build pass the lifecycle applier triggers
// (badgeNewlyCodeworded runs when the plan owed claims/builds), and the
// strict derivation against `occluded` as the occlusion applier will leave
// it. cssHidden is read-time too: derived from the gathered cssVisible at
// the point of use (phase 1).
//
// Cost: O(store) over the gather's already-read geometry. The only layout
// reads are the bounded lazy fallbacks for wrappers the gather couldn't see
// (cssVisible for just-repaired dormant badges — the rare desync case),
// counted via the reconcilePlan:size:lazyReads bucket as a tripwire.

export interface ReconcilePlanLists {
  toRelease: ElementWrapper[];
  toClaim: ElementWrapper[];
  toBuild: ElementWrapper[];
  toShow: ElementWrapper[];
  toHide: ElementWrapper[];
  /** Wrappers whose `_strict` membership (wantsStrict over simulated
   * post-apply flags) differs from the last value pushed to the plugin. */
  strictDelta: ElementWrapper[];
  /** Harness-only (settle-storm diagnosis): per-input attribution for the
   * strictDelta cohort — which plan input changed since the PREVIOUS pass.
   * A delta member with NO changed input ('stable') means the disagreement
   * is with the lastSent baseline itself (the stamp/sync side), not with a
   * between-settle input writer. Always present; all-zero in release. */
  strictFlips: StrictFlipCounts;
}

export interface StrictFlipCounts {
  geometry: number;
  clipped: number;
  overlayCovered: number;
  cssHidden: number;
  ancestor: number;
  /** In the delta with inputs identical to last pass — baseline mismatch. */
  stable: number;
  /** In the delta with no previous-pass probe (first sighting). */
  first: number;
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
  gather: SettleGather,
): ReconcilePlanLists {
  const lazy = { reads: 0 };
  const lists: ReconcilePlanLists = {
    toRelease: [], toClaim: [], toBuild: [], toShow: [], toHide: [],
    strictDelta: [],
    strictFlips: { geometry: 0, clipped: 0, overlayCovered: 0, cssHidden: 0, ancestor: 0, stable: 0, first: 0 },
  };
  const probing = harnessHooksEnabled();

  // Band membership is DERIVED per wrapper from the gather's fresh rect
  // (DESIGN_OBSERVED_STATE_READ_TIME phase 3) — there is no stored flag, no
  // repair class, and no apply-order simulation for it. A wrapper the
  // gather has no rect for (detached mid-read) is skipped: the plan cannot
  // judge lifecycle without geometry, and the next pass re-derives.
  const inBandOf = (w: ElementWrapper): boolean | null => {
    const r = gather.rects.get(w);
    if (!r) return null;
    // Boxless skip (zero-rect guard): display:none reports all-zeros, which
    // would false-positive at the origin.
    if (r.width === 0 && r.height === 0 && r.top === 0 && r.left === 0) return null;
    return geometryInBand(r, gather.vw, gather.vh, RECONCILE_BAND_MARGIN_PX);
  };

  // First walk: lifecycle classes (release/claim) from derived membership.
  for (const w of store.all) {
    if (w.disconnectedAt !== null) continue;
    if (!w.element.isConnected) continue;
    const inBand = inBandOf(w);
    if (inBand === null) continue;
    const codeworded = w.scanned.codeword.length > 0;
    if (!inBand && codeworded) lists.toRelease.push(w);
    else if (inBand && !codeworded) lists.toClaim.push(w);
  }

  // The build pass runs whenever the lifecycle applier found owed work.
  const buildPassRuns = lists.toClaim.length > 0;

  for (const w of store.all) {
    if (w.disconnectedAt !== null) continue;
    const codeworded = w.scanned.codeword.length > 0;
    const flag = inBandOf(w) === true;

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

    // Build sim — badgeNewlyCodeworded's paint set: wants a hint, badge not
    // currently showing, target CSS-visible. Band-scoped, NOT strict-viewport
    // (notes/DESIGN_PAINT_THE_BAND.md): off-viewport band wrappers build and
    // paint too, riding the scroll into view already painted.
    const wantsHintNow = flag && codeworded;
    const showingAtPlan = w.hint?.isVisible ?? false;
    let builtAndShown = false;
    if (wantsHintNow && !showingAtPlan) {
      if (cssVisible()) {
        lists.toBuild.push(w);
        builtAndShown = buildPassRuns;
      }
    }

    // Step-5 sim — the visibility recheck's show/hide transitions, over the
    // post-repair flag and post-build badge visibility.
    const hasBadgeAtRecheck = w.hint !== null || builtAndShown;
    if (hasBadgeAtRecheck && flag && w.element.isConnected) {
      const showingAtRecheck = showingAtPlan || builtAndShown;
      const visible = w.hint
        ? wantsShown(w, { flagInBand: flag, cssVisible: cssVisible(), overVideo: targetOverVideo(w.element) })
        : cssVisible(); // freshly-constructed badge: shown-ness core
      if (visible && !showingAtRecheck) lists.toShow.push(w);
      else if (!visible && showingAtRecheck) lists.toHide.push(w);
    }

    // Step-6 sim (the strict fold, cutover 4/4) — wantsStrict over the
    // gather-derived inputs: effective occlusion folded from the gather's
    // hit-tests and the clip flag (stable — the membership sync runs before
    // the gather); cssHidden derived from the same gathered cssVisible the
    // show/hide sim consumed (read-time — there is no stored flag; see
    // notes/DESIGN_OBSERVED_STATE_READ_TIME.md phase 1).
    // lastSentStrictViewport is only written at batch POST, so it is stable
    // across the pipeline.
    if (codeworded) {
      // Unprobed wrapper (badge not visible/in-band, or the occlusion flag is
      // off) → not overlay-covered as far as we can tell — the same default an
      // unprobed stored flag had. The clip signal folds regardless: `clipped`
      // is the clip IO's own continuously-maintained state, not a copy.
      const overlay5 = gather.overlayCovered.get(w) ?? false;
      const occluded5 = overlay5 || w.clipped;
      const cssHidden5 = !cssVisible();
      const inStrict = wantsStrict(w, {
        ancestorChainVisible: gather.ancestorChainVisible,
        onScreen: onScreen(),
        occluded: occluded5,
        cssHidden: cssHidden5,
      });
      if (inStrict !== w.lastSentStrictViewport) {
        lists.strictDelta.push(w);
        if (probing) {
          const prev = lastStrictProbe.get(w);
          if (!prev) {
            lists.strictFlips.first++;
          } else {
            let changed = false;
            if (prev.onScreen !== onScreen()) { lists.strictFlips.geometry++; changed = true; }
            if (prev.clipped !== w.clipped) { lists.strictFlips.clipped++; changed = true; }
            if (prev.overlayCovered !== overlay5) { lists.strictFlips.overlayCovered++; changed = true; }
            if (prev.cssHidden !== cssHidden5) { lists.strictFlips.cssHidden++; changed = true; }
            if (prev.ancestor !== gather.ancestorChainVisible) { lists.strictFlips.ancestor++; changed = true; }
            if (!changed) lists.strictFlips.stable++;
          }
        }
      }
      if (probing) {
        lastStrictProbe.set(w, {
          onScreen: onScreen(),
          clipped: w.clipped,
          overlayCovered: overlay5,
          cssHidden: cssHidden5,
          ancestor: gather.ancestorChainVisible,
          inStrict,
        });
      }
    }
  }

  if (lazy.reads > 0) recordCpu('reconcilePlan:size:lazyReads', lazy.reads);
  return lists;
}

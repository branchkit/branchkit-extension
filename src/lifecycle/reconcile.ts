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
import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { VIEWPORT_MARGIN_PX } from '../observe/intersection-tracker';
import { wantsCodeword, wantsHint, wantsShown, wantsStrict } from './desired-state';
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
// The strict delta is computed separately (computeStrictDeltaPlan) because
// its two flag inputs (`occluded`, `cssHidden`) are written by the occlusion
// and visibility steps that run between the gather and the strict step; when
// the occlusion hit-tests move into the gather (Phase D territory), it folds
// into the single plan call.
//
// Ordering is simulated, not assumed: the show/hide derivation runs against
// the band flags as repaired by the teardown sim, and against badge
// visibility as it stands after the conditional build pass the live teardown
// triggers (badgeNewlyCodeworded runs inside teardown's reconcile() only when
// a stale-FALSE repair happened).
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
   * delta is computed. */
  cssHiddenDelta: Array<[ElementWrapper, boolean]>;
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
    cssHiddenDelta: [],
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

    // Claim sim — refreshViewportClaims over post-repair flags.
    if (flag && w.scanned.codeword.length === 0) lists.toClaim.push(w);

    // Build sim — badgeNewlyCodeworded's paint set: wants a hint, badge not
    // currently showing, target on-screen and CSS-visible.
    const wantsHintNow = flag && w.scanned.codeword.length > 0
      && (!activeCategory || w.category === activeCategory);
    const showingAtPlan = w.hint?.isVisible ?? false;
    let builtAndShown = false;
    if (wantsHintNow && !showingAtPlan) {
      const r = gather.rects.get(w);
      const onScreen = r
        ? isRectOnScreen(r, gather.vw, gather.vh)
        : lazyOnScreen(w, gather.vw, gather.vh, lazy);
      const cssVisible = gather.cssVisible.get(w) ?? lazyCssVisible(w, lazy);
      if (onScreen && cssVisible) {
        lists.toBuild.push(w);
        builtAndShown = buildPassRuns;
      }
    }

    // Step-5 sim — the visibility recheck's show/hide transitions, over the
    // post-repair flag and post-build badge visibility.
    const hasBadgeAtRecheck = w.hint !== null || builtAndShown;
    if (!hasBadgeAtRecheck || !flag || !w.element.isConnected) continue;
    const showingAtRecheck = showingAtPlan || builtAndShown;
    const r = gather.rects.get(w);
    const onScreen = r
      ? isRectOnScreen(r, gather.vw, gather.vh)
      : lazyOnScreen(w, gather.vw, gather.vh, lazy);
    const cssVisible = gather.cssVisible.get(w) ?? lazyCssVisible(w, lazy);
    // The recheck's write-through: cssHidden tracks !cssVisible for every
    // member of its set, not just transitioning ones.
    if (w.cssHidden !== !cssVisible) lists.cssHiddenDelta.push([w, !cssVisible]);
    const visible = w.hint
      ? wantsShown(w, { flagInBand: flag, cssVisible, onScreen })
      : (cssVisible && onScreen); // freshly-constructed badge: shown-ness core
    if (visible && !showingAtRecheck) lists.toShow.push(w);
    else if (!visible && showingAtRecheck) lists.toHide.push(w);
  }

  if (lazy.reads > 0) recordCpu('reconcilePlan:size:lazyReads', lazy.reads);
  return lists;
}

/**
 * The strict-delta half of the plan: wrappers whose `_strict` membership
 * (per `wantsStrict`) differs from the last value pushed to the plugin.
 * Call AFTER the occlusion and visibility steps have written `occluded` /
 * `cssHidden` for this settle — the predicate reads those flags live, the
 * geometry comes from the gather.
 */
export function computeStrictDeltaPlan(
  wrappers: Iterable<ElementWrapper>,
  gather: SettleGather,
): ElementWrapper[] {
  const lazy = { reads: 0 };
  const delta: ElementWrapper[] = [];
  for (const w of wrappers) {
    if (w.disconnectedAt !== null) continue;
    if (!w.scanned.codeword) continue;
    const r = gather.rects.get(w);
    const onScreen = r
      ? (r.bottom > 0 && r.top < gather.vh && r.right > 0 && r.left < gather.vw)
      : lazyOnScreen(w, gather.vw, gather.vh, lazy);
    const inStrict = wantsStrict(w, {
      ancestorChainVisible: gather.ancestorChainVisible,
      onScreen,
    });
    if (inStrict !== w.lastSentStrictViewport) delta.push(w);
  }
  if (lazy.reads > 0) recordCpu('reconcilePlan:size:lazyReads', lazy.reads);
  return delta;
}

// --- Shadow diff (plan lists vs what the live steps actually did) ---

export interface ShadowClassDiff {
  /** List sizes (planned vs live-acted) — proof the diff compared real
   * volume, and the future applied-counts telemetry (decision 4). */
  planned: number;
  acted: number;
  planOnly: number;
  liveOnly: number;
  planOnlySample: string[];
  liveOnlySample: string[];
}

export interface ShadowDiff {
  release: ShadowClassDiff;
  repair: ShadowClassDiff;
  show: ShadowClassDiff;
  hide: ShadowClassDiff;
  strict: ShadowClassDiff;
  /** Sum of every class's planOnly + liveOnly — zero means the plan's lists
   * exactly matched the live steps this settle. */
  total: number;
}

function wrapperTag(w: ElementWrapper): string {
  return w.scanned.codeword || `#${w.scanned.id}`;
}

function diffClass(plan: ElementWrapper[], live: ElementWrapper[]): ShadowClassDiff {
  const planSet = new Set(plan);
  const liveSet = new Set(live);
  const planOnly: ElementWrapper[] = plan.filter(w => !liveSet.has(w));
  const liveOnly: ElementWrapper[] = live.filter(w => !planSet.has(w));
  return {
    planned: plan.length,
    acted: live.length,
    planOnly: planOnly.length,
    liveOnly: liveOnly.length,
    planOnlySample: planOnly.slice(0, 3).map(wrapperTag),
    liveOnlySample: liveOnly.slice(0, 3).map(wrapperTag),
  };
}

export interface LiveSettleActions {
  released: ElementWrapper[];
  repaired: ElementWrapper[];
  shown: ElementWrapper[];
  hidden: ElementWrapper[];
  strictDelta: ElementWrapper[];
}

export function diffShadow(
  lists: ReconcilePlanLists,
  strictPlan: ElementWrapper[],
  live: LiveSettleActions,
): ShadowDiff {
  const release = diffClass(lists.toRelease, live.released);
  const repair = diffClass(lists.toRepair, live.repaired);
  const show = diffClass(lists.toShow, live.shown);
  const hide = diffClass(lists.toHide, live.hidden);
  const strict = diffClass(strictPlan, live.strictDelta);
  const total =
    release.planOnly + release.liveOnly +
    repair.planOnly + repair.liveOnly +
    show.planOnly + show.liveOnly +
    hide.planOnly + hide.liveOnly +
    strict.planOnly + strict.liveOnly;
  return { release, repair, show, hide, strict, total };
}

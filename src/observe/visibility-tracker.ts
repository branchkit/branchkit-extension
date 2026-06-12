/**
 * BranchKit Browser — visibility recovery (source).
 *
 * Promotes elements that matched HINTABLE_SELECTOR but failed isVisible() at
 * scan time, and gates already-hinted badges as page-script visibility flips.
 * Extracted from content.ts module scope (Tier 1 of
 * notes/DESIGN_EXTENSION_RESTRUCTURE.md). It owns the `pendingVisibility` set
 * and the two visibility observers; the attention observer (owned by the
 * `pageSession`) feeds candidates in via `trackPendingCandidate` /
 * `untrackPendingCandidate`.
 *
 * Two layers (see notes/completed/DESIGN_VISIBILITY_OBSERVER.md):
 *   1. IntersectionObserver catches display:none -> block (geometry change).
 *   2. Scoped MutationObserver on class/style catches visibility:hidden ->
 *      visible (no geometry change). Connected only while candidates exist;
 *      disconnects when the set empties. RAF-debounced to coalesce React's
 *      per-component class churn into one re-check per frame.
 *
 * `attachWrapper` is a direct import from core/wrapper-lifecycle; the
 * `pageSession` singleton is imported from lifecycle/page-session, and the
 * remaining content.ts orchestration (`showHints`, the strict-viewport
 * re-push) arrives through `pageSession.deps`. The two observers here are
 * constructed by `constructVisibilityObservers()`, called from
 * `PageSession.start()` — the session owns observer construction (Tier 3 of
 * notes/DESIGN_EXTENSION_RESTRUCTURE.md).
 */

import { ElementWrapper } from '../scan/element-wrapper';
import { scanSingle, isVisible } from '../scan/scanner';
import { cacheVisibility, clearLayoutCache, getCachedRect, isRectOnScreen } from '../layout-cache';
import { recordCpu } from '../debug/perf-counters';
import { store } from '../core/store';
import { attachWrapper } from '../core/wrapper-lifecycle';
import { pageSession } from '../lifecycle/page-session';
import type { SettleGather } from '../lifecycle/gather';

const pendingVisibility = new Set<Element>();
const VISIBILITY_ABANDON_MS = 30_000;
let visibilityAbandonTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityRafPending = false;

let visibilityIO: IntersectionObserver | undefined;
let visibilityMO: MutationObserver | undefined;

/** Construct the two visibility observers. Called once from
 * `PageSession.start()`. Construction is inert — nothing is observed until a
 * candidate is tracked. */
export function constructVisibilityObservers(): void {
  visibilityIO = new IntersectionObserver((entries) => {
    let dirty = false;
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      visibilityIO?.unobserve(el);
      if (store.findWrapperFor(el)) { pendingVisibility.delete(el); continue; }
      const scanned = scanSingle(el);
      // Keep in pendingVisibility — visibility:hidden elements have non-zero
      // rects so IO fires immediately, but they need the MO layer to promote
      // them once a class/style change flips visibility.
      if (!scanned) continue;
      attachWrapper(new ElementWrapper(el, scanned));
      pendingVisibility.delete(el);
      dirty = true;
    }
    // attachWrapper above emits a store attach delta → grammar sync (Tier 2).
    if (dirty && pageSession.hintsVisible) pageSession.deps.showHints();
    if (pendingVisibility.size === 0) disconnectVisibilityMO();
  }, { root: null, rootMargin: '200px', threshold: 0 });

  visibilityMO = new MutationObserver(() => {
    scheduleVisibilitySweep();
  });
}

// A "visibility may have changed" signal does two distinct things, on two
// cadences:
//   1. PROMOTE — re-scan `pendingVisibility` so a candidate that just became
//      visible turns into a hinted wrapper (rAF-coalesced; `recheckPendingVisibility`).
//   2. RE-SHOW — re-check already-hinted badges to show/hide them to match
//      current isVisible (100ms-throttled; `recheckHintedVisibility`).
// The class/style MutationObserver fires this for mutation-driven reveals.
// Pointer events fire it too (content.ts) for pure CSS `:hover` reveals, which
// produce NO mutation — without the PROMOTE half, a freshly-:hover-revealed
// element that was never scanned-while-visible never becomes a wrapper, so the
// recheck has nothing to show (the temperamental "hover the report, no hint").
//
// The 100ms throttle on the re-show is separate from the rAF promote because on
// heavy pages (YouTube /watch ad iframes, reflow storms) the MO fires many times
// per second; coupling the re-show to rAF (16ms) compounded into ~200ms CPU/min
// and tripped Firefox's slow-extension warning (reverted 2026-06-02). 100ms
// (Rango's debouncedRefresh interval) keeps it bounded to ~30ms/sec worst case.
// MutationObserver path: fast rAF promote (keep up with mutation storms) + the
// shared 100ms-throttled re-show. The pointer path uses the throttled variant
// below.
function scheduleVisibilitySweep(): void {
  if (!visibilityRafPending) {
    visibilityRafPending = true;
    requestAnimationFrame(recheckPendingVisibility);
  }
  scheduleHintVisibilityRecheck();
}

// Pointer-driven sweep variant. Same two halves, but the PROMOTE runs on a 100ms
// throttle instead of rAF: pointer events fire on every element-boundary crossing
// during mouse movement, and at rAF cadence the promote scan would run ~60×/sec
// while the cursor moves over a dense page. A hover-revealed badge appearing
// ~100ms after the hover is imperceptible, so the fast cadence buys no UX — the
// throttle cuts that movement-driven cost ~6× while leaving the MutationObserver
// on its fast rAF promote (which must keep up with mutation storms). The re-show
// half is already 100ms-throttled and shared.
let promoteThrottlePending = false;
const PROMOTE_THROTTLE_MS = 100;
function schedulePromoteThrottled(): void {
  if (promoteThrottlePending) return;
  promoteThrottlePending = true;
  setTimeout(() => {
    promoteThrottlePending = false;
    recheckPendingVisibility();
  }, PROMOTE_THROTTLE_MS);
}

export function schedulePointerVisibilitySweep(): void {
  schedulePromoteThrottled();
  scheduleHintVisibilityRecheck();
}

// Throttle state for the hint-visibility recheck. Single pending flag; many
// visibilityMO fires within a 100ms window collapse to one recheck.
let hintVisibilityRecheckPending = false;
const HINT_VISIBILITY_RECHECK_THROTTLE_MS = 100;

export function scheduleHintVisibilityRecheck(): void {
  if (hintVisibilityRecheckPending) return;
  hintVisibilityRecheckPending = true;
  setTimeout(() => {
    hintVisibilityRecheckPending = false;
    recheckHintedVisibility();
  }, HINT_VISIBILITY_RECHECK_THROTTLE_MS);
}

// Iterate hinted wrappers, hide/show their badges based on current
// isVisible(). Also writes `w.cssHidden` (so do the paint sites — showHints,
// badgeNewlyCodeworded): a target hidden because it's CSS-invisible
// (visibility:hidden/opacity:0 — a hover-reveal action bar) is flagged so the
// strict-viewport pass drops it from the voice-matchable `_strict` collection.
// We previously kept the codeword live for
// CSS-hidden targets (Rango's updateShouldBeHinted semantics — voice-activate a
// hover-revealed control you can't see); the QuickBase WidgetActions ghost-badge
// report changed that policy to "if the badge is hidden, voice can't match it
// either." When any badge flips shown/hidden, fire `onVisibilityChanged` so the
// strict delta re-pushes without waiting for the next scroll-settle.
// The settle pipeline passes its gather snapshot (Phase B of
// notes/DESIGN_UNIFIED_RECONCILER.md) so the style/rect reads come out of the
// once-per-settle batched pass; the throttled out-of-pipeline callers run the
// legacy self-read path. Wrapper flags are always read live. Returns the
// badges it actually transitioned so the pipeline can diff the shadow plan's
// toShow/toHide lists against the live actions (Phase C).
export function recheckHintedVisibility(
  gather?: SettleGather,
): { shown: ElementWrapper[]; hidden: ElementWrapper[] } {
  const __cpuStart = performance.now();
  const acted: { shown: ElementWrapper[]; hidden: ElementWrapper[] } = { shown: [], hidden: [] };
  // Don't re-show badges the user just hid. Without this guard, hideHints()
  // sets pageSession.hintsVisible=false and clears each badge's visible
  // class — but the next visibilityMO tick (or periodic recheck) walks
  // every wrapper, sees its target is CSS-visible, and calls hint.show()
  // again. The user observes "I said hide and the badges flashed off then
  // popped back on." This function exists to catch *page-script-driven*
  // visibility changes (YouTube fade-out, dropdown close), NOT to override
  // the user's explicit hide intent.
  if (!pageSession.hintsVisible) {
    recordCpu('recheckHintedVisibility', performance.now() - __cpuStart);
    return acted;
  }
  const wrappers = store.all;
  const hinted: Element[] = [];
  for (const w of wrappers) {
    // Only consider wrappers IO says are in-viewport. With hint reuse
    // (DESIGN_HINT_REUSE.md), `w.hint` persists for out-of-viewport
    // wrappers in dormant state — including them here would let the
    // `visible && !showing` branch below re-show a hint for a wrapper
    // the IO already released, painting badges off-screen.
    if (w.hint && w.isInViewport && w.element.isConnected) hinted.push(w.element);
  }
  if (hinted.length === 0) {
    recordCpu('recheckHintedVisibility', performance.now() - __cpuStart);
    return acted;
  }
  // Reads come from the settle gather when present (snapshot taken at
  // pipeline start; misses fall back live). Legacy path warms the layout
  // cache itself.
  if (!gather) cacheVisibility(hinted);
  // cacheVisibility warms each seed element's rect too, so getCachedRect below
  // is free. Gate paint on actual viewport geometry, not the tracker's wide-
  // margin isInViewport flag: an element parked off-screen but within that
  // margin (YouTube's collapsed nav drawer at x=-228) is isInViewport-true yet
  // must not paint a badge clamped to the edge. Without this the reposition
  // pass hides it and this loop re-shows it 100ms later — the flashing column.
  const vw = gather?.vw ?? window.innerWidth, vh = gather?.vh ?? window.innerHeight;
  let transitions = 0;
  try {
    for (const w of wrappers) {
      if (!w.hint || !w.isInViewport || !w.element.isConnected) continue;
      // Split the two reasons a badge hides: CSS-invisible (visibility/opacity —
      // voice should drop it) vs merely off the real viewport (the band-margin
      // clamp — geometry already drops it from strict, so don't flag cssHidden).
      const cssVisible = gather?.cssVisible.get(w) ?? isVisible(w.element);
      const rect = gather?.rects.get(w) ?? getCachedRect(w.element);
      const visible = cssVisible && isRectOnScreen(rect, vw, vh);
      w.cssHidden = !cssVisible;
      const showing = w.hint.isVisible;
      if (visible && !showing) {
        w.hint.show(w.grammarReady);
        transitions++;
        acted.shown.push(w);
      } else if (!visible && showing) {
        w.hint.hide();
        transitions++;
        acted.hidden.push(w);
      }
    }
  } finally {
    clearLayoutCache();
  }
  recordCpu('recheckHintedVisibility', performance.now() - __cpuStart);
  if (transitions > 0) {
    recordCpu(`recheckHintedVisibility:transitions:${transitions > 10 ? '10+' : '<10'}`, transitions);
    // A badge flipped shown/hidden → its strict-viewport eligibility may have
    // changed too. Re-push the strict delta now (debounced downstream) so voice
    // converges with the visual without waiting for a scroll-settle.
    pageSession.deps.onVisibilityChanged();
  }
  return acted;
}

function anyHintedWrapperVisible(): boolean {
  for (const w of store.all) {
    // Dormant reused hints exist but aren't visible — only currently-
    // showing hints count toward "visible" here.
    if (w.hint?.isVisible) return true;
  }
  return false;
}

export function connectVisibilityMO(): void {
  if (visibilityAbandonTimer) clearTimeout(visibilityAbandonTimer);
  visibilityAbandonTimer = setTimeout(() => {
    for (const el of pendingVisibility) visibilityIO?.unobserve(el);
    pendingVisibility.clear();
    disconnectVisibilityMO();
  }, VISIBILITY_ABANDON_MS);
  if (pageSession.visibilityMOConnected) return;
  visibilityMO?.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style'],
  });
  pageSession.visibilityMOConnected = true;
}

function disconnectVisibilityMO(): void {
  if (!pageSession.visibilityMOConnected) return;
  // Stay connected while any wrapper owns a hint — the throttled
  // recheckHintedVisibility relies on this MO to catch class/style
  // transitions that hide/show hinted targets (YouTube player controls,
  // sticky headers, sliding sidebars). Cost is bounded by the 100ms
  // throttle, so leaving the MO connected on a hinted page costs at most
  // ~30ms CPU per second of activity.
  if (anyHintedWrapperVisible()) return;
  visibilityMO?.disconnect();
  pageSession.visibilityMOConnected = false;
  if (visibilityAbandonTimer) {
    clearTimeout(visibilityAbandonTimer);
    visibilityAbandonTimer = null;
  }
}

function recheckPendingVisibility(): void {
  const __cpuStart = performance.now();
  const __initialSize = pendingVisibility.size;
  visibilityRafPending = false;
  let dirty = false;
  // Pre-cache the union of (target + ancestor chain) so the many
  // isVisible() reads inside scanSingle share the read. Same trick as
  // drainReevaluations — siblings under one parent reuse the ancestor
  // walk's computedStyle reads. Cleared in `finally` so the next frame
  // sees live state.
  cacheVisibility(pendingVisibility);
  try {
    for (const el of pendingVisibility) {
      if (!el.isConnected) {
        pendingVisibility.delete(el);
        visibilityIO?.unobserve(el);
        continue;
      }
      if (store.findWrapperFor(el)) {
        pendingVisibility.delete(el);
        visibilityIO?.unobserve(el);
        continue;
      }
      const scanned = scanSingle(el);
      if (!scanned) continue;
      pendingVisibility.delete(el);
      visibilityIO?.unobserve(el);
      attachWrapper(new ElementWrapper(el, scanned));
      dirty = true;
    }
  } finally {
    clearLayoutCache();
  }
  // attachWrapper above emits a store attach delta → grammar sync (Tier 2).
  if (dirty && pageSession.hintsVisible) pageSession.deps.showHints();
  if (pendingVisibility.size === 0) disconnectVisibilityMO();
  recordCpu('recheckPendingVisibility', performance.now() - __cpuStart);
  if (__initialSize > 0) recordCpu(`recheckPendingVisibility:size:${__initialSize > 1000 ? '1000+' : __initialSize > 100 ? '100-1000' : '<100'}`, __initialSize);
}

/**
 * Begin tracking an invisible candidate that just entered the attention
 * region. Called from the attention observer's onEnter. Adds it to the
 * pending set, observes it for geometry-driven reveal, and ensures the
 * class/style MutationObserver is running.
 */
export function trackPendingCandidate(el: Element): void {
  pendingVisibility.add(el);
  visibilityIO?.observe(el);
  connectVisibilityMO();
}

/**
 * Stop tracking a candidate that drifted out of the attention region.
 * Called from the attention observer's onLeave.
 */
export function untrackPendingCandidate(el: Element): void {
  if (pendingVisibility.has(el)) {
    pendingVisibility.delete(el);
    visibilityIO?.unobserve(el);
    if (pendingVisibility.size === 0) disconnectVisibilityMO();
  }
}

/**
 * Disconnect both visibility observers and drop all tracked state. Idempotent;
 * called from teardown. Also clears the pending set and the abandon timer so no
 * stray 30s callback fires into a torn-down context (the original inline
 * teardown only disconnected the observers).
 */
export function teardownVisibilityTracker(): void {
  try { visibilityIO?.disconnect(); } catch { /* idempotent */ }
  try { visibilityMO?.disconnect(); } catch { /* idempotent */ }
  if (visibilityAbandonTimer) {
    clearTimeout(visibilityAbandonTimer);
    visibilityAbandonTimer = null;
  }
  pendingVisibility.clear();
}

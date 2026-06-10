/**
 * BranchKit Browser — visibility recovery (source).
 *
 * Promotes elements that matched HINTABLE_SELECTOR but failed isVisible() at
 * scan time, and gates already-hinted badges as page-script visibility flips.
 * Extracted from content.ts module scope (Tier 1 of
 * notes/DESIGN_EXTENSION_RESTRUCTURE.md). It owns the `pendingVisibility` set
 * and the two visibility observers; the attention observer (still in
 * content.ts) feeds candidates in via `trackPendingCandidate` /
 * `untrackPendingCandidate`.
 *
 * Two layers (see notes/completed/DESIGN_VISIBILITY_OBSERVER.md):
 *   1. IntersectionObserver catches display:none -> block (geometry change).
 *   2. Scoped MutationObserver on class/style catches visibility:hidden ->
 *      visible (no geometry change). Connected only while candidates exist;
 *      disconnects when the set empties. RAF-debounced to coalesce React's
 *      per-component class churn into one re-check per frame.
 *
 * Transitional seam: `attachWrapper`, `showHints`, and the `pageSession`
 * instance still live in content.ts and are injected via `initVisibilityTracker`
 * (mirroring the PageSession hooks pattern). They become direct imports once the
 * wrapper-lifecycle lift and the store delta cut land.
 */

import { ElementWrapper } from '../scan/element-wrapper';
import { scanSingle, isVisible } from '../scan/scanner';
import { cacheVisibility, clearLayoutCache, getCachedRect, isRectOnScreen } from '../layout-cache';
import { recordCpu } from '../debug/perf-counters';
import { store } from '../core/store';
import type { PageSession } from '../lifecycle/page-session';

let pageSession!: PageSession;
let attachWrapper!: (w: ElementWrapper) => void;
let showHints!: () => void;
let onVisibilityChanged: (() => void) | undefined;

export interface VisibilityTrackerDeps {
  pageSession: PageSession;
  attachWrapper: (w: ElementWrapper) => void;
  showHints: () => void;
  /** Called after `recheckHintedVisibility` flips any badge's shown/hidden
   * state. Lets content.ts re-push the strict-viewport delta so a target the
   * recheck just hid (or re-showed) drops from (or rejoins) the voice-matchable
   * `_strict` collection promptly — without waiting for the next scroll-settle. */
  onVisibilityChanged?: () => void;
}

/** Wire the still-in-content.ts dependencies. Call once at boot, before any
 * candidate is observed. */
export function initVisibilityTracker(deps: VisibilityTrackerDeps): void {
  pageSession = deps.pageSession;
  attachWrapper = deps.attachWrapper;
  showHints = deps.showHints;
  onVisibilityChanged = deps.onVisibilityChanged;
}

const pendingVisibility = new Set<Element>();
const VISIBILITY_ABANDON_MS = 30_000;
let visibilityAbandonTimer: ReturnType<typeof setTimeout> | null = null;
let visibilityRafPending = false;

const visibilityIO = new IntersectionObserver((entries) => {
  let dirty = false;
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    const el = entry.target;
    visibilityIO.unobserve(el);
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
  if (dirty && pageSession.hintsVisible) showHints();
  if (pendingVisibility.size === 0) disconnectVisibilityMO();
}, { root: null, rootMargin: '200px', threshold: 0 });

const visibilityMO = new MutationObserver(() => {
  if (!visibilityRafPending) {
    visibilityRafPending = true;
    requestAnimationFrame(recheckPendingVisibility);
  }
  // Schedule a hint-visibility recheck on a separate, slower throttle than
  // recheckPendingVisibility's rAF cadence. On heavy pages (YouTube
  // /watch's ad iframes, page-load reflow storms) the MO fires many times
  // per second; coupling the hint recheck to rAF (16ms) compounded that
  // into ~200ms cumulative CPU per minute and tripped Firefox's slow-extension
  // warning (reverted 2026-06-02). 100ms throttle matches Rango's
  // debouncedRefresh interval — 10Hz upper bound keeps the recheck cost
  // bounded to ~30ms/sec even on the worst-case ad-storm pages.
  scheduleHintVisibilityRecheck();
});

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
export function recheckHintedVisibility(): void {
  const __cpuStart = performance.now();
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
    return;
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
    return;
  }
  cacheVisibility(hinted);
  // cacheVisibility warms each seed element's rect too, so getCachedRect below
  // is free. Gate paint on actual viewport geometry, not the tracker's 200px-
  // margin isInViewport flag: an element parked off-screen but within that
  // margin (YouTube's collapsed nav drawer at x=-228) is isInViewport-true yet
  // must not paint a badge clamped to the edge. Without this the reposition
  // pass hides it and this loop re-shows it 100ms later — the flashing column.
  const vw = window.innerWidth, vh = window.innerHeight;
  let transitions = 0;
  try {
    for (const w of wrappers) {
      if (!w.hint || !w.isInViewport || !w.element.isConnected) continue;
      // Split the two reasons a badge hides: CSS-invisible (visibility/opacity —
      // voice should drop it) vs merely off the real viewport (the band-margin
      // clamp — geometry already drops it from strict, so don't flag cssHidden).
      const cssVisible = isVisible(w.element);
      const visible = cssVisible && isRectOnScreen(getCachedRect(w.element), vw, vh);
      w.cssHidden = !cssVisible;
      const showing = w.hint.isVisible;
      if (visible && !showing) {
        w.hint.show(w.grammarReady);
        transitions++;
      } else if (!visible && showing) {
        w.hint.hide();
        transitions++;
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
    onVisibilityChanged?.();
  }
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
    for (const el of pendingVisibility) visibilityIO.unobserve(el);
    pendingVisibility.clear();
    disconnectVisibilityMO();
  }, VISIBILITY_ABANDON_MS);
  if (pageSession.visibilityMOConnected) return;
  visibilityMO.observe(document.documentElement, {
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
  visibilityMO.disconnect();
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
        visibilityIO.unobserve(el);
        continue;
      }
      if (store.findWrapperFor(el)) {
        pendingVisibility.delete(el);
        visibilityIO.unobserve(el);
        continue;
      }
      const scanned = scanSingle(el);
      if (!scanned) continue;
      pendingVisibility.delete(el);
      visibilityIO.unobserve(el);
      attachWrapper(new ElementWrapper(el, scanned));
      dirty = true;
    }
  } finally {
    clearLayoutCache();
  }
  // attachWrapper above emits a store attach delta → grammar sync (Tier 2).
  if (dirty && pageSession.hintsVisible) showHints();
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
  visibilityIO.observe(el);
  connectVisibilityMO();
}

/**
 * Stop tracking a candidate that drifted out of the attention region.
 * Called from the attention observer's onLeave.
 */
export function untrackPendingCandidate(el: Element): void {
  if (pendingVisibility.has(el)) {
    pendingVisibility.delete(el);
    visibilityIO.unobserve(el);
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
  try { visibilityIO.disconnect(); } catch { /* idempotent */ }
  try { visibilityMO.disconnect(); } catch { /* idempotent */ }
  if (visibilityAbandonTimer) {
    clearTimeout(visibilityAbandonTimer);
    visibilityAbandonTimer = null;
  }
  pendingVisibility.clear();
}

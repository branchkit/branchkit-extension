/**
 * BranchKit Browser — visibility recovery (source).
 *
 * Promotes elements that matched HINTABLE_SELECTOR but failed isVisible() at
 * scan time, and turns page-script visibility flips on already-hinted badges
 * into settle-pass requests (the pass's plan owns the show/hide convergence).
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
import { scanSingle } from '../scan/scanner';
import { cacheVisibility, clearLayoutCache } from '../layout-cache';
import { recordCpu } from '../debug/perf-counters';
import { store } from '../core/store';
import { attachWrapper } from '../core/wrapper-lifecycle';
import { pageSession } from '../lifecycle/page-session';

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
//      Candidate lifecycle, not wrapper reconcile — it stays here.
//   2. RE-SHOW — already-hinted badges converge to current visibility. Phase E
//      of notes/DESIGN_UNIFIED_RECONCILER.md demoted this half from its own
//      100ms-throttled loop to a settle-pass request (schedulePassSoon, also
//      non-extending at the same 100ms cadence): the pass's plan derives
//      toShow/toHide/cssHidden from the gather, so one convergence engine
//      serves the settle and between-settle triggers alike.
// The class/style MutationObserver fires this for mutation-driven reveals.
// Pointer events fire it too (content.ts) for pure CSS `:hover` reveals, which
// produce NO mutation — without the PROMOTE half, a freshly-:hover-revealed
// element that was never scanned-while-visible never becomes a wrapper, so the
// pass has nothing to show (the temperamental "hover the report, no hint").
//
// The promote stays on rAF for the MO path (must keep up with mutation
// storms; coupling the RE-SHOW to rAF was what compounded into ~200ms
// CPU/min and tripped Firefox's slow-extension warning, reverted 2026-06-02
// — the re-show cadence stays 100ms via the pass timer).
function scheduleVisibilitySweep(): void {
  if (!visibilityRafPending) {
    visibilityRafPending = true;
    requestAnimationFrame(recheckPendingVisibility);
  }
  pageSession.deps.schedulePassSoon();
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
  // RE-SHOW half: demoted to the settle pass (Phase E) — the plan's
  // toShow/toHide/cssHidden derivation converges hinted badges, including
  // the "user just hid" guard (the pipeline gates on hintsVisible) and the
  // strict re-push (the plan's strictDelta rides the same pass).
  pageSession.deps.schedulePassSoon();
}

// (recheckHintedVisibility is gone — Phase E of
// notes/DESIGN_UNIFIED_RECONCILER.md. Badge show/hide convergence, the
// cssHidden write-through, and the QuickBase ghost-badge policy ("if the
// badge is hidden, voice can't match it either") live in the plan's
// wantsShown/wantsStrict derivation; the between-settle triggers above just
// request the pass.)

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
  // Stay connected while any wrapper owns a hint — this MO is what turns
  // class/style transitions that hide/show hinted targets (YouTube player
  // controls, sticky headers, sliding sidebars) into settle-pass requests.
  // Cost is bounded by the pass timer's 100ms single-flight, so leaving the
  // MO connected on a hinted page stays cheap.
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

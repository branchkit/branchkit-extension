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
 * Three layers (see notes/completed/DESIGN_VISIBILITY_OBSERVER.md +
 * notes/DESIGN_FLING_WAVE.md round 21):
 *   1. IntersectionObserver catches display:none -> block (geometry change) —
 *      one delivery per candidate, then it defers to the other layers.
 *   2. Scoped MutationObserver on class/style catches visibility:hidden ->
 *      visible (no geometry change). Connected only while candidates exist;
 *      disconnects when the set empties. RAF-debounced to coalesce React's
 *      per-component class churn into one re-check per frame.
 *   3. Per-candidate ResizeObserver catches MUTATION-FREE box gains — the
 *      reveals neither MO can see: React text fills (characterData-only,
 *      outside every childList/attributes config — QuickBase lookup-column
 *      anchors render empty with href and fill ~2.5-3.5s later when the
 *      related-table data lands), and CSSOM/stylesheet-driven sizing
 *      (Emotion insertRule). Observed at park, unobserved at
 *      promote/untrack; zero-box deliveries are dropped (they can't flip
 *      the size gate, and they absorb the RO's initial-fire storm). This
 *      is Rango's sleeper sensor (their ElementWrapper ResizeObserver on
 *      every hintable) scoped to our bounded parked set.
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
import { lifecycleCounters, recordCpu } from '../debug/perf-counters';
import { store } from '../core/store';
import { attachWrapper } from '../core/wrapper-lifecycle';
import { pageSession } from '../lifecycle/page-session';

// Candidates are held until they promote, disconnect, or leave the attention
// region (untrackPendingCandidate via the attention IO's onLeave — which also
// fires for DOM removal). No time-based abandonment: the original 30s
// abandon timer predated the attention-region scoping (it was the cost bound
// for a document-wide candidate set) and permanently stranded pre-mounted,
// CSS-revealed UI opened >30s after discovery — the attention IO never
// refires onEnter for an element it already considers intersecting, so an
// abandoned candidate could never re-track without a scroll across the
// region boundary. The set is now bounded by attention-region membership;
// the recheckPendingVisibility:size perf bucket is the growth tripwire.
const pendingVisibility = new Set<Element>();
let visibilityRafPending = false;

let visibilityIO: IntersectionObserver | undefined;
let visibilityMO: MutationObserver | undefined;
let visibilityRO: ResizeObserver | undefined;

// Layer-3 signal classifier, split from the RO callback for unit tests
// (happy-dom constructs ResizeObserver but never delivers). A parked
// candidate reporting a real box is the mutation-free reveal; count it and
// let the shared rAF promote apply the actual gates. Zero-box deliveries
// (the initial fire at observe time for a still-collapsed element, or a
// shrink) can't flip the size gate — dropping them also drops the
// initial-fire storm a park burst would otherwise cause. A nonzero initial
// fire is kept deliberately: it means the element gained its box between
// the walk's rejection and the RO's first delivery, which is exactly the
// race the sensor exists to close.
function parkedResizeSignal(target: Element, hasBox: boolean): boolean {
  if (!hasBox || !pendingVisibility.has(target)) return false;
  lifecycleCounters.visibilityRoSignals++;
  return true;
}

function handleParkedResizeEntries(entries: ResizeObserverEntry[]): void {
  let dirty = false;
  for (const entry of entries) {
    const box = entry.borderBoxSize?.[0];
    const hasBox = box
      ? box.inlineSize >= 1 && box.blockSize >= 1
      : entry.contentRect.width >= 1 && entry.contentRect.height >= 1;
    if (parkedResizeSignal(entry.target, hasBox)) dirty = true;
  }
  // Same two-cadence signal as the class/style MO: rAF promote + settle-pass
  // request (the pass converges already-hinted badges; the promote turns the
  // revealed candidate into a wrapper).
  if (dirty) scheduleVisibilitySweep();
}

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
      if (store.findWrapperFor(el)) {
        pendingVisibility.delete(el);
        visibilityRO?.unobserve(el);
        continue;
      }
      const scanned = scanSingle(el);
      // Keep in pendingVisibility — visibility:hidden elements have non-zero
      // rects so IO fires immediately, but they need the MO layer to promote
      // them once a class/style change flips visibility (and the RO layer to
      // promote a mutation-free box gain).
      if (!scanned) continue;
      attachWrapper(new ElementWrapper(el, scanned), 'visibility');
      pendingVisibility.delete(el);
      visibilityRO?.unobserve(el);
      dirty = true;
    }
    // attachWrapper above emits a store attach delta → grammar sync (Tier 2).
    if (dirty && pageSession.hintsVisible) pageSession.deps.showHints();
    if (pendingVisibility.size === 0) disconnectVisibilityMO();
  }, { root: null, rootMargin: '200px', threshold: 0 });

  visibilityMO = new MutationObserver(() => {
    scheduleVisibilitySweep();
  });

  // Layer 3 (round 21). Constructed inert like the others; candidates are
  // observed as they park. Guarded: happy-dom/older engines without RO just
  // lose the sensor, not the tracker.
  visibilityRO = typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver(handleParkedResizeEntries)
    : undefined;
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
  if (pageSession.visibilityMOConnected) return;
  visibilityMO?.observe(document.documentElement, {
    subtree: true,
    attributes: true,
    // open/hidden: <details> toggling and hidden-attr reveals mutate
    // NEITHER class nor style, and (for details) not geometry either —
    // Chrome keeps closed-details content laid out under
    // content-visibility, so the attention IO never fires on open. The
    // open-attr mutation is the only reveal signal for candidates parked
    // by the checkVisibility gate.
    attributeFilter: ['class', 'style', 'open', 'hidden'],
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
        visibilityRO?.unobserve(el);
        continue;
      }
      if (store.findWrapperFor(el)) {
        pendingVisibility.delete(el);
        visibilityIO?.unobserve(el);
        visibilityRO?.unobserve(el);
        continue;
      }
      const scanned = scanSingle(el);
      if (!scanned) continue;
      pendingVisibility.delete(el);
      visibilityIO?.unobserve(el);
      visibilityRO?.unobserve(el);
      attachWrapper(new ElementWrapper(el, scanned), 'visibility');
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
  visibilityRO?.observe(el);
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
    visibilityRO?.unobserve(el);
    if (pendingVisibility.size === 0) disconnectVisibilityMO();
  }
}

/**
 * Disconnect both visibility observers and drop all tracked state. Idempotent;
 * called from teardown. Also clears the pending set (the original inline
 * teardown only disconnected the observers).
 */
export function teardownVisibilityTracker(): void {
  try { visibilityIO?.disconnect(); } catch { /* idempotent */ }
  try { visibilityMO?.disconnect(); } catch { /* idempotent */ }
  try { visibilityRO?.disconnect(); } catch { /* idempotent */ }
  pendingVisibility.clear();
}

// Test seams: happy-dom constructs the observers but never delivers entries,
// so the layer-3 classifier and the promote pass are driven directly.
export const __testing = {
  parkedResizeSignal,
  recheckNow: recheckPendingVisibility,
  isPending: (el: Element): boolean => pendingVisibility.has(el),
};

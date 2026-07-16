/**
 * BranchKit Browser — scroll-container clip detection (Rango's IO-root=scroller
 * idea, adapted to body-mounted badges).
 *
 * The body-mounted badge escapes the page's clipping, so when its target scrolls
 * out of an inner overflow pane the badge keeps painting where the (now-clipped)
 * target's rect is — a ghost. Rango avoids this by NESTING the hint in the
 * target's container (so it clips with it); we keep body-mounting (binding
 * robustness) and instead DETECT the clip with an `IntersectionObserver` whose
 * `root` is the target's scroll container. When the target leaves that container
 * the IO reports `isIntersecting: false` → we flag the wrapper `clipped`.
 *
 * Why IO and not the elementFromPoint pass: IO is compositor-driven and
 * overflow-clip-aware — it updates continuously and in sync with scroll (no
 * settle-debounce, no per-frame JS, no flicker), and it sees clipping that
 * `elementFromPoint` misses on `pointer-events:none` covers. It does NOT catch
 * arbitrary overlays (that stays the elementFromPoint job); the two signals
 * compose via `applyOcclusion` (effective = overlayCovered || clipped).
 *
 * Flag-gated (`bkClipObserver`, default ON). One shared observer per scroll
 * container root (like Rango's `scrollIntersectionObservers`), released when
 * its last target is dropped: `observersByRoot` holds a strong ref to the root
 * Element, so an entry that outlives its targets pins the root — and, for a
 * detached SPA route's main scroller, the route's entire subtree — for the
 * life of the tab. Hundreds of SPA navs/day made this the extension's largest
 * long-session memory leak (notes/INVESTIGATION_LONG_SESSION_PERF.md, finding 1).
 */

import type { ElementWrapper } from '../scan/element-wrapper';
import { findClippingScroller } from '../render/scroll-accel';
import { applyOcclusion } from './occlusion';

let clipObserverEnabled = false;

export function setClipObserverEnabled(enabled: boolean): void {
  clipObserverEnabled = enabled;
  if (!enabled) drainClipObservers();
}

export function isClipObserverEnabled(): boolean {
  return clipObserverEnabled;
}

const observersByRoot = new Map<Element, IntersectionObserver>();
// Live-target refcount per root, release-at-zero (container-resize-tracker's
// pattern). Only the count matters — membership already lives in rootByTarget,
// so a Set here was a second sync surface whose contents were never read.
const targetCountByRoot = new Map<Element, number>();
const rootByTarget = new Map<Element, Element>();
const wrapperByTarget = new Map<Element, ElementWrapper>();

function getObserver(root: Element): IntersectionObserver {
  let io = observersByRoot.get(root);
  if (!io) {
    io = new IntersectionObserver(onClipIntersection, { root, threshold: 0 });
    observersByRoot.set(root, io);
  }
  return io;
}

function onClipIntersection(entries: IntersectionObserverEntry[]): void {
  for (const e of entries) {
    const w = wrapperByTarget.get(e.target);
    if (!w) continue;
    // Clipped = the target is NOT intersecting its scroll container's visible box
    // (scrolled out of the pane / under a scroll-clipping header). The initial
    // IO callback on observe() also lands here, so an already-clipped target is
    // hidden immediately.
    w.clipped = !e.isIntersecting;
    applyOcclusion(w);
  }
}

function unobserveTarget(el: Element): void {
  const root = rootByTarget.get(el);
  if (root) {
    const io = observersByRoot.get(root);
    io?.unobserve(el);
    // Last target gone → release the root's observer. Without this the Map
    // entry (strong ref to the root) survives the root's own disconnection,
    // pinning detached SPA subtrees until teardown. Underflow can't occur:
    // the decrement only runs for a target rootByTarget still holds, and
    // every rootByTarget entry contributed exactly one count.
    const count = targetCountByRoot.get(root) ?? 0;
    if (count <= 1) {
      io?.disconnect();
      observersByRoot.delete(root);
      targetCountByRoot.delete(root);
    } else {
      targetCountByRoot.set(root, count - 1);
    }
  }
  rootByTarget.delete(el);
  const w = wrapperByTarget.get(el);
  wrapperByTarget.delete(el);
  // Clear the clip signal so dropping observation can't strand a hidden badge.
  if (w && w.clipped) {
    w.clipped = false;
    applyOcclusion(w);
  }
}

/**
 * The clipping scroller currently bound to a hinted target, if any (round
 * 36b): placement uses this to flip a badge below its icon when the
 * above-position would poke past the scroller's top edge and get clipped
 * mid-letters. Read-only view over the same bookkeeping the clip IO uses,
 * so placement and clip detection can't disagree about which scroller
 * clips a target.
 */
export function clipRootOf(el: Element): Element | null {
  return rootByTarget.get(el) ?? null;
}

/**
 * Level-triggered sync: observe every currently-hinted, connected target that
 * lives inside an inner scroll container; drop targets that are gone. Called
 * from the settle handlers. The IO drives `clipped` continuously between calls —
 * this only reconciles the membership. `findScrollableAncestor` (reused from the
 * accelerator) runs once per newly-observed target; already-observed ones are
 * skipped, so per-settle cost is bounded to churn. No-op (and drains) when off.
 */
export function reconcileClipObservation(wrappers: Iterable<ElementWrapper>): void {
  if (!clipObserverEnabled) {
    if (rootByTarget.size > 0) drainClipObservers();
    return;
  }
  const wanted = new Set<Element>();
  for (const w of wrappers) {
    if (!w.hint || !w.element.isConnected) continue;
    wanted.add(w.element);
    const boundRoot = rootByTarget.get(w.element);
    if (boundRoot) {
      // Staleness recheck (cheap: Map/flag reads + one containment walk, no
      // layout). A same-task reparent never disconnects the element, so it
      // skips every limbo/unobserve reset path — without this, a target
      // whose old scroller detached stays bound to it forever: the detached
      // subtree stays pinned (defeating the last-target release) and the IO
      // reports a permanent non-intersection → visible badge wrongly hidden.
      // Same reset applies when the wrapper was recreated for the element
      // (attribute flap detach→reattach between settles) so clip signals
      // land on the live wrapper, not the dead one.
      //
      // The containment check closes what used to be a documented residual
      // gap: a reparent between two still-connected scrollers kept the stale
      // binding. QuickBase's double-buffered swap does that reparent at
      // SCALE — rows render in a hidden buffer container, then move into the
      // live pane — leaving ~186 visible targets bound to the buffer, whose
      // IO reports permanent non-intersection → clipped=true on shown
      // badges → they drop out of the voice-matchable _strict set AND the
      // hide→unobserve-clears-clipped→re-push→re-observe oscillator sustains
      // a ~620ms settle loop (169-entry strict re-push per cycle, 1.4k
      // plugin writes/sec — DESIGN_FLING_WAVE round 19). contains() is a
      // pointer walk on already-touched nodes; the bounded-to-churn cost
      // this loop guarantees is unchanged.
      if (boundRoot.isConnected && boundRoot.contains(w.element)
        && wrapperByTarget.get(w.element) === w) continue;
      unobserveTarget(w.element);
    }
    // The scroll container that actually CLIPS this target. Returns null for a
    // position:fixed target (or one nested under a fixed popup) — ancestor
    // overflow doesn't clip it, so rooting an IO at an ancestor scroller would
    // false-flag it `clipped` whenever it floats outside that scroller's box.
    const root = findClippingScroller(w.element);
    if (!root) continue; // viewport-only / fixed: clipping is covered by isInViewport
    // Bookkeeping BEFORE observe(): a throwing observe() must not strand a
    // root with a zero count (release could then never fire) or a
    // believed-observed target. Nothing depends on the order — the initial
    // IO callback is async (long-session review backlog, add-path ordering).
    // The count can't double-increment for one element: a still-bound target
    // either `continue`d above or went through unobserveTarget's decrement.
    rootByTarget.set(w.element, root);
    wrapperByTarget.set(w.element, w);
    targetCountByRoot.set(root, (targetCountByRoot.get(root) ?? 0) + 1);
    getObserver(root).observe(w.element);
  }
  for (const el of [...rootByTarget.keys()]) {
    if (!wanted.has(el)) unobserveTarget(el);
  }
}

/**
 * Disconnect every clip observer in one shot. For orphan/navigate teardown
 * (`quiesceOrphan` sweeps hosts via raw DOM, bypassing per-wrapper unobserve) and
 * when the flag flips off. Clears the clip signal on anything still flagged.
 */
export function drainClipObservers(): void {
  for (const io of observersByRoot.values()) io.disconnect();
  observersByRoot.clear();
  targetCountByRoot.clear();
  for (const w of wrapperByTarget.values()) {
    if (w.clipped) {
      w.clipped = false;
      applyOcclusion(w);
    }
  }
  rootByTarget.clear();
  wrapperByTarget.clear();
}

export function clipObserverDebug(): { roots: number; targets: number } {
  return { roots: observersByRoot.size, targets: rootByTarget.size };
}

/** Diagnostic/test accessor: the scroll-container root `el` is bound to. */
export function boundClipRoot(el: Element): Element | null {
  return rootByTarget.get(el) ?? null;
}

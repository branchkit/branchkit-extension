/**
 * Inner-scroll accelerator (notes/DESIGN_INNER_SCROLL_ACCELERATOR.md).
 *
 * Rides an inner overflow scroller on the compositor via a CSS `ScrollTimeline`
 * so a body-mounted hint badge stops wiggling when its target scrolls inside an
 * inner pane (QuickBase data-table grids). The reconcile base writes the
 * scroll-invariant `docY0` (the target's document position at the scroller's
 * scroll 0), and a `ScrollTimeline`-driven animation on the shadow `outer`
 * element supplies `translateY(-scrollTop)`; the composited sum is the live
 * position with zero main-thread chase.
 *
 * NON-LOAD-BEARING by contract (see the design note's safety contract): the
 * reconcile base in `hints.ts` stays the single source of truth. This module
 * only suppresses the wiggle WHEN HEALTHY; the moment the scroller is
 * disconnected or recreated, `scrollAccelHealthy` returns false and the badge
 * degrades to the existing JS-chase on the next reconcile pass — worst case the
 * wiggle returns, never a dangle. It writes NOTHING onto page elements: the
 * timeline references the scroller as a read-only `source` only.
 *
 * Pure (`findScrollableAncestor`) + feature-detected (`isScrollTimelineSupported`)
 * so it is unit-testable and a no-op on engines without scroll-driven animations
 * (Firefox stable today).
 */

// `ScrollTimeline` is a scroll-driven-animations constructor not yet in the DOM
// lib typings. Read it off the global and type it minimally rather than pulling
// in an ambient declaration that could collide with a future lib upgrade.
type ScrollTimelineCtor = new (options: { source: Element; axis?: 'block' | 'inline' }) => AnimationTimeline;

function getScrollTimelineCtor(): ScrollTimelineCtor | undefined {
  return (globalThis as { ScrollTimeline?: ScrollTimelineCtor }).ScrollTimeline;
}

/** Feature gate: is `ScrollTimeline` available? Absent on Firefox stable today
 *  (it ships behind a flag / in Nightly), so callers fall back to the chase. */
export function isScrollTimelineSupported(): boolean {
  return getScrollTimelineCtor() !== undefined;
}

export interface ScrollAccel {
  /** The inner scroller being ridden — referenced read-only as the timeline
   *  `source`; never written to. */
  readonly scroller: Element;
  /** The `ScrollTimeline` bound to `scroller` (stable across keyframe rebuilds). */
  readonly timeline: AnimationTimeline;
  /** The compositor animation on the shadow `outer` element; rebuilt when `max`
   *  changes (content reflow), so it is mutable. */
  anim: Animation;
  /** `scrollHeight - clientHeight` captured in the current keyframe. */
  max: number;
}

function scrollMax(scroller: Element): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

function parentPiercingShadow(node: Element): Element | null {
  const parent = node.parentElement;
  if (parent) return parent;
  const root = node.getRootNode();
  return root instanceof ShadowRoot ? (root.host as Element) : null;
}

function isVerticalScroller(el: Element): boolean {
  // scrollHeight > clientHeight AND overflow-y is auto|scroll: the element both
  // can and is allowed to scroll vertically right now. A momentarily
  // non-overflowing scroller (content shrank) reads as not-a-scroller, which is
  // correct — there is nothing to ride.
  if (el.scrollHeight <= el.clientHeight) return false;
  const overflowY = getComputedStyle(el).overflowY;
  return overflowY === 'auto' || overflowY === 'scroll';
}

/**
 * Nearest ancestor of `el` that is a live vertical overflow scroller, piercing
 * shadow boundaries. Excludes `documentElement`/`body` (window scroll is already
 * ridden by the absolute/fixed host). Returns null when the only scroller is the
 * document — meaning no accelerator, stay on the chase. Pure: no side effects,
 * reads layout + computed style only.
 */
export function findScrollableAncestor(el: Element): Element | null {
  const doc = el.ownerDocument;
  const docEl = doc ? doc.documentElement : null;
  const body = doc ? doc.body : null;
  let node = parentPiercingShadow(el);
  while (node) {
    if (node !== docEl && node !== body && isVerticalScroller(node)) {
      return node;
    }
    node = parentPiercingShadow(node);
  }
  return null;
}

function buildAnim(outer: HTMLElement, timeline: AnimationTimeline, max: number): Animation {
  // At scroll progress p = S/max the interpolated transform is
  // translateY(-p*max) = translateY(-S); composited, no main-thread work.
  // `fill: 'both'` holds the end transform past the range; `duration: 1` is the
  // non-zero duration Firefox requires for a scroll-driven animation.
  const options = { timeline, duration: 1, fill: 'both' } as unknown as KeyframeAnimationOptions;
  return outer.animate(
    [{ transform: 'translateY(0px)' }, { transform: `translateY(${-max}px)` }],
    options,
  );
}

/**
 * Create an accelerator for `target`'s nearest inner scroller, animating
 * `outer`'s transform with `translateY(-scrollTop)` on the compositor. Returns
 * null when `ScrollTimeline` is unsupported or `target` has no inner scroller
 * (caller then stays on the chase). The caller is responsible for the flag gate
 * and excluding viewport-pinned targets.
 */
export function createScrollAccel(target: Element, outer: HTMLElement): ScrollAccel | null {
  const Ctor = getScrollTimelineCtor();
  if (!Ctor) return null;
  const scroller = findScrollableAncestor(target);
  if (!scroller) return null;
  const max = scrollMax(scroller);
  const timeline = new Ctor({ source: scroller, axis: 'block' });
  const anim = buildAnim(outer, timeline, max);
  return { scroller, timeline, anim, max };
}

/**
 * Refresh the keyframe when the scroller's max scroll changed (content
 * loaded/reflowed), so the compositor delta keeps matching the live scroll
 * range. A no-op when `max` is unchanged — recreation is the rare exception, not
 * per-frame work. Reuses the existing timeline (still bound to the same
 * scroller); only the keyframe (which encodes `max`) is rebuilt.
 */
export function recomputeScrollAccel(accel: ScrollAccel, outer: HTMLElement): void {
  const max = scrollMax(accel.scroller);
  if (max === accel.max) return;
  accel.anim.cancel();
  accel.anim = buildAnim(outer, accel.timeline, max);
  accel.max = max;
}

/** Tear down the compositor animation, reverting `outer`'s transform to its base
 *  (no delta) so the chase base alone is correct. The timeline is dropped with
 *  the accel object by the caller. */
export function teardownScrollAccel(accel: ScrollAccel): void {
  accel.anim.cancel();
}

/**
 * Is the accelerator still valid for `target` this pass? True iff the ridden
 * scroller is still connected AND is still `target`'s nearest inner scroller
 * (identity check catches scroller recreation under virtualization, and a
 * scroller that stopped overflowing reads as no-longer-the-scroller). False ⇒
 * the caller drops the accel and falls back to the chase — the graceful-
 * degradation contract. Evaluated every reconcile pass (level-triggered).
 */
export function scrollAccelHealthy(accel: ScrollAccel, target: Element): boolean {
  return accel.scroller.isConnected && findScrollableAncestor(target) === accel.scroller;
}

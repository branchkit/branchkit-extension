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

export interface ScrollAccelLayer {
  /** A scroller being ridden — referenced read-only as the timeline `source`. */
  readonly scroller: Element;
  /** The `ScrollTimeline` bound to `scroller` (stable across keyframe rebuilds). */
  readonly timeline: AnimationTimeline;
  /** The compositor animation on the shadow `outer` element; rebuilt when `max`
   *  changes (content reflow), so it is mutable. */
  anim: Animation;
  /** `scrollHeight - clientHeight` captured in the current keyframe. */
  max: number;
}

export interface ScrollAccel {
  /** Scroller chain, innermost first. One layer = the single-scroller case
   *  (default). Multiple layers = NESTED scrollers (target inside scroller-in-
   *  scroller): each layer rides one scroller, composed via ADDITIVE transform
   *  animations on `outer` (the per-layer `translateY(-scrollTop)` values
   *  concatenate, summing to `-Σ scrollTop`). The reconcile base in hints.ts adds
   *  `Σ scrollTop` so the net is the live position under any combination of the
   *  chain's scrolls. Single-layer uses a plain `replace` animation (unchanged). */
  readonly layers: ScrollAccelLayer[];
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

/**
 * ALL live vertical overflow scroller ancestors of `el`, innermost first
 * (excluding documentElement/body — window scroll is ridden by the host). Used
 * for nested-scroller support: a target inside scroller-in-scroller needs each
 * scroller in the chain ridden, not just the nearest. Empty array ⇒ no inner
 * scroller. Pure.
 */
export function findScrollableAncestors(el: Element): Element[] {
  const doc = el.ownerDocument;
  const docEl = doc ? doc.documentElement : null;
  const body = doc ? doc.body : null;
  const out: Element[] = [];
  let node = parentPiercingShadow(el);
  while (node) {
    if (node !== docEl && node !== body && isVerticalScroller(node)) out.push(node);
    node = parentPiercingShadow(node);
  }
  return out;
}

function buildAnim(
  outer: HTMLElement,
  timeline: AnimationTimeline,
  max: number,
  composite: CompositeOperation,
): Animation {
  // At scroll progress p = S/max the interpolated transform is
  // translateY(-p*max) = translateY(-S); composited, no main-thread work.
  // `fill: 'both'` holds the end transform past the range; `duration: 1` is the
  // non-zero duration Firefox requires for a scroll-driven animation. `composite`
  // is `add` for nested chains so each layer's translateY sums (transform `add`
  // concatenates the lists, and stacked translateYs sum); `replace` for the lone
  // single-scroller case (identical to before).
  const options = { timeline, duration: 1, fill: 'both', composite } as unknown as KeyframeAnimationOptions;
  return outer.animate(
    [{ transform: 'translateY(0px)' }, { transform: `translateY(${-max}px)` }],
    options,
  );
}

/**
 * Create an accelerator for `target`'s inner scroller(s), animating `outer`'s
 * transform on the compositor. With `nested` false (default), rides only the
 * NEAREST scroller (one `replace` layer — unchanged behavior). With `nested`
 * true, rides the WHOLE chain of scroller ancestors (one additive layer each).
 * Returns null when `ScrollTimeline` is unsupported or `target` has no inner
 * scroller. Caller owns the flag gate and viewport-pinned exclusion.
 */
export function createScrollAccel(target: Element, outer: HTMLElement, nested: boolean): ScrollAccel | null {
  const Ctor = getScrollTimelineCtor();
  if (!Ctor) return null;
  const nearest = findScrollableAncestor(target);
  if (!nearest) return null;
  const scrollers = nested ? findScrollableAncestors(target) : [nearest];
  if (scrollers.length === 0) return null;
  // Multiple scrollers must compose additively; a lone scroller stays `replace`
  // so the default path is byte-identical and never relies on `composite: add`.
  const composite: CompositeOperation = scrollers.length > 1 ? 'add' : 'replace';
  const layers: ScrollAccelLayer[] = scrollers.map((scroller) => {
    const max = scrollMax(scroller);
    const timeline = new Ctor({ source: scroller, axis: 'block' });
    return { scroller, timeline, anim: buildAnim(outer, timeline, max, composite), max };
  });
  return { layers };
}

/**
 * Refresh each layer's keyframe when its scroller's max scroll changed (content
 * loaded/reflowed). No-op for unchanged layers — recreation is the rare
 * exception, not per-frame work. Reuses each layer's timeline; only the keyframe
 * (which encodes `max`) is rebuilt.
 */
export function recomputeScrollAccel(accel: ScrollAccel, outer: HTMLElement): void {
  const composite: CompositeOperation = accel.layers.length > 1 ? 'add' : 'replace';
  for (const layer of accel.layers) {
    const max = scrollMax(layer.scroller);
    if (max === layer.max) continue;
    layer.anim.cancel();
    layer.anim = buildAnim(outer, layer.timeline, max, composite);
    layer.max = max;
  }
}

/** Tear down every layer's compositor animation, reverting `outer`'s transform to
 *  its base (no delta) so the chase base alone is correct. */
export function teardownScrollAccel(accel: ScrollAccel): void {
  for (const layer of accel.layers) layer.anim.cancel();
}

/** Σ of the chain's live `scrollTop`s — the value the reconcile base adds so the
 *  composited net (base − Σ via the animations) is the live position. */
export function scrollAccelScrollOffset(accel: ScrollAccel): number {
  let sum = 0;
  for (const layer of accel.layers) sum += layer.scroller.scrollTop;
  return sum;
}

/**
 * Is the accelerator still valid for `target` this pass? True iff every ridden
 * scroller is still connected AND the nearest is still `target`'s nearest inner
 * scroller (catches scroller recreation / stopped-overflowing). For nested
 * chains this is a cheap partial check — a mid-chain change with the nearest
 * intact + all connected is rare and self-heals at the next arm. False ⇒ caller
 * drops the accel and falls back to the chase (graceful-degradation contract).
 */
export function scrollAccelHealthy(accel: ScrollAccel, target: Element): boolean {
  for (const layer of accel.layers) {
    if (!layer.scroller.isConnected) return false;
  }
  return findScrollableAncestor(target) === accel.layers[0].scroller;
}

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
  /** The compositor animation on this layer's `element`; rebuilt when `max`
   *  changes (content reflow), so it is mutable. */
  anim: Animation;
  /** `scrollHeight - clientHeight` captured in the current keyframe. */
  max: number;
  /** The shadow element this layer's `translateY(-scrollTop)` animates. The
   *  OUTERMOST layer animates `outer` (the existing badge element); each inner
   *  scroller gets its own nested wrapper div. One `composite:'replace'` anim per
   *  element keeps every layer on the COMPOSITOR — stacking N `composite:'add'`
   *  anims on one element instead drops to the main thread (the wiggle we fixed). */
  readonly element: HTMLElement;
}

export interface ScrollAccel {
  /** Scroller chain, innermost first. One layer = the single-scroller case
   *  (default), animating `outer` directly — byte-identical to the pre-nesting
   *  path. Multiple layers = NESTED scrollers (target inside scroller-in-scroller):
   *  each scroller rides its OWN nested wrapper element with a single
   *  `composite:'replace'` animation, and the per-element `translateY(-scrollTop)`
   *  values compose down the DOM tree (parent transform cascades to children),
   *  summing to `-Σ scrollTop` — all on the compositor. The reconcile base in
   *  hints.ts adds `Σ scrollTop` so the net is the live position under any
   *  combination of the chain's scrolls. The OUTERMOST scroller maps to `outer`
   *  and is never rebuilt when an inner hover-gated scroller flaps. */
  layers: ScrollAccelLayer[];
}

// Monotonic build id, stamped on every animation so a test (or the page console)
// can tell whether a layer's anim was REBUILT (id changed) or reused across a
// chain change. Module-scope counter — no Date/Math.random (those break resume).
let animBuildSeq = 0;

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

function buildLayerAnim(
  element: HTMLElement,
  timeline: AnimationTimeline,
  max: number,
): Animation {
  // At scroll progress p = S/max the interpolated transform is
  // translateY(-p*max) = translateY(-S); composited, no main-thread work.
  // `fill: 'both'` holds the end transform past the range; `duration: 1` is the
  // non-zero duration Firefox requires for a scroll-driven animation. ALWAYS
  // `composite:'replace'` — a single replace anim per element stays on the
  // compositor; composing multiple scrollers is done by NESTING elements (their
  // transforms cascade), not by stacking additive anims on one element.
  const options = { timeline, duration: 1, fill: 'both', composite: 'replace' } as unknown as KeyframeAnimationOptions;
  const anim = element.animate(
    [{ transform: 'translateY(0px)' }, { transform: `translateY(${-max}px)` }],
    options,
  );
  anim.id = `bk-accel-${++animBuildSeq}`;
  return anim;
}

/** A transparent passthrough wrapper for one inner scroller's layer: 0-offset,
 *  absolutely positioned so it establishes a containing block for its descendants
 *  and carries only the `translateY(-scrollTop)` animation. Nested between `outer`
 *  and the badge `inner`, its transform cascades to everything below it. */
function createLayerWrapper(doc: Document): HTMLElement {
  const w = doc.createElement('div');
  w.className = 'bk-accel-layer';
  w.style.cssText = 'position:absolute;top:0;left:0;transform-origin:0 0;';
  return w;
}

function makeLayer(scroller: Element, element: HTMLElement, Ctor: ScrollTimelineCtor): ScrollAccelLayer {
  const max = scrollMax(scroller);
  const timeline = new Ctor({ source: scroller, axis: 'block' });
  return { scroller, timeline, anim: buildLayerAnim(element, timeline, max), max, element };
}

// Build the nested element chain for `scrollers` (innermost-first): the OUTERMOST
// scroller animates `outer`; each successively-inner scroller gets a wrapper
// nested one level deeper, and the badge `inner` is reparented into the deepest
// wrapper. Returns layers innermost-first (layers[0] = nearest scroller). DOM
// after, for [report, mainBody]: outer(mainBody) > wrapper(report) > inner.
function buildLayerChain(
  scrollers: readonly Element[],
  outer: HTMLElement,
  inner: HTMLElement,
  Ctor: ScrollTimelineCtor,
): ScrollAccelLayer[] {
  const ordered = [...scrollers].reverse(); // outermost-first, for DOM nesting
  const doc = outer.ownerDocument;
  const layers: ScrollAccelLayer[] = [makeLayer(ordered[0], outer, Ctor)];
  let parent: HTMLElement = outer;
  for (let i = 1; i < ordered.length; i++) {
    const wrapper = createLayerWrapper(doc);
    parent.appendChild(wrapper);
    layers.push(makeLayer(ordered[i], wrapper, Ctor));
    parent = wrapper;
  }
  parent.appendChild(inner); // move the badge into the deepest wrapper (no-op when single)
  layers.reverse(); // innermost-first
  return layers;
}

/**
 * Create an accelerator for `target`'s inner scroller(s) as a nested element
 * chain animated on the compositor. With `nested` false (default), rides only the
 * NEAREST scroller (one `replace` layer on `outer` — byte-identical to before).
 * With `nested` true, rides the WHOLE chain: the outermost scroller animates
 * `outer`, each inner scroller a nested wrapper, and `inner` is reparented into
 * the deepest wrapper. Returns null when `ScrollTimeline` is unsupported or
 * `target` has no inner scroller. Caller owns the flag gate.
 */
export function createScrollAccel(target: Element, outer: HTMLElement, inner: HTMLElement, nested: boolean): ScrollAccel | null {
  const Ctor = getScrollTimelineCtor();
  if (!Ctor) return null;
  const nearest = findScrollableAncestor(target);
  if (!nearest) return null;
  const scrollers = nested ? findScrollableAncestors(target) : [nearest];
  if (scrollers.length === 0) return null;
  return { layers: buildLayerChain(scrollers, outer, inner, Ctor) };
}

/**
 * Incrementally reconcile the ridden chain to `desired` (innermost-first) while
 * KEEPING the outermost layer (`outer`) and its running animation untouched when
 * its scroller is unchanged — so the page scroll the user is actually dragging
 * never hitches as a hover-gated inner scroller flaps. Only the inner wrappers
 * (below `outer`) are rebuilt. Falls back to a full rebuild when the outermost
 * scroller itself changed (rare). Returns the number of anims built.
 */
export function updateScrollAccelChain(accel: ScrollAccel, desired: readonly Element[], outer: HTMLElement, inner: HTMLElement): number {
  const Ctor = getScrollTimelineCtor();
  if (!Ctor || desired.length === 0) return 0;
  const desiredOutermost = desired[desired.length - 1];
  const outerLayer = accel.layers.find((l) => l.element === outer);
  // Outermost unchanged → keep `outer`'s layer + anim; rebuild only inner wrappers.
  if (outerLayer && outerLayer.scroller === desiredOutermost && outerLayer.scroller.isConnected) {
    for (const layer of accel.layers) {
      if (layer.element !== outer) layer.anim.cancel();
    }
    if (inner.parentElement !== outer) outer.appendChild(inner);
    for (const layer of accel.layers) {
      if (layer.element !== outer) layer.element.remove();
    }
    const innerScrollers = [...desired.slice(0, desired.length - 1)].reverse(); // outermost-of-inner first
    const layers: ScrollAccelLayer[] = [outerLayer];
    let parent: HTMLElement = outer;
    let built = 0;
    for (const scroller of innerScrollers) {
      const wrapper = createLayerWrapper(outer.ownerDocument);
      parent.appendChild(wrapper);
      layers.push(makeLayer(scroller, wrapper, Ctor));
      parent = wrapper;
      built++;
    }
    parent.appendChild(inner);
    layers.reverse(); // innermost-first
    accel.layers = layers;
    return built;
  }
  // Outermost changed — full rebuild.
  teardownScrollAccel(accel, outer, inner);
  accel.layers = buildLayerChain(desired, outer, inner, Ctor);
  return accel.layers.length;
}

/**
 * Refresh each layer's keyframe when its scroller's max scroll changed (content
 * loaded/reflowed). No-op for unchanged layers — recreation is the rare exception,
 * not per-frame work. Reuses each layer's timeline; only the keyframe (which
 * encodes `max`) is rebuilt, on that layer's own element. Returns the rebuild count.
 */
export function recomputeScrollAccel(accel: ScrollAccel): number {
  let rebuilt = 0;
  for (const layer of accel.layers) {
    const max = scrollMax(layer.scroller);
    if (max === layer.max) continue;
    layer.anim.cancel();
    layer.anim = buildLayerAnim(layer.element, layer.timeline, max);
    layer.max = max;
    rebuilt++;
  }
  return rebuilt;
}

/** Tear down every layer's compositor animation, reparent `inner` back under
 *  `outer`, and drop the inner wrapper elements — leaving the chase base alone
 *  correct. Safe regardless of current nesting depth. */
export function teardownScrollAccel(accel: ScrollAccel, outer: HTMLElement, inner: HTMLElement): void {
  for (const layer of accel.layers) layer.anim.cancel();
  if (inner.parentElement !== outer) outer.appendChild(inner);
  for (const layer of accel.layers) {
    if (layer.element !== outer) layer.element.remove();
  }
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

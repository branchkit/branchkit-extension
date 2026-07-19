/**
 * Layout read cache — batches getBoundingClientRect / getComputedStyle
 * reads to avoid forced reflows during hint positioning.
 *
 * Adapted from Rango's layoutCache.ts. Cache is populated before a batch
 * operation (show, reposition) and cleared after.
 */

const boundingRects = new Map<Element, DOMRect>();
const computedStyles = new Map<Element, CSSStyleDeclaration>();
const clientDims = new Map<
  Element,
  { clientWidth: number; scrollWidth: number; clientHeight: number; scrollHeight: number }
>();

export function clearLayoutCache(): void {
  boundingRects.clear();
  computedStyles.clear();
  clientDims.clear();
}

/**
 * Batch-read layout properties for a set of elements and their ancestors
 * (up to 10 levels). All reads happen in one pass before any writes,
 * preventing layout thrashing.
 */
export function cacheLayout(elements: Element[]): void {
  const toCache = new Set<Element>();

  for (const el of elements) {
    let current: Element | null = el;
    let depth = 0;
    while (current && depth < 10) {
      if (toCache.has(current)) break;
      toCache.add(current);
      current = current.parentElement;
      depth++;
    }
  }

  for (const el of toCache) {
    boundingRects.set(el, el.getBoundingClientRect());
    computedStyles.set(el, getComputedStyle(el));
    const { clientWidth, scrollWidth, clientHeight, scrollHeight } = el;
    clientDims.set(el, { clientWidth, scrollWidth, clientHeight, scrollHeight });
  }
}

export function getCachedRect(el: Element): DOMRect {
  return boundingRects.get(el) ?? el.getBoundingClientRect();
}

/**
 * True when a rect overlaps the actual visible viewport — the STRICT notion,
 * deliberately distinct from derived IO-band membership,
 * which is set by a wide-rootMargin IO (VIEWPORT_MARGIN_PX). Badge shown-ness
 * is band-scoped (notes/DESIGN_PAINT_THE_BAND.md), so this is no longer a
 * paint gate; the strict-viewport consumers that remain are the voice
 * `_strict` set, occlusion, the build queue's on-screen-first prioritization
 * (showBadges/viewportSort, badgeNewlyCodeworded's sync-vs-budgeted split),
 * and reconcileRead's fully-off-screen write-time clamp. All route through
 * this one predicate so they agree.
 */
export function isRectOnScreen(
  r: DOMRect,
  vw: number = window.innerWidth,
  vh: number = window.innerHeight,
): boolean {
  return r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
}

/**
 * True if a viewport-relative rect falls within the viewport ± margin band —
 * the IO-band notion (the tracker's VIEWPORT_MARGIN_PX), deliberately
 * distinct from `isRectOnScreen`'s strict notion. Lives here (leaf module)
 * rather than in lifecycle/reconcile.ts so observe/ modules can consume it:
 * reconcile.ts reads the tracker's VIEWPORT_MARGIN_PX at module-eval time,
 * so a tracker → reconcile import would be a TDZ cycle.
 */
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

/**
 * Cache-only peek — returns null if no entry was populated. Distinct from
 * `getCachedRect`, which falls back to a live `getBoundingClientRect()`.
 * The live fallback returns `{0,0,0,0}` for disconnected elements; for
 * code that needs to remember an element's last *connected* rect (limbo
 * tiebreaker), the zero-rect fallback would corrupt the signal.
 */
export function peekCachedRect(el: Element): DOMRect | null {
  return boundingRects.get(el) ?? null;
}

export function getCachedStyle(el: Element): CSSStyleDeclaration {
  return computedStyles.get(el) ?? getComputedStyle(el);
}

/**
 * Cache-only peek for computed styles, mirroring peekCachedRect. Used by
 * isVisible to count cache hits vs. real reads — a getCachedStyle()
 * fallthrough hides the distinction.
 */
export function peekCachedStyle(el: Element): CSSStyleDeclaration | null {
  return computedStyles.get(el) ?? null;
}

/**
 * Lighter alternative to `cacheLayout` for visibility/hintability checks:
 * caches the element itself plus its ancestor chain (up to 15 levels) and
 * no descendants. isHintable's hot path reads `el.getBoundingClientRect`
 * + `getComputedStyle(el)` once and then walks the parent chain probing
 * opacity; neither phase touches descendants, so the full cacheLayout's
 * descendant walk would be pure overhead. Called from the rAF-coalesced
 * reevaluateAttribute drain so many same-tree attribute mutations share
 * one ancestor pre-read. (Badge construction uses the heavier
 * `cacheConstruction` below — it needs ancestor rects + dims too.)
 */
// When the engine has Element.checkVisibility, isVisible's ancestor gate is
// one native call — it never reads ancestor styles, so warming the chain is
// pure waste (the dominant getComputedStyle producer in settleGather before
// this: ~15 styles/element/settle). Only engines on the legacy opacity walk
// still want the chain.
const NATIVE_ANCESTOR_VISIBILITY =
  typeof Element !== 'undefined' && typeof Element.prototype.checkVisibility === 'function';

export function cacheVisibility(elements: Iterable<Element>): { rects: number; styles: number } {
  // isVisible reads the *element's* rect + style once, then gates ancestors
  // via native checkVisibility (no reads) or, on legacy engines, walks them
  // probing only `opacity` (a style read). It never reads an ancestor's
  // rect. So we cache rect for the seed elements only, and style for seed
  // (+ ancestor chain on legacy engines only). Caching ancestor rects (the
  // old behavior) was pure waste — on a YouTube comment mount that's
  // thousands of needless getBoundingClientRect.
  let rects = 0;
  let styles = 0;
  const chainDepth = NATIVE_ANCESTOR_VISIBILITY ? 1 : 15;
  const toCacheStyle = new Set<Element>();
  for (const el of elements) {
    if (!boundingRects.has(el)) { boundingRects.set(el, el.getBoundingClientRect()); rects++; }
    let current: Element | null = el;
    let depth = 0;
    while (current && depth < chainDepth) {
      if (toCacheStyle.has(current)) break;
      toCacheStyle.add(current);
      current = current.parentElement;
      depth++;
    }
  }
  // Count the live reads we actually perform (ancestor-deduped via the Set)
  // so callers can attribute the cost to their own perf counters — without
  // this the scanner's getComputedStyle/getBoundingClientRect counters only
  // see peek-misses and undercount the work moved in here.
  for (const el of toCacheStyle) {
    if (!computedStyles.has(el)) { computedStyles.set(el, getComputedStyle(el)); styles++; }
  }
  return { rects, styles };
}

/**
 * Heavy warm pass for badge CONSTRUCTION (paint-the-band tuning round 3):
 * seeds + their ancestor chains get rect + style + dims, deduped across
 * seeds. Construction's container walks read all three off ANCESTORS
 * (getSpaceInAncestor rects, isScrollContainer/isClipAncestor dims), and
 * each constructed badge appends its host — a layout write — so any cold
 * ancestor read on the NEXT badge forces a reflow. Batching every read
 * here, before the first append, caps the whole build pass at ~one reflow.
 * cacheVisibility stays styles-only for its own caller (reevaluations),
 * where ancestor rects are pure waste.
 */
export function cacheConstruction(elements: Iterable<Element>, maxDepth = 40): void {
  const chain = new Set<Element>();
  for (const el of elements) {
    let current: Element | null = el;
    let depth = 0;
    while (current && depth < maxDepth) {
      if (chain.has(current)) break;
      chain.add(current);
      current = current.parentElement;
      depth++;
    }
  }
  for (const el of chain) {
    if (!boundingRects.has(el)) boundingRects.set(el, el.getBoundingClientRect());
    if (!computedStyles.has(el)) computedStyles.set(el, getComputedStyle(el));
    if (!clientDims.has(el)) {
      const { clientWidth, scrollWidth, clientHeight, scrollHeight } = el;
      clientDims.set(el, { clientWidth, scrollWidth, clientHeight, scrollHeight });
    }
  }
}

function overflowClips(v: string): boolean {
  return v !== '' && v !== 'visible';
}

export function isClipAncestor(el: Element): boolean {
  const s = getCachedStyle(el);
  if (overflowClips(s.overflowX) || overflowClips(s.overflowY)) return true;
  if (s.clipPath && s.clipPath !== 'none') return true;
  if (/paint|content|strict/.test(s.contain)) return true;
  if (s.contentVisibility && s.contentVisibility !== 'visible') return true;
  return false;
}

export function getCachedDims(el: Element): {
  clientWidth: number; scrollWidth: number; clientHeight: number; scrollHeight: number;
} {
  return clientDims.get(el) ?? {
    clientWidth: el.clientWidth,
    scrollWidth: el.scrollWidth,
    clientHeight: el.clientHeight,
    scrollHeight: el.scrollHeight,
  };
}

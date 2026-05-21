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

    for (const desc of el.querySelectorAll('*')) {
      toCache.add(desc);
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

export function getCachedStyle(el: Element): CSSStyleDeclaration {
  return computedStyles.get(el) ?? getComputedStyle(el);
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

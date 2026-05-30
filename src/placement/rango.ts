import { ElementWrapper } from '../element-wrapper';
import { getCachedDims, getCachedRect, getCachedStyle, isClipAncestor } from '../layout-cache';
import { PlacementStrategy } from './strategy';
import { computePlacement, Nudge } from './compute';

const BASE_Z = 2147483000;

export type TextProbe = { hasText: true; rect: DOMRect } | { hasText: false };

/**
 * Compute the first-visible-text probe for an element. Each call walks
 * text nodes and reads `Range.getBoundingClientRect()` — the rect read
 * forces synchronous layout unconditionally (the Element rect cache
 * doesn't extend to Ranges). Prefer `getOrComputeProbe(wrapper)` from
 * the hot placement path; this raw function is exported for tests and
 * for callers that don't have a wrapper.
 */
export function probeFirstVisibleText(element: Element): TextProbe {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (!node.textContent || node.textContent.trim().length === 0) continue;
    const parent = node.parentElement;
    if (parent) {
      const pr = getCachedRect(parent);
      if (pr.width < 3 && pr.height < 3) continue;
    }
    const text = node.textContent;
    const start = text.search(/\S/);
    if (start < 0) continue;
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 1);
    const rect = range.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) return { hasText: true, rect };
  }
  return { hasText: false };
}

/**
 * Read the wrapper's cached probe — or compute and store one on first call.
 *
 * The cache stores scroll-invariant offsets from the element rect (see
 * `ElementWrapper.cachedProbe`), so we can reconstruct the absolute viewport
 * rect by reading the current element rect (cheap, Element-rect cache covers
 * it) and adding the offset. Subsequent scrolls reuse the cached offset; no
 * Range rect reads on the scroll path.
 *
 * Invalidation is the caller's responsibility — see `invalidateProbe`. The
 * target-mutation-tracker wires this in `content.ts`.
 */
export function getOrComputeProbe(w: ElementWrapper): TextProbe {
  if (w.cachedProbe !== null) {
    if (!w.cachedProbe.hasText) return { hasText: false };
    const el = getCachedRect(w.element);
    const { offsetX, offsetY, width, height } = w.cachedProbe;
    return { hasText: true, rect: new DOMRect(el.left + offsetX, el.top + offsetY, width, height) };
  }
  const probe = probeFirstVisibleText(w.element);
  if (!probe.hasText) {
    w.cachedProbe = { hasText: false };
    return probe;
  }
  const el = getCachedRect(w.element);
  w.cachedProbe = {
    hasText: true,
    offsetX: probe.rect.left - el.left,
    offsetY: probe.rect.top - el.top,
    width: probe.rect.width,
    height: probe.rect.height,
  };
  return probe;
}

/**
 * Clear a wrapper's cached probe. Call when the element mutates, so the
 * next placement re-probes against the fresh internal layout.
 */
export function invalidateProbe(w: ElementWrapper): void {
  w.cachedProbe = null;
}

function getNudge(element: Element, hasText: boolean): Nudge {
  const rect = getCachedRect(element);
  // Large icon-only elements (icon-only buttons big enough to host the
  // badge inside): place hint at the top-left INSIDE the element.
  // Matches Rango's "nudge=1" branch.
  if (rect.width > 30 && rect.height > 30 && !hasText) {
    return { kind: 'inside', x: 1, y: 1 };
  }

  // Everything else (text-bearing labels + small icon targets like
  // collapse-chevrons) — place the badge OUTSIDE the element to the
  // upper-left. `x` and `y` are absolute pixel overhang past the
  // element's left/top edge; 0 means the badge ends exactly at the
  // edge with no overlap. Smaller font sizes look fine with a tiny
  // x-overhang (badge tucks into the leading); larger fonts need a
  // bit more so the badge doesn't look detached.
  const style = getCachedStyle(element);
  const fontSize = parseInt(style.fontSize, 10);
  if (fontSize < 15) return { kind: 'outside', x: 3, y: 0 };
  if (fontSize < 20) return { kind: 'outside', x: 4, y: 0 };
  return { kind: 'outside', x: 6, y: 0 };
}

export class RangoStrategy implements PlacementStrategy {
  name = 'rango';

  placeAll(wrappers: ElementWrapper[]): void {
    const sorted = [...wrappers].sort((a, b) => {
      const ra = getCachedRect(a.element);
      const rb = getCachedRect(b.element);
      return (ra.top - rb.top) || (ra.left - rb.left);
    });

    // Read pass: probe text positions for all elements before any writes.
    // Cached per-wrapper (see `ElementWrapper.cachedProbe`) so scroll-only
    // repositions don't re-walk text nodes or re-read Range rects.
    const probes = sorted.map((w) => getOrComputeProbe(w));

    // Write pass: position all badges using pre-collected probes.
    for (let i = 0; i < sorted.length; i++) {
      const w = sorted[i];
      if (!w.hint) continue;
      this.positionAtTopLeft(w, probes[i]);
      w.hint.hideLeader();
      w.hint.host.style.zIndex = String(BASE_Z + i);
    }
  }

  placeOne(wrapper: ElementWrapper, readingIndex: number): void {
    if (!wrapper.hint) return;
    this.positionAtTopLeft(wrapper);
    wrapper.hint.hideLeader();
    wrapper.hint.host.style.zIndex = String(BASE_Z + readingIndex);
  }

  clear(): void {}

  private getAvailableSpace(container: Element, rect: DOMRect): { left: number | undefined; top: number | undefined } {
    let current: Element | null = container;
    while (current) {
      if (current === document.body || isClipAncestor(current)) {
        const parentRect = getCachedRect(current);
        const left = Math.max(0, rect.left - parentRect.left);
        const top = Math.max(0, rect.top - parentRect.top);
        return { left, top };
      }
      current = current.parentElement;
    }
    return { left: undefined, top: undefined };
  }

  private findStickyBound(container: Element): { left: number; top: number } | null {
    let current: Element | null = container.parentElement;
    while (current && current !== document.body) {
      const s = getCachedStyle(current);
      if (s.position === 'sticky' || s.position === 'fixed') {
        const r = getCachedRect(current);
        return { left: r.left, top: r.top };
      }
      current = current.parentElement;
    }
    return null;
  }

  private isInScrollList(el: Element): boolean {
    let current: Element | null = el;
    while (current && current !== document.body) {
      const s = getCachedStyle(current);
      const { clientHeight, scrollHeight } = getCachedDims(current);
      if (scrollHeight > clientHeight && /scroll|auto/.test(s.overflowY)) return true;
      current = current.parentElement;
    }
    return false;
  }

  private positionAtTopLeft(w: ElementWrapper, probe?: TextProbe): void {
    if (!w.hint) return;
    if (!probe) probe = getOrComputeProbe(w);

    // Gather half: all DOM reads. The decision (corner/overhang/space clamp/
    // sticky clamp/overlap fallback) lives in the pure computePlacement.
    //   nudge — 'inside' (ratio, large icon-only targets) vs 'outside'
    //     (absolute overhang, e.g. Gmail's Categories chevron sits
    //     above-and-left of the icon, not on it).
    const targetRect = probe.hasText ? probe.rect : getCachedRect(w.element);
    const stickyBound = this.findStickyBound(w.hint.anchorParent);
    const result = computePlacement({
      targetRect,
      elementRect: getCachedRect(w.element),
      badgeSize: w.hint.badgeSize,
      nudge: getNudge(w.element, probe.hasText),
      availableSpace: this.getAvailableSpace(w.hint.anchorParent, targetRect),
      stickyBound,
      // isInScrollList is only consulted in the sticky overlap fallback; gate
      // the ancestor walk on the cheap precondition so the common (non-sticky)
      // path skips it, preserving the original short-circuit.
      inScrollList: stickyBound !== null && probe.hasText
        ? this.isInScrollList(w.hint.anchorParent)
        : false,
      hasText: probe.hasText,
    });

    // scrollSensitive marks a viewport-fixed clamp (sticky/fixed ancestor) so
    // the window-scroll reposition doesn't skip it as compositor-tracked.
    // geometryDependent marks placements whose offset rode ancestor geometry,
    // so the 'all' layout sweep must re-place them even on the anchor path.
    w.hint.scrollSensitive = result.scrollSensitive;
    w.hint.geometryDependent = result.geometryDependent;
    w.hint.updatePosition({ x: result.x, y: result.y }, 'rango.positionAtTopLeft');
  }
}

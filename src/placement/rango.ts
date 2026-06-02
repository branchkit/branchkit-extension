import { ElementWrapper } from '../scan/element-wrapper';
import { getCachedRect, getCachedStyle, isClipAncestor } from '../layout-cache';
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
  // The probe's `range.getBoundingClientRect()` is a LIVE read that forced a
  // synchronous layout. Measure the element rect LIVE here too, in that same
  // flushed frame — NOT via `getCachedRect`, whose snapshot was taken by
  // `cacheLayout()` before this read pass. On a quiescent page the two agree;
  // but when the page reflows between `cacheLayout()` and this probe (YouTube
  // scroll-back virtualization re-laying-out rows), a cached element rect
  // mixed with a live text rect bakes the reflow delta into `offsetY`. That
  // delta then rides the anchor host's `calc(anchor(top) + Δpx)` and strands
  // the badge ~200px off its (correctly-bound) target — the bug this guards.
  const elLive = w.element.getBoundingClientRect();
  const offsetX = probe.rect.left - elLive.left;
  const offsetY = probe.rect.top - elLive.top;
  w.cachedProbe = {
    hasText: true,
    offsetX,
    offsetY,
    width: probe.rect.width,
    height: probe.rect.height,
  };
  // Return the rect reconstructed on the pass-consistent cached element rect,
  // matching the cached-hit branch above. This keeps the candidate,
  // `computePlacement`'s `elementRect`, and `updatePosition`'s anchor-offset
  // bake all on one basis, so the baked offset is the intended overhang and
  // can't absorb a reflow delta even if `cacheLayout`'s snapshot is stale —
  // `anchor()` re-resolves the live target at render time regardless.
  const elCached = getCachedRect(w.element);
  return {
    hasText: true,
    rect: new DOMRect(elCached.left + offsetX, elCached.top + offsetY, probe.rect.width, probe.rect.height),
  };
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
  // badge inside): place hint at the target's top-left INSIDE the element.
  // Matches Rango's "nudge=1" branch.
  if (rect.width > 30 && rect.height > 30 && !hasText) {
    return { x: 1, y: 1 };
  }

  // Everything else — Rango-style ratio nudge. Badge sits at the target's
  // top-left with a fractional overhang up-and-left; the remainder of the
  // badge sits ON the text. Rango's ratios assume a ~12px hint; BranchKit's
  // hints are taller, so y is biased smaller (mostly-above) than Rango to
  // keep overlap to the cap-height area rather than the full line. Bigger
  // fonts can host more of the badge inside without occluding the glyphs,
  // so the ratios slide toward 1.
  const style = getCachedStyle(element);
  const fontSize = parseInt(style.fontSize, 10);
  if (fontSize < 15) return { x: 0.3, y: 0.2 };
  if (fontSize < 20) return { x: 0.4, y: 0.3 };
  return { x: 0.6, y: 0.5 };
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

  private getAvailableSpace(container: Element, rect: DOMRect, anchorMode: boolean): { left: number | undefined; top: number | undefined } {
    // In CSS anchor-positioning mode the host is body-mounted (see
    // setupAnchorHost), not nested inside anchorParent — so anchorParent
    // never visually clips the badge. The clamp's only purpose was to keep
    // the badge inside its mount container's visible area; without nesting
    // there's nothing to escape. Return unbounded space so the nudge alone
    // determines placement. This unblocks YouTube Shorts cards, where the
    // title link is wrapped in an h3 with `overflow:hidden` and the chosen
    // anchorParent often resolves to that h3 (no roomier ancestor exists
    // for the title text — the thumbnail is a sibling container).
    if (anchorMode) return { left: undefined, top: undefined };
    // Nesting-path fallback (Firefox, or per-target anchor() bailout):
    // measure inside the resolved container so the clamp prevents the
    // badge from being clipped by anchorParent's overflow.
    if (!isClipAncestor(container) && container !== document.body) {
      return { left: undefined, top: undefined };
    }
    const containerRect = getCachedRect(container);
    const left = Math.max(0, rect.left - containerRect.left);
    const top = Math.max(0, rect.top - containerRect.top);
    return { left, top };
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

  private positionAtTopLeft(w: ElementWrapper, probe?: TextProbe): void {
    if (!w.hint) return;
    if (!probe) probe = getOrComputeProbe(w);

    // Gather half: all DOM reads. The decision (ratio offset / space clamp /
    // sticky clamp) lives in the pure computePlacement.
    const targetRect = probe.hasText ? probe.rect : getCachedRect(w.element);
    const stickyBound = this.findStickyBound(w.hint.anchorParent);
    const result = computePlacement({
      targetRect,
      badgeSize: w.hint.badgeSize,
      nudge: getNudge(w.element, probe.hasText),
      availableSpace: this.getAvailableSpace(w.hint.anchorParent, targetRect, w.hint.anchorMode),
      stickyBound,
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

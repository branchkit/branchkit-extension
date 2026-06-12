import { ElementWrapper } from '../scan/element-wrapper';
import { getCachedRect, getCachedStyle } from '../layout-cache';
import { computePlacement, Nudge } from './compute';
import { calculateZIndex } from './stacking';
import { type BadgeSettings, DEFAULT_BADGE_SETTINGS } from '../badge-settings-storage';

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

// Live nudge state — initialized from DEFAULT_BADGE_SETTINGS and overwritten
// by the content-script bootstrap once storage has been read. Mutable refs
// so settings changes propagate without re-wiring callers.
let nudgeXSmall = DEFAULT_BADGE_SETTINGS.nudgeXSmall;
let nudgeYSmall = DEFAULT_BADGE_SETTINGS.nudgeYSmall;
let nudgeXMed = DEFAULT_BADGE_SETTINGS.nudgeXMed;
let nudgeYMed = DEFAULT_BADGE_SETTINGS.nudgeYMed;
let nudgeXLarge = DEFAULT_BADGE_SETTINGS.nudgeXLarge;
let nudgeYLarge = DEFAULT_BADGE_SETTINGS.nudgeYLarge;

export function setNudgesFromSettings(s: BadgeSettings): void {
  nudgeXSmall = s.nudgeXSmall;
  nudgeYSmall = s.nudgeYSmall;
  nudgeXMed = s.nudgeXMed;
  nudgeYMed = s.nudgeYMed;
  nudgeXLarge = s.nudgeXLarge;
  nudgeYLarge = s.nudgeYLarge;
}

function getNudge(element: Element, hasText: boolean): Nudge {
  const rect = getCachedRect(element);
  // Large icon-only elements (icon-only buttons big enough to host the
  // badge inside): place hint at the target's top-left INSIDE the element.
  // Matches Rango's "nudge=1" branch.
  if (rect.width > 30 && rect.height > 30 && !hasText) {
    return { x: 1, y: 1 };
  }

  // Everything else — Rango-style ratio nudge per font-size bucket.
  // Badge sits at the target's top-left with a fractional overhang
  // up-and-left; the remainder of the badge sits ON the text. Bigger
  // fonts can host more of the badge inside without occluding glyphs,
  // so the ratios slide toward 1.
  const style = getCachedStyle(element);
  const fontSize = parseInt(style.fontSize, 10);
  if (fontSize < 15) return { x: nudgeXSmall, y: nudgeYSmall };
  if (fontSize < 20) return { x: nudgeXMed, y: nudgeYMed };
  return { x: nudgeXLarge, y: nudgeYLarge };
}

export function placeBadges(wrappers: ElementWrapper[]): void {
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
    positionAtTopLeft(w, probes[i]);
    w.hint.hideLeader();
    w.hint.host.style.zIndex = String(calculateZIndex(w.element, w.hint.host) + i);
  }
}

export function placeOne(wrapper: ElementWrapper, readingIndex: number): void {
  if (!wrapper.hint) return;
  positionAtTopLeft(wrapper);
  wrapper.hint.hideLeader();
  wrapper.hint.host.style.zIndex = String(calculateZIndex(wrapper.element, wrapper.hint.host) + readingIndex);
}

function positionAtTopLeft(w: ElementWrapper, probe?: TextProbe): void {
  if (!w.hint) return;
  if (!probe) probe = getOrComputeProbe(w);

  // Gather half: all DOM reads. The ratio-offset decision lives in the pure
  // computePlacement. Hosts are body-mounted and follow the live target every
  // reconcile pass, so no container space-clamp or sticky/fixed bound applies —
  // see the sticky-clamp sub-question in
  // notes/completed/DESIGN_HINT_POSITIONING_REARCH.md.
  const targetRect = probe.hasText ? probe.rect : getCachedRect(w.element);
  const result = computePlacement({
    targetRect,
    badgeSize: w.hint.badgeSize,
    nudge: getNudge(w.element, probe.hasText),
  });
  w.hint.updatePosition({ x: result.x, y: result.y });
}

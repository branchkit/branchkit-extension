/**
 * Badge container resolution — picks the `anchorParent` for a badge.
 *
 * Hosts are body-mounted (the reconcile positioner pins them to the live
 * target rect), so the resolved container no longer hosts the badge — it
 * drives the container-resize tracker: the ancestor whose size changes
 * signal "this badge's neighborhood re-laid-out, reposition".
 *
 * Direct port of Rango's getAptContainer / getContextForHint walk. All
 * reads go through the layout cache, so callers batch them (cacheLayout)
 * before resolving in a loop.
 */

import { getCachedRect, getCachedStyle, getCachedDims, isClipAncestor } from '../layout-cache';

// Walk ancestors (piercing shadow boundaries) for a position:fixed or sticky
// element. Such a target holds a constant viewport position as the window
// scrolls, so its badge host must be viewport-anchored (position:fixed + viewport
// coords) — a document-anchored host would ride the page scroll away from the
// pinned target (the YouTube left-rail drift). Uses the warm style cache;
// evaluated once at construction / retarget.
export function hasViewportPinnedAncestor(target: Element): boolean {
  let node: Element | null = target;
  while (node) {
    if (node instanceof HTMLElement) {
      const pos = getCachedStyle(node).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      node = parent;
    } else {
      const r = node.getRootNode();
      node = r instanceof ShadowRoot ? (r.host as Element) : null;
    }
  }
  return false;
}

export function findBadgeContainer(target: Element): HTMLElement {
  let current: Node | null = target.parentNode;
  while (current) {
    if (current instanceof ShadowRoot) return current.host as HTMLElement;
    if (!(current instanceof HTMLElement) || current.shadowRoot) {
      current = current.parentNode;
      continue;
    }
    const s = getCachedStyle(current);
    if (s.display === 'contents') { current = current.parentElement; continue; }
    // Mount inside table cells / rows / sections — these participate
    // in normal flow for inline-block children and are required for
    // scroll-tracking on apps that scroll the table itself rather than
    // an outer wrapper (Gmail mail list). Skip only the <table>/<inline-table>
    // containers themselves; their cell/row/section/group descendants
    // accept arbitrary inline children fine.
    if (current.tagName === 'TABLE' || s.display === 'table' || s.display === 'inline-table') {
      current = current.parentElement;
      continue;
    }
    return current;
  }
  return document.body;
}

export function isScrollContainer(el: Element): boolean {
  const s = getCachedStyle(el);
  const { clientWidth, scrollWidth, clientHeight, scrollHeight } = getCachedDims(el);
  return (
    el === document.documentElement ||
    (scrollWidth > clientWidth && /scroll|auto/.test(s.overflowX)) ||
    (scrollHeight > clientHeight && /scroll|auto/.test(s.overflowY))
  );
}

export const ENOUGH_LEFT = 15;
export const ENOUGH_TOP = 10;

export function findLimitParent(target: Element): HTMLElement {
  let current: Element | null = target.parentElement;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement) {
      const s = getCachedStyle(current);
      if (
        s.position === 'fixed' || s.position === 'sticky' ||
        (s.transform && s.transform !== 'none') ||
        s.willChange === 'transform' ||
        isScrollContainer(current)
      ) {
        return current;
      }
    }
    current = current.parentElement;
  }
  return document.body;
}

export function getSpaceInAncestor(ancestor: Element, targetRect: DOMRect): { left: number; top: number } {
  const ancestorRect = getCachedRect(ancestor);
  return {
    left: Math.max(0, targetRect.left - ancestorRect.left),
    top: Math.max(0, targetRect.top - ancestorRect.top),
  };
}

export function resolveContainer(target: Element): HTMLElement {
  const candidate = findBadgeContainer(target);
  const limitParent = findLimitParent(target);
  const targetRect = getCachedRect(target);

  // Walk every clipping ancestor between target and limitParent. For
  // each, measure how much space the badge would have to the left and
  // above the target. Stop at the first ancestor that has ENOUGH_LEFT
  // and ENOUGH_TOP — that ancestor's parent is the container. Direct
  // port of Rango's getContextForHint loop; the multi-level escalation
  // is what handles deeply-nested sidebars (Gmail's nav rail clips at
  // ~3 levels and a single-level escalation would still leave the
  // badge clamped over the menu text).
  const clipAncestors: HTMLElement[] = [];
  let current: Element | null = target.parentElement;
  while (current && current !== document.body) {
    if (current instanceof HTMLElement && isClipAncestor(current)) {
      clipAncestors.push(current);
    }
    if (current === limitParent) break;
    current = current.parentElement;
  }

  let chosen: HTMLElement | null = null;
  for (let i = 0; i < clipAncestors.length; i++) {
    const ancestor = clipAncestors[i];
    // The limitParent represents the scroll/positioning boundary. If
    // it appears as a clip ancestor itself (overflow:auto scroll
    // container case), don't escape past it — that would mount the
    // badge OUTSIDE the scrolling context where it can't follow the
    // target on internal scroll. Let the fallthrough return the
    // candidate (findBadgeContainer's result) so the badge stays
    // inside the scrolling content (Gmail mail-list bug).
    if (ancestor === limitParent) continue;
    const space = getSpaceInAncestor(ancestor, targetRect);
    if (space.left >= ENOUGH_LEFT && space.top >= ENOUGH_TOP) {
      // This ancestor has enough space for the badge; its parent
      // container is the right place to anchor.
      const parent = (i === 0 ? ancestor : clipAncestors[i - 1]).parentElement;
      if (parent instanceof HTMLElement && limitParent.contains(parent)) {
        chosen = parent;
      } else {
        const escaped = findBadgeContainer(ancestor);
        // Don't escape outside limitParent. If the escape result isn't
        // contained, leave chosen null so we fall through to candidate
        // (which is findBadgeContainer(target) — already inside limitParent
        // because target is).
        if (limitParent.contains(escaped)) chosen = escaped;
      }
      break;
    }
  }

  if (chosen) return chosen;

  // No ancestor had enough room. Escape past the LAST tight clip we
  // found — escaping past only the first would land us inside the
  // remaining tight clips, which still clamp the badge over the text.
  // Confirmed on Gmail's nav: clipAncestors are [span.nU, div.aio.UKr6le],
  // both with space (0, 1). Anchoring at span.nU.parentElement = div.aio
  // (the second tight clip) leaves the badge clamped; anchoring at
  // div.aio.parentElement = div.TN gets us out of both.
  if (clipAncestors.length > 0) {
    const lastTight = clipAncestors[clipAncestors.length - 1];
    const clipParent = lastTight.parentElement;
    if (clipParent instanceof HTMLElement && limitParent.contains(clipParent)) {
      return clipParent;
    }
    const escaped = findBadgeContainer(lastTight);
    if (limitParent.contains(escaped)) return escaped;
  }
  return candidate;
}

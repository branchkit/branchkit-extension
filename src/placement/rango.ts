import { ElementWrapper } from '../element-wrapper';
import { getCachedDims, getCachedRect, getCachedStyle, isClipAncestor } from '../layout-cache';
import { PlacementStrategy } from './strategy';

const BASE_Z = 2147483000;

type TextProbe = { hasText: true; rect: DOMRect } | { hasText: false };

function probeFirstVisibleText(element: Element): TextProbe {
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

function getNudgeRatios(element: Element, hasText: boolean): { x: number; y: number } {
  const rect = getCachedRect(element);
  // Large no-text elements (icon-only buttons, image links): place hint
  // INSIDE the top-left corner. nudge=1 means hintOffset is 0 → badge
  // top-left aligns with target top-left. Matches Rango.
  if (rect.width > 30 && rect.height > 30 && !hasText) {
    return { x: 1, y: 1 };
  }

  // Text-bearing elements: nudge values picked so the badge sits just
  // above-and-to-the-left of the first character, with minimal overlap.
  // Direct port of Rango's font-size scale.
  const style = getCachedStyle(element);
  const fontSize = parseInt(style.fontSize, 10);

  if (fontSize < 15) return { x: 0.3, y: 0.5 };
  if (fontSize < 20) return { x: 0.4, y: 0.6 };
  return { x: 0.6, y: 0.8 };
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
    const probes = sorted.map((w) => probeFirstVisibleText(w.element));

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
    if (!probe) probe = probeFirstVisibleText(w.element);
    const targetRect = probe.hasText ? probe.rect : getCachedRect(w.element);
    const elementRect = getCachedRect(w.element);
    const size = w.hint.badgeSize;
    const { x: nudgeX, y: nudgeY } = getNudgeRatios(w.element, probe.hasText);
    const space = this.getAvailableSpace(w.hint.anchorParent, targetRect);

    const hintOffsetX = size.w * (1 - nudgeX);
    const hintOffsetY = size.h * (1 - nudgeY);

    const clampedOffsetX = space.left !== undefined
      ? Math.min(hintOffsetX, Math.max(0, space.left - 1))
      : hintOffsetX;
    const clampedOffsetY = space.top !== undefined
      ? Math.min(hintOffsetY, Math.max(0, space.top - 1))
      : hintOffsetY;

    let x = Math.max(0, targetRect.left - clampedOffsetX);
    let y = Math.max(0, targetRect.top - clampedOffsetY);

    const stickyBound = this.findStickyBound(w.hint.anchorParent);
    if (stickyBound) {
      x = Math.max(stickyBound.left, x);
      y = Math.max(stickyBound.top, y);
    }

    const overlapIntoText = (y + size.h) - targetRect.top;
    const badgeOverlapsText = overlapIntoText > size.h * 0.4;
    if (stickyBound && badgeOverlapsText && probe.hasText && !this.isInScrollList(w.hint.anchorParent)) {
      x = Math.max(stickyBound.left, elementRect.left);
      y = elementRect.bottom - size.h * 0.5;
    }

    w.hint.updatePosition({ x, y }, 'rango.positionAtTopLeft');
  }
}

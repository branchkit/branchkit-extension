import { ElementWrapper } from '../element-wrapper';
import { getCachedRect, getCachedStyle } from '../layout-cache';
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
  if (rect.width > 30 && rect.height > 30 && !hasText) {
    return { x: 0.4, y: 0.5 };
  }

  const style = getCachedStyle(element);
  const fontSize = parseInt(style.fontSize, 10);

  if (fontSize < 15) return { x: 0.1, y: 0.2 };
  if (fontSize < 20) return { x: 0.15, y: 0.25 };
  return { x: 0.2, y: 0.3 };
}

export class RangoStrategy implements PlacementStrategy {
  name = 'rango';

  placeAll(wrappers: ElementWrapper[]): void {
    const sorted = [...wrappers].sort((a, b) => {
      const ra = getCachedRect(a.element);
      const rb = getCachedRect(b.element);
      return (ra.top - rb.top) || (ra.left - rb.left);
    });

    for (let i = 0; i < sorted.length; i++) {
      const w = sorted[i];
      if (!w.hint) continue;
      this.positionAtTopLeft(w);
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

  private isClipAncestor(el: Element): boolean {
    const s = getCachedStyle(el);
    if ((s.overflowX && s.overflowX !== 'visible') || (s.overflowY && s.overflowY !== 'visible')) return true;
    if (s.clipPath && s.clipPath !== 'none') return true;
    if (/paint|content|strict/.test(s.contain)) return true;
    if (s.contentVisibility && s.contentVisibility !== 'visible') return true;
    return false;
  }

  private getAvailableSpace(container: Element, rect: DOMRect): { left: number | undefined; top: number | undefined } {
    let current: Element | null = container;
    while (current) {
      if (current === document.body || this.isClipAncestor(current)) {
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

  private positionAtTopLeft(w: ElementWrapper): void {
    if (!w.hint) return;
    const probe = probeFirstVisibleText(w.element);
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
    if (stickyBound && badgeOverlapsText && probe.hasText) {
      x = Math.max(stickyBound.left, elementRect.left);
      y = elementRect.bottom - size.h * 0.5;
    }

    w.hint.updatePosition({ x, y });
  }
}

import { ElementWrapper } from '../element-wrapper';
import { getCachedRect } from '../layout-cache';
import { PlacementStrategy } from './strategy';

const BASE_Z = 2147483000;

function hasVisibleTextContent(element: Element): boolean {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (!node.textContent || node.textContent.trim().length === 0) continue;
    const parent = node.parentElement;
    if (parent) {
      const pr = parent.getBoundingClientRect();
      if (pr.width < 3 && pr.height < 3) continue;
    }
    return true;
  }
  return false;
}

function getNudgeRatios(element: Element): { x: number; y: number } {
  const rect = element.getBoundingClientRect();
  if (rect.width > 30 && rect.height > 30 && !hasVisibleTextContent(element)) {
    return { x: 1, y: 1 };
  }

  const style = getComputedStyle(element);
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
    const s = getComputedStyle(el);
    if (s.overflow !== 'visible') return true;
    if (s.clipPath !== 'none') return true;
    if (/paint|content|strict/.test(s.contain)) return true;
    if (s.position === 'fixed' || s.position === 'sticky') return true;
    if (s.contentVisibility && s.contentVisibility !== 'visible') return true;
    return false;
  }

  private getAvailableSpace(element: Element, rect: DOMRect): { left: number | undefined; top: number | undefined } {
    let parent = element.parentElement;
    while (parent) {
      if (parent === document.body || this.isClipAncestor(parent)) {
        const parentRect = parent.getBoundingClientRect();
        return {
          left: Math.max(0, rect.left - parentRect.left),
          top: Math.max(0, rect.top - parentRect.top),
        };
      }
      parent = parent.parentElement;
    }
    return { left: undefined, top: undefined };
  }

  private getFirstTextRect(element: Element): DOMRect {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Text | null;
    while ((node = walker.nextNode() as Text | null)) {
      if (!node.textContent || node.textContent.trim().length === 0) continue;
      const parent = node.parentElement;
      if (parent) {
        const pr = parent.getBoundingClientRect();
        if (pr.width < 3 && pr.height < 3) continue;
      }
      const range = document.createRange();
      const text = node.textContent;
      const start = text.search(/\S/);
      if (start < 0) continue;
      range.setStart(node, start);
      range.setEnd(node, start + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) return rect;
    }
    return element.getBoundingClientRect();
  }

  private positionAtTopLeft(w: ElementWrapper): void {
    if (!w.hint) return;
    const targetRect = this.getFirstTextRect(w.element);
    const size = w.hint.badgeSize;
    const { x: nudgeX, y: nudgeY } = getNudgeRatios(w.element);
    const space = this.getAvailableSpace(w.element, targetRect);

    const hintOffsetX = size.w * (1 - nudgeX);
    const hintOffsetY = size.h * (1 - nudgeY);

    const clampedOffsetX = space.left !== undefined
      ? Math.min(hintOffsetX, Math.max(0, space.left - 1))
      : hintOffsetX;
    const clampedOffsetY = space.top !== undefined
      ? Math.min(hintOffsetY, Math.max(0, space.top - 1))
      : hintOffsetY;

    const x = Math.max(0, targetRect.left - clampedOffsetX);
    const y = Math.max(0, targetRect.top - clampedOffsetY);

    w.hint.updatePosition({ x, y });
  }
}

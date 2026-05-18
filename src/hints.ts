/**
 * BranchKit Browser — Shadow DOM hint badges.
 *
 * Each badge lives in a closed Shadow DOM to prevent page CSS interference.
 * Container selection adapted from Rango: walks the ancestor tree to find a
 * container that (a) scrolls in lockstep with the target and (b) won't clip
 * the badge via overflow/clip-path/contain.
 */

import { Category, CATEGORY_BORDER_COLORS, BadgeDisplayMode } from './types';
import { LabelAssignment, labelToDisplay } from './words';
import { getCachedRect, getCachedStyle, getCachedDims } from './layout-cache';
import { calculateZIndex } from './stacking-context';
import { computeBadgeColors } from './badge-colors';

const BADGE_SPACE_LEFT = 28;
const BADGE_SPACE_TOP = 10;

function isScrollable(el: Element): boolean {
  const s = getCachedStyle(el);
  const dims = getCachedDims(el);
  return (
    el === document.documentElement ||
    (dims.scrollWidth > dims.clientWidth && /scroll|auto/.test(s.overflowX)) ||
    (dims.scrollHeight > dims.clientHeight && /scroll|auto/.test(s.overflowY))
  );
}

function clips(el: Element): boolean {
  const s = getCachedStyle(el);
  if (s.overflow !== 'visible') return true;
  if (s.clipPath !== 'none') return true;
  if (/paint|content|strict/.test(s.contain)) return true;
  if (s.contentVisibility && s.contentVisibility !== 'visible') return true;
  return false;
}

function limitsChildren(el: Element): boolean {
  const s = getCachedStyle(el);
  return (
    s.position === 'fixed' ||
    s.position === 'sticky' ||
    s.transform !== 'none' ||
    s.willChange === 'transform' ||
    isScrollable(el)
  );
}

function getPaddingRect(el: Element): DOMRect {
  const s = getCachedStyle(el);
  const bl = parseInt(s.borderLeftWidth, 10) || 0;
  const bt = parseInt(s.borderTopWidth, 10) || 0;
  const br = parseInt(s.borderRightWidth, 10) || 0;
  const bb = parseInt(s.borderBottomWidth, 10) || 0;
  const r = getCachedRect(el);
  return new DOMRect(r.x + bl, r.y + bt, r.width - bl - br, r.height - bt - bb);
}

function getSpaceAvailable(container: HTMLElement, target: Element): { left: number; top: number } {
  const targetRect = getCachedRect(target);

  if (isScrollable(container)) {
    const pr = getPaddingRect(container);
    return {
      left: Math.max(container.scrollLeft + (targetRect.left - pr.left), 0),
      top: Math.max(container.scrollTop + (targetRect.top - pr.top), 0),
    };
  }

  if (clips(container)) {
    const pr = getPaddingRect(container);
    return {
      left: Math.max(targetRect.left - pr.left, 0),
      top: Math.max(targetRect.top - pr.top, 0),
    };
  }

  const s = getComputedStyle(container);
  if (s.position === 'fixed' || s.position === 'sticky') {
    const br = container.getBoundingClientRect();
    return {
      left: Math.max(targetRect.left - br.left, 0),
      top: Math.max(targetRect.top - br.top, 0),
    };
  }

  return {
    left: Math.max(targetRect.left + window.scrollX, 0),
    top: Math.max(targetRect.top + window.scrollY, 0),
  };
}

function isAptContainer(el: HTMLElement): boolean {
  const tag = el.tagName;
  if (/^(THEAD|TBODY|TFOOT|CAPTION|COLGROUP|COL|TR|TH|TD)$/.test(tag)) return false;
  if (tag === 'TABLE') return false;
  const s = getCachedStyle(el);
  if (s.display.startsWith('table')) return false;
  if (s.display === 'contents') return false;
  return true;
}

function findAptContainer(start: Element): HTMLElement {
  let current: Node | null = start.parentNode;
  while (current) {
    if (current instanceof HTMLElement && !current.shadowRoot && isAptContainer(current)) {
      return current;
    }
    current = current.parentNode;
  }
  return document.body;
}

type HintContainer = {
  container: HTMLElement;
  spaceLeft: number;
  spaceTop: number;
};

function pickContainer(target: Element): HintContainer {
  let limitParent: HTMLElement | null = null;
  const clipAncestors: HTMLElement[] = [];

  const s0 = getCachedStyle(target);
  let current: Node | null =
    s0.position === 'sticky' || s0.position === 'fixed' ? target : target.parentNode;

  while (current) {
    if (!(current instanceof HTMLElement)) {
      current = current.parentNode;
      continue;
    }
    if (current === document.body || current === document.documentElement) {
      limitParent ??= current as HTMLElement;
      clipAncestors.push(current as HTMLElement);
      break;
    }

    if (limitsChildren(current)) limitParent ??= current;

    if (clips(current) || limitsChildren(current)) {
      clipAncestors.push(current);
      if (limitParent) break;
    }

    current = current.parentNode;
  }

  limitParent ??= document.body;

  let candidate = findAptContainer(target);
  let prevSpace = clipAncestors.length > 0
    ? getSpaceAvailable(clipAncestors[0]!, target)
    : { left: Infinity, top: Infinity };
  let prevClip: HTMLElement | undefined;

  for (const clipAnc of clipAncestors) {
    const space = getSpaceAvailable(clipAnc, target);

    if (space.left >= BADGE_SPACE_LEFT && space.top >= BADGE_SPACE_TOP) {
      const container =
        (space.left > prevSpace.left || space.top > prevSpace.top) && prevClip
          ? findAptContainer(prevClip)
          : candidate;
      return { container, spaceLeft: space.left, spaceTop: space.top };
    }

    if (
      (space.left > prevSpace.left && prevSpace.left < BADGE_SPACE_LEFT) ||
      (space.top > prevSpace.top && prevSpace.top < BADGE_SPACE_TOP)
    ) {
      if (prevClip) {
        const next = findAptContainer(prevClip);
        if (limitParent.contains(next)) {
          candidate = next;
          prevSpace = space;
        } else {
          break;
        }
      }
    }

    prevClip = clipAnc;
  }

  return { container: candidate, spaceLeft: prevSpace.left, spaceTop: prevSpace.top };
}

function findClipAncestor(target: Element): HTMLElement | null {
  let el = target.parentElement;
  while (el && el !== document.body && el !== document.documentElement) {
    if (clips(el)) return el;
    el = el.parentElement;
  }
  return null;
}

const BADGE_OFFSET = 24;

export class HintBadge {
  public readonly host: HTMLDivElement;
  public readonly anchorParent: HTMLElement;
  private clipAncestor: HTMLElement | null;
  private shadow: ShadowRoot;
  private outer: HTMLDivElement;
  private inner: HTMLDivElement;
  private target: Element;
  private category: Category;
  private _visible: boolean = false;

  constructor(target: Element, label: LabelAssignment, category: Category, displayMode: BadgeDisplayMode) {
    this.target = target;
    this.category = category;

    this.host = document.createElement('div');
    this.host.setAttribute('data-branchkit-hint', 'true');
    this.host.style.cssText = 'position:absolute; top:0; left:0; width:0; height:0; overflow:visible; pointer-events:none;';

    this.shadow = this.host.attachShadow({ mode: 'closed' });

    this.outer = document.createElement('div');
    this.outer.className = 'bk-outer';

    this.inner = document.createElement('div');
    this.inner.className = 'bk-inner';

    const text = labelToDisplay(label, displayMode);
    this.inner.textContent = text;

    const style = document.createElement('style');
    style.textContent = `
      .bk-outer {
        position: absolute;
        pointer-events: none;
      }
      .bk-inner {
        font: bold 11px/16px system-ui, -apple-system, sans-serif;
        padding: 1px 5px;
        border-radius: 3px;
        user-select: none;
        white-space: nowrap;
        min-width: 16px;
        text-align: center;
        border-width: 1.5px;
        border-style: solid;
        box-shadow: 0 1px 3px rgba(0,0,0,0.18);
        opacity: 0;
        transition: opacity 0.15s ease-in;
      }
      .bk-inner.visible {
        opacity: 1;
      }
      .bk-inner.filtered {
        display: none;
      }
      .bk-inner.text-match {
        border-color: #FFD60A !important;
        box-shadow: 0 1px 3px rgba(0,0,0,0.18), 0 0 0 1px #FFD60A;
      }
      .bk-outer.focus-hidden { visibility: hidden; }
      @media print { .bk-outer { visibility: hidden; } }
    `;

    this.shadow.appendChild(style);
    this.outer.appendChild(this.inner);
    this.shadow.appendChild(this.outer);

    const { container } = pickContainer(target);
    if (container !== document.body && container !== document.documentElement) {
      if (getCachedStyle(container).position === 'static') {
        container.style.position = 'relative';
      }
    }
    this.anchorParent = container;
    this.clipAncestor = findClipAncestor(target);
    this.anchorParent.appendChild(this.host);

    this.host.style.zIndex = String(calculateZIndex(target, this.host));

    if (document.hasFocus() && target === document.activeElement) {
      this.outer.classList.add('focus-hidden');
    }
    target.addEventListener('focusin', () => {
      this.outer.classList.add('focus-hidden');
    });
    target.addEventListener('focusout', () => {
      this.outer.classList.remove('focus-hidden');
    });
  }

  updatePosition(): void {
    const targetRect = getCachedRect(this.target);
    let x: number;
    let y: number;

    if (this.anchorParent === document.body || this.anchorParent === document.documentElement) {
      x = targetRect.left + window.scrollX - BADGE_OFFSET;
      y = targetRect.top + window.scrollY + 2;
    } else {
      const parentRect = getCachedRect(this.anchorParent);
      x = targetRect.left - parentRect.left + this.anchorParent.scrollLeft - BADGE_OFFSET;
      y = targetRect.top - parentRect.top + this.anchorParent.scrollTop + 2;
    }

    if (this.clipAncestor) {
      const clipRect = getPaddingRect(this.clipAncestor);
      const minX = this.anchorParent === document.body || this.anchorParent === document.documentElement
        ? clipRect.left + window.scrollX
        : clipRect.left - getCachedRect(this.anchorParent).left + this.anchorParent.scrollLeft;
      if (x < minX) x = minX;
    }

    this.outer.style.left = `${x}px`;
    this.outer.style.top = `${y}px`;
  }

  reattach(): void {
    this.anchorParent.appendChild(this.host);
  }

  show(): void {
    if (this._visible) return;
    this._visible = true;
    this.applyColors();
    this.updatePosition();
    requestAnimationFrame(() => {
      this.inner.classList.add('visible');
    });
  }

  private applyColors(): void {
    const borderHex = CATEGORY_BORDER_COLORS[this.category];
    const colors = computeBadgeColors(this.target, borderHex);
    this.inner.style.background = colors.bg;
    this.inner.style.color = colors.fg;
    this.inner.style.borderColor = colors.border;
  }

  hide(): void {
    this._visible = false;
    this.inner.classList.remove('visible');
  }

  setFiltered(filtered: boolean): void {
    if (filtered) {
      this.inner.classList.add('filtered');
    } else {
      this.inner.classList.remove('filtered');
      if (this._visible) {
        this.updatePosition();
      }
    }
  }

  setTextMatch(matched: boolean): void {
    if (matched) {
      this.inner.classList.add('text-match');
    } else {
      this.inner.classList.remove('text-match');
    }
  }

  updateLabel(label: LabelAssignment, displayMode: BadgeDisplayMode): void {
    this.inner.textContent = labelToDisplay(label, displayMode);
  }

  reposition(): void {
    if (this._visible) {
      this.updatePosition();
    }
  }

  remove(): void {
    this.host.remove();
  }

  get isVisible(): boolean {
    return this._visible;
  }
}

/**
 * BranchKit Browser — Shadow DOM hint badges.
 *
 * Each badge lives in a closed Shadow DOM to prevent page CSS interference.
 * Appended to the target's nearest scroll ancestor so badges scroll in
 * lockstep with their targets via the compositor — no JS repositioning
 * needed during scroll.
 */

import { Category, CATEGORY_COLORS, BadgeDisplayMode } from './types';
import { LabelAssignment, labelToDisplay } from './words';

function getScrollAncestor(el: Element): HTMLElement | null {
  let parent = el.parentElement;
  while (parent && parent !== document.body && parent !== document.documentElement) {
    const s = getComputedStyle(parent);
    if (/(auto|scroll)/.test(s.overflow + s.overflowX + s.overflowY)) {
      return parent;
    }
    parent = parent.parentElement;
  }
  return null;
}

export class HintBadge {
  public readonly host: HTMLDivElement;
  public readonly anchorParent: HTMLElement;
  private shadow: ShadowRoot;
  private outer: HTMLDivElement;
  private inner: HTMLDivElement;
  private target: Element;
  private _visible: boolean = false;

  constructor(target: Element, label: LabelAssignment, category: Category, displayMode: BadgeDisplayMode) {
    this.target = target;

    const colors = CATEGORY_COLORS[category];

    this.host = document.createElement('div');
    this.host.setAttribute('data-branchkit-hint', 'true');
    this.host.style.cssText = 'position:absolute; top:0; left:0; width:0; height:0; overflow:visible; z-index:2147483647; pointer-events:none;';

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
        background: ${colors.bg};
        color: ${colors.fg};
        border: 1px solid ${colors.border};
        box-shadow: 0 1px 3px rgba(0,0,0,0.3);
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
        border-color: #FFD60A;
        box-shadow: 0 1px 3px rgba(0,0,0,0.3), 0 0 0 1px #FFD60A;
      }
      @media print { .bk-outer { visibility: hidden; } }
    `;

    this.shadow.appendChild(style);
    this.outer.appendChild(this.inner);
    this.shadow.appendChild(this.outer);

    const scrollAncestor = getScrollAncestor(target);
    if (scrollAncestor) {
      if (getComputedStyle(scrollAncestor).position === 'static') {
        scrollAncestor.style.position = 'relative';
      }
      this.anchorParent = scrollAncestor;
    } else {
      this.anchorParent = document.body;
    }
    this.anchorParent.appendChild(this.host);
  }

  updatePosition(): void {
    const targetRect = this.target.getBoundingClientRect();

    if (this.anchorParent === document.body) {
      const x = targetRect.left + window.scrollX - 24;
      const y = targetRect.top + window.scrollY + 2;
      this.outer.style.left = `${x}px`;
      this.outer.style.top = `${y}px`;
    } else {
      const parentRect = this.anchorParent.getBoundingClientRect();
      const x = targetRect.left - parentRect.left + this.anchorParent.scrollLeft - 24;
      const y = targetRect.top - parentRect.top + this.anchorParent.scrollTop + 2;
      this.outer.style.left = `${x}px`;
      this.outer.style.top = `${y}px`;
    }
  }

  reattach(): void {
    this.anchorParent.appendChild(this.host);
  }

  show(): void {
    if (this._visible) return;
    this._visible = true;
    this.updatePosition();
    requestAnimationFrame(() => {
      this.inner.classList.add('visible');
    });
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

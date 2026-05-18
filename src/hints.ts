/**
 * BranchKit Browser — Shadow DOM hint badges.
 *
 * Each badge lives in a closed Shadow DOM to prevent page CSS interference.
 * Uses position:fixed with viewport coordinates for reliable placement.
 * Badges reposition on scroll via a shared scroll listener in content.ts.
 */

import { Category, CATEGORY_COLORS, BadgeDisplayMode } from './types';
import { LabelAssignment, labelToDisplay } from './words';

export class HintBadge {
  // Host is public so an external rescuer (content.ts's body
  // childList observer) can re-append it after a page-driven
  // removal. The shadow root inside is still closed; the page can
  // remove the host from body but can't peek at its contents.
  public readonly host: HTMLDivElement;
  private shadow: ShadowRoot;
  private outer: HTMLDivElement;
  private inner: HTMLDivElement;
  private target: Element;
  private _visible: boolean = false;

  constructor(target: Element, label: LabelAssignment, category: Category, displayMode: BadgeDisplayMode) {
    this.target = target;

    const colors = CATEGORY_COLORS[category];

    // Create shadow host — appended to body to avoid layout interference
    this.host = document.createElement('div');
    this.host.setAttribute('data-branchkit-hint', 'true');
    this.host.style.cssText = 'position:fixed; top:0; left:0; width:0; height:0; overflow:visible; z-index:2147483647; pointer-events:none;';

    // Closed shadow DOM
    this.shadow = this.host.attachShadow({ mode: 'closed' });

    // Build inner structure
    this.outer = document.createElement('div');
    this.outer.className = 'bk-outer';

    this.inner = document.createElement('div');
    this.inner.className = 'bk-inner';

    const text = labelToDisplay(label, displayMode);
    this.inner.textContent = text;

    // Create style
    const style = document.createElement('style');
    style.textContent = `
      .bk-outer {
        position: fixed;
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

    // Append to body (fixed positioning, so location in DOM doesn't matter)
    document.body.appendChild(this.host);
  }

  updatePosition(): void {
    const targetRect = this.target.getBoundingClientRect();

    // Position to the left of the target element
    const x = targetRect.left - 24;
    const y = targetRect.top + 2;

    this.outer.style.left = `${x}px`;
    this.outer.style.top = `${y}px`;
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

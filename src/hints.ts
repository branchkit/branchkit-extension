/**
 * BranchKit Extension — Shadow DOM hint badges.
 *
 * Each badge lives in a closed Shadow DOM to prevent page CSS interference.
 * Badges are DOM-embedded near their target element so they scroll naturally.
 * Based on Rango's approach (DESIGN_BROWSER_EXTENSION.md §3).
 */

import { Category, CATEGORY_COLORS, BadgeDisplayMode } from './types';
import { LabelAssignment, labelToDisplay } from './words';

/**
 * Check if a CSS property creates a stacking context.
 */
function createsStackingContext(style: CSSStyleDeclaration): boolean {
  if (style.position !== 'static' && style.zIndex !== 'auto') return true;
  if (parseFloat(style.opacity) < 1) return true;
  if (style.transform !== 'none') return true;
  if (style.filter !== 'none') return true;
  if (style.isolation === 'isolate') return true;
  if (style.position === 'fixed' || style.position === 'sticky') return true;
  const willChange = style.willChange;
  if (willChange === 'transform' || willChange === 'opacity' || willChange === 'filter') return true;
  return false;
}

/**
 * Calculate z-index to sit above siblings near the target element.
 */
function calculateZIndex(target: Element, container: Element): number {
  let maxZ = 0;

  // Walk ancestors up to container
  let el: Element | null = target;
  while (el && el !== container) {
    const style = getComputedStyle(el);
    if (createsStackingContext(style)) {
      maxZ = Math.max(maxZ, parseInt(style.zIndex) || 0);
    }
    el = el.parentElement;
  }

  return maxZ + 5;
}

/**
 * Find the best DOM insertion point for a badge.
 * Simplified version: insert before target's parent.
 * Full ancestor traversal can be added later for edge cases.
 */
function getAptContainer(target: Element): Element {
  // For fixed/sticky elements, use the element itself
  const style = getComputedStyle(target);
  if (style.position === 'fixed' || style.position === 'sticky') {
    return target;
  }

  // Walk up to find a block-level container
  let el: Element | null = target.parentElement;
  while (el && el !== document.body) {
    const elStyle = getComputedStyle(el);
    const display = elStyle.display;
    // Skip inline, contents, and table internals
    if (display !== 'inline' && display !== 'contents' &&
        !display.startsWith('table') && !el.shadowRoot) {
      return el;
    }
    el = el.parentElement;
  }

  return document.body;
}

export class HintBadge {
  private host: HTMLDivElement;
  private shadow: ShadowRoot;
  private outer: HTMLDivElement;
  private inner: HTMLDivElement;
  private target: Element;
  private _visible: boolean = false;

  constructor(target: Element, label: LabelAssignment, category: Category, displayMode: BadgeDisplayMode) {
    this.target = target;

    const colors = CATEGORY_COLORS[category];
    const container = getAptContainer(target);
    const zIndex = calculateZIndex(target, container);

    // Create shadow host
    this.host = document.createElement('div');
    this.host.setAttribute('data-branchkit-hint', 'true');
    this.host.style.display = 'contents';

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
      :host { display: contents; }
      .bk-outer {
        position: absolute;
        contain: layout size style;
        pointer-events: none;
        z-index: ${zIndex};
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
      @media print { .bk-outer { visibility: hidden; } }
    `;

    this.shadow.appendChild(style);
    this.outer.appendChild(this.inner);
    this.shadow.appendChild(this.outer);

    // Insert into DOM near target (position deferred until show())
    container.insertBefore(this.host, container.firstChild);
  }

  private updatePosition(): void {
    const targetRect = this.target.getBoundingClientRect();
    const outerRect = this.outer.getBoundingClientRect();

    // Position at the left edge of the target, slightly overlapping
    const x = targetRect.x - outerRect.x - 2;
    const y = targetRect.y - outerRect.y;

    this.outer.style.left = `${x}px`;
    this.outer.style.top = `${y}px`;
  }

  show(): void {
    if (this._visible) return;
    this._visible = true;
    // Batch: position then fade in next frame
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

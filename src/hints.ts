/**
 * BranchKit Browser — Shadow DOM hint badges.
 *
 * Each badge lives in a closed Shadow DOM to prevent page CSS interference.
 * Badge hosts are always appended to document.documentElement — never inside
 * React-owned subtrees — so they can't trigger hydration error #418.
 */

import { Category, BadgeDisplayMode } from './types';
import { LabelAssignment, labelToDisplay } from './words';
import { getCachedRect, getCachedStyle } from './layout-cache';
import { computeBadgeColors } from './badge-colors';
import { leaderLineGeometry } from './placement/geometry';

function clips(el: Element): boolean {
  const s = getCachedStyle(el);
  if (s.overflow !== 'visible') return true;
  if (s.clipPath !== 'none') return true;
  if (/paint|content|strict/.test(s.contain)) return true;
  if (s.contentVisibility && s.contentVisibility !== 'visible') return true;
  return false;
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

function findClipAncestor(target: Element): HTMLElement | null {
  let el = target.parentElement;
  while (el && el !== document.body && el !== document.documentElement) {
    if (clips(el)) return el;
    el = el.parentElement;
  }
  return null;
}

const BADGE_OFFSET = 24;

const MAX_BADGE_FONT = 14;

function computeBadgeFontSize(target: Element): number {
  const targetSize = parseFloat(getCachedStyle(target).fontSize) || 12;
  return Math.min(Math.round(targetSize), MAX_BADGE_FONT);
}

export class HintBadge {
  public readonly host: HTMLDivElement;
  public readonly anchorParent: HTMLElement;
  private clipAncestor: HTMLElement | null;
  private shadow: ShadowRoot;
  private outer: HTMLDivElement;
  private inner: HTMLDivElement;
  private leaderLine: HTMLDivElement | null = null;
  private target: Element;
  private category: Category;
  private _visible: boolean = false;
  private _size: { w: number; h: number } | null = null;
  private focusinHandler: () => void;
  private focusoutHandler: () => void;

  private label: LabelAssignment;
  private displayMode: BadgeDisplayMode;
  private fontSize: number;

  constructor(target: Element, label: LabelAssignment, category: Category, displayMode: BadgeDisplayMode) {
    this.target = target;
    this.category = category;
    this.label = label;
    this.displayMode = displayMode;
    this.fontSize = computeBadgeFontSize(target);

    this.host = document.createElement('div');
    this.host.setAttribute('data-branchkit-hint', 'true');
    this.host.style.cssText = 'display:contents;';

    this.shadow = this.host.attachShadow({ mode: 'closed' });

    this.outer = document.createElement('div');
    this.outer.className = 'bk-outer';

    this.inner = document.createElement('div');
    this.inner.className = 'bk-inner';
    this.inner.style.fontSize = `${this.fontSize}px`;

    const text = labelToDisplay(label, displayMode);
    this.inner.textContent = text;

    const style = document.createElement('style');
    style.textContent = `
      .bk-outer {
        position: absolute;
        left: 0;
        top: 0;
        z-index: 2147483647;
        pointer-events: none;
      }
      .bk-inner {
        font-weight: bold;
        font-family: system-ui, -apple-system, sans-serif;
        line-height: 1.2;
        padding: 0 0.1em;
        border-radius: 2px;
        user-select: none;
        white-space: nowrap;
        text-align: center;
        border-width: 1px;
        border-style: solid;
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
        outline: 1px solid currentColor;
      }
      .bk-matched {
        opacity: 0.35;
      }
      @keyframes bk-flash {
        /* No !important here — the CSS spec specifies that !important inside
         * @keyframes is silently ignored, which drops the entire declaration
         * and makes the keyframe a no-op. Animation declarations naturally
         * outrank normal inline styles set by applyColors(), so no override
         * marker is needed. */
        0%, 70% { background: #ffeb3b; color: #000; }
        100% { /* fade back to inherited background/color */ }
      }
      .bk-inner.flashing {
        animation: bk-flash 350ms ease-out;
      }
      .bk-leader {
        position: absolute;
        height: 1px;
        transform-origin: 0 0;
        pointer-events: none;
      }
      .bk-outer.focus-hidden { visibility: hidden; }
      @media print { .bk-outer { visibility: hidden; } }
    `;

    this.shadow.appendChild(style);
    this.outer.appendChild(this.inner);
    this.shadow.appendChild(this.outer);

    this.anchorParent = document.documentElement as HTMLElement;
    this.clipAncestor = findClipAncestor(target);
    this.anchorParent.appendChild(this.host);

    if (document.hasFocus() && target === document.activeElement) {
      this.outer.classList.add('focus-hidden');
    }
    this.focusinHandler = () => this.outer.classList.add('focus-hidden');
    this.focusoutHandler = () => this.outer.classList.remove('focus-hidden');
    target.addEventListener('focusin', this.focusinHandler);
    target.addEventListener('focusout', this.focusoutHandler);
  }

  updatePosition(candidate?: { x: number; y: number }): void {
    let vpX: number;
    let vpY: number;

    if (candidate) {
      vpX = candidate.x;
      vpY = candidate.y;
    } else {
      const targetRect = getCachedRect(this.target);
      vpX = targetRect.left - BADGE_OFFSET;
      vpY = targetRect.top + 2;
    }

    if (this.clipAncestor) {
      const clipRect = getPaddingRect(this.clipAncestor);
      if (vpX < clipRect.left) vpX = clipRect.left;
    }

    // Delta-based positioning: measure where the outer currently sits
    // in viewport coords, then adjust left/top to reach the desired
    // position. Works regardless of containing block — no need to set
    // position:relative on the container (which would mutate React-
    // owned elements and break hydration).
    const outerRect = this.outer.getBoundingClientRect();
    const curLeft = parseFloat(this.outer.style.left) || 0;
    const curTop = parseFloat(this.outer.style.top) || 0;

    this.outer.style.left = `${curLeft + (vpX - outerRect.left)}px`;
    this.outer.style.top = `${curTop + (vpY - outerRect.top)}px`;
  }

  reattach(): void {
    this.anchorParent.appendChild(this.host);
  }

  show(): void {
    if (this._visible) return;
    this._visible = true;
    this.inner.classList.remove('filtered');
    this.applyColors();
    this._size = null;
    requestAnimationFrame(() => {
      this.inner.classList.add('visible');
    });
  }

  get badgeSize(): { w: number; h: number } {
    if (this._size) return this._size;
    const rect = this.inner.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this._size = { w: Math.ceil(rect.width), h: Math.ceil(rect.height) };
      return this._size;
    }
    const text = this.inner.textContent || '';
    const charWidth = this.fontSize * 0.6;
    const w = Math.ceil(text.length * charWidth) + 4;
    const h = Math.ceil(this.fontSize * 1.2) + 2;
    this._size = { w, h };
    return this._size;
  }

  private applyColors(): void {
    const colors = computeBadgeColors(this.target);
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
    }
  }

  setTextMatch(matched: boolean): void {
    if (matched) {
      this.inner.classList.add('text-match');
    } else {
      this.inner.classList.remove('text-match');
    }
  }

  // Briefly highlight this badge to confirm "this is the codeword that
  // matched." Yellow background + black text for 350ms. Does NOT modify
  // textContent — the badge keeps whatever label it was already showing.
  // Runs on the compositor; non-blocking.
  flash(): void {
    this.inner.classList.remove('flashing');
    void this.inner.offsetWidth; // force reflow so re-add restarts the animation
    this.inner.classList.add('flashing');
    setTimeout(() => this.inner.classList.remove('flashing'), 400);
  }

  updateLabel(label: LabelAssignment, displayMode: BadgeDisplayMode): void {
    this.label = label;
    this.displayMode = displayMode;
    this.inner.textContent = labelToDisplay(label, displayMode);
    this._size = null;
  }

  setMatchedChars(count: number): void {
    if (count === 0) {
      this.inner.textContent = labelToDisplay(this.label, this.displayMode);
      this._size = null;
      return;
    }

    const { words, letter } = this.label;
    let matchedText: string;
    let remainingText: string;

    switch (this.displayMode) {
      case 'letter':
        matchedText = letter.slice(0, count);
        remainingText = letter.slice(count);
        break;
      case 'word':
        matchedText = words.slice(0, count).join(' ');
        remainingText = words.slice(count).join(' ');
        if (matchedText && remainingText) remainingText = ' ' + remainingText;
        break;
      case 'both':
        if (words.length === 1) {
          matchedText = labelToDisplay(this.label, 'both');
          remainingText = '';
        } else {
          matchedText = words.slice(0, count).join(' ');
          remainingText = words.slice(count).join(' ');
          if (matchedText && remainingText) remainingText = ' ' + remainingText;
        }
        break;
      case 'first-word':
        if (count >= 1 && words.length >= 2) {
          matchedText = letter[0];
          remainingText = ' ' + words[1];
        } else {
          matchedText = letter.slice(0, count);
          remainingText = '';
        }
        break;
    }

    this.inner.textContent = '';
    if (matchedText) {
      const matched = document.createElement('span');
      matched.className = 'bk-matched';
      matched.textContent = matchedText;
      this.inner.appendChild(matched);
    }
    if (remainingText) {
      this.inner.appendChild(document.createTextNode(remainingText));
    }
    this._size = null;
  }

  reposition(): void {
    if (this._visible) {
      this.updatePosition();
    }
  }

  remove(): void {
    this.target.removeEventListener('focusin', this.focusinHandler);
    this.target.removeEventListener('focusout', this.focusoutHandler);
    this.host.remove();
  }

  get isVisible(): boolean {
    return this._visible;
  }

  setLeader(
    targetRect: { left: number; right: number; top: number; bottom: number },
    badgeRect: { x: number; y: number; width: number; height: number },
  ): void {
    if (!this.leaderLine) {
      this.leaderLine = document.createElement('div');
      this.leaderLine.className = 'bk-leader';
      this.leaderLine.style.background = this.inner.style.color || '#333';
      this.leaderLine.style.opacity = '0.4';
      this.outer.appendChild(this.leaderLine);
    }

    const badgeAnchor = { x: badgeRect.x + badgeRect.width / 2, y: badgeRect.y + badgeRect.height / 2 };
    const targetAnchor = {
      x: Math.max(targetRect.left, Math.min(targetRect.right, badgeAnchor.x)),
      y: Math.max(targetRect.top, Math.min(targetRect.bottom, badgeAnchor.y)),
    };
    const { length, angle } = leaderLineGeometry(badgeAnchor, targetAnchor);

    if (length <= 16) {
      this.leaderLine.style.display = 'none';
      return;
    }

    const outerRect = this.outer.getBoundingClientRect();
    const anchorLocalX = badgeAnchor.x - outerRect.left;
    const anchorLocalY = badgeAnchor.y - outerRect.top;

    this.leaderLine.style.display = '';
    this.leaderLine.style.width = `${length}px`;
    this.leaderLine.style.left = `${anchorLocalX}px`;
    this.leaderLine.style.top = `${anchorLocalY}px`;
    this.leaderLine.style.transform = `rotate(${angle}rad)`;
  }

  hideLeader(): void {
    if (this.leaderLine) {
      this.leaderLine.style.display = 'none';
    }
  }
}

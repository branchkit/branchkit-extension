/**
 * BranchKit Browser — Shadow DOM hint badges.
 *
 * Each badge lives in a closed Shadow DOM to prevent page CSS interference.
 * Badges mount in their target's nearest block-level ancestor (like Rango's
 * getAptContainer) so they sit close to the target in the DOM tree and
 * naturally follow any scroll mechanism — CSS overflow, JS-driven, or
 * transform-based. No JS scroll listeners needed.
 */

import { Category, BadgeDisplayMode } from './types';
import { LabelAssignment, labelToDisplay } from './words';
import { getCachedRect, getCachedStyle, getCachedDims, isClipAncestor } from './layout-cache';
import { computeBadgeColors } from './badge-colors';
import { leaderLineGeometry } from './placement/geometry';
import { trackContainerResize, untrackContainerResize } from './container-resize-tracker';
import { trackTargetMutations, untrackTargetMutations } from './target-mutation-tracker';
import { trackHostAttributes, untrackHostAttributes } from './host-attribute-tracker';

// --- Position debug log (temporary investigation) ---
export interface PositionLogEntry {
  ts: number;
  caller: string;
  scrollY: number;
  target: { tag: string; name: string; vpY: number };
  container: { tag: string; id: string; vpY: number; display: string; position: string };
  outer: { vpY: number; h: number; w: number };
  computed: { vpX: number; vpY: number; innerTop: string; innerLeft: string };
  result: { innerVpY: number; diff: number };
}
const POSITION_LOG_MAX = 200;
const positionLog: PositionLogEntry[] = [];
function pushPositionLog(entry: PositionLogEntry): void {
  positionLog.push(entry);
  if (positionLog.length > POSITION_LOG_MAX) positionLog.shift();
}
export function getPositionLog(): readonly PositionLogEntry[] { return positionLog; }
let _positionCaller = '';
export function setPositionCaller(c: string): void { _positionCaller = c; }
export function clearPositionCaller(): void { _positionCaller = ''; }

export type PositionMode = 'absolute' | 'relative';

export interface BadgeContext {
  container: HTMLElement;
  positionMode: PositionMode;
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

function isScrollContainer(el: Element): boolean {
  const s = getCachedStyle(el);
  const { clientWidth, scrollWidth, clientHeight, scrollHeight } = getCachedDims(el);
  return (
    el === document.documentElement ||
    (scrollWidth > clientWidth && /scroll|auto/.test(s.overflowX)) ||
    (scrollHeight > clientHeight && /scroll|auto/.test(s.overflowY))
  );
}

const ENOUGH_LEFT = 15;
const ENOUGH_TOP = 10;

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

function getSpaceInAncestor(ancestor: Element, targetRect: DOMRect): { left: number; top: number } {
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

export interface ContainerResolutionDiag {
  limitParent: { tag: string; id: string; classes: string; position: string; isScrollContainer: boolean };
  clipAncestors: Array<{ tag: string; id: string; classes: string; space: { left: number; top: number }; tight: boolean }>;
  escalated: boolean;
  escalationBlocked: boolean;
  finalContainer: { tag: string; id: string; classes: string };
}

function elSig(el: Element): { tag: string; id: string; classes: string } {
  return {
    tag: el.tagName.toLowerCase(),
    id: el.id || '',
    classes: (typeof el.className === 'string' ? el.className : '').slice(0, 200),
  };
}

export function diagnoseContainerResolution(target: Element): ContainerResolutionDiag {
  const candidate = findBadgeContainer(target);
  const limitParent = findLimitParent(target);
  const targetRect = getCachedRect(target);
  const lpStyle = getCachedStyle(limitParent);

  const clipAncestors: ContainerResolutionDiag['clipAncestors'] = [];
  let current: Element | null = target.parentElement;
  let firstTightClip: HTMLElement | null = null;

  while (current && current !== limitParent && current !== document.body) {
    if (current instanceof HTMLElement && isClipAncestor(current)) {
      const space = getSpaceInAncestor(current, targetRect);
      const tight = space.left < ENOUGH_LEFT || space.top < ENOUGH_TOP;
      clipAncestors.push({ ...elSig(current), space, tight });
      if (tight) firstTightClip ??= current;
    }
    current = current.parentElement;
  }

  let escalated = false;
  let escalationBlocked = false;
  let finalContainer = candidate;

  if (firstTightClip) {
    const clipParent = firstTightClip.parentElement;
    if (clipParent instanceof HTMLElement && limitParent.contains(clipParent)) {
      finalContainer = clipParent;
      escalated = true;
    } else {
      const escaped = findBadgeContainer(firstTightClip);
      if (limitParent.contains(escaped)) {
        finalContainer = escaped;
        escalated = true;
      } else {
        escalationBlocked = true;
      }
    }
  }

  return {
    limitParent: {
      ...elSig(limitParent),
      position: lpStyle.position,
      isScrollContainer: isScrollContainer(limitParent),
    },
    clipAncestors,
    escalated,
    escalationBlocked,
    finalContainer: elSig(finalContainer),
  };
}

export function resolveBadgeContext(target: Element, host: HTMLElement, outer: HTMLElement): BadgeContext {
  const container = resolveContainer(target);
  container.appendChild(host);
  // Always use relative positioning (Rango/Vimium pattern). The outer's
  // visual position is driven by its DOM placement — which is INSIDE
  // the container, which is inside whatever scrolling content the
  // target lives in. Both scroll together natively; no JS reposition
  // needed for in-context tracking.
  //
  // Previous absolute-default broke on Gmail because the outer's
  // containing block (under closed shadow DOM, anchored to the nearest
  // positioned ancestor outside the shadow tree) didn't move with
  // internal pane scrolls. Switching to relative makes the outer
  // participate in normal flow inside the container, which is the case
  // Rango has shipped reliably across the same hard targets (Gmail,
  // Slack, etc.) for years.
  //
  // The `outer.offsetParent` open-shadow check remains for completeness
  // — in test environments using open shadow it preserves the original
  // behavior, while production closed-shadow falls through to relative.
  const outerOffsetParent = outer.offsetParent;
  const positionMode: PositionMode = outerOffsetParent && container.contains(outerOffsetParent)
    ? 'absolute'  // open-shadow test path: outer's offsetParent is inside container
    : 'relative'; // closed-shadow production path (offsetParent null) OR offsetParent outside container
  return { container, positionMode };
}

const BADGE_OFFSET = 24;

const MAX_BADGE_FONT = 14;
const MIN_BADGE_FONT = 11;

function computeBadgeFontSize(target: Element): number {
  // Targets with font-size: 0 (the common a11y-text-hiding trick on
  // role=checkbox / role=button divs) would otherwise yield a 0px or
  // tiny badge — `0 || 12` would fall back to 12 but only when targetSize
  // is exactly 0. Floor at MIN_BADGE_FONT so any sub-readable value
  // (parsing oddities, 0px declarations, vw/em < 11) lifts to readable.
  const targetSize = parseFloat(getCachedStyle(target).fontSize) || 12;
  const scaled = Math.round(targetSize * 0.85);
  return Math.min(Math.max(scaled, MIN_BADGE_FONT), MAX_BADGE_FONT);
}

export class HintBadge {
  public readonly host: HTMLDivElement;
  // Mutable: `retarget(newEl)` resolves a new container when the wrapper
  // rebinds to a replacement DOM node (DESIGN_WRAPPER_IDENTITY_STABILITY
  // step 4). Same host stays attached; the host's parent and the
  // tracked target both move.
  public anchorParent: HTMLElement;
  private shadow: ShadowRoot;
  private outer: HTMLDivElement;
  private inner: HTMLDivElement;
  private leaderLine: HTMLDivElement | null = null;
  private target: Element;
  private category: Category;
  private _visible: boolean = false;
  private _size: { w: number; h: number } | null = null;

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
        inset: auto;
        display: block;
        contain: layout size style;
        z-index: 2147483647;
        pointer-events: none;
      }
      .bk-inner {
        position: absolute;
        /* Floor the font size so inheritance from the host can't collapse
         * the badge text. Gmail's email-row checkbox is a div[role=checkbox]
         * with font-size:0 (to hide its accessible-name text node from layout)
         * and that value inherits through the shadow boundary. Without this
         * floor, badges on Gmail rows render at 3x3 px — visible to the
         * scanner but invisible to the user. Inline style.fontSize set in
         * the constructor still wins for normal targets; this rule is the
         * defensive backstop. */
        font-size: 11px;
        min-width: 8px;
        min-height: 12px;
        font-weight: bold;
        font-family: system-ui, -apple-system, sans-serif;
        line-height: 1.2;
        padding: 0 0.1em;
        border-radius: 3px;
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
      @media print { .bk-outer { visibility: hidden; } }
    `;

    this.shadow.appendChild(style);
    this.outer.appendChild(this.inner);
    this.shadow.appendChild(this.outer);

    const ctx = resolveBadgeContext(target, this.host, this.outer);
    this.anchorParent = ctx.container;
    if (ctx.positionMode === 'relative') {
      this.outer.style.position = 'relative';
      this.outer.style.display = 'inline';
    }

    trackContainerResize(this.anchorParent);
    trackTargetMutations(this.target);
    // Start the host-attribute defender AFTER all setup is done — the
    // observer fires on real mutations only, but starting it earlier
    // would treat our own setAttribute/style writes as page tampering.
    trackHostAttributes(this.host);
  }

  updatePosition(candidate?: { x: number; y: number }, caller?: string): void {
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

    const outerRect = this.outer.getBoundingClientRect();
    this.inner.style.left = `${vpX - outerRect.left}px`;
    this.inner.style.top = `${vpY - outerRect.top}px`;

    const elRect = this.target.getBoundingClientRect();
    const containerRect = this.anchorParent.getBoundingClientRect();
    pushPositionLog({
      ts: Date.now(),
      caller: caller ?? (_positionCaller || '?'),
      scrollY: Math.round(window.scrollY),
      target: {
        tag: this.target.tagName.toLowerCase(),
        name: (this.target as HTMLElement).innerText?.slice(0, 30) ?? '',
        vpY: Math.round(elRect.top),
      },
      container: {
        tag: this.anchorParent.tagName.toLowerCase(),
        id: this.anchorParent.id.slice(0, 20),
        vpY: Math.round(containerRect.top),
        display: getComputedStyle(this.anchorParent).display,
        position: getComputedStyle(this.anchorParent).position,
      },
      outer: {
        vpY: Math.round(outerRect.top),
        h: Math.round(outerRect.height),
        w: Math.round(outerRect.width),
      },
      computed: {
        vpX: Math.round(vpX),
        vpY: Math.round(vpY),
        innerTop: `${Math.round(vpY - outerRect.top)}`,
        innerLeft: `${Math.round(vpX - outerRect.left)}`,
      },
      result: {
        innerVpY: Math.round(outerRect.top + (vpY - outerRect.top)),
        diff: Math.round(Math.abs(elRect.top - (outerRect.top + (vpY - outerRect.top)))),
      },
    });
  }

  reattach(): void {
    this.anchorParent.appendChild(this.host);
  }

  /**
   * Re-point this badge at a different DOM element. Called when the
   * wrapper's logical identity rebinds to a new node (the React
   * re-render case — see DESIGN_WRAPPER_IDENTITY_STABILITY step 4).
   * The host element itself is reused; only the tracked target, its
   * container, and the per-target/per-anchor observers swap.
   *
   * Font size and colors aren't recomputed — a same-fingerprint
   * replacement should be visually similar, and re-running those reads
   * during a rebind would add a layout/style read for a marginal
   * appearance match. Future tuning can revisit if rebound badges
   * routinely mis-paint.
   */
  retarget(newEl: Element): void {
    untrackContainerResize(this.anchorParent);
    untrackTargetMutations(this.target);

    this.target = newEl;
    const ctx = resolveBadgeContext(newEl, this.host, this.outer);
    this.anchorParent = ctx.container;
    if (ctx.positionMode === 'relative') {
      this.outer.style.position = 'relative';
      this.outer.style.display = 'inline';
    } else {
      // Reset in case the prior context was relative.
      this.outer.style.position = 'absolute';
      this.outer.style.display = 'block';
    }

    trackContainerResize(this.anchorParent);
    trackTargetMutations(this.target);
    // host-attribute tracker is keyed on the host (unchanged); no swap.

    this.reposition();
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
    untrackContainerResize(this.anchorParent);
    untrackTargetMutations(this.target);
    untrackHostAttributes(this.host);
    this.host.remove();
  }

  get isVisible(): boolean {
    return this._visible;
  }

  get diagnostics(): {
    innerRect: { x: number; y: number; w: number; h: number };
    outerRect: { x: number; y: number; w: number; h: number };
    anchorParentRect: { x: number; y: number; w: number; h: number };
    anchorParentScroll: { top: number; left: number; width: number; height: number };
    anchorParentOverflow: { x: string; y: string };
    anchorParentTag: string;
    anchorParentClasses: string;
    displayedAs: string;
  } {
    const ir = this.inner.getBoundingClientRect();
    const or2 = this.outer.getBoundingClientRect();
    const ap = this.anchorParent;
    const apr = ap.getBoundingClientRect();
    const aps = getComputedStyle(ap);
    return {
      innerRect: { x: Math.round(ir.left), y: Math.round(ir.top), w: Math.round(ir.width), h: Math.round(ir.height) },
      outerRect: { x: Math.round(or2.left), y: Math.round(or2.top), w: Math.round(or2.width), h: Math.round(or2.height) },
      anchorParentRect: { x: Math.round(apr.left), y: Math.round(apr.top), w: Math.round(apr.width), h: Math.round(apr.height) },
      anchorParentScroll: { top: ap.scrollTop, left: ap.scrollLeft, width: ap.scrollWidth, height: ap.scrollHeight },
      anchorParentOverflow: { x: aps.overflowX, y: aps.overflowY },
      anchorParentTag: ap.tagName.toLowerCase(),
      anchorParentClasses: ap.className?.toString().slice(0, 200) ?? '',
      displayedAs: this.inner.textContent ?? '',
    };
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

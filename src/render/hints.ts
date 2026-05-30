/**
 * BranchKit Browser — Shadow DOM hint badges.
 *
 * Each badge lives in a closed Shadow DOM to prevent page CSS interference.
 * Badges mount in their target's nearest block-level ancestor (like Rango's
 * getAptContainer) so they sit close to the target in the DOM tree and
 * naturally follow any scroll mechanism — CSS overflow, JS-driven, or
 * transform-based. No JS scroll listeners needed.
 */

import { Category, BadgeDisplayMode } from '../types';
import { LabelAssignment, labelToDisplay } from '../labels/words';
import { getCachedRect, getCachedStyle, getCachedDims, isClipAncestor } from '../layout-cache';
import { computeBadgeColors } from './badge-colors';
import { leaderLineGeometry } from '../placement/geometry';
import { trackContainerResize, untrackContainerResize } from '../observe/container-resize-tracker';
import { trackScrollAncestor, untrackScrollAncestor } from '../observe/scroll-ancestor-tracker';
import { trackTargetMutations, untrackTargetMutations } from '../observe/target-mutation-tracker';
import { trackHostAttributes, untrackHostAttributes } from '../observe/host-attribute-tracker';

// --- CSS Anchor Positioning fast-path (Chromium 125+) ---
//
// When the engine supports CSS Anchor Positioning we pin each badge host to
// its target via `anchor-name`/`anchor()` instead of physically nesting the
// host inside the target's scroll-ancestor. The compositor then carries the
// badge through *every* overflow ancestor with zero JS scroll work — solving
// the "Hard" inner-pane scroll case (Phase 5b) natively. The anchor CSS must
// live on the light-DOM host: `anchor()` does not pierce up out of a shadow
// tree to a light-DOM `anchor-name` (verified open + closed). Firefox (no
// `anchor()`) keeps the nesting + settle-reposition path unchanged.
let _anchorSupport: boolean | null = null;
export function supportsAnchorPositioning(): boolean {
  if (_anchorSupport !== null) return _anchorSupport;
  _anchorSupport =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    CSS.supports('anchor-name', '--x') &&
    CSS.supports('top', 'anchor(top)');
  return _anchorSupport;
}
let _nextAnchorId = 0;

// Firefox (through 150) advertises CSS Anchor Positioning but fails to resolve
// `anchor()` when the anchored element references a target inside a
// `position:fixed` containing block — the host collapses to the viewport
// origin (0,0), so badges on fixed page chrome (YouTube's masthead, mini-guide,
// chips bar) render stacked in the top-left corner instead of on their target.
// Chromium resolves it correctly. Feature-detect the specific broken behavior
// (no UA sniffing) so targets under a fixed ancestor fall back to the nesting
// path, which Firefox renders fine. Sticky/transform containing blocks resolve
// correctly in both engines and stay on the anchor path.
let _anchorAcrossFixed: boolean | null = null;
export function anchorResolvesAcrossFixed(): boolean {
  if (_anchorAcrossFixed !== null) return _anchorAcrossFixed;
  if (!supportsAnchorPositioning() || typeof document === 'undefined' || !document.body) {
    // Only consulted when anchor is supported; assume ok until the DOM is ready.
    return true;
  }
  const name = `--bk-probe-${_nextAnchorId++}`;
  const anchor = document.createElement('div');
  anchor.style.cssText = 'position:fixed;top:100px;left:120px;width:1px;height:1px;visibility:hidden;';
  anchor.style.setProperty('anchor-name', name);
  const host = document.createElement('div');
  host.style.cssText =
    `position:absolute;top:anchor(top);left:anchor(left);position-anchor:${name};width:1px;height:1px;visibility:hidden;`;
  document.body.appendChild(anchor);
  document.body.appendChild(host);
  const a = anchor.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  anchor.remove();
  host.remove();
  _anchorAcrossFixed = Math.abs(a.top - h.top) < 2 && Math.abs(a.left - h.left) < 2;
  return _anchorAcrossFixed;
}

// Walk ancestors (piercing shadow boundaries) for a `position:fixed` element.
export function hasFixedAncestor(target: Element): boolean {
  let node: Element | null = target;
  while (node) {
    if (node instanceof HTMLElement && getCachedStyle(node).position === 'fixed') return true;
    const parent: Element | null = node.parentElement;
    if (parent) {
      node = parent;
    } else {
      const root = node.getRootNode();
      node = root instanceof ShadowRoot ? (root.host as Element) : null;
    }
  }
  return false;
}

// Express placement's absolute viewport decision as a scroll-invariant offset
// from the target's element rect, baked into the host's anchor() calc. The
// compositor then carries the badge through scroll.
export function anchorOffsetCss(
  candidate: { x: number; y: number },
  elRect: { left: number; top: number },
): { left: string; top: string } {
  const offX = Math.round(candidate.x - elRect.left);
  const offY = Math.round(candidate.y - elRect.top);
  return { left: `calc(anchor(left) + ${offX}px)`, top: `calc(anchor(top) + ${offY}px)` };
}

// Test hook: pin anchor support on/off (or null to re-detect). happy-dom's
// CSS.supports returns true for everything, so tests must set the mode they
// intend rather than relying on detection.
export const __testing = {
  setAnchorSupport(v: boolean | null): void { _anchorSupport = v; _anchorAcrossFixed = null; },
  setAnchorAcrossFixed(v: boolean | null): void { _anchorAcrossFixed = v; },
};

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

/**
 * Nearest scrollable ancestor of `target`, or null if the only scroller is
 * the document (window scroll, handled separately in content.ts). Used to
 * register the badge with the scroll-ancestor tracker so inner-pane scroll
 * keeps TargetRectStore warm. Reads layout via the warm cache — call only
 * inside a cacheLayout window (badge construction / retarget run there).
 */
export function findScrollAncestor(target: Element): HTMLElement | null {
  let current: Element | null = target.parentElement;
  while (current && current !== document.body && current !== document.documentElement) {
    if (current instanceof HTMLElement && isScrollContainer(current)) return current;
    current = current.parentElement;
  }
  return null;
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
  // Nearest scrollable ancestor on the nesting path, registered with the
  // scroll-ancestor tracker so inner-pane scroll keeps TargetRectStore warm.
  // Null on the anchor path (compositor-tracked, store not read for it) and
  // when the only scroller is the document.
  private scrollAncestor: HTMLElement | null = null;
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

  // CSS Anchor Positioning fast-path. When `anchorMode` is true the host is
  // body-mounted and pinned to the target via `anchorName`; scroll-tracking
  // is handled by the compositor, so reposition() is a no-op. Disabled per
  // target when the engine can't resolve anchor() across a fixed ancestor
  // (Firefox) — those fall back to the nesting path. Set in the constructor.
  private readonly anchorMode: boolean;
  private anchorName: string | null = null;

  // Scroll-tracking trim (nesting path). A badge nested in its target's
  // scroll context translates with the target via the compositor, so the
  // window-scroll reposition is redundant for it. needsScrollReposition()
  // detects the badges that DO need a JS reposition on scroll: those whose
  // placement is clamped by a sticky/fixed ancestor (clamp point is
  // viewport-fixed, so it engages/disengages as the target scrolls past it),
  // and those whose host drifted relative to the target (scroll-context
  // mismatch). `scrollSensitive` is set by the placement strategy when it
  // resolves a sticky bound; the *Vp fields snapshot the last placement so
  // drift can be measured as a delta-of-deltas.
  public scrollSensitive: boolean = false;
  // Set by the placement strategy when the resolved offset actually rode
  // ancestor geometry (available-space clamp bit, or a sticky/fixed bound
  // applied). Such a badge must be re-placed on the 'all' layout sweep even on
  // the anchor path, because a resize can move that ancestor geometry. When
  // false, the offset is purely target-relative and the compositor carries it.
  public geometryDependent: boolean = false;
  private _lastTargetVp: { x: number; y: number } | null = null;
  private _lastOuterVp: { x: number; y: number } | null = null;
  private static readonly DRIFT_EPS = 0.5;

  constructor(target: Element, label: LabelAssignment, category: Category, displayMode: BadgeDisplayMode) {
    this.target = target;
    this.category = category;
    this.label = label;
    this.displayMode = displayMode;
    this.fontSize = computeBadgeFontSize(target);
    this.anchorMode = supportsAnchorPositioning()
      && (anchorResolvesAcrossFixed() || !hasFixedAncestor(target));

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

    if (this.anchorMode) {
      // Pin the host to the target via CSS Anchor Positioning. anchorParent
      // is still resolved (placement reads it for space/sticky clamping) but
      // the host is mounted at body, not nested in the container.
      this.anchorName = `--bk-${_nextAnchorId++}`;
      // One-time page-DOM write, BEFORE trackTargetMutations starts so it
      // isn't seen as a foreign mutation. The per-placement offset lives on
      // our own host, so the target is never mutated again until remove().
      (this.target as HTMLElement).style?.setProperty?.('anchor-name', this.anchorName);
      this.anchorParent = resolveContainer(target);
      this.setupAnchorHost();
    } else {
      const ctx = resolveBadgeContext(target, this.host, this.outer);
      this.anchorParent = ctx.container;
      if (ctx.positionMode === 'relative') {
        this.outer.style.position = 'relative';
        this.outer.style.display = 'inline';
      }
    }

    trackContainerResize(this.anchorParent);
    if (!this.anchorMode) {
      this.scrollAncestor = findScrollAncestor(this.target);
      if (this.scrollAncestor) trackScrollAncestor(this.scrollAncestor, this.target);
    }
    trackTargetMutations(this.target);
    // Start the host-attribute defender AFTER all setup is done — the
    // observer fires on real mutations only, but starting it earlier
    // would treat our own setAttribute/style writes as page tampering.
    // Anchor hosts need a real box (position:absolute → display block);
    // nesting hosts stay display:contents.
    trackHostAttributes(this.host, this.anchorMode ? 'block' : 'contents');
  }

  // Body-mount the host and pin it to the target via anchor(). outer/inner
  // sit at the host's origin; updatePosition writes the placement offset into
  // the host's anchor() calc. Idempotent enough to reuse from reattach.
  private setupAnchorHost(): void {
    this.host.style.cssText =
      `display:block;position:absolute;top:anchor(top);left:anchor(left);` +
      `position-anchor:${this.anchorName};width:0;height:0;pointer-events:none;`;
    this.outer.style.position = 'absolute';
    this.outer.style.top = '0';
    this.outer.style.left = '0';
    document.body.appendChild(this.host);
  }

  updatePosition(candidate?: { x: number; y: number }, caller?: string): void {
    if (this.anchorMode) {
      // Express placement's absolute decision as a scroll-invariant offset
      // from the target's element rect and bake it into the host's anchor()
      // calc. The compositor then carries the badge through scroll. A
      // candidate-less call is the reposition path — a no-op here.
      if (!candidate) return;
      const css = anchorOffsetCss(candidate, getCachedRect(this.target));
      this.host.style.left = css.left;
      this.host.style.top = css.top;
      return;
    }

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

    // Snapshot target + outer viewport origin so a later scroll can decide,
    // via delta-of-deltas, whether the badge tracked the target on its own.
    const tRect = getCachedRect(this.target);
    this._lastTargetVp = { x: tRect.left, y: tRect.top };
    this._lastOuterVp = { x: outerRect.left, y: outerRect.top };

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
    if (this.anchorMode) {
      this.setupAnchorHost();
      return;
    }
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
    if (this.scrollAncestor) {
      untrackScrollAncestor(this.scrollAncestor, this.target);
      this.scrollAncestor = null;
    }
    untrackTargetMutations(this.target);

    if (this.anchorMode) {
      // Move the anchor name from the old target to the new one (reuse the
      // same name so the host's position-anchor stays valid). Set it before
      // trackTargetMutations so it isn't seen as a foreign mutation.
      (this.target as HTMLElement).style?.removeProperty?.('anchor-name');
      this.target = newEl;
      if (this.anchorName) (newEl as HTMLElement).style?.setProperty?.('anchor-name', this.anchorName);
      this.anchorParent = resolveContainer(newEl);
    } else {
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
    }

    trackContainerResize(this.anchorParent);
    if (!this.anchorMode) {
      this.scrollAncestor = findScrollAncestor(this.target);
      if (this.scrollAncestor) trackScrollAncestor(this.scrollAncestor, this.target);
    }
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
    // Anchor-mode badges follow their target via the compositor; a
    // candidate-less reposition would have no offset to apply (and
    // updatePosition guards against it anyway).
    if (this.anchorMode) return;
    if (this._visible) {
      this.updatePosition();
    }
  }

  // Does this badge need a JS reposition on a window scroll? For the nesting
  // path the host rides the scroll-ancestor compositor, so the common badge
  // tracks its target for free. Returns true only for badges the compositor
  // can't keep correct on its own:
  //  - anchor mode never needs it (compositor + anchor()), always false;
  //  - sticky/fixed-clamped badges: the clamp point is viewport-fixed, so it
  //    must be recomputed as the target scrolls relative to it;
  //  - drifted badges: the outer moved by a different delta than the target
  //    since the last placement (scroll-context mismatch).
  needsScrollReposition(): boolean {
    if (this.anchorMode || !this._visible) return false;
    if (this.scrollSensitive) return true;
    if (!this._lastTargetVp || !this._lastOuterVp) return true;
    const t = getCachedRect(this.target);
    const o = this.outer.getBoundingClientRect();
    const driftX = (t.left - this._lastTargetVp.x) - (o.left - this._lastOuterVp.x);
    const driftY = (t.top - this._lastTargetVp.y) - (o.top - this._lastOuterVp.y);
    return Math.abs(driftX) > HintBadge.DRIFT_EPS || Math.abs(driftY) > HintBadge.DRIFT_EPS;
  }

  // Does this badge need a JS re-place on an 'all' layout sweep (resize,
  // huge-mutation settle)? The nesting path always does — its host position is
  // computed in JS. The anchor path normally does not: the compositor carries a
  // target-relative offset through layout changes for free. The exception is a
  // badge whose offset rode ancestor geometry (clamped to a clip ancestor's
  // available space, or pinned to a sticky/fixed bound) — a resize can move
  // that geometry, so it must be recomputed.
  needsLayoutReposition(): boolean {
    if (!this.anchorMode || !this._visible) return true;
    return this.geometryDependent;
  }

  remove(): void {
    untrackContainerResize(this.anchorParent);
    if (this.scrollAncestor) {
      untrackScrollAncestor(this.scrollAncestor, this.target);
      this.scrollAncestor = null;
    }
    untrackTargetMutations(this.target);
    untrackHostAttributes(this.host);
    if (this.anchorMode) {
      // Untrack the target mutation observer first (above) so clearing our
      // anchor-name write isn't observed as a foreign mutation.
      (this.target as HTMLElement).style?.removeProperty?.('anchor-name');
    }
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

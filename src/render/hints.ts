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
import { type BadgeSettings, DEFAULT_BADGE_SETTINGS } from '../badge-settings-storage';
import { leaderLineGeometry } from '../placement/geometry';
import { trackContainerResize, untrackContainerResize } from '../observe/container-resize-tracker';
import { trackTargetMutations, untrackTargetMutations } from '../observe/target-mutation-tracker';
import { trackHostAttributes, untrackHostAttributes } from '../observe/host-attribute-tracker';
import { register as registerReconcile, unregister as unregisterReconcile, type ReconcileWrite } from './reconcile-positioner';
import {
  type ScrollAccel,
  createScrollAccel,
  recomputeScrollAccel,
  teardownScrollAccel,
  scrollAccelHealthy,
} from './scroll-accel';

// Walk ancestors (piercing shadow boundaries) for a position:fixed or sticky
// element. Such a target holds a constant viewport position as the window
// scrolls, so its badge host must be viewport-anchored (position:fixed + viewport
// coords) — a document-anchored host would ride the page scroll away from the
// pinned target (the YouTube left-rail drift). Uses the warm style cache;
// evaluated once at construction / retarget.
function hasViewportPinnedAncestor(target: Element): boolean {
  let node: Element | null = target;
  while (node) {
    if (node instanceof HTMLElement) {
      const pos = getCachedStyle(node).position;
      if (pos === 'fixed' || pos === 'sticky') return true;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      node = parent;
    } else {
      const r = node.getRootNode();
      node = r instanceof ShadowRoot ? (r.host as Element) : null;
    }
  }
  return false;
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

const BADGE_OFFSET = 24;

// --- Refinement scheduler (phase 3 of the two-pass paint plan) ---
//
// Newly-constructed HintBadges enqueue themselves here; the scheduler runs
// `badge.refine()` on idle time. Refinement is the page-mutation-defense
// half of badge setup — 4 observer registrations (~2-4 ms per badge) —
// work that doesn't change what's painted this frame but catches page
// scripts that strip our DOM or layout shifts that move our anchor.
//
// APCA color computation stays in the synchronous show() path because
// Rango paints with accurate colors from the first frame and deferring
// them introduces a visible flash from default-palette → APCA colors.
// The observer dance has no visible effect at first paint, so deferring
// it is invisible while still saving the majority of per-badge CPU.
//
// Budget per pass: ~4 ms of CPU before yielding. `requestIdleCallback`
// supplies its own deadline; the setTimeout fallback (Firefox-historic and
// jsdom) uses a wall-clock budget of the same magnitude.

const pendingRefine = new Set<HintBadge>();
let refineScheduled = false;
const REFINE_BUDGET_MS = 4;

/** Sync-mode flag for tests: when true, the constructor calls `refine()`
 *  inline instead of enqueueing. Tests assert observer state immediately
 *  after construction, which is incompatible with deferred refinement.
 *  Off in production. */
let refineImmediately = false;

function scheduleRefine(badge: HintBadge): void {
  pendingRefine.add(badge);
  if (refineScheduled) return;
  refineScheduled = true;
  scheduleRefineDrain();
}

function unscheduleRefine(badge: HintBadge): void {
  pendingRefine.delete(badge);
}

function scheduleRefineDrain(): void {
  const ric = (globalThis as { requestIdleCallback?: (cb: (d: IdleDeadline) => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) {
    ric((deadline) => drainPendingRefines(deadline), { timeout: 200 });
  } else {
    setTimeout(() => drainPendingRefines(), 16);
  }
}

function drainPendingRefines(deadline?: IdleDeadline): void {
  refineScheduled = false;
  const start = performance.now();
  for (const badge of pendingRefine) {
    pendingRefine.delete(badge);
    badge.refine();
    const remaining = deadline?.timeRemaining?.()
      ?? Math.max(0, REFINE_BUDGET_MS - (performance.now() - start));
    if (remaining <= 0.5) break;
  }
  if (pendingRefine.size > 0) {
    refineScheduled = true;
    scheduleRefineDrain();
  }
}

export const __refineScheduler = {
  /** Force-sync mode for unit tests. Existing pending entries are drained
   *  immediately. Subsequent constructions call refine() inline until
   *  cleared. */
  setImmediate(enabled: boolean): void {
    refineImmediately = enabled;
    if (enabled && pendingRefine.size > 0) {
      // Drain anything already queued so tests see a refined state.
      for (const badge of pendingRefine) {
        pendingRefine.delete(badge);
        badge.refine();
      }
    }
  },
  /** Test helper: synchronously drain the queue (for tests that want to
   *  exercise the deferred path without a fake clock). */
  drainNow(): void {
    for (const badge of pendingRefine) {
      pendingRefine.delete(badge);
      badge.refine();
    }
  },
  pendingCount(): number {
    return pendingRefine.size;
  },
};

// Live badge sizing state — initialized from DEFAULT_BADGE_SETTINGS and
// overwritten by the content-script bootstrap once storage has been read.
// Constants are mutable refs (not literals) so settings changes propagate
// without re-importing or re-wiring callers.
let badgeFontScale = DEFAULT_BADGE_SETTINGS.scale;
let badgeFontMin = DEFAULT_BADGE_SETTINGS.fontMin;
let badgeFontMax = DEFAULT_BADGE_SETTINGS.fontMax;

export function setBadgeSizingFromSettings(s: BadgeSettings): void {
  badgeFontScale = s.scale;
  badgeFontMin = s.fontMin;
  badgeFontMax = s.fontMax;
}

// Inner-scroll accelerator gate (notes/DESIGN_INNER_SCROLL_ACCELERATOR.md).
// Production default is ON, set at content-script init from the `bkScrollAccel`
// flag (only an explicit `false` disables it). This module ref initializes false
// as a pre-read safety value — off until that init read confirms — so a badge
// built before the storage read doesn't arm prematurely; it re-arms on its next
// show()/updatePosition once the flag resolves. A mutable ref so the flag
// propagates without re-wiring callers.
let scrollAccelEnabled = false;

export function setScrollAccelEnabled(enabled: boolean): void {
  scrollAccelEnabled = enabled;
}

function computeBadgeFontSize(target: Element): number {
  // Targets with font-size: 0 (the common a11y-text-hiding trick on
  // role=checkbox / role=button divs) would otherwise yield a 0px or
  // tiny badge — `0 || 12` would fall back to 12 but only when targetSize
  // is exactly 0. Floor at the configured min so any sub-readable value
  // (parsing oddities, 0px declarations, vw/em below floor) lifts up.
  const targetSize = parseFloat(getCachedStyle(target).fontSize) || 12;
  const scaled = Math.round(targetSize * badgeFontScale);
  return Math.min(Math.max(scaled, badgeFontMin), badgeFontMax);
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
  private shadow: ShadowRoot;
  private outer: HTMLDivElement;
  private inner: HTMLDivElement;
  private leaderLine: HTMLDivElement | null = null;
  private target: Element;
  private category: Category;
  private _visible: boolean = false;
  private _size: { w: number; h: number } | null = null;
  // Has the deferrable refinement (observer registration, etc.) run yet?
  // Production: false until the rIC-scheduled drain runs `refine()`.
  // Tests: refineImmediately makes the constructor call refine() inline
  // so observer state is asserted right after `new HintBadge(...)`.
  private _refined: boolean = false;
  // Has remove() been called? Refinement on a removed badge would register
  // observers on a torn-down host — wasted work and a memory leak. The
  // scheduler can't atomically pull a badge out of its pending set during
  // a synchronous remove() call, so refine() guards on this flag instead.
  private _removed: boolean = false;

  // Nullable: set by the constructor (a HintBadge always starts with a label),
  // optionally cleared by `clearLabel()` when the wrapper exits the viewport
  // and we keep the badge alive for reuse on scroll-back. While null the badge
  // is dormant — `setMatchedChars` short-circuits, the inner text is empty,
  // and `hide()` has been called.
  private label: LabelAssignment | null;
  private displayMode: BadgeDisplayMode;
  private fontSize: number;

  // CSS Anchor Positioning fast-path. When `anchorMode` is true the host is
  // body-mounted and pinned to the target via `anchorName`; scroll-tracking
  // is handled by the compositor, so reposition() is a no-op. Disabled per
  // target when the engine can't resolve anchor() across a fixed ancestor
  // (Firefox) — those fall back to the nesting path. Set in the constructor.
  public readonly anchorMode: boolean;
  private anchorName: string | null = null;

  // Option 3 (notes/completed/DESIGN_HINT_POSITIONING_REARCH.md). Mutually exclusive with
  // anchorMode: when true the host is body-mounted (position:absolute, document-
  // anchored so it rides window scroll on the compositor) and the batched JS
  // reconciler writes its transform from the live target rect + page scroll +
  // this baked offset (candidate minus target top-left), instead of CSS anchor()
  // or the nesting path. Set in the constructor from the bkJsPosition flag.
  public readonly reconcileMode: boolean;
  private _reconcileOffset: { x: number; y: number } | null = null;
  // True when the target is viewport-pinned (fixed/sticky ancestor): the host is
  // position:fixed + viewport coords instead of position:absolute + doc coords.
  private _viewportFixed = false;

  // Inner-scroll accelerator (notes/DESIGN_INNER_SCROLL_ACCELERATOR.md). Non-null
  // only when armed: flag on, ScrollTimeline supported, and the target sits inside
  // an inner overflow scroller — which holds even when that scroller is itself
  // inside a fixed/sticky app-shell pane (the host's window-scroll anchoring and
  // the inner-scroll delta are orthogonal). When armed, the reconcile base writes
  // the scroll-0 docY0 (scroll-invariant under inner scroll) and the compositor
  // animation on `outer` supplies translateY(-scrollTop). When it dies (scroller
  // recreated/detached) the badge falls back to the chase — the accel is
  // non-load-bearing; the chase base is always correct.
  private _scrollAccel: ScrollAccel | null = null;

  // Placement outputs, surfaced in diagnostics: scrollSensitive = the offset
  // rode a sticky/fixed bound; geometryDependent = it rode ancestor geometry
  // (clamp or sticky bound). Set by the placement strategy.
  public scrollSensitive: boolean = false;
  public geometryDependent: boolean = false;
  // Diagnostic-only: inputs of the last bake (candidate/target), surfaced in a
  // snapshot to compare against the live target rect.
  private _lastBake: { candidateY: number; targetTop: number } | null = null;

  constructor(target: Element, label: LabelAssignment, category: Category, displayMode: BadgeDisplayMode) {
    this.target = target;
    this.category = category;
    this.label = label;
    this.displayMode = displayMode;
    this.fontSize = computeBadgeFontSize(target);
    this.reconcileMode = true;
    this.anchorMode = false;

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
      }
      .bk-inner.visible {
        opacity: 1;
        transition: opacity 0.12s ease-out;
      }
      /* Voice-pending: badge is painted but the native plugin hasn't yet
       * acknowledged its codeword in the grammar. The translucent state
       * communicates "visible, identifiable, but voice may not match this
       * yet" — the keyboard layer can still operate on it. Removed when
       * the grammar push ACK arrives via wrapper.grammarReady → markGrammarReady.
       */
      .bk-inner.visible.bk-pending {
        opacity: 0.55;
      }
      .bk-inner.filtered {
        display: none;
      }
      /* Occlusion: the target is covered by another element (hit-test), so the
       * badge would float on top of whatever hides it. Hidden entirely —
       * orthogonal to .filtered (text-match) and the .visible opacity gate. */
      .bk-inner.bk-occluded {
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

    // Body-mount the host; the JS reconciler follows the target. No page-DOM
    // write (no anchor-name) — nothing for the page's inline-style rewrites to
    // strip. anchorParent is still resolved for container-resize tracking.
    // Viewport-pinned (fixed/sticky) targets get a viewport-anchored host so it
    // doesn't ride the page scroll away from them; flow targets get a
    // document-anchored host that rides the scroll with them.
    this._viewportFixed = hasViewportPinnedAncestor(target);
    this.anchorParent = resolveContainer(target);
    this.setupReconcileHost();
    registerReconcile(this);

    // Defer the heavy half of setup (4 observer registrations + APCA color
    // computation, ~5-10 ms total) onto idle time via the module-level
    // scheduler. The badge paints immediately with default colors and
    // generic placement; refine() upgrades it within a few frames. Tests
    // can flip `refineImmediately` to force sync behavior so they can
    // assert observer state right after construction.
    if (refineImmediately) this.refine();
    else scheduleRefine(this);
  }

  /**
   * The deferrable half of badge setup — work that doesn't affect the
   * first visible paint but is needed for ongoing correctness:
   *
   *   - container-resize observer: detects layout shifts not driven by
   *     scroll/resize (animated dropdowns, sibling expansion, :focus-within).
   *   - scroll-ancestor observer (nesting path only): keeps TargetRectStore
   *     warm for inner-pane scroll so anchor offsets stay accurate.
   *   - target mutation observer: catches the page mutating the target's
   *     class/style/aria-label so the wrapper's hintability can be re-checked.
   *   - host attribute defender: restores attributes/styles the page tries
   *     to strip from our shadow host.
   *
   * Idempotent — calling `refine()` twice is a no-op for the second call.
   * Today it's called inline at the end of the constructor (preserving
   * current behavior). A future phase will defer this to idle time.
   */
  refine(): void {
    if (this._refined || this._removed) return;
    this._refined = true;
    trackContainerResize(this.anchorParent);
    trackTargetMutations(this.target);
    // Start the host-attribute defender AFTER all setup is done — the
    // observer fires on real mutations only, but starting it earlier
    // would treat our own setAttribute/style writes as page tampering.
    // Anchor/reconcile hosts need a real box (position → display block);
    // nesting hosts stay display:contents.
    trackHostAttributes(this.host, 'block');
    // Colors are NOT touched here — they were already applied accurately
    // (APCA) at show() time. Refinement is observer-only now.
  }

  // Option 3. Body-mount a 0x0 box and write `transform: translate(x, y)` from
  // the live target rect each pass. Anchoring is chosen per target:
  //   - flow targets: position:absolute + DOCUMENT coords (rect + page scroll),
  //     so the host rides window scroll on the compositor in lockstep — no chase.
  //   - viewport-pinned targets (fixed/sticky ancestor): position:fixed +
  //     VIEWPORT coords (rect only), so the host stays put with the pinned target.
  // Either is scroll-invariant for its target, so no per-frame chase / no wiggle.
  // No anchor-name — nothing for the page's inline-style rewrites to strip.
  private setupReconcileHost(): void {
    const position = this._viewportFixed ? 'fixed' : 'absolute';
    this.host.style.cssText =
      `display:block;position:${position};top:0;left:0;width:0;height:0;pointer-events:none;`;
    this.outer.style.position = 'absolute';
    this.outer.style.top = '0';
    this.outer.style.left = '0';
    document.body.appendChild(this.host);
  }

  // Read half for the batched reconciler: compute the host's desired viewport
  // coords from the live target rect + baked offset WITHOUT writing, so the
  // reconciler can batch all reads before any composited writes. Null when the
  // badge shouldn't be placed this pass (hidden / disconnected / not yet baked).
  reconcileRead(): ReconcileWrite | null {
    if (!this._reconcileOffset || !this._visible || !this.target.isConnected) return null;
    const r = this.target.getBoundingClientRect();
    // Coords match the host's anchoring (see setupReconcileHost): document coords
    // (rect + page scroll) for a flow target so it rides window scroll; viewport
    // coords (rect only) for a viewport-pinned target so it stays with it. Both
    // are scroll-invariant for their target, so no per-frame chase / no wiggle.
    const sx = this._viewportFixed ? 0 : window.scrollX;
    const sy = this._viewportFixed ? 0 : window.scrollY;
    let y = r.top + sy + this._reconcileOffset.y;
    // Inner-scroll accelerator, evaluated every pass (level-triggered).
    if (this._scrollAccel) {
      if (scrollAccelHealthy(this._scrollAccel, this.target)) {
        // Healthy: write the scroll-0 base docY0 = rect.top + scrollY + offset +
        // scrollTop. As the pane scrolls, rect.top drops by ΔS while scrollTop
        // rises by ΔS, so docY0 is constant (scroll-invariant under inner scroll);
        // the compositor animation on `outer` supplies translateY(-scrollTop), so
        // the net is the live position with no main-thread chase. Refresh the
        // keyframe if the scroller's max changed (rare; reflow only).
        recomputeScrollAccel(this._scrollAccel, this.outer);
        y += this._scrollAccel.scroller.scrollTop;
      } else {
        // Broken (scroller recreated/detached): drop the accel so `outer`'s
        // animated delta reverts to 0 and the chase base (current position) is
        // correct — wiggly, but never a dangle. Re-detected on the next arm
        // (settle/show). This is the graceful-degradation contract.
        this.disarmScrollAccel();
      }
    }
    return {
      host: this.host,
      x: Math.round(r.left + sx + this._reconcileOffset.x),
      y: Math.round(y),
    };
  }

  // Arm the inner-scroll accelerator if eligible. Idempotent — a no-op when the
  // flag is off, an accel is already armed, or `createScrollAccel` finds no inner
  // scroller / ScrollTimeline support. The presence of an inner scroller (via
  // `findScrollableAncestor`) is the SOLE gate; a viewport-pinned host
  // (`_viewportFixed`) is NOT excluded, because the host's window-scroll
  // anchoring (absolute vs fixed) and the inner-scroll delta (the `outer`
  // animation) are orthogonal and compose correctly — an app-shell pane is
  // position:fixed yet still scrolls its content internally. A truly pinned
  // target with no inner scroller returns null here and arms nothing, so the
  // dropped exclusion only newly covers fixed/sticky panes that DO inner-scroll.
  // Called from `updatePosition` (offset baked) and `show`.
  private armScrollAccel(): void {
    if (!scrollAccelEnabled || this._scrollAccel) return;
    this._scrollAccel = createScrollAccel(this.target, this.outer);
    // Diagnostic mirror on the light-DOM host: a badge that found an inner
    // scroller and armed carries `data-bk-accel="<max>"`, so the accelerated set
    // is countable from the page console
    // (`document.querySelectorAll('[data-bk-accel]').length`) without peeking
    // into the closed shadow root. Allowed by the host-attribute tracker.
    if (this._scrollAccel) {
      this.host.setAttribute('data-bk-accel', String(this._scrollAccel.max));
    }
  }

  // Tear down the accelerator (cancel the compositor animation, drop the
  // reference). Safe to call when none is armed. The chase base alone is correct
  // afterward.
  private disarmScrollAccel(): void {
    if (!this._scrollAccel) return;
    teardownScrollAccel(this._scrollAccel);
    this._scrollAccel = null;
    this.host.removeAttribute('data-bk-accel');
  }

  // Write the host's transform NOW from the live target rect, instead of waiting
  // for the next reconcile pass. Critical right after arm/disarm: the accelerator
  // couples two transforms — the host base (`docY0`, with `+scrollTop`) and the
  // `outer` animation (`-scrollTop`). They must flip together. If `outer` gains
  // the `-scrollTop` animation while the host still holds the non-accelerated
  // base (no `+scrollTop`), the badge jumps up by `scrollTop` and renders
  // off-screen until a scroll triggers a reconcile. No-op when not yet
  // placed/visible (`reconcileRead` returns null).
  private repositionHostNow(): void {
    const w = this.reconcileRead();
    if (w) this.host.style.transform = `translate(${w.x}px,${w.y}px)`;
  }

  updatePosition(candidate?: { x: number; y: number }, _caller?: string): void {
    // Bake the placement offset (candidate relative to the target's top-left);
    // the reconciler applies it against the live target rect each pass. A
    // candidate-less call is the reposition path — the reconciler owns it.
    if (!candidate) return;
    const tr = getCachedRect(this.target);
    this._reconcileOffset = { x: candidate.x - tr.left, y: candidate.y - tr.top };
    // Offset is baked — arm the inner-scroll accelerator (no-op when the flag is
    // off or the target has no inner scroller). Must precede the paint so it uses
    // the accelerated (docY0) base when armed, consistent with `outer`'s -scrollTop.
    this.armScrollAccel();
    // Paint at the right spot immediately (if already visible) so it doesn't
    // wait a frame for the next reconcile tick.
    this.repositionHostNow();
  }

  reattach(): void {
    // Body-mount again; the reconciler re-applies the transform next tick.
    this.setupReconcileHost();
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
    // The accelerator is bound to the OLD target's scroller; drop it before the
    // swap and re-detect for the new node below.
    this.disarmScrollAccel();

    // No page-DOM binding to move (no anchor-name); just swap the tracked
    // target. The baked offset is target-relative, so it stays valid for a
    // same-fingerprint replacement; the reconciler follows the new target on
    // its next pass.
    this.target = newEl;
    this.anchorParent = resolveContainer(newEl);
    // Re-evaluate viewport-pinning for the new target; flip the host's anchoring
    // mode if it changed (e.g. rebind from a flow node to a fixed one).
    const wasViewportFixed = this._viewportFixed;
    this._viewportFixed = hasViewportPinnedAncestor(newEl);
    if (this._viewportFixed !== wasViewportFixed) {
      this.host.style.position = this._viewportFixed ? 'fixed' : 'absolute';
    }

    trackContainerResize(this.anchorParent);
    trackTargetMutations(this.target);
    // host-attribute tracker is keyed on the host (unchanged); no swap.
    // Re-detect the accelerator for the new node (no-op when flag off / no
    // inner scroller). Disarm above + this re-arm flip `outer`'s animation, so
    // the host base must be repainted in lockstep (below).
    this.armScrollAccel();

    // retarget wires observers up itself, so the deferred refine() pass is
    // no longer needed. Mark refined and pull off the pending queue.
    if (!this._refined) {
      this._refined = true;
      unscheduleRefine(this);
    }

    // Paint the new target's host now (flag on only), keeping the base
    // consistent with the (re-armed or cleared) accelerator animation — the
    // old-target disarm + new-target re-arm flip `outer`'s -scrollTop, so the
    // base must move in lockstep. Flag off keeps today's behavior: `reposition()`
    // is a no-op and the next reconcile pass moves the host to the new target.
    if (scrollAccelEnabled) this.repositionHostNow();
    else this.reposition();
  }

  /**
   * Show the badge.
   *
   * @param grammarReady — does the codeword already have a confirmed
   *   place in the native plugin's voice grammar? If false (typical
   *   first-paint case), the badge paints translucent (`bk-pending`
   *   class) so the user can tell the visual is there but voice isn't
   *   ready yet. When `markGrammarReady()` is called later (from the
   *   grammar push ACK), the class is removed and the badge transitions
   *   to full opacity. If true (rare race where ACK landed before the
   *   first show — or alphabet-stable post-rotate path), paint opaque.
   */
  show(grammarReady = false): void {
    if (this._visible) return;
    this._visible = true;
    this.inner.classList.remove('filtered');
    this.applyColors();
    this._size = null;
    // Arm the accelerator on show too (idempotent): a badge reused via the
    // scroll-back fast path (clearLabel→hide→show+setLabel) was disarmed in
    // hide() and needs re-detection now that it's visible again. Repaint right
    // after (flag on only): arming adds `outer`'s -scrollTop, so the host base
    // must adopt the +scrollTop (docY0) in the same frame or the badge renders
    // off-screen (the host here may still hold a non-accelerated base from a
    // prior render). Gated on the flag so flag-off `show()` is unchanged — today
    // it does not touch the host transform here.
    this.armScrollAccel();
    if (scrollAccelEnabled) this.repositionHostNow();
    if (!grammarReady) {
      this.inner.classList.add('bk-pending');
      this.host.setAttribute('data-bk-pending', 'true');
    }
    requestAnimationFrame(() => {
      this.inner.classList.add('visible');
      // Mirror the visibility state onto the light-DOM host so tools that
      // can't peek into the closed shadow root (Playwright tests, dev-tool
      // selectors) can query `[data-bk-shown]`. Allowed by the host-
      // attribute tracker's reconcile.
      this.host.setAttribute('data-bk-shown', 'true');
    });
  }

  /** Clear the `bk-pending` class on the inner. Called from content.ts
   *  when the grammar push ACK for this wrapper's codeword lands —
   *  signalling that voice will now match it. Idempotent. */
  markGrammarReady(): void {
    this.inner.classList.remove('bk-pending');
    this.host.removeAttribute('data-bk-pending');
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

  /** APCA-accurate page-aware colors. Walks the target's ancestors to
   *  resolve the effective background, then tunes foreground contrast.
   *  ~1-2 ms per badge. Runs synchronously in show() because deferring it
   *  produced a visible flash from default colors to the accurate ones
   *  (see DESIGN_HINT_REUSE.md / phase 3 of the two-pass paint refactor).
   *  Rango does the same — synchronous APCA at construction, no flash. */
  private applyColors(): void {
    const colors = computeBadgeColors(this.target);
    this.inner.style.background = colors.bg;
    this.inner.style.color = colors.fg;
    this.inner.style.borderColor = colors.border;
  }

  hide(): void {
    this._visible = false;
    this.inner.classList.remove('visible');
    this.inner.classList.remove('bk-pending');
    this.host.removeAttribute('data-bk-shown');
    this.host.removeAttribute('data-bk-pending');
    // Drop the accelerator while dormant; a hidden badge isn't reconciled, so a
    // live ScrollTimeline animation would just hold a stale delta. Re-armed on
    // the next show().
    this.disarmScrollAccel();
  }

  setFiltered(filtered: boolean): void {
    if (filtered) {
      this.inner.classList.add('filtered');
    } else {
      this.inner.classList.remove('filtered');
    }
  }

  // Visually hide a badge whose target is covered by another element (the
  // occlusion hit-test, notes/DESIGN_HINT_OCCLUSION_FILTERING.md). Distinct from
  // hide()/_visible (the badge stays "shown" in the visibility-tracker's sense,
  // so it un-hides the instant the cover moves) and from setFiltered (text-match
  // filtering). Mirrors the occluded state onto the light-DOM host as
  // data-bk-occluded for diagnostics. Idempotent.
  setOccluded(occluded: boolean): void {
    if (occluded) {
      this.inner.classList.add('bk-occluded');
      this.host.setAttribute('data-bk-occluded', 'true');
    } else {
      this.inner.classList.remove('bk-occluded');
      this.host.removeAttribute('data-bk-occluded');
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

  /**
   * Update the displayed label without changing display mode. Used by the
   * scroll-back fast path: when a wrapper re-enters the viewport and the
   * codeword pool grants a (possibly-different) codeword, swap the text
   * without recreating the badge. Cheap — one `textContent` write + size
   * cache invalidation. The shadow DOM, observers, anchorParent, colors,
   * and z-index all persist from the prior visibility cycle.
   *
   * Pair with `clearLabel()` on viewport exit; both keep the badge object
   * alive so the next show()+setLabel() avoids the full construction cost.
   */
  setLabel(label: LabelAssignment): void {
    this.label = label;
    this.inner.textContent = labelToDisplay(label, this.displayMode);
    this._size = null;
  }

  /**
   * Drop the current label without tearing down the badge. Pair with
   * `hide()` at viewport exit when we want to keep the DOM + observers
   * around for a likely scroll-back. Doesn't touch the host's DOM
   * connection or observer subscriptions — those persist for the next
   * `show() + setLabel()`. Idempotent.
   */
  clearLabel(): void {
    this.label = null;
    this.inner.textContent = '';
  }

  setMatchedChars(count: number): void {
    // Dormant (cleared) badge — caller may have raced with viewport exit.
    // Nothing to highlight; the next show()+setLabel() resets text content.
    if (!this.label) return;

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
    // Reconcile badges follow their target via the JS reconciler; a
    // candidate-less reposition has no offset to apply, so it's a no-op.
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
    // Reconcile follows the target via the rAF reconciler — no JS scroll reposition.
    return false;
  }

  // Does this badge need a JS re-place on an 'all' layout sweep (resize,
  // huge-mutation settle)? The nesting path always does — its host position is
  // computed in JS. The anchor path normally does not: the compositor carries a
  // target-relative offset through layout changes for free. The exception is a
  // badge whose offset rode ancestor geometry (clamped to a clip ancestor's
  // available space, or pinned to a sticky/fixed bound) — a resize can move
  // that geometry, so it must be recomputed.
  needsLayoutReposition(): boolean {
    // Reconcile re-reads the target rect every pass — no layout-sweep reposition.
    return false;
  }

  remove(): void {
    this._removed = true;
    unscheduleRefine(this);
    // Untracks are no-ops when the corresponding track* was never called
    // (refine() may not have run yet), so it's safe to call them
    // unconditionally — they just clean up whichever subscriptions exist.
    untrackContainerResize(this.anchorParent);
    untrackTargetMutations(this.target);
    untrackHostAttributes(this.host);
    unregisterReconcile(this);
    this.disarmScrollAccel();
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
    // Which of the two positioning methods this badge uses: 'anchor' = CSS
    // anchor() fast-path (host body-mounted, compositor tracks the target);
    // 'nesting' = host physically nested in a resolved container and re-placed
    // by JS on settle. The scroll-back stranding bug lives on whichever path
    // can't follow a target moved by sibling reflow — this label disambiguates.
    positioningMethod: 'anchor' | 'nesting';
    scrollSensitive: boolean;
    geometryDependent: boolean;
    // Anchor-path only: does the live target still carry the `anchor-name`
    // the host's `position-anchor` references? false ⇒ the binding dangled
    // (target node recreated underneath us — sub-cause A); true ⇒ binding is
    // intact, so a stranded badge means anchor() failed to re-resolve on
    // reflow (sub-cause B). null on the nesting path (concept N/A).
    bindingLive: boolean | null;
    // Anchor-path only: the host's literal inline `top`/`left` — the baked
    // `calc(anchor(top) + Npx)`. Lets a stranded badge be decomposed: if the
    // baked Npx is small but outerRect is far from the target, anchor()
    // resolved to the WRONG element (duplicate name); if Npx is itself large,
    // the offset bake was stale. null/'' on the nesting path.
    hostTop: string;
    hostLeft: string;
    // Anchor-path only: how many OTHER connected elements carry this badge's
    // `anchor-name` inline. >0 ⇒ a recycled/stale node is competing for the
    // anchor and anchor() may resolve to it (last in tree order wins). null on
    // the nesting path.
    anchorNameDupes: number | null;
    // Anchor-path bake forensics. `bakeCandidateY`/`bakeTargetTop` are the two
    // inputs to the last `anchor(top)+Npx` bake (Npx = candidateY − targetTop).
    // `liveTargetTop` is the target's gBCR.top read NOW. If the baked offset is
    // stale-large, comparing these tells us which input was wrong: if
    // bakeTargetTop ≈ liveTargetTop but bakeCandidateY is far off, the candidate
    // was computed from a stale element rect; if bakeTargetTop ≠ liveTargetTop,
    // the target rect read at bake time disagreed with the candidate's basis
    // (cache-miss live-fallback or a target/element identity split).
    bakeCandidateY: number | null;
    bakeTargetTop: number | null;
    liveTargetTop: number | null;
    targetTag: string;
    // Reconcile-model forensics (the live positioning model). `reconcileOffset`
    // is the baked candidate-minus-target offset the reconciler applies each
    // pass; a scroll-back-stranded badge typically shows a stale offset here
    // (e.g. offset.y ~= the scroll delta instead of the small placement nudge).
    // `hostTransform` is what the reconciler last wrote. `viewportFixed` picks
    // the host's anchoring (fixed vs absolute). The `scrollAccel*` fields show
    // whether the inner-scroll accelerator is armed and its live scroll state —
    // an armed badge's on-screen position is host base + outer's -scrollerTop.
    reconcileOffset: { x: number; y: number } | null;
    hostTransform: string;
    viewportFixed: boolean;
    scrollAccelArmed: boolean;
    scrollAccelMax: number | null;
    scrollAccelScrollerTop: number | null;
  } {
    const ir = this.inner.getBoundingClientRect();
    const or2 = this.outer.getBoundingClientRect();
    const ap = this.anchorParent;
    const apr = ap.getBoundingClientRect();
    const aps = getComputedStyle(ap);
    let bindingLive: boolean | null = null;
    let anchorNameDupes: number | null = null;
    if (this.anchorMode && this.anchorName) {
      const live = getComputedStyle(this.target as Element)
        .getPropertyValue('anchor-name')
        .trim();
      bindingLive = live === this.anchorName;
      // Count OTHER connected elements whose inline style carries this exact
      // anchor-name. Diagnostic-only (manual snapshot path), so the bounded
      // scan over badge-tagged targets is acceptable; the live placement path
      // never runs this.
      anchorNameDupes = 0;
      for (const el of document.querySelectorAll<HTMLElement>('[style*="--bk-"]')) {
        if (el === this.target) continue;
        if (el.style?.getPropertyValue?.('anchor-name')?.trim() === this.anchorName) {
          anchorNameDupes++;
        }
      }
    }
    return {
      innerRect: { x: Math.round(ir.left), y: Math.round(ir.top), w: Math.round(ir.width), h: Math.round(ir.height) },
      outerRect: { x: Math.round(or2.left), y: Math.round(or2.top), w: Math.round(or2.width), h: Math.round(or2.height) },
      anchorParentRect: { x: Math.round(apr.left), y: Math.round(apr.top), w: Math.round(apr.width), h: Math.round(apr.height) },
      anchorParentScroll: { top: ap.scrollTop, left: ap.scrollLeft, width: ap.scrollWidth, height: ap.scrollHeight },
      anchorParentOverflow: { x: aps.overflowX, y: aps.overflowY },
      anchorParentTag: ap.tagName.toLowerCase(),
      anchorParentClasses: ap.className?.toString().slice(0, 200) ?? '',
      displayedAs: this.inner.textContent ?? '',
      positioningMethod: this.anchorMode ? 'anchor' : 'nesting',
      scrollSensitive: this.scrollSensitive,
      geometryDependent: this.geometryDependent,
      bindingLive,
      hostTop: this.anchorMode ? (this.host.style.top ?? '') : '',
      hostLeft: this.anchorMode ? (this.host.style.left ?? '') : '',
      anchorNameDupes,
      bakeCandidateY: this._lastBake ? Math.round(this._lastBake.candidateY) : null,
      bakeTargetTop: this._lastBake ? Math.round(this._lastBake.targetTop) : null,
      liveTargetTop: this.anchorMode ? Math.round(this.target.getBoundingClientRect().top) : null,
      targetTag: this.target.tagName.toLowerCase(),
      reconcileOffset: this._reconcileOffset
        ? { x: Math.round(this._reconcileOffset.x), y: Math.round(this._reconcileOffset.y) }
        : null,
      hostTransform: this.host.style.transform ?? '',
      viewportFixed: this._viewportFixed,
      scrollAccelArmed: this._scrollAccel != null,
      scrollAccelMax: this._scrollAccel ? Math.round(this._scrollAccel.max) : null,
      scrollAccelScrollerTop: this._scrollAccel ? Math.round(this._scrollAccel.scroller.scrollTop) : null,
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

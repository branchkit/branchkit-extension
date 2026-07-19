/**
 * BranchKit Browser — the HintBadge: a Shadow DOM badge pinned to its target.
 *
 * Each badge lives in a closed Shadow DOM to prevent page CSS interference.
 * Hosts are body-mounted; the batched JS reconciler (reconcile-positioner.ts)
 * pins each host to its target's live rect every pass. Container resolution
 * (container-resolution.ts) still runs per badge — its anchorParent drives the
 * container-resize tracker. Accelerator coordination lives in
 * scroll-accel-glue.ts; container diagnostics in container-diagnostics.ts.
 */

import { Category, BadgeDisplayMode } from '../types';
import type { BadgeHandle, BadgeDiagnostics } from './badge-handle';
import { LabelAssignment, labelToDisplay, letterToSpokenWord } from '../labels/words';
import { getCachedRect, getCachedStyle, isRectOnScreen } from '../layout-cache';
import { calculateZIndex } from '../placement/stacking';
import { computeBadgeColors } from './badge-colors';
import { type BadgeSettings, DEFAULT_BADGE_SETTINGS } from '../badge-settings-storage';
import { leaderLineGeometry } from '../placement/geometry';
import { trackContainerResize, untrackContainerResize } from '../observe/container-resize-tracker';
import {
  isTransformTriggerEnabled,
  trackTransformAncestor,
  untrackTransformAncestor,
} from '../observe/transform-ancestor-tracker';
import { harnessHooksEnabled } from '../debug/harness-hooks';
import { trackTargetMutations, untrackTargetMutations } from '../observe/target-mutation-tracker';
import { trackHostAttributes, untrackHostAttributes } from '../observe/host-attribute-tracker';
import { clipRootOf } from '../observe/clip-observer';
import { register as registerReconcile, unregister as unregisterReconcile, type ReconcileWrite } from './reconcile-positioner';
import { hasViewportPinnedAncestor, resolveContainer } from './container-resolution';
import { targetOverVideo } from './video-overlay';
import {
  isScrollAccelEnabled,
  isScrollAccelNestedEnabled,
  registerScrollAccelBadge,
  unregisterScrollAccelBadge,
  sameElements,
  describeScroller,
} from './scroll-accel-glue';
import {
  type ScrollAccel,
  createScrollAccel,
  updateScrollAccelChain,
  recomputeScrollAccel,
  teardownScrollAccel,
  scrollAccelHealthy,
  scrollAccelScrollOffset,
  findScrollableAncestor,
  findScrollableAncestors,
  findTransformedAncestors,
} from './scroll-accel';

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

// Per-site override from a matched domain rule (DomainRule.badgeSizePx),
// quoted the same way as the options page's size slider: badge font px on
// nominal 14px text — so the effective scale is px/14 per target. Null =
// use the global settings above. Set by the content script whenever the
// compiled rule set changes.
let badgeSizeOverridePx: number | null = null;

export function setBadgeSizeOverridePx(px: number | null): void {
  badgeSizeOverridePx = px;
}

// Z-index cache, keyed by anchorParent. calculateZIndex walks the target's
// descendants plus its ancestor chain with live getComputedStyle — too
// expensive to run per badge per placement pass (the pre-2026-06 model, the
// biggest single read cost on dense pages). Badges sharing an anchorParent sit
// in the same stacking context, so one walk serves them all; computed once per
// badge at refine()/retarget() time. WeakMap so detached containers fall out
// with the page's own GC. Staleness (a container whose stacking context
// changes after the first badge computed it) is accepted — calculateZIndex's
// +5 buffer covers minor drift, and a re-shown session rebuilds badges anyway.
const zIndexByAnchorParent = new WeakMap<HTMLElement, number>();

function zIndexFor(target: Element, host: HTMLElement, anchorParent: HTMLElement): number {
  let z = zIndexByAnchorParent.get(anchorParent);
  if (z === undefined) {
    z = calculateZIndex(target, host);
    zIndexByAnchorParent.set(anchorParent, z);
  }
  return z;
}

// Test affordance: open the badge's shadow root so integration tests (Playwright)
// can measure the PAINTED badge's true viewport position — including the
// accelerator's compositor transform on `outer`, which the body-mounted host's
// own rect does NOT reflect (the host carries the docY0 base). Closed in
// production (keeps hostile pages out of badge internals). Read once at module
// load from a localStorage flag the test sets before the content script boots
// (localStorage is shared between the page and the CS isolated world). The
// harness-hooks gate keeps release builds closed even if a page pre-seeds the
// flag in its own localStorage — one flag away was the whole protection.
const SHADOW_MODE: ShadowRootMode = (() => {
  try {
    return harnessHooksEnabled()
      && typeof localStorage !== 'undefined' && localStorage.getItem('bkOpenShadow') === '1'
      ? 'open' : 'closed';
  } catch {
    return 'closed';
  }
})();

const BADGE_CSS = `
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
  .bk-inner.filtered {
    display: none;
  }
  /* Occlusion: the target is covered by another element (hit-test), so the
   * badge would float on top of whatever hides it. Hidden entirely —
   * orthogonal to .filtered (codeword filter) and the .visible opacity gate. */
  .bk-inner.bk-occluded {
    display: none;
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

// One shared constructable stylesheet adopted by every badge shadow root,
// instead of a per-badge <style> clone of the ~80-line block above (N parsed
// copies retained at hundreds of badges). Lazily built on first use. Both
// build targets support it (Chrome 73+, and MV3 implies Firefox 109+ where
// shadow-root adoption landed in 101); the <style> fallback exists because
// Firefox content scripts run in their own compartment and constructable-
// sheet adoption across the Xray boundary is the one path we can't verify
// outside a live browser. `false` = construction/adoption threw once, don't
// retry per badge.
let sharedBadgeSheet: CSSStyleSheet | null | false = null;

function adoptBadgeStyles(shadow: ShadowRoot): void {
  if (sharedBadgeSheet === null) {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(BADGE_CSS);
      sharedBadgeSheet = sheet;
    } catch {
      sharedBadgeSheet = false;
    }
  }
  if (sharedBadgeSheet) {
    try {
      shadow.adoptedStyleSheets = [sharedBadgeSheet];
      return;
    } catch {
      sharedBadgeSheet = false;
    }
  }
  const style = document.createElement('style');
  style.textContent = BADGE_CSS;
  shadow.appendChild(style);
}

/**
 * Clamp a badge's viewport-relative box to its target's side of the viewport
 * edge (notes/DESIGN_PAINT_THE_BAND.md seam 3). Only meaningful when the
 * target rect is FULLY off-screen (the caller checks): a target parked
 * off-screen (YouTube's collapsed nav drawer at x=-228) keeps its badge
 * painted under the band-scoped shown predicate, but the badge box — which
 * placement hangs up-and-left of the target — must not overhang into the
 * visible viewport. Per-axis: only the axis on which the target is fully
 * off-screen is clamped, so a below-fold target riding in (off-screen with
 * its badge) is untouched.
 *
 * Pure geometry, no DOM. The caller applies the result per pass at WRITE
 * time — never baked into the reconcile offset (a bake-time clamp was the
 * d35201a stranding bug).
 */
export function clampOffscreenBadgeBox(
  badge: { x: number; y: number; w: number; h: number },
  target: { left: number; top: number; right: number; bottom: number },
  vw: number,
  vh: number,
): { x: number; y: number } {
  let { x, y } = badge;
  if (target.right <= 0) x = Math.min(x, target.right - badge.w);
  else if (target.left >= vw) x = Math.max(x, target.left);
  if (target.bottom <= 0) y = Math.min(y, target.bottom - badge.h);
  else if (target.top >= vh) y = Math.max(y, target.top);
  return { x, y };
}

export function computeBadgeFontSize(target: Element): number {
  // Sub-readable target font sizes are CSS accidents, not signal: 0px or
  // a-few-px declarations exist to hide accessible-name text nodes from
  // layout (Gmail's email-row div[role=checkbox] is the canonical case).
  // Scaling from them pins the badge at fontMin no matter what badge size
  // the user picked. Treat anything below readable as "no target font"
  // and scale from the nominal 14px the size slider is quoted against,
  // so icon-only targets track the slider exactly.
  const raw = parseFloat(getCachedStyle(target).fontSize);
  const targetSize = Number.isFinite(raw) && raw >= 9 ? raw : 14;
  if (badgeSizeOverridePx !== null) {
    // A rule override replaces the global scale, and the clamp widens
    // just enough to honor it (mirroring the options size slider, which
    // stretches fontMin/fontMax to the picked size) — a stored clamp
    // must never silently cap an explicit per-site choice.
    const scaled = Math.round(targetSize * (badgeSizeOverridePx / 14));
    const min = Math.min(badgeFontMin, Math.floor(badgeSizeOverridePx));
    const max = Math.max(badgeFontMax, Math.ceil(badgeSizeOverridePx));
    return Math.min(Math.max(scaled, min), max);
  }
  const scaled = Math.round(targetSize * badgeFontScale);
  return Math.min(Math.max(scaled, badgeFontMin), badgeFontMax);
}

export class HintBadge implements BadgeHandle {
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
  // Occlusion paint-decision state (applyOcclusion): the last overlay
  // hit-test verdict this badge was given, and the applied OR-fold. Decision
  // state, not an observation — the facts are re-derived at every consumer
  // (DESIGN_OBSERVED_STATE_READ_TIME phase 2).
  private _overlayOccluded: boolean = false;
  private _occludedApplied: boolean = false;
  private _size: { w: number; h: number } | null = null;
  // Has the deferrable refinement (observer registration, etc.) run yet?
  // Production: false until the rIC-scheduled drain runs `refine()`.
  // Tests: refineImmediately makes the constructor call refine() inline
  // so observer state is asserted right after `new HintBadge(...)`.
  private _refined: boolean = false;
  // Whether THIS badge holds a container-resize refcount on anchorParent.
  // Guards the shared-refcount untracks in retarget()/remove().
  private _containerTracked: boolean = false;
  // The transformed ancestors this badge tracks for the pan/zoom-canvas reconcile
  // trigger (all of them up the chain — a React Flow canvas nests a static
  // per-node transform under the moving viewport transform). Empty when the flag
  // is off or there are none. Held so remove()/retarget() untrack exactly what
  // was registered, since the shared refcounts can't be recomputed from a
  // possibly-changed target.
  private _transformAncestors: Element[] = [];
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

  // The reconcile positioning model (notes/completed/DESIGN_HINT_POSITIONING_REARCH.md):
  // the host is body-mounted and the batched JS reconciler writes its transform
  // from the live target rect + page scroll + this baked offset (candidate
  // minus target top-left).
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
  // Count of chain-change events over this badge's life (diagnostic only). Climbs
  // when a hover-gated inner scroller (QuickBase report grid) flaps as an outer
  // scroll slides the pane under the cursor.
  private _scrollAccelRearms = 0;
  // Cumulative ScrollTimeline anims BUILT over this badge's life (diagnostic). The
  // nested model rebuilds only the inner wrapper that flaps and reuses the
  // outermost layer's anim, so this climbs ~1 per flap while the OUTER layer's
  // anim id stays constant — the proof the page-scroll layer is never torn down.
  private _scrollAccelAnimBuilds = 0;

  constructor(target: Element, label: LabelAssignment, category: Category, displayMode: BadgeDisplayMode) {
    this.target = target;
    this.category = category;
    this.label = label;
    this.displayMode = displayMode;
    this.fontSize = computeBadgeFontSize(target);

    this.host = document.createElement('div');
    this.host.setAttribute('data-branchkit-hint', 'true');
    this.host.style.cssText = 'display:contents;';

    this.shadow = this.host.attachShadow({ mode: SHADOW_MODE });

    this.outer = document.createElement('div');
    this.outer.className = 'bk-outer';

    this.inner = document.createElement('div');
    this.inner.className = 'bk-inner';
    this.inner.style.fontSize = `${this.fontSize}px`;

    const text = labelToDisplay(label, displayMode);
    this.inner.textContent = text;

    adoptBadgeStyles(this.shadow);
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
    registerScrollAccelBadge(this);

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
    this._containerTracked = true;
    trackTargetMutations(this.target);
    // Stacking: place the badge in its target's natural stacking context so
    // modals/dropdowns with a higher-z context still cover it. Deferred here
    // (not the constructor) because the walk reads live computed styles;
    // cached per anchorParent. Written before the host-attribute defender
    // starts so the write isn't observed as page tampering.
    this.host.style.zIndex = String(zIndexFor(this.target, this.host, this.anchorParent));
    // Start the host-attribute defender AFTER all setup is done — the
    // observer fires on real mutations only, but starting it earlier
    // would treat our own setAttribute/style writes as page tampering.
    // Anchor/reconcile hosts need a real box (position → display block);
    // nesting hosts stay display:contents.
    trackHostAttributes(this.host, 'block');
    this.armTransformTracker();
    // Colors are NOT touched here — they were already applied accurately
    // (APCA) at show() time. Refinement is observer-only now.
  }

  // Register this badge's nearest transformed ancestor with the shared
  // MutationObserver so a pan/zoom-canvas transform mutation (which fires no
  // scroll event) pokes the reconcile loop. No-op when the flag is off, no
  // transformed ancestor exists, or one is already tracked. Called from refine()
  // and retarget() (target swap → possibly a different ancestor).
  private armTransformTracker(): void {
    if (!isTransformTriggerEnabled() || this._transformAncestors.length) return;
    const ancestors = findTransformedAncestors(this.target);
    if (!ancestors.length) return;
    this._transformAncestors = ancestors;
    for (const a of ancestors) trackTransformAncestor(a);
  }

  // Release this badge's transformed-ancestor refcounts (shared: many badges per
  // canvas viewport). Guarded on the stored elements so we untrack exactly what
  // we tracked. Called from remove() and retarget() (before the target swap).
  private disarmTransformTracker(): void {
    if (!this._transformAncestors.length) return;
    for (const a of this._transformAncestors) untrackTransformAncestor(a);
    this._transformAncestors = [];
  }

  // Re-evaluate transform tracking against the current flag — arm if newly on,
  // disarm if newly off. Called from the glue's reconcileTransformTrigger() on a
  // live `bkTransformTrigger` flip so a toggle applies without a page reload.
  // (Part of ScrollAccelReconcilable, which reuses the live-badge registry.)
  syncTransformTracker(): void {
    if (this._removed) return;
    if (isTransformTriggerEnabled()) this.armTransformTracker();
    else this.disarmTransformTracker();
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
    let x = r.left + sx + this._reconcileOffset.x;
    let y = r.top + sy + this._reconcileOffset.y;
    // Inner-scroll accelerator, evaluated every pass (level-triggered).
    if (this._scrollAccel) {
      if (!scrollAccelHealthy(this._scrollAccel, this.target)) {
        // Chain went stale THIS pass — most often a hover-activated inner scroller
        // dropping out because an OUTER scroll slid the pane out from under the
        // cursor, flipping its :hover off (QuickBase report grids flip
        // overflow:hidden<->auto under :hover). Incrementally reconcile: the
        // outermost layer (the page scroll being dragged) keeps its running anim,
        // only the inner wrapper is rebuilt, so the outer scroll never hitches. If
        // nothing is scrollable now this disarms fully (graceful degradation). No
        // repositionHostNow — this read pass writes the fresh position.
        this.syncScrollAccelChain();
      }
      if (this._scrollAccel) {
        // Healthy (or freshly reconciled): write the scroll-0 base docY0 = rect.top
        // + scrollY + offset + Σ scrollTop (over the ridden scroller chain). As any
        // ridden pane scrolls, rect.top drops by ΔS while its scrollTop rises by ΔS,
        // so docY0 is constant (scroll-invariant under the chain's scrolls); the
        // per-layer compositor animations cascade to translateY(-Σ scrollTop), so
        // the net is the live position with no main-thread chase. Refresh keyframes
        // on max change (counts toward the anim-build diagnostic).
        this._scrollAccelAnimBuilds += recomputeScrollAccel(this._scrollAccel);
        y += scrollAccelScrollOffset(this._scrollAccel);
      }
    }
    // Write-time clamp for FULLY off-screen targets (paint-the-band seam 3,
    // replacing the old settle-time off-screen hide sweep): a parked target
    // keeps its badge painted under the band-scoped predicate, but the badge
    // box must not overhang into the viewport edge. Applied to the VIEWPORT-
    // relative box (accel and anchoring cancel out of it), per pass, never
    // into the baked offset. Same predicate every paint path uses.
    const vw = window.innerWidth, vh = window.innerHeight;
    if (!isRectOnScreen(r, vw, vh)) {
      const size = this._size ?? this.estimateSize();
      const bx = r.left + this._reconcileOffset.x;
      const by = r.top + this._reconcileOffset.y;
      const clamped = clampOffscreenBadgeBox({ x: bx, y: by, w: size.w, h: size.h }, r, vw, vh);
      x += clamped.x - bx;
      y += clamped.y - by;
    }
    // Top-edge clamp vs the target's clipping scroller, evaluated per pass
    // (level-triggered). The retired PLACEMENT-time fallbacks (36b flip-below,
    // then a one-day overlap) baked the edge decision into the offset at
    // build/show time and were followed by pure translation, so rows wore the
    // fallback long after leaving the edge (Gmail: whole bands of dropped/
    // covering badges). This is a WRITE-time delta in the same shape as the
    // off-screen clamp above — recomputed from live rects every pass, never
    // baked: a badge poking above the scroller's top edge (where QuickBase's
    // header band paints over it) is pinned at the edge, sliding down over
    // its own target's upper part as the row reaches the very top, and
    // releasing the moment the row gains headroom. Never pushed past the
    // target's own top, so it stays inside its target's footprint —
    // unambiguous, no neighbor collisions.
    else {
      const clipRoot = clipRootOf(this.target);
      if (clipRoot) {
        const by = r.top + this._reconcileOffset.y;
        const rootTop = clipRoot.getBoundingClientRect().top;
        if (by < rootTop) {
          y += Math.min(rootTop, r.top) - by;
        }
      }
    }
    return {
      host: this.host,
      x: Math.round(x),
      y: Math.round(y),
      targetRect: r,
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
    if (!isScrollAccelEnabled() || this._scrollAccel) return;
    this._scrollAccel = createScrollAccel(this.target, this.outer, this.inner, isScrollAccelNestedEnabled());
    // Diagnostic mirror on the light-DOM host: a badge that found an inner
    // scroller and armed carries `data-bk-accel="<layerCount>"`, so the accelerated
    // set is countable from the page console
    // (`document.querySelectorAll('[data-bk-accel]').length`) and a value >1 marks
    // a nested-scroller chain. Allowed by the host-attribute tracker.
    if (this._scrollAccel) {
      this._scrollAccelAnimBuilds += this._scrollAccel.layers.length;
      this.host.setAttribute('data-bk-accel', String(this._scrollAccel.layers.length));
      this.host.setAttribute('data-bk-accel-builds', String(this._scrollAccelAnimBuilds));
    }
  }

  // Tear down the accelerator (cancel every layer's animation, reparent `inner`
  // back under `outer`, drop the wrapper elements). Safe to call when none is
  // armed. The chase base alone is correct afterward.
  private disarmScrollAccel(): void {
    if (!this._scrollAccel) return;
    teardownScrollAccel(this._scrollAccel, this.outer, this.inner);
    this._scrollAccel = null;
    this.host.removeAttribute('data-bk-accel');
  }

  // Level-triggered re-detection (settle path): reconcile the chain if it changed
  // since arming. Catches a scroller that became scrollable after show, a chain
  // that grew/shrank, and late flag reads. Repositions after, since this is not
  // called from inside reconcileRead.
  syncScrollAccel(): void {
    if (!isScrollAccelEnabled() || !this._visible) return;
    if (this.syncScrollAccelChain() && this._scrollAccel) this.repositionHostNow();
  }

  // Re-detect only if this badge's target lives inside `scroller` (the element
  // that just scrolled). The `contains` guard keeps the gesture-start fast path
  // cheap: badges outside the scrolled subtree skip the layout-reading chain
  // walk entirely. See `reconcileScrollAccelForScroller`.
  syncScrollAccelInside(scroller: Element): void {
    if (!isScrollAccelEnabled() || !this._visible) return;
    if (!scroller.contains(this.target)) return;
    this.syncScrollAccel();
  }

  // Reconcile the armed chain to the CURRENT scrollable ancestors. When already
  // armed, this updates INCREMENTALLY (updateScrollAccelChain): the outermost
  // layer (`outer`, the page scroll the user drags) keeps its running animation
  // when its scroller is unchanged, and only the inner wrapper(s) are rebuilt — so
  // a hover-gated inner scroller flapping never hitches the outer scroll. Returns
  // true if the chain changed. Does NOT reposition (callers decide). Fully disarms
  // when nothing is scrollable now (→ chase base, graceful degradation).
  private syncScrollAccelChain(): boolean {
    const desired = isScrollAccelNestedEnabled()
      ? findScrollableAncestors(this.target)
      : ((s) => (s ? [s] : []))(findScrollableAncestor(this.target));
    const current = this._scrollAccel ? this._scrollAccel.layers.map((l) => l.scroller) : [];
    if (sameElements(current, desired)) return false;
    this.bumpRearm();
    if (desired.length === 0) {
      this.disarmScrollAccel();
      return true;
    }
    if (!this._scrollAccel) {
      this.armScrollAccel();
      return true;
    }
    this._scrollAccelAnimBuilds += updateScrollAccelChain(this._scrollAccel, desired, this.outer, this.inner);
    this.host.setAttribute('data-bk-accel', String(this._scrollAccel.layers.length));
    this.host.setAttribute('data-bk-accel-builds', String(this._scrollAccelAnimBuilds));
    return true;
  }

  // Tally a chain-change event and mirror it on the host as `data-bk-accel-rearms`
  // so tests + the page console can spot hover-churn without reading the closed
  // shadow root. Allowed by the host-attribute tracker.
  private bumpRearm(): void {
    this._scrollAccelRearms++;
    this.host.setAttribute('data-bk-accel-rearms', String(this._scrollAccelRearms));
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

  updatePosition(candidate?: { x: number; y: number }): void {
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
    // Only release a container refcount this badge actually holds. The
    // container-resize tracker is a SHARED refcount (many badges per
    // anchorParent): an unconditional untrack on a not-yet-refined badge
    // decrements a sibling's count and can unobserve a container that
    // surviving badges still depend on — silently killing their resize
    // tracking (2026-07 long-session audit, finding 8).
    if (this._containerTracked) untrackContainerResize(this.anchorParent);
    untrackTargetMutations(this.target);
    // The accelerator is bound to the OLD target's scroller; drop it before the
    // swap and re-detect for the new node below.
    this.disarmScrollAccel();
    // Same for the transformed-ancestor tracker — the new target may live under
    // a different (or no) transformed ancestor; re-detect after the swap.
    this.disarmTransformTracker();

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
    this._containerTracked = true;
    trackTargetMutations(this.target);
    this.armTransformTracker();
    // Recompute stacking for the new target's container (cached per
    // anchorParent). The host-attribute defender allows style writes that
    // keep display intact, so this is safe with the tracker live.
    this.host.style.zIndex = String(zIndexFor(this.target, this.host, this.anchorParent));
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

    // Paint the new target's host NOW, unconditionally. With the accelerator
    // enabled this keeps the base consistent with the (re-armed or cleared)
    // accelerator animation — the old-target disarm + new-target re-arm flip
    // `outer`'s -scrollTop, so the base must move in lockstep. With it off
    // (Firefox stable: no ScrollTimeline, so the isScrollAccelEnabled() gate
    // never passed after the 2026-07-03 feature-detect fix), the old gate
    // left a rebound badge at its previous position until the next
    // settle/reconcile tick — a visible ~100ms lag on every limbo rebind
    // (long-session review backlog: retarget repaint gap). One rect read +
    // one transform write per rebind — cheap on both engines.
    this.repositionHostNow();
  }

  /**
   * Show the badge, at full opacity. (The bk-pending translucent state —
   * per-codeword grammar-ACK gating — retired with display-grade demotion
   * phase 2: under sealed dispatch a painted badge is speakable the moment
   * the hints tag is up, push or no push.)
   */
  show(): void {
    if (this._visible) return;
    // Dormant guard: a null label means clearLabel() ran (band-exit reuse, a
    // mid-flight codeword reclaim, or session/alphabet rotation) and the inner
    // text is empty. Painting now yields an empty badge BOX with no letters — the
    // recheck/pointerover show path can race ahead of the setLabel the claim
    // pipeline issues. Stay hidden; the setLabel + show() that badgeNewlyCodeworded
    // / showBadges run once the label is restored will paint it. Enforces the
    // dormant invariant documented on `label` and mirrors setMatchedChars's guard.
    if (this.label === null) return;
    // Video-overlay gate: painting over an actively-playing video re-rolls
    // Firefox's compositor-surface race (bugzilla 1989948 class) on every
    // reposition — the measured Shorts-freeze amplifier. Every live show
    // path funnels through here, so this is the one chokepoint. The
    // reconciler's wantsShown carries the same predicate for level-triggered
    // hide of already-painted badges when a video starts beneath them.
    // Park the host as well — a declined show would otherwise leave the
    // freshly-built host at display:block, the exact residue layer this
    // gate exists to remove.
    if (targetOverVideo(this.target)) {
      this.host.style.display = 'none';
      return;
    }
    this._visible = true;
    // Un-park the host from the display:none hide() leaves it in.
    this.host.style.display = 'block';
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
    if (isScrollAccelEnabled()) this.repositionHostNow();
    requestAnimationFrame(() => {
      this.inner.classList.add('visible');
      // Mirror the visibility state onto the light-DOM host so tools that
      // can't peek into the closed shadow root (Playwright tests, dev-tool
      // selectors) can query `[data-bk-shown]`. Allowed by the host-
      // attribute tracker's reconcile.
      this.host.setAttribute('data-bk-shown', 'true');
    });
  }

  get badgeSize(): { w: number; h: number } {
    if (this._size) return this._size;
    const rect = this.inner.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0) {
      this._size = { w: Math.ceil(rect.width), h: Math.ceil(rect.height) };
      return this._size;
    }
    this._size = this.estimateSize();
    return this._size;
  }

  // Font-metric estimate of the badge box, no layout read. Shared by the
  // badgeSize fallback (zero-rect inner) and the reconcile clamp path — the
  // latter runs inside the batched read pass, must not force a reflow, and
  // uses it directly (uncached) so a later badgeSize still gets the real rect.
  private estimateSize(): { w: number; h: number } {
    const text = this.inner.textContent || '';
    const charWidth = this.fontSize * 0.6;
    return {
      w: Math.ceil(text.length * charWidth) + 4,
      h: Math.ceil(this.fontSize * 1.2) + 2,
    };
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
    this.host.removeAttribute('data-bk-shown');
    // Park the host out of the layer tree entirely. opacity:0 alone leaves a
    // compositor-active element (the .visible opacity transition promotes
    // it), which kept invisible layers stacked over videos — the 2026-07-18
    // manual-mode freeze confound. show() restores display.
    this.host.style.display = 'none';
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
  // so it un-hides the instant the cover moves) and from setFiltered (codeword-
  // filter dimming). Mirrors the occluded state onto the light-DOM host as
  // data-bk-occluded for diagnostics.
  //
  // Two-input fold (notes/DESIGN_OBSERVED_STATE_READ_TIME.md phase 2): the
  // settle applier passes the fresh overlay hit-test verdict; the clip IO
  // passes `overlay: null` with its fresh clip signal. The badge remembers
  // the overlay half as paint-decision state ("why am I hidden") so the two
  // producers — different cadences — compose without a stored observation on
  // the wrapper. Returns true when the applied visual flipped.
  applyOcclusion(overlay: boolean | null, clipped: boolean): boolean {
    if (overlay !== null) this._overlayOccluded = overlay;
    const eff = this._overlayOccluded || clipped;
    if (eff === this._occludedApplied) return false;
    this._occludedApplied = eff;
    if (eff) {
      this.inner.classList.add('bk-occluded');
      this.host.setAttribute('data-bk-occluded', 'true');
    } else {
      this.inner.classList.remove('bk-occluded');
      this.host.removeAttribute('data-bk-occluded');
    }
    return true;
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
    // `words` holds single-letter tokens (label inversion, da74214); the spoken
    // codeword comes from the voice overlay via letterToSpokenWord, exactly as
    // labelToDisplay does. Without this, word/both/first-word reveals emit the
    // raw letter (e.g. "a s") instead of the expanded word ("a stone").
    const spoken = words.map(letterToSpokenWord);
    let matchedText: string;
    let remainingText: string;

    switch (this.displayMode) {
      case 'letter':
        matchedText = letter.slice(0, count);
        remainingText = letter.slice(count);
        break;
      case 'word':
        matchedText = spoken.slice(0, count).join(' ');
        remainingText = spoken.slice(count).join(' ');
        if (matchedText && remainingText) remainingText = ' ' + remainingText;
        break;
      case 'expand':
        if (count >= 1 && words.length >= 2) {
          matchedText = letter[0];
          remainingText = ' ' + spoken[1];
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

  remove(): void {
    this._removed = true;
    unscheduleRefine(this);
    // untrackTargetMutations/untrackHostAttributes are keyed 1:1 and no-op
    // when never tracked. untrackContainerResize is NOT: it's a shared
    // refcount, and untracking a container this badge never tracked
    // (refine() pending — routine for badges churned within the swap
    // window) underflows a sibling badge's count and unobserves a
    // container survivors still track (audit finding 8).
    if (this._containerTracked) {
      untrackContainerResize(this.anchorParent);
      this._containerTracked = false;
    }
    untrackTargetMutations(this.target);
    untrackHostAttributes(this.host);
    unregisterReconcile(this);
    unregisterScrollAccelBadge(this);
    this.disarmScrollAccel();
    this.disarmTransformTracker();
    this.host.remove();
  }

  get isVisible(): boolean {
    return this._visible;
  }

  /**
   * Photon-level state (round 34d): what this badge ACTUALLY renders as
   * right now, by computed style + geometry — NOT the `_visible` flag.
   * The flag records intent; a badge can be flag-visible while its box is
   * 0×0, transitioned to opacity 0, or positioned off-viewport. The
   * eye-level drill sampler reads this so user drills carry the same
   * ground truth as the Playwright harness's shadow-piercing eye.
   * Null = not rendering (no box or fully transparent). Forces layout —
   * callers batch reads at a bounded cadence.
   */
  eyeState(): { solid: boolean; inViewport: boolean } | null {
    const r = this.inner.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    const is = getComputedStyle(this.inner);
    const os = getComputedStyle(this.outer);
    if (is.visibility === 'hidden' || os.visibility === 'hidden' ||
        is.display === 'none' || os.display === 'none') return null;
    const op = Math.min(parseFloat(is.opacity), parseFloat(os.opacity));
    if (!(op >= 0.05)) return null;
    return {
      solid: op >= 0.85,
      inViewport: r.bottom > 0 && r.top < window.innerHeight &&
        r.right > 0 && r.left < window.innerWidth,
    };
  }

  get diagnostics(): BadgeDiagnostics {
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
      targetTag: this.target.tagName.toLowerCase(),
      reconcileOffset: this._reconcileOffset
        ? { x: Math.round(this._reconcileOffset.x), y: Math.round(this._reconcileOffset.y) }
        : null,
      hostTransform: this.host.style.transform ?? '',
      viewportFixed: this._viewportFixed,
      scrollAccelArmed: this._scrollAccel != null,
      scrollAccelMax: this._scrollAccel
        ? Math.round(this._scrollAccel.layers.reduce((s, l) => s + l.max, 0))
        : null,
      scrollAccelScrollerTop: this._scrollAccel ? Math.round(scrollAccelScrollOffset(this._scrollAccel)) : null,
      scrollAccelLayers: this._scrollAccel
        ? this._scrollAccel.layers.map((l) => ({
            scroller: describeScroller(l.scroller),
            max: Math.round(l.max),
            scrollTop: Math.round(l.scroller.scrollTop),
          }))
        : null,
      scrollAccelRearms: this._scrollAccelRearms,
      scrollAccelAnimBuilds: this._scrollAccelAnimBuilds,
      occluded: this.inner.classList.contains('bk-occluded'),
      overlayOccluded: this._overlayOccluded,
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

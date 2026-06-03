/**
 * BranchKit Browser — per-frame page lifecycle.
 *
 * One `PageSession` per content-script context. It is the single object that
 * represents "this frame's hinting session": its identity, and its lifecycle
 * transitions (boot, SPA navigation, teardown).
 *
 * This is the first, transitional cut of the extraction described in
 * notes/DESIGN_EXTENSION_RESTRUCTURE.md §3.3.1. The observer/timer state the
 * session will eventually own still lives in `content.ts` module scope; the
 * session reaches it through injected hooks. Subsequent steps migrate that
 * state into the instance and route SPA-nav/bfcache through `onUrlChange`/
 * `restore`. Keeping the seam injection-based first makes each step
 * behavior-identical and independently revertable, instead of relocating
 * ~2,800 lines of entangled top-level boot in a single diff.
 */

import { getSessionId } from '../labels/label-sync';

/**
 * Why a session is tearing down. Carried so the teardown body (and its log
 * line) can distinguish the cases that today all funnel through the same
 * observer-disconnect path:
 *   - 'orphan'   — extension reloaded; our chrome.* context is dead but the
 *                  JS context lives on (the original quiesceOrphan trigger).
 *   - 'navigate' — hard same-origin/cross-document unload (future use).
 *   - 'unload'   — page going away (future use).
 */
export type TeardownReason = 'orphan' | 'navigate' | 'unload';

export interface PageSessionHooks {
  /**
   * Disconnect every observer/timer and remove badge hosts for this frame.
   * Must be idempotent — the session guards against repeat calls, but the
   * underlying body should tolerate being run after partial init too.
   */
  teardown: (reason: TeardownReason) => void;

  /**
   * Content-side reconcile for a same-document navigation. Driven by the
   * background `webNavigation` SPA-nav signal (dispatched as the `rescan`
   * action); this hook is the handler, not the detector. `fromCache` selects
   * the fast app-refocus path (drop dead wrappers + republish) vs. a full
   * DOM rescan.
   */
  onUrlChange: (fromCache: boolean, reason: string) => void;

  /**
   * bfcache restore (`pageshow` with persisted=true): re-register surviving
   * wrappers and rescan so the plugin's wiped grammar is rebuilt.
   */
  restore: () => void;
}

export class PageSession {
  private toreDown = false;

  /**
   * Per-frame lifecycle state, migrated out of `content.ts` module scope
   * (DESIGN_EXTENSION_RESTRUCTURE.md §3.3.1 step 2). These are deliberately
   * public during the transition: the boot/teardown/scheduling logic still
   * lives as free functions in `content.ts` and reaches them through the
   * module-level `pageSession` singleton. Later increments encapsulate them
   * as the surrounding logic moves onto the instance. The observer singletons
   * and `hintsVisible` stay in module scope for now (heavier entanglement).
   */

  /** SW-assigned frame id; null until the liveness Port handshake completes. */
  myFrameId: number | null = null;

  /** In-flight discovery rAF handle, or null when no drain is scheduled. */
  discoveryFrame: number | null = null;

  /** Roots queued for the next discovery drain. */
  readonly pendingDiscoveryRoots: Set<Element> = new Set();

  /** Debounce handles for the three reposition paths. */
  scrollRepositionTimer: ReturnType<typeof setTimeout> | null = null;
  deferredRepositionTimer: ReturnType<typeof setTimeout> | null = null;
  hugeMutationTimer: ReturnType<typeof setTimeout> | null = null;

  /** Debounce handle coalescing the level-triggered reconcile (claim + build). */
  reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Single-flight guard for the band-discovery sweep (reconcile's discover
   * step). True from the moment a sweep is scheduled until its async DOM walk
   * completes, so settle bursts coalesce to one in-flight sweep — never two
   * concurrent walks racing to attach the same element.
   */
  discoverySweepPending = false;

  /** Whether the visibility MutationObserver is currently connected. */
  visibilityMOConnected = false;

  /** The mode flag — "user wants hints showing." */
  hintsVisible = false;

  /**
   * AbortController for every module-level `addEventListener` in this
   * frame's content script. Each listener registers itself with
   * `{ signal: pageSession.eventAbortController.signal }`; orphan teardown
   * calls `abort()` to atomically remove all of them. Without this, the
   * orphan keeps calling its handlers (scroll, focusin/focusout, transitionend,
   * keydown, etc.) which call `chrome.runtime.sendMessage` — which throws
   * synchronously on an invalidated context, surfacing as uncaught errors
   * that saturate the page and make the tab unresponsive.
   */
  readonly eventAbortController = new AbortController();

  /** Convenience alias for the controller's signal — passed as the `signal`
   * option to `addEventListener`. */
  get eventSignal(): AbortSignal {
    return this.eventAbortController.signal;
  }

  constructor(private readonly hooks: PageSessionHooks) {}

  /**
   * The label/grammar session id. Owned by the LabelStage (`label-sync.ts`);
   * surfaced here so callers can read identity through the session object
   * rather than a free function. Rotation still happens in label-sync on
   * alphabet swap.
   */
  get id(): string {
    return getSessionId();
  }

  /**
   * Whether this frame's session has torn down. Read by the hot keydown/keyup
   * handlers to short-circuit once the context is dead, replacing the old
   * module-scope `orphaned` flag.
   */
  get isTornDown(): boolean {
    return this.toreDown;
  }

  /**
   * Cancel every owned timer + abort every owned event listener. Called by
   * `quiesceOrphan` (orphan content-script self-cleanup) so the dying
   * isolated world stops firing setTimeout chains + DOM listeners that
   * each call into the dead `chrome.runtime.*` and throw synchronously.
   *
   * Idempotent. Independent of `teardown` (which fires the caller's hook
   * for higher-level cleanup) — this only kills timers + listeners, not
   * observers/state.
   */
  cancelScheduled(): void {
    if (this.scrollRepositionTimer !== null) { clearTimeout(this.scrollRepositionTimer); this.scrollRepositionTimer = null; }
    if (this.deferredRepositionTimer !== null) { clearTimeout(this.deferredRepositionTimer); this.deferredRepositionTimer = null; }
    if (this.hugeMutationTimer !== null) { clearTimeout(this.hugeMutationTimer); this.hugeMutationTimer = null; }
    if (this.reconcileTimer !== null) { clearTimeout(this.reconcileTimer); this.reconcileTimer = null; }
    if (this.discoveryFrame !== null) {
      try { cancelAnimationFrame(this.discoveryFrame); } catch { /* may not exist */ }
      this.discoveryFrame = null;
    }
    this.pendingDiscoveryRoots.clear();
    // abort() is idempotent on AbortController (no-op after first call).
    try { this.eventAbortController.abort(); } catch { /* never throws but be defensive */ }
  }

  /** Tear down this frame's session. Idempotent. */
  teardown(reason: TeardownReason): void {
    if (this.toreDown) return;
    this.toreDown = true;
    this.hooks.teardown(reason);
  }

  /** Reconcile after a same-document navigation. See `onUrlChange` hook. */
  onUrlChange(fromCache: boolean, reason: string): void {
    this.hooks.onUrlChange(fromCache, reason);
  }

  /** Rebuild grammar after a bfcache restore. See `restore` hook. */
  restore(): void {
    this.hooks.restore();
  }
}

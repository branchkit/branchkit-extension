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

  /** Whether the visibility MutationObserver is currently connected. */
  visibilityMOConnected = false;

  /** The mode flag — "user wants hints showing." */
  hintsVisible = false;

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

  /** Tear down this frame's session. Idempotent. */
  teardown(reason: TeardownReason): void {
    if (this.toreDown) return;
    this.toreDown = true;
    this.hooks.teardown(reason);
  }
}

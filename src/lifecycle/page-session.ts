/**
 * BranchKit Browser — per-frame page lifecycle.
 *
 * One `PageSession` per content-script context. It is the single object that
 * represents "this frame's hinting session": its identity, its lifecycle
 * transitions (boot, SPA navigation, teardown), and — since the Tier 3
 * relocation (notes/DESIGN_EXTENSION_RESTRUCTURE.md step 10) — the
 * construction of the six observers that feed the session. `start()` builds
 * the IntersectionTracker / ResizeObserver / AttentionObserver here and asks
 * the visibility-tracker and mutation-source modules to construct theirs, so
 * the session is the one owner of observer construction; the extracted source
 * modules import the `pageSession` singleton directly instead of being wired
 * through per-module init seams.
 *
 * The orchestration the observers still reach back into content.ts for
 * (codeword-claim sync, the discovery walk, the reposition schedulers, paint)
 * arrives once through `start(deps)` — the single remaining seam, consumed by
 * the unified-reconciler work (notes/DESIGN_UNIFIED_RECONCILER.md).
 */

import { store } from '../core/store';
import { DiscoverySource, ElementWrapper } from '../scan/element-wrapper';
import { scanSingle, isHintable } from '../scan/scanner';
import { IntersectionTracker } from '../observe/intersection-tracker';
import { AttentionObserver } from '../observe/attention-observer';
import { attachWrapper, detachWrapper } from '../core/wrapper-lifecycle';
import {
  constructVisibilityObservers,
  trackPendingCandidate,
  untrackPendingCandidate,
} from '../observe/visibility-tracker';
import { constructPageMutationObserver } from '../observe/mutation-source';
import { getSessionId } from '../labels/label-sync';
import { SessionResources } from './session-resources';

/**
 * Why a session is tearing down. Carried so the teardown body (and its log
 * line) can distinguish the cases that today all funnel through the same
 * observer-disconnect path:
 *   - 'orphan'     — extension reloaded; our chrome.* context is dead but the
 *                    JS context lives on (the original quiesceOrphan trigger).
 *   - 'navigate'   — hard same-origin/cross-document unload (future use).
 *   - 'unload'     — page going away (future use).
 *   - 'superseded' — the guard keeper found another content script owning
 *                    this frame's idempotency guard; the elder copy converges
 *                    the frame back to a single CS by quiescing itself.
 */
export type TeardownReason = 'orphan' | 'navigate' | 'unload' | 'superseded';

/**
 * The content.ts-owned orchestration the session and its observers drive.
 * Passed once to `start()`. Everything here is a function that reaches the
 * render/grammar/discovery surfaces still living in content.ts module scope;
 * pure store mutation lives in the importable modules and needs no seam.
 */
export interface PageSessionDeps {
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

  /**
   * IntersectionTracker flush changed codewords: drive the delta-sync
   * Put/Delete bookkeeping, the claim-path counters, and the build-up
   * reconcile. Stays in content.ts — it is grammar/render orchestration,
   * not store mutation.
   */
  onCodewordsChanged: (claimed: ElementWrapper[], released: string[]) => void;

  // --- visibility-tracker collaborators ---

  /** Paint badges after a visibility promotion attached new wrappers. */
  showHints: () => void;

  /** Demoted backstop entry (Phase E of DESIGN_UNIFIED_RECONCILER.md): a
   * between-settle signal (class/style mutation, pointer reveal) requests
   * the unified settle pass instead of running its own loop. Non-extending —
   * the pass fires within the backstop's old 100ms cadence even under
   * sustained churn. */
  schedulePassSoon: () => void;

  // --- mutation-source collaborators ---

  discoverInSubtree: (root: Element, source: DiscoverySource) => number;
  /** Third param: one-slab wall budget for reveal-armed sweeps (round 20);
   * omitted/0 = yield every batch (huge path, idle sweeps). */
  discoverInSubtreeBatched: (root: Element, source: DiscoverySource, slabBudgetMs?: number) => Promise<number>;
  reevaluateAttribute: (target: Element) => boolean;
  scheduleReposition: () => void;
  scheduleDeferredReposition: () => void;
}

export class PageSession {
  private toreDown = false;

  /**
   * Content.ts orchestration, set by `start()`. Public so the source modules
   * (mutation-source, visibility-tracker) reach it through the singleton; in
   * tests it is assigned directly with stubs.
   */
  deps!: PageSessionDeps;

  /**
   * Owned listeners/intervals/timeouts/rAFs/observers (Phase 2a of
   * notes/DESIGN_TEARDOWN_OWNERSHIP.md). Resources created through these
   * helpers are torn down as a set by `quiesceOrphan` via `teardownAll()`,
   * so creation and teardown can't drift. Migration is incremental; the
   * sendMessage throw still backstops anything not yet routed through here.
   */
  readonly resources = new SessionResources();

  /**
   * The session-owned observers, constructed by `start()`. Public and
   * assignable: production code reads them; unit tests install fakes without
   * constructing the real (happy-dom-less) observers.
   */

  /** Narrow-margin IO driving codeword claim/release. */
  tracker!: IntersectionTracker;

  /**
   * Safety net for CSS-driven visibility changes the MutationObserver can't
   * see. The MO's attribute filter watches `disabled`, `aria-hidden`, `role`,
   * `contenteditable`, `href` — a `display:none` toggle (via class change or
   * inline `style`) flies past it. When an element's bounding rect collapses
   * to zero, RO fires; we re-evaluate hintability and detach if it's no
   * longer hintable.
   *
   * One-directional: detects hintable → non-hintable, but can't catch the
   * reverse (an element going from `display:none` to visible) since RO
   * only observes elements we already know about. The forward-direction
   * case is the one that matters for pool hygiene — keeping codewords
   * attached to invisible elements would leak the budget.
   */
  resizeObserver!: ResizeObserver;

  /**
   * Viewport-scoped attention. Wide-margin IO (2 viewports above/below)
   * drives the lifecycle of candidates that aren't yet wrappers. Distinct
   * from the IntersectionTracker (narrow-margin IO for codeword claim/
   * release) by design — different concerns, different margins. See
   * notes/DESIGN_OBSERVER_DRIVEN_LAYOUT.md.
   */
  attentionObserver!: AttentionObserver;

  /**
   * Per-frame lifecycle state, migrated out of `content.ts` module scope
   * (DESIGN_EXTENSION_RESTRUCTURE.md §3.3.1 step 2). These are deliberately
   * public during the transition: the boot/teardown/scheduling logic still
   * lives as free functions in `content.ts` and reaches them through the
   * `pageSession` singleton.
   */

  /** SW-assigned frame id; null until the liveness Port handshake completes. */
  myFrameId: number | null = null;

  /** Single-flight flag for the yield-scheduled discovery drain (entry and
   * chain share it). The yield task itself is not cancellable — teardown
   * relies on drainDiscovery's isTornDown guard; this flag just prevents
   * double-scheduling. */
  discoveryScheduled = false;

  /** Roots queued for the next discovery drain. */
  readonly pendingDiscoveryRoots: Set<Element> = new Set();

  /** Debounce handles for the three reposition paths. */
  scrollRepositionTimer: ReturnType<typeof setTimeout> | null = null;
  deferredRepositionTimer: ReturnType<typeof setTimeout> | null = null;
  hugeMutationTimer: ReturnType<typeof setTimeout> | null = null;
  /** Max-wait companion to hugeMutationTimer (debounce+deadline shape): armed
   * by the first huge batch of a mutation storm, non-extending, so a
   * sustained storm can't defer the coarse refresh indefinitely. */
  hugeMutationDeadline: ReturnType<typeof setTimeout> | null = null;

  /** Debounce handle coalescing the level-triggered reconcile (claim + build). */
  reconcileTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Single-flight guard for the band-discovery sweep (reconcile's discover
   * step). True from the moment a sweep is scheduled until its async DOM walk
   * completes, so settle bursts coalesce to one in-flight sweep — never two
   * concurrent walks racing to attach the same element.
   */
  discoverySweepPending = false;

  /**
   * Set true when a coalesced scheduleBandDiscovery request arrives during an
   * in-flight sweep. The finally block reads this to decide whether to schedule
   * one bounded retry — the dropped request might have been triggered by a row
   * insertion that landed after the sweep's enumeration pass (the scroll-back
   * missing-badge gap). Reset to false on each new sweep start.
   */
  discoverySweepRerun = false;

  /**
   * Set true when a MASS-REVEAL request (settle plan repaired
   * >= REVEAL_REPAIR_FAST_ARM stale band flags) coalesces into an in-flight
   * sweep — the fast-arm the single-flight bail would otherwise swallow.
   * The finally block consumes it to re-arm immediately, bypassing the
   * added===0 retry gate: this is an explicit fresh reveal signal, not the
   * race heuristic (DESIGN_FLING_WAVE round 18b — on QuickBase the reveal
   * waves arrive ~600ms apart, so a sweep is nearly always in flight when
   * the big repair lands, and the swallowed fast-arm cost ~2s).
   */
  discoverySweepFastRerun = false;

  /**
   * Retry depth for the bounded band-discovery re-arm chain. Incremented when
   * the finally block schedules a retry, capped at MAX_RETRY_DEPTH to prevent
   * indefinite chaining under sustained scroll/mutation. Reset to 0 on any
   * sweep that completes without needing a retry — so steady-state pages don't
   * carry a stale depth into the next scroll-back event.
   */
  discoveryRetryDepth = 0;

  /** Whether the visibility MutationObserver is currently connected. */
  visibilityMOConnected = false;

  /** The mode flag — "user wants hints showing." */
  hintsVisible = false;

  /**
   * Manual-mode defer flag: set when the mutation observer sees a mutation
   * while hints are showing in `manual` visibility mode, so codewords don't
   * shuffle under the user's eyes. doScan() flushes and clears it.
   */
  pendingMutation = false;

  /**
   * Construct the six observers and store the content.ts orchestration deps.
   * Called once from content.ts boot, before any listener/scan can fire.
   * Construction is side-effect-free (no element is observed until the
   * lifecycle paths call `observe`), so relocating it here from module scope
   * changes no behavior.
   */
  start(deps: PageSessionDeps): void {
    this.deps = deps;

    this.tracker = new IntersectionTracker(store, {
      onCodewordsChanged: (claimed, released) => this.deps.onCodewordsChanged(claimed, released),
    });

    this.resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target;
        const wrapper = store.findWrapperFor(el);
        if (!wrapper) continue;
        // Limbo wrappers: hold codeword + badge until finalize/rebind.
        // Disconnected elements deterministically fail isHintable; we don't
        // want that path stealing the wrapper out from under the limbo
        // lifecycle.
        if (wrapper.disconnectedAt !== null) continue;
        if (!isHintable(el)) {
          // detachWrapper emits a store detach delta → grammar sync (Tier 2).
          detachWrapper(el);
        }
      }
    });

    this.attentionObserver = new AttentionObserver({
      onEnter: (el) => {
        if (!el.isConnected) return;
        if (store.findWrapperFor(el)) return;
        const scanned = scanSingle(el);
        if (scanned) {
          // attachWrapper emits a store attach delta → grammar sync (Tier 2).
          attachWrapper(new ElementWrapper(el, scanned), 'attention');
          return;
        }
        // Still not hintable (visibility:hidden, opacity:0, etc.). Bounded
        // by attention region — only stays in the recheck loop while near
        // the viewport. visibilityMO watches for class/style flips that
        // make it hintable.
        trackPendingCandidate(el);
      },
      onLeave: (el) => {
        // Deliberately NOT detaching wrappers on attention-leave (Rango model).
        // Wrappers stay alive until their element disconnects from the DOM.
        // The attention IO's role here is just to manage pendingVisibility
        // membership — bounding the visibility-recheck set is what fixed the
        // Firefox unresponsive-script case on YouTube. Detaching wrappers as
        // well introduced two real regressions (Gmail scroll-back lost hints;
        // Gmail unresponsiveness when we tried keeping IO subscriptions alive
        // instead). Better trade-off: wrappers grow with discovered hintables,
        // but scroll-back works correctly and per-event cost stays bounded.
        untrackPendingCandidate(el);
      },
    });

    constructVisibilityObservers();
    constructPageMutationObserver();
  }

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

  /** Tear down this frame's session. Idempotent. */
  teardown(reason: TeardownReason): void {
    if (this.toreDown) return;
    this.toreDown = true;
    this.deps.teardown(reason);
  }

  /** Reconcile after a same-document navigation. See `onUrlChange` dep. */
  onUrlChange(fromCache: boolean, reason: string): void {
    this.deps.onUrlChange(fromCache, reason);
  }

  /** Rebuild grammar after a bfcache restore. See `restore` dep. */
  restore(): void {
    this.deps.restore();
  }
}

/**
 * The per-frame session singleton. Constructed inert at module load (no
 * observers, no deps); content.ts boot calls `start()` exactly once. Source
 * modules import this directly — the per-module init injection seams are gone.
 */
export const pageSession = new PageSession();

/**
 * Chain a continuation task so a backlog drains near-back-to-back while
 * still yielding for input/paint. Prefer `scheduler.yield()` (Chromium): its
 * continuation lands at the FRONT of the task queue, resuming ~1-4ms later —
 * a setTimeout(0) continuation queues BEHIND the page's pending tasks, which
 * mid-fling on QuickBase left ~50-200ms gaps between slices (paint-the-band
 * round-7 residual). Fallback: session-owned 0-timeout (Firefox), torn down
 * with the session.
 *
 * The yield path is NOT cancellable — every callback chained through here
 * must re-check `pageSession.isTornDown` (and any of its own gates) at the
 * top, exactly as `drainDiscovery` does. Shared by the discovery drain and
 * the band-build continuation so the two chains cannot drift
 * (notes/DESIGN_FLING_WAVE.md step 2).
 */
export function scheduleYieldTask(cb: () => void): void {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sched?.yield === 'function') {
    void sched.yield().then(cb);
  } else {
    pageSession.resources.timeout(cb, 0);
  }
}

/**
 * Awaitable sibling of `scheduleYieldTask` for async walks that yield
 * between batches. Same preference order and the same caveats: the
 * scheduler.yield continuation is NOT cancellable, so the awaiting loop
 * must re-check `pageSession.isTornDown` after each hop.
 *
 * Exists because the discovery sweep's inter-batch `setTimeout(0)` hops
 * queue BEHIND the page's pending tasks — mid-storm on QuickBase that was
 * 50-150ms per hop × ~45 batches ≈ the entire 3-4s "late wave"
 * (notes/DESIGN_FLING_WAVE.md round 17), the same starvation class the
 * round-3 rAF-entry fix addressed for drainDiscovery.
 */
export function yieldTask(): Promise<void> {
  const sched = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (typeof sched?.yield === 'function') return sched.yield();
  return new Promise((r) => pageSession.resources.timeout(r, 0));
}

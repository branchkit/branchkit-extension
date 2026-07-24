/**
 * Machinery gate — the deferred/active/suspended state machine for a frame's
 * hint machinery, plus the machinery half of session teardown.
 *
 * The round-3 lift rejected in DESIGN_RESTRUCTURE_ROUND3.md sec 8, landed
 * once the teardown arc gave it a home (DESIGN_ORPHAN_PAINT.md layer 5;
 * ownership contract in content.ts above quiesceOrphan). Owns:
 *
 *   - activate / suspend / resume (Levers 2+3: lazy discovery on first
 *     show; hidden-tab suspend of the MutationObserver + discovery loop)
 *   - the persistent visibilitychange handler driving those transitions +
 *     registry-level pause/resume of pausable intervals
 *   - teardownMachinery: stopping the suspend/resume-cycled machinery at
 *     session teardown (mutation source, visibility tracker, discovery
 *     queue, reconcile loop). Per the ownership contract this machinery is
 *     RE-CREATED across suspend/resume, so the one-shot SessionResources
 *     registry is the wrong owner — this module, which cycles it, is.
 *
 * Timing contract (the reason round 3 rejected a naive relocation):
 * NOTHING registers at import time. content.ts calls registerMachineryGate
 * at the exact point in its module evaluation where the visibilitychange
 * listener + initial-pause decision always lived, so listener registration
 * order and the "intervals armed earlier cannot tick before the initial
 * pause lands" guarantee are unchanged. Deps that remain content.ts-local
 * (boot orchestration, gauge, engine instance) are injected here; leaf
 * modules are imported directly.
 *
 * Resurrection guards (Phase 1, DESIGN_TEARDOWN_OWNERSHIP.md) stay on the
 * work functions: a torn-down orphan must not re-arm what teardown stopped,
 * and every guarded hit is counted via the injected recordOrphanHit.
 */

import { pageSession } from './page-session';
import { store } from '../core/store';
import { doScan } from '../scan/scan-orchestrator';
import { attachPageMutationObserver, teardownMutationSource } from '../observe/mutation-source';
import { teardownVisibilityTracker } from '../observe/visibility-tracker';
import { drain as drainReconcilePositioner } from '../render/reconcile-positioner';
import { drainClipObservers } from '../observe/clip-observer';
import { finalizeExpiredLimboWrappers, LIMBO_DEADLINE_MS } from '../observe/limbo';
import { labelReservoir } from '../labels/label-reservoir';
import { bkLog } from '../debug/bk-log';
import type { SettleEngine } from './settle-engine';

export interface MachineryGateDeps {
  /** The settle engine content.ts constructs over its collaborators. */
  engine: SettleEngine;
  /** Orphan-activity gauge (content.ts) — counts guarded resurrection hits. */
  recordOrphanHit: () => void;
  /** Boot orchestration kept in content.ts. */
  kickInitialScan: () => void;
  showBadges: () => Promise<void>;
  frameMayHoldHints: () => boolean;
  trimFrameUrl: (href: string) => string;
}

let deps: MachineryGateDeps;

export function activateHintMachinery(trigger: 'load' | 'resize'): void {
  // Resurrection guard: a torn-down orphan (e.g. a visibilitychange after
  // supersede) must not re-arm the MutationObserver + scan loop that teardown
  // stopped. See notes/DESIGN_TEARDOWN_OWNERSHIP.md.
  if (pageSession.isTornDown) { deps.recordOrphanHit(); return; }
  if (pageSession.hintMachineryEnabled) return;
  pageSession.hintMachineryEnabled = true;
  // Open the boot window: convergence backstops run hot while the page's
  // app renders (late-reveal regions the MO pre-dates — the QuickBase
  // tab-reopen trail). See BOOT_WINDOW_MS in settle-engine.ts.
  deps.engine.noteActivated();
  attachPageMutationObserver();
  // The limbo finalize sweep, registered exactly once per session (this
  // function is guarded by pageSession.hintMachineryEnabled). A pausable: it stops while
  // the tab is hidden — a 250ms whole-store walk was the second continuous
  // hidden-tab cost after the MO (long-session-perf finding 7) — and
  // teardownAll clears it instead of leaving an orphan sweeper running.
  // onVisibilityChange drives pause/resume at the registry level.
  pageSession.resources.pausableInterval(finalizeExpiredLimboWrappers, LIMBO_DEADLINE_MS);
  if (trigger === 'resize') {
    // Subframe that just grew past the eligibility threshold. The module-
    // load reservoir warm-up was skipped (frame was too small / blank),
    // so warm it now before the first scan so the IO claim path doesn't
    // pay an IPC round-trip on its first batch.
    if (typeof chrome !== 'undefined' && chrome.runtime) {
      void labelReservoir.ensureReady();
    }
    pageSession.resources.timeout(() => doScan(), 0);
  }
}

// Lever 3 (hidden-tab suspend): stop reacting to the page's DOM churn while the
// tab is backgrounded. Disconnect ONLY the page MutationObserver (the lone
// continuous cost in a hidden tab — the IO/resize observers are dormant without
// scroll/relayout) and cancel the discovery rAF. Preserve wrappers, codewords,
// pool claims, badges, registry: this is reversible, NOT teardown
// (cf. quiesceOrphan). See notes/DESIGN_HIDDEN_TAB_SUSPEND.md.
export function suspendHintMachinery(): void {
  if (pageSession.suspended || !pageSession.hintMachineryEnabled) return;
  pageSession.suspended = true;
  teardownMutationSource();
  // The limbo finalize sweep pauses too, but at the registry level: the
  // caller (onVisibilityChange) follows this with resources.pause(), which
  // stops every pausable interval. Pausing it is safe: the mutation source
  // is now down, so no new wrappers enter limbo while hidden; resume re-arms
  // it and doScan reaps anything expired (long-session-perf finding 7).
  // The discovery drain is a yield task (not cancellable): clearing the
  // queue makes an already-scheduled continuation a no-op (empty-set
  // return), and the reset flag lets resume re-schedule cleanly.
  pageSession.discoveryScheduled = false;
  pageSession.pendingDiscoveryRoots.clear();
  bkLog('BK_SUSPEND', { url: deps.trimFrameUrl(window.location.href), wrappers: store.all.length });
}

// Re-arm the page MutationObserver and catch up on whatever the page mutated
// while we were suspended: doScan discovers new content + drops detached
// wrappers, reconcile refreshes viewport claims. Mirrors the from_cache
// reactivate path; doScan's scanChain serializes this against the background's
// reactivate so there's no duplicate-codeword race.
export function resumeHintMachinery(): void {
  // Resurrection guard (see activateHintMachinery): a torn-down orphan that
  // goes visible must not resume the MutationObserver + scan loop.
  if (pageSession.isTornDown) { deps.recordOrphanHit(); return; }
  if (!pageSession.suspended) return;
  pageSession.suspended = false;
  // Re-opening after a hidden-tab suspend has the same late-render shape as
  // boot (the suspend window went unobserved) — run the backstops hot again.
  deps.engine.noteActivated();
  attachPageMutationObserver();
  void doScan().then(() => {
    deps.engine.reconcile();
    void pageSession.tracker.flushNow();
    if (pageSession.badgesVisible) void deps.showBadges();
  });
  bkLog('BK_RESUME', { url: deps.trimFrameUrl(window.location.href), wrappers: store.all.length });
}

// One persistent visibilitychange handler driving the deferred/active/suspended
// state machine for an eligible frame, plus the registry-level pause/resume of
// every pausable interval (limbo sweep, top-frame watchdog + perf publishers).
// A subframe inherits the top document's visibility, so the whole tab
// transitions as a unit.
//   - Lever 2 (lazy discovery): a tab that loaded hidden activates on first show.
//   - Lever 3 (suspend): an active tab suspends when hidden, resumes when shown.
function onVisibilityChange(): void {
  if (document.visibilityState === 'visible') {
    // Re-arm pausables BEFORE the eligibility gate and the machinery resume:
    // pausables exist independently of hint machinery (the top-frame watchdog
    // and perf publishers run even before activation), and resumeHintMachinery's
    // doScan should run with a live limbo sweep.
    pageSession.resources.resume();
    if (!deps.frameMayHoldHints()) return;
    if (!pageSession.hintMachineryEnabled) {
      // First show of a tab that loaded hidden. 'load' relies on the storage
      // callback for the first scan, but that returned early while hidden —
      // kick it here.
      activateHintMachinery('load');
      deps.kickInitialScan();
    } else if (pageSession.suspended) {
      resumeHintMachinery();
    }
  } else {
    if (deps.frameMayHoldHints() && pageSession.hintMachineryEnabled && !pageSession.suspended) {
      suspendHintMachinery();
    }
    pageSession.resources.pause();
  }
}

/**
 * Stop the suspend/resume-cycled machinery at session teardown — the
 * machinery half of quiesceOrphan's body (ownership contract, content.ts).
 * Each call tears down the CURRENT generation; all idempotent.
 */
export function teardownMachinery(): void {
  teardownMutationSource();
  teardownVisibilityTracker();
  // The discovery drain is a yield task (not cancellable) — clear the
  // queue and reset the flag; drainDiscovery's isTornDown guard makes the
  // already-scheduled continuation inert.
  pageSession.discoveryScheduled = false;
  pageSession.pendingDiscoveryRoots.clear();
  // Stop the reconcile scroll loop and drop every reconcile-mode badge from
  // the positioner registry. quiesceOrphan's host-removal sweep bypasses
  // HintBadge.remove() (the only per-badge unregister site), so without this
  // the registry would retain dead badges and a stray settle/scroll pass
  // could iterate and reflow detached frames. drain() is a no-op when the
  // registry is empty.
  try {
    deps.engine.stopScrollLoop();
    drainReconcilePositioner();
    drainClipObservers();
  } catch { /* each step best-effort; teardown must not throw */ }
}

/**
 * Bind deps and register the visibilitychange driver + initial pausable
 * state. Called from content.ts at the SAME point in module evaluation the
 * inline registration always occupied (see timing contract above).
 */
export function registerMachineryGate(d: MachineryGateDeps): void {
  deps = d;
  pageSession.resources.listen(document, 'visibilitychange', onVisibilityChange);
  // Initial pausable state must match initial visibility: a tab loaded hidden
  // (background open, prerender) pays no pausable wakeups until first shown.
  // Module evaluation is synchronous, so intervals armed earlier in
  // content.ts (the top-frame watchdog) cannot tick before this pause lands.
  if (document.visibilityState !== 'visible') pageSession.resources.pause();
}

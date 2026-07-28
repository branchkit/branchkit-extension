/**
 * BranchKit Browser — the perf snapshot integrator and its two publishers.
 *
 * `buildPerfSnapshot` merges every counter surface in the extension into one
 * object; `publishPerfSnapshot` mirrors it to a dataset attribute for
 * cross-world reads (harness builds, top frame); `shipPerfReport` sends it to
 * the browser plugin every 5s for the durable JSONL trail.
 *
 * Lifted out of `content.ts` (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md phase 4).
 * `perf-report.ts`'s header used to claim this integrator "stays in content.ts
 * by design (it reads counters from everywhere)" — reading from everywhere is
 * a reason to be a leaf that imports widely, not a reason to sit in the entry
 * point. Nothing imports this module but `content.ts`, so the wide import list
 * closes no cycle (lint F).
 */

import { store } from '../core/store';
import { pageSession } from '../lifecycle/page-session';
import { geometryInBand } from '../core/layout-cache';
import { VIEWPORT_MARGIN_PX } from '../observe/intersection-tracker';
import { getPerfCounters, resetPerfCounters } from '../scan/scanner';
import { rebindCounters } from '../observe/limbo';
import { harnessHooksEnabled } from './harness-hooks';
import { resetMessageCounters, messageCountersSnapshot } from './message-counters';
import {
  claimCounters, computeCpuShare, cpuBucketsSnapshot, lifecycleCounters,
  longtaskSnapshot, rearmCpuShareBaseline, rearmWatchdogBaseline,
  resetCpuCounters, resetLifecycleCounters, resetLongtask, resetWatchdog,
  watchdogSnapshot,
} from './perf-counters';

// Scan / hintability perf snapshot. Counters are cumulative since CS load
// (or last reset). Useful diff sequence: reset → interact for N seconds →
// read. Surfaces "are we paying 5000 getComputedStyle calls per scan?".
// `advanceShareBaseline` gates the rolling cpu.share window. Only the
// durable 5s ship (shipPerfReport) should advance it; the 250ms live
// publisher must read without consuming the delta, or it cannibalizes
// the window the trail is meant to measure (pct collapses to ~0 and
// share.buckets goes empty — the YouTube-investigation measurement gap).
export function buildPerfSnapshot(advanceShareBaseline = false) {
  // Walk the store once to split connected from limbo. Limbo wrappers
  // have `disconnectedAt !== null` — the design's "wrapper held while
  // we wait for a possible rebind" state. A monotonically-climbing
  // limboCount across the leak samples is the signature of a
  // finalize-sweeper that's falling behind.
  let limbo = 0;
  let sentinelDisconnected = 0;
  let inViewport = 0;
  let inViewportWithCodeword = 0;
  // Band membership derived live (no stored flag — DESIGN_OBSERVED_STATE_
  // READ_TIME phase 3): one rect read per live wrapper at snapshot cadence
  // (5s ship / on-demand), the same price the band-convergence pass pays.
  const __vw = window.innerWidth, __vh = window.innerHeight;
  for (const w of store.all) {
    if (w.disconnectedAt !== null) { limbo++; continue; }
    if (!w.element.isConnected) { sentinelDisconnected++; continue; }
    let __inBand = false;
    try {
      __inBand = geometryInBand(w.element.getBoundingClientRect(), __vw, __vh, VIEWPORT_MARGIN_PX);
    } catch { /* detached mid-read */ }
    if (__inBand) {
      inViewport++;
      if (w.scanned.codeword) inViewportWithCodeword++;
    }
  }
  const engine = pageSession.engine;
  return {
    ...getPerfCounters(),
    // Publish timestamp. The dataset mirror freezes while the tab is hidden
    // (visibility gate below), so consumers need this to tell a fresh snapshot
    // from one stranded at the moment the tab was backgrounded.
    ts: Date.now(),
    // Subframe count of this (top) frame — preserves the ad-frame-swarm signal
    // now that subframes no longer ship their own trail entries.
    frames: window.length,
    // Total DOM element count (live-collection length, O(1) read) — the
    // giant-DOM breaker's Phase-0 input (notes/DESIGN_GIANT_DOM_BREAKER.md):
    // correlate >25k-element pages with the walk/store cpu buckets to pick
    // the breaker option. No machinery before the numbers.
    domElementCount: document.getElementsByTagName('*').length,
    wrapperCount: store.all.length,
    wrapperLimboCount: limbo,
    // claim.* splits codeword acquisition by path so we can see if the scan
    // path went silent while the viewport tracker kept the visible handful
    // alive.
    claim: { ...claimCounters },
    // Direct symptom metric: of wrappers the tracker considers in-viewport
    // (IO band margin), how many actually hold a codeword. < 1.0 ratio = the
    // visible-links-without-badges bug.
    inViewportWrappers: inViewport,
    inViewportWithCodeword,
    // Disconnected wrappers that aren't yet in limbo. Should be ≈ 0 in
    // steady state; nonzero means dropDisconnectedWrappers isn't being
    // called between detach and snapshot.
    wrapperDisconnectedOutOfLimbo: sentinelDisconnected,
    lifecycleCounters: { ...lifecycleCounters },
    rebindCounters: { ...rebindCounters },
    messages: messageCountersSnapshot(),
    cpu: {
      // share: rolling CPU share since the prior snapshot publish — the
      // metric Firefox uses to flag "extension is slowing things down."
      // advanceShareBaseline gates the rolling window so only the durable
      // 5s ship advances it; see computeCpuShare in debug/perf-counters.
      share: computeCpuShare(advanceShareBaseline),
      buckets: cpuBucketsSnapshot(),
      longtask: longtaskSnapshot(),
      watchdog: watchdogSnapshot(),
    },
    // Grammar-epoch tripwire (Phase 2a of DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md):
    // checks should climb with sync traffic; mismatches should stay 0 except
    // around the enumerated republish triggers — those firings are the
    // evidence Phase 3 needs before retiring them.
    // What the settle pass DID (Phase E, decision 4 of the unified-reconciler
    // note): per-class applied counts for the last pass + cumulative. The
    // plan is authoritative, so this replaces the old shadow counts/diff.
    reconcileApplied: {
      passes: engine.applied.passes,
      last: { ...engine.applied.last },
      total: { ...engine.applied.total },
    },
  };
}

// Cross-world bridge: content script globals live in the isolated world,
// so Playwright's page.evaluate (main world) can't call them directly.
// Mirror the snapshot to a documentElement dataset attribute every 250ms
// so any world can read it. The interval is a pausable, so hidden tabs skip
// the work entirely — including the timer wakeup (the dataset goes stale,
// not empty): the snapshot walks the whole wrapper store and the JSON grows
// with CPU-bucket count, and Firefox only throttles hidden-tab timers to
// ~1s (vs Chrome's ~1/min), so unpaused this was a store-walk + stringify
// per second per hidden tab, times days of accumulated tabs. Direct one-shot
// calls (boot marker, reset-handshake confirmation) publish regardless of
// visibility: a tab loaded hidden must still publish once so dataset
// presence works as a liveness probe (scripts/_test-extension-reload-
// firefox.mjs), and a reset delivered to a hidden tab must confirm with
// zeroed counters or drivers diff against pre-reset history
// (scripts/test-perf.mjs).
export function publishPerfSnapshot(): void {
  if (!harnessHooksEnabled()) return;
  try {
    document.documentElement.dataset.branchkitPerf =
      JSON.stringify(buildPerfSnapshot());
  } catch { /* dom not ready */ }
}

// Periodic ship to the browser plugin's /perf-report endpoint so we have
// a JSONL trail in `~/Library/Application Support/BranchKitDev/plugins/
// browser/extension-perf.jsonl` for offline analysis. The dataset
// publish above is for live in-page inspection; this is the durable
// record. Every 5s is the sample interval — slow enough to be cheap,
// fast enough to bracket a Firefox unresponsive-script event.
// Visible tabs only (the interval is a pausable, stopped while hidden): a
// hidden tab has nothing new to report, and every ship is a sendMessage
// that resets the background's idle timer — with N accumulated tabs that's
// N/5 wakeups/sec keeping the Firefox event page (and the plugin's
// /perf-report handler) permanently hot. The trail keeps full coverage of
// the tab the user is actually looking at.
export function shipPerfReport(): void {
  try {
    const snapshot = buildPerfSnapshot(true);
    const ua = navigator.userAgent;
    const browser = /Firefox\//i.test(ua) ? 'firefox' : /Chrome\//i.test(ua) ? 'chrome' : 'other';
    chrome.runtime.sendMessage({
      type: 'PERF_REPORT',
      url: location.href,
      browser,
      snapshot,
    }).catch(() => {/* extension context may be invalidated */});
  } catch {
    /* extension orphan or chrome.runtime missing */
  }
}

const PERF_REPORT_INTERVAL_MS = 5000;

/**
 * Install the perf surfaces: console globals in every frame, the dataset
 * mirror and the durable ship in the top frame only.
 *
 * Called once from `content.ts` at the end of boot. The timers are session
 * resources, so a teardown takes them with it.
 */
export function installPerfReporting(): void {
  const isTopFrame = window === window.top;

  (window as any).branchkitPerfStats = buildPerfSnapshot;
  (window as any).branchkitResetPerf = (): void => {
    resetPerfCounters();
    resetMessageCounters();
    resetLifecycleCounters();
    resetCpuCounters();
    resetLongtask();
    resetWatchdog();
  };

  // Top frame only: the dataset mirror exists for Playwright/in-page inspection,
  // which reads the top document's element. A subframe publishing to its own
  // (unread) documentElement is pure 4Hz waste across the ad-frame swarm.
  // Harness builds only: in release this is a 4Hz store-walk+stringify forever
  // AND a page-readable disclosure surface (any site can fingerprint the
  // extension and read the full perf payload). The 5s PERF_REPORT ship below
  // stays — it goes to the paired plugin, not the page.
  if (isTopFrame && harnessHooksEnabled()) {
    pageSession.resources.pausableInterval(publishPerfSnapshot, 250);
    publishPerfSnapshot();
  }

  // Top frame only: each subframe shipping its own snapshot every 5s is what
  // flooded the trail with ~700 ad-frame entries per sample on ad-heavy pages.
  // The top-frame snapshot carries `frames` (subframe count) so the trail still
  // surfaces swarm size without 700 separate sendMessage round-trips.
  if (isTopFrame) {
    pageSession.resources.pausableInterval(shipPerfReport, PERF_REPORT_INTERVAL_MS);
    // Pause stops ships while hidden, which also stops the only cpu.share
    // baseline advance — without a re-arm, the first ship after refocus would
    // compute its share window over the entire hidden span (hours), diluting
    // pct toward 0 and lumping all hidden-period bucket deltas into one bogus
    // trail sample. Re-arm (without shipping) on the visible transition so the
    // first sample covers a normal window; the watchdog baseline needs the
    // same treatment or its first post-resume tick reads the hidden span as
    // one giant stall.
    pageSession.resources.listen(document, 'visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        rearmCpuShareBaseline();
        rearmWatchdogBaseline();
      }
    });
    // Reset trigger from main world — set the dataset to "1" and we reset.
    // Harness builds only (page-dispatchable, plus a standing attribute MO).
    // NOTE: this path deliberately mirrors what content.ts did — it resets
    // five of the six counter groups `branchkitResetPerf` above does, leaving
    // the watchdog baseline alone. That asymmetry predates the lift and is
    // preserved rather than quietly corrected; see §6g.
    if (harnessHooksEnabled()) {
      new MutationObserver(() => {
        if (document.documentElement.dataset.branchkitResetPerf === '1') {
          resetPerfCounters();
          resetMessageCounters();
          resetLifecycleCounters();
          resetCpuCounters();
          resetLongtask();
          delete document.documentElement.dataset.branchkitResetPerf;
          publishPerfSnapshot();
        }
      }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-branchkit-reset-perf'] });
    }
  }
}

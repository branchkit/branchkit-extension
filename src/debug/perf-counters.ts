/**
 * BranchKit Browser — main-thread cost measurement primitives.
 *
 * Three cooperating measurements, all feeding the perf snapshot that
 * content.ts ships to the browser plugin every 5s:
 *   - CPU buckets: wall-clock around suspect long-task paths (recordCpu).
 *   - CPU share: rolling % of the main thread used since the prior publish —
 *     the metric Firefox uses to flag "extension is slowing things down."
 *   - Longtask + watchdog: "did the main thread freeze?" from two angles.
 *
 * This module owns the counters and exposes recordCpu (the injected sink),
 * reset functions, and read-only snapshot/compute accessors. buildPerfSnapshot
 * in content.ts is the integrator that stitches these together with the
 * store/lifecycle counters it owns.
 *
 * Side effect on import: publishes recordCpu on globalThis for peer observer
 * modules. The watchdog interval and longtask observer start via
 * `startPerfObservers(resources)` — owned by the session's resource registry,
 * so teardown stops them and pause/resume quiesces the watchdog while hidden.
 *
 * Extracted from content.ts as part of the extension restructure (step 1,
 * carve leaf concerns). See notes/DESIGN_EXTENSION_RESTRUCTURE.md.
 */

import type { SessionResources } from '../lifecycle/session-resources';

const CPU_TOP_N = 10;

// CPU timing: wall-clock around suspect long-task paths. Each bucket
// records call count, total ms, max single-call ms, and a top-N ring of
// the longest individual calls (with wall-clock timestamps) for forensic
// when Firefox flags an unresponsive script.
type CpuBucket = { count: number; totalMs: number; maxMs: number; top: Array<{ ts: number; ms: number }> };
const cpuBuckets: Record<string, CpuBucket> = {};

export function recordCpu(label: string, ms: number): void {
  let b = cpuBuckets[label];
  if (!b) { b = cpuBuckets[label] = { count: 0, totalMs: 0, maxMs: 0, top: [] }; }
  b.count++;
  b.totalMs += ms;
  if (ms > b.maxMs) b.maxMs = ms;
  if (b.top.length < CPU_TOP_N || ms > (b.top[b.top.length - 1]?.ms ?? 0)) {
    b.top.push({ ts: Date.now(), ms });
    b.top.sort((a, x) => x.ms - a.ms);
    if (b.top.length > CPU_TOP_N) b.top.length = CPU_TOP_N;
  }
  // Breadcrumb for watchdog stall attribution (see pushMark). Skip the
  // `:size:` count-overloaded buckets (their ms field is a target count, not
  // real time) and the watchdog's own record (self-reference).
  if (!label.includes(':size:') && label !== 'watchdog:delay') {
    pushMark(label, ms);
  }
}

// Breadcrumb ring of recent recordCpu marks, for attributing a watchdog stall
// to instrumented work. When the watchdog reports a delay D, the blocking ran
// during the gap [lastFire, now]; summing the marks whose end-time lands in
// that gap tells us how much of D was OUR instrumented JS vs. unattributed
// (browser style/layout/paint of the DOM we injected, or page script — neither
// shows up in a recordCpu bucket). Fixed circular buffer, no per-call alloc.
const MARK_RING = 512;
const markLabel: string[] = new Array(MARK_RING).fill('');
const markEndAt = new Float64Array(MARK_RING); // performance.now() at record time
const markMs = new Float64Array(MARK_RING);
let markHead = 0;
function pushMark(label: string, ms: number): void {
  markLabel[markHead] = label;
  markEndAt[markHead] = performance.now();
  markMs[markHead] = ms;
  markHead = (markHead + 1) % MARK_RING;
}

export function resetCpuCounters(): void {
  for (const k of Object.keys(cpuBuckets)) delete cpuBuckets[k];
  cpuShareLastSumMs = 0;
  cpuShareLastWall = performance.now();
}

/**
 * Sum all bucket totalMs values, skipping the `:size:` overloaded buckets
 * (those store target counts in their ms field — meaningful by themselves
 * but not summable with real ms).
 */
function sumBucketTotalMs(): number {
  let total = 0;
  for (const [k, b] of Object.entries(cpuBuckets)) {
    if (k.includes(':size:')) continue;
    total += b.totalMs;
  }
  return total;
}

// Rolling CPU-share tracker. Firefox's "extension is slowing things down"
// warning fires on sustained CPU share, not single-stall length — see
// notes from the YouTube freeze investigation. Snapshot-to-snapshot delta
// over wall-clock gap gives us "CPU% used in the last sample window."
let cpuShareLastSumMs = 0;
let cpuShareLastWall = performance.now();
const cpuShareBucketPrior: Record<string, { count: number; totalMs: number }> = {};

/**
 * Rolling CPU share since the prior snapshot publish. Sustained percentage
 * of the main thread, not single-stall length — the YouTube investigation
 * showed high per-second invocation rates of small-cost paths add up to
 * 20-37% sustained CPU without any single call exceeding the watchdog's
 * 100ms threshold. The `buckets` block carries per-bucket delta totals so
 * each window can be attributed to specific paths post-hoc.
 *
 * `advanceShareBaseline` gates the rolling window: only the durable 5s ship
 * should advance it; the 250ms live publisher must read without consuming
 * the delta, or it cannibalizes the window the trail is meant to measure.
 */
export function computeCpuShare(advanceShareBaseline: boolean): {
  wallMs: number; sumMs: number; pct: number; buckets: Record<string, { dCount: number; dMs: number }>;
} {
  const curSum = sumBucketTotalMs();
  const curWall = performance.now();
  const wallGap = curWall - cpuShareLastWall;
  const sumGap = Math.max(0, curSum - cpuShareLastSumMs);
  const pct = wallGap > 0 ? (sumGap / wallGap) * 100 : 0;
  // Per-bucket delta since prior publish, computed on read.
  const sinceBuckets: Record<string, { dCount: number; dMs: number }> = {};
  for (const [k, b] of Object.entries(cpuBuckets)) {
    if (k.includes(':size:')) continue;
    const prior = cpuShareBucketPrior[k] || { count: 0, totalMs: 0 };
    const dCount = b.count - prior.count;
    const dMs = b.totalMs - prior.totalMs;
    if (dCount > 0 || dMs > 0.01) {
      sinceBuckets[k] = { dCount, dMs: +dMs.toFixed(2) };
    }
    if (advanceShareBaseline) {
      cpuShareBucketPrior[k] = { count: b.count, totalMs: b.totalMs };
    }
  }
  if (advanceShareBaseline) {
    cpuShareLastSumMs = curSum;
    cpuShareLastWall = curWall;
  }
  return {
    wallMs: +wallGap.toFixed(0),
    sumMs: +sumGap.toFixed(0),
    pct: +pct.toFixed(2),
    buckets: sinceBuckets,
  };
}

/**
 * Advance the cpu-share baseline without producing a sample. Used on the
 * hidden→visible transition: ships are visibility-gated, so the baseline
 * freezes while hidden — without this, the first post-refocus ship would
 * integrate its share window over the whole hidden span.
 */
export function rearmCpuShareBaseline(): void {
  computeCpuShare(true);
}

/** Per-bucket cumulative totals for the snapshot's `cpu.buckets`. */
export function cpuBucketsSnapshot(): Record<string, { count: number; totalMs: number; maxMs: number; top: Array<{ ts: number; ms: number }> }> {
  return Object.fromEntries(
    Object.entries(cpuBuckets).map(([k, b]) => [k, {
      count: b.count,
      totalMs: +b.totalMs.toFixed(2),
      maxMs: +b.maxMs.toFixed(2),
      top: b.top.map(t => ({ ts: t.ts, ms: +t.ms.toFixed(2) })),
    }]),
  );
}

// Expose recordCpu globally so peer modules without a direct content.ts
// import (intersection-tracker, attention-observer) can attribute their
// callback time to the same bucket system content.ts already collects.
// Plain globalThis stash — explicit string contract beats an event-callback
// wire-up that would add an API surface to two observers nothing else
// touches. Read by handleEntries in both observers.
(globalThis as { __branchkitRecordCpu?: (label: string, ms: number) => void }).__branchkitRecordCpu = recordCpu;

// Long Tasks API (Chrome/Edge only; Firefox returns false for supportedEntryTypes).
// Catches anything that monopolizes the main thread for >50ms regardless of source —
// includes work from page scripts, not just ours, so attribution is via the wall-clock
// buckets above. The longtask block answers "did anything block?"; the buckets answer
// "was it us, and which path?".
let longtaskCount = 0;
let longtaskTotalMs = 0;
let longtaskMaxMs = 0;
const longtaskTop: Array<{ ts: number; ms: number }> = [];
let longtaskObserver: PerformanceObserver | null = null;
function startLongtaskObserver(): void {
  try {
    const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
    if (supported?.includes('longtask')) {
      longtaskObserver = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          longtaskCount++;
          longtaskTotalMs += e.duration;
          if (e.duration > longtaskMaxMs) longtaskMaxMs = e.duration;
          if (longtaskTop.length < CPU_TOP_N || e.duration > (longtaskTop[longtaskTop.length - 1]?.ms ?? 0)) {
            longtaskTop.push({ ts: Date.now(), ms: e.duration });
            longtaskTop.sort((a, x) => x.ms - a.ms);
            if (longtaskTop.length > CPU_TOP_N) longtaskTop.length = CPU_TOP_N;
          }
        }
      });
      longtaskObserver.observe({ type: 'longtask', buffered: true });
    }
  } catch { /* PerformanceObserver missing or longtask unsupported */ }
}

export function resetLongtask(): void {
  longtaskCount = 0;
  longtaskTotalMs = 0;
  longtaskMaxMs = 0;
  longtaskTop.length = 0;
}

/** Longtask totals for the snapshot's `cpu.longtask`. */
export function longtaskSnapshot(): { count: number; totalMs: number; maxMs: number; top: Array<{ ts: number; ms: number }>; supported: boolean } {
  return {
    count: longtaskCount,
    totalMs: +longtaskTotalMs.toFixed(2),
    maxMs: +longtaskMaxMs.toFixed(2),
    top: longtaskTop.map(t => ({ ts: t.ts, ms: +t.ms.toFixed(2) })),
    supported: longtaskCount > 0 || (PerformanceObserver as unknown as { supportedEntryTypes?: string[] })
      .supportedEntryTypes?.includes('longtask') || false,
  };
}

// Watchdog: a 4Hz interval that records the gap between expected and actual
// fire times. Firefox doesn't support the Long Tasks API, so this is our only
// direct measurement of "did the main thread freeze." Any source — page
// scripts, browser-internal layout, extension paths we don't instrument —
// shows up here as a delayed fire.
//
// The interval is a SessionResources pausable: it stops entirely while the
// tab is hidden (background-tab timer throttling would otherwise read as a
// continuous freeze, and the wakeups themselves are the hidden-tab cost the
// long-session audit flagged). `rearmWatchdogBaseline()` resets the baseline
// on the visible transition so the first post-resume tick doesn't read the
// whole hidden span as one stall.
//
// Top-N preserves the wall-clock timestamps of the worst stalls so we can
// correlate trail entries to user-reported unresponsive-script events.
const WATCHDOG_INTERVAL_MS = 250;
const WATCHDOG_RECORD_THRESHOLD_MS = 100;
let watchdogLastFire = performance.now();

// Top-N worst stalls with attribution: how much of the stall landed in our
// instrumented buckets (`trackedMs`) vs. went unaccounted (`unattributedMs` =
// browser style/layout/paint of injected DOM, or page script). `topLabels`
// names the heaviest instrumented contributors during the stall window so a
// JS-side cause can be pinpointed. unattributed ≫ tracked ⇒ not our JS.
const STALL_TOP_N = 8;
type WatchdogStall = {
  ts: number; delayMs: number; trackedMs: number; unattributedMs: number;
  topLabels: Array<{ label: string; ms: number; count: number }>;
};
const watchdogStalls: WatchdogStall[] = [];

function attributeStall(windowStart: number, windowEnd: number): { trackedMs: number; topLabels: Array<{ label: string; ms: number; count: number }> } {
  const byLabel: Record<string, { ms: number; count: number }> = {};
  let trackedMs = 0;
  for (let i = 0; i < MARK_RING; i++) {
    const at = markEndAt[i];
    if (at < windowStart || at > windowEnd) continue;
    const label = markLabel[i];
    if (!label) continue;
    const ms = markMs[i];
    trackedMs += ms;
    const e = byLabel[label] || (byLabel[label] = { ms: 0, count: 0 });
    e.ms += ms; e.count++;
  }
  const topLabels = Object.entries(byLabel)
    .map(([label, v]) => ({ label, ms: +v.ms.toFixed(1), count: v.count }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, STALL_TOP_N);
  return { trackedMs: +trackedMs.toFixed(1), topLabels };
}

function watchdogTick(): void {
  const now = performance.now();
  // Defense-in-depth, not the primary gate (that's the registry pause): if a
  // tick still lands while hidden — a pause wire missed, or a document that
  // never gets a visibilitychange at all — background-tab timer throttling
  // (≥1000ms clamps, further when inactive >5min) would read as a permanent
  // fake freeze. Reset the baseline and skip; safe for an interval, where the
  // old self-rescheduling chain would have died on an early return.
  if (document.visibilityState !== 'visible') {
    watchdogLastFire = now;
    return;
  }
  const expected = watchdogLastFire + WATCHDOG_INTERVAL_MS;
  const delay = Math.max(0, now - expected);
  if (delay > WATCHDOG_RECORD_THRESHOLD_MS) {
    recordCpu('watchdog:delay', delay);
    // The blocking work ran somewhere in [watchdogLastFire, now]. Attribute
    // it against the breadcrumb ring captured over that same gap.
    const { trackedMs, topLabels } = attributeStall(watchdogLastFire, now);
    const stall: WatchdogStall = {
      ts: Date.now(),
      delayMs: +delay.toFixed(1),
      trackedMs,
      unattributedMs: +Math.max(0, delay - trackedMs).toFixed(1),
      topLabels,
    };
    if (watchdogStalls.length < STALL_TOP_N || delay > (watchdogStalls[watchdogStalls.length - 1]?.delayMs ?? 0)) {
      watchdogStalls.push(stall);
      watchdogStalls.sort((a, b) => b.delayMs - a.delayMs);
      if (watchdogStalls.length > STALL_TOP_N) watchdogStalls.length = STALL_TOP_N;
    }
  }
  watchdogLastFire = now;
}

// Standing per-frame observers (watchdog interval + longtask PerformanceObserver)
// are diagnostic-only and their output is read solely from the top frame's
// snapshot. Subframes — especially the 1000+ ad/about:blank frames on ad-heavy
// pages — would otherwise each run a 4Hz timer forever, inflating the very
// per-frame CPU footprint that trips Firefox's slow-extension warning. The
// caller gates this to the top frame; inline recordCpu marks stay everywhere
// (cheap) so a frame promoted to top-of-its-process still has fresh attribution.
//
// Both are owned by the passed registry (parameter, NOT a pageSession import —
// that would close a cycle through mutation-source): the watchdog as a
// pausable interval (stops while hidden, dies with teardownAll), the longtask
// observer via track() (disconnected by teardownAll). There is no separate
// stop function — teardown of the registry is the stop.
let perfObserversStarted = false;
export function startPerfObservers(resources: SessionResources): void {
  if (perfObserversStarted) return;
  perfObserversStarted = true;
  watchdogLastFire = performance.now();
  resources.pausableInterval(watchdogTick, WATCHDOG_INTERVAL_MS);
  startLongtaskObserver();
  if (longtaskObserver) resources.track(longtaskObserver);
}

/**
 * Reset the watchdog baseline without recording. Called on the hidden→visible
 * transition: the watchdog pausable was stopped while hidden, so
 * `watchdogLastFire` still points at the last pre-hide tick — without this,
 * the first post-resume tick would read the entire hidden span as one giant
 * stall. Companion to `rearmCpuShareBaseline` on the same transition.
 */
export function rearmWatchdogBaseline(): void {
  watchdogLastFire = performance.now();
}

export function resetWatchdog(): void {
  watchdogStalls.length = 0;
}

/** Worst attributed stalls for the snapshot's `cpu.watchdog`. */
export function watchdogSnapshot(): { stalls: WatchdogStall[] } {
  return { stalls: watchdogStalls.map(s => ({ ...s, topLabels: s.topLabels.map(t => ({ ...t })) })) };
}

/**
 * Lifecycle event counters, written from the wrapper-lifecycle / mutation /
 * discovery paths and read once per `buildPerfSnapshot`. Promoted out of
 * content.ts module scope (Tier 0 of notes/DESIGN_EXTENSION_RESTRUCTURE.md) so
 * the integrator's inputs are explicit and the bump sites can live in the
 * modules being extracted instead of the monolith. A mutable object (not
 * exported `let`s) so importers can increment fields directly.
 */
export interface LifecycleCounters {
  dropDisconnectedCalls: number;
  dropDisconnectedFound: number;
  finalizeSweeps: number;
  finalizeDetached: number;
  moCallbackInvocations: number;
  moForeignRecords: number;
  moRemoveRecordsSeen: number;
  moHugePathFired: number;
  processMutationsCalls: number;
  // childList records whose addedNodes held ONLY non-Element nodes (text /
  // CDATA). The `node instanceof Element` gate skips these entirely — no
  // dom-seen stamp, no discovery walk — yet a text insertion can flip its
  // PARENT hintable (an empty <a> gaining its label). Suspect (c) of the
  // round-15 40%-miss diagnosis; this counts how often the shape occurs.
  moTextOnlyAddRecords: number;
  // Discovery-drain reductions. `Deduped` = roots dropped because a queued
  // ancestor already covers them; `Skipped` = roots whose light DOM held
  // nothing hintable (cheap pre-filter bail).
  discoveryRootsDeduped: number;
  discoveryRootsSkipped: number;
  // Wrappers claim-primed at attach time (in-band by geometry, so the claim
  // didn't wait for IO delivery — notes/DESIGN_FLING_WAVE.md Part 1). Sizes
  // the fresh-row cohort whose attached_to_band stage collapsed to ~0.
  primedClaims: number;
  // Band flags repaired/released by the mid-scroll sweep (rows crossing the
  // band edge mid-fling, caught by geometry ahead of the starved IO —
  // notes/DESIGN_FLING_WAVE.md Part 1c + round 2). Repairs size the
  // entering cohort; releases size the exits that fund the entries' claims
  // (local reservoir round-trip within one sweep).
  bandSweepRepairs: number;
  bandSweepReleases: number;
  // Elements a discovery walk DID reach but rejected as invisible and
  // handed to the attention observer (observeInvisibleCandidates). During a
  // fling, this ≈0 while sweeps attach hundreds means the walk never saw
  // the missed content at all; large means the walk classified it hidden
  // and the promotion path is what's slow. Round-15 discriminator.
  invisibleCandidatesObserved: number;
  // Nonzero-box ResizeObserver deliveries on PARKED candidates (the reveal
  // sensor, notes/DESIGN_FLING_WAVE.md round 21): a parked element gained a
  // box with no mutation our filtered page MO could see (text fill via
  // characterData, CSSOM sizing). Read with attachedBySource.visibility —
  // signals climbing while visibility attaches stay flat means the promote
  // recheck is rejecting what the sensor reports.
  visibilityRoSignals: number;
  // Open shadow roots registered as additional page-MO targets (the walk's
  // sighting hook → observeShadowRootForMutations). Sizes the extra
  // observation surface on shadow-heavy pages; resets with the attach cycle
  // it describes only via resetLifecycleCounters (registration itself is
  // WeakSet-deduped per cycle).
  shadowRootsObserved: number;
  // Settle-trigger scoping (notes/DESIGN_SETTLE_TRIGGER_SCOPING.md): visible
  // compression counters for the relevance gates — never silent drops.
  // visMoIrrelevantSkips = class/style batches that touched no tracked
  // element (no promote, no settle request); moBatchRepositionOnly = foreign
  // page-MO batches downgraded from full settle to a positioner pass.
  visMoIrrelevantSkips: number;
  moBatchRepositionOnly: number;
  // Cumulative wrapper attaches by discovery source (attachWrapper stamps
  // the same value on the wrapper — see DiscoverySource in element-wrapper).
  // Window-scoped per-source latency lives in the debug snapshot's
  // wave.discovery_sources; this is the lifetime count per path.
  attachedBySource: Record<string, number>;
}

export const lifecycleCounters: LifecycleCounters = {
  dropDisconnectedCalls: 0,
  dropDisconnectedFound: 0,
  finalizeSweeps: 0,
  finalizeDetached: 0,
  moCallbackInvocations: 0,
  moForeignRecords: 0,
  moRemoveRecordsSeen: 0,
  moHugePathFired: 0,
  processMutationsCalls: 0,
  moTextOnlyAddRecords: 0,
  discoveryRootsDeduped: 0,
  discoveryRootsSkipped: 0,
  primedClaims: 0,
  bandSweepRepairs: 0,
  bandSweepReleases: 0,
  invisibleCandidatesObserved: 0,
  visibilityRoSignals: 0,
  shadowRootsObserved: 0,
  visMoIrrelevantSkips: 0,
  moBatchRepositionOnly: 0,
  attachedBySource: {},
};

export function resetLifecycleCounters(): void {
  for (const k of Object.keys(lifecycleCounters) as (keyof LifecycleCounters)[]) {
    if (k === 'attachedBySource') continue;
    (lifecycleCounters as unknown as Record<string, number>)[k] = 0;
  }
  lifecycleCounters.attachedBySource = {};
}

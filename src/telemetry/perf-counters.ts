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
 * Side effects on import: installs the longtask observer, starts the
 * watchdog, and publishes recordCpu on globalThis for peer observer modules.
 *
 * Extracted from content.ts as part of the extension restructure (step 1,
 * carve leaf concerns). See notes/DESIGN_EXTENSION_RESTRUCTURE.md.
 */

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
try {
  const supported = (PerformanceObserver as unknown as { supportedEntryTypes?: string[] }).supportedEntryTypes;
  if (supported?.includes('longtask')) {
    new PerformanceObserver((list) => {
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
    }).observe({ type: 'longtask', buffered: true });
  }
} catch { /* PerformanceObserver missing or longtask unsupported */ }

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

// Watchdog: self-rescheduling setTimeout that records the gap between
// expected and actual fire times. Firefox doesn't support the Long Tasks
// API, so this is our only direct measurement of "did the main thread
// freeze." Any source — page scripts, browser-internal layout, extension
// paths we don't instrument — shows up here as a delayed fire.
//
// Skipped while the tab is hidden because Firefox throttles setTimeout to
// 1000ms in background tabs; the throttling would otherwise look like a
// continuous freeze. visibilitychange resets the baseline on un-hide.
//
// Top-N preserves the wall-clock timestamps of the worst stalls so we can
// correlate trail entries to user-reported unresponsive-script events.
const WATCHDOG_INTERVAL_MS = 250;
const WATCHDOG_RECORD_THRESHOLD_MS = 100;
let watchdogLastFire = performance.now();
let watchdogVisibleOnLastFire = document.visibilityState === 'visible';
function watchdogTick(): void {
  const now = performance.now();
  const visible = document.visibilityState === 'visible';
  // Only attribute delay when the tab was visible during BOTH the prior
  // fire and this one. If either was hidden, the gap could be Firefox /
  // Chrome's background-tab setTimeout throttling (clamps to ≥1000ms,
  // further when inactive >5min), not a real main-thread block. Check
  // both ends because event-driven visibility tracking misses tabs that
  // were never visible to begin with (loader iframes, OAuth popups,
  // hidden gapi frames on about:blank) — those would otherwise look
  // like permanent 750-1000ms freezes from the throttle.
  if (visible && watchdogVisibleOnLastFire) {
    const expected = watchdogLastFire + WATCHDOG_INTERVAL_MS;
    const delay = Math.max(0, now - expected);
    if (delay > WATCHDOG_RECORD_THRESHOLD_MS) {
      recordCpu('watchdog:delay', delay);
    }
  }
  watchdogLastFire = now;
  watchdogVisibleOnLastFire = visible;
  setTimeout(watchdogTick, WATCHDOG_INTERVAL_MS);
}
setTimeout(watchdogTick, WATCHDOG_INTERVAL_MS);

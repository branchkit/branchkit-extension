/**
 * BranchKit Browser — perf-snapshot unit tests.
 *
 * This code ran for its whole life inside content.ts, so none of it had ever
 * been executed by a test. What is pinned here is the behaviour the comments
 * in the module claim, in the order they cost something when wrong:
 *
 *   - the store walk's three-way split (limbo / disconnected-out-of-limbo /
 *     in-band), including that the three arms are mutually exclusive,
 *   - the `advanceShareBaseline` gate, which is the YouTube-investigation
 *     measurement gap: the 250ms publisher must NOT consume the cpu.share
 *     delta and the 5s ship MUST,
 *   - frame and harness gating of the two publishers,
 *   - the visibilitychange re-arm, which only fires on the visible edge.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type PerfSnapshot = typeof import('./perf-snapshot');

interface FakeWrapper {
  disconnectedAt: number | null;
  element: { isConnected: boolean; getBoundingClientRect: () => DOMRect };
  scanned: { codeword: string };
}

const wrappers: FakeWrapper[] = [];

/** Rect x-coordinate doubles as the band flag — see the geometryInBand mock. */
function wrapper(over: Partial<{ limbo: boolean; connected: boolean; inBand: boolean; codeword: string; rectThrows: boolean }> = {}): FakeWrapper {
  const { limbo = false, connected = true, inBand = true, codeword = '', rectThrows = false } = over;
  return {
    disconnectedAt: limbo ? 1 : null,
    element: {
      isConnected: connected,
      getBoundingClientRect: () => {
        if (rectThrows) throw new Error('detached mid-read');
        return { x: inBand ? 1 : 0 } as DOMRect;
      },
    },
    scanned: { codeword },
  };
}

let harnessEnabled = true;
let shareCalls: boolean[] = [];
let rearmed: string[] = [];
let resets: string[] = [];
let intervals: Array<{ fn: () => void; ms: number }> = [];
let listeners: Array<{ target: unknown; type: string; fn: (e: Event) => void }> = [];
let sent: Array<Record<string, unknown>> = [];
let sendResult: () => Promise<unknown> = () => Promise.resolve();

// installPerfReporting attaches a MutationObserver to the REAL documentElement,
// which outlives vi.resetModules() — a stale observer from an earlier test kept
// answering the reset trigger, which made the harness-off case look installed
// and the installed case look correct for the wrong reason. Track every
// instance and disconnect between tests.
const RealMutationObserver = globalThis.MutationObserver;
let observers: MutationObserver[] = [];

// The live counter objects the module spreads. Held here by identity so a test
// can mutate them AFTER a snapshot is taken — comparing against a hand-written
// duplicate cannot tell a copy from an alias.
const claimCountersMock = { trackerPathClaimed: 5 };
const lifecycleCountersMock = { longStopRescues: 6 };
const rebindCountersMock = { rebinds: 2 };
const appliedMock = { passes: 3, last: { show: 1 }, total: { show: 9 } };

async function load(): Promise<PerfSnapshot> {
  vi.resetModules();
  vi.doMock('../core/store', () => ({ store: { get all() { return wrappers; } } }));
  vi.doMock('../lifecycle/page-session', () => ({
    pageSession: {
      engine: { applied: appliedMock },
      resources: {
        pausableInterval: (fn: () => void, ms: number) => { intervals.push({ fn, ms }); },
        listen: (target: unknown, type: string, fn: (e: Event) => void) => { listeners.push({ target, type, fn }); },
      },
    },
  }));
  // The band predicate is faked on the rect's x so a test can place a wrapper
  // in or out of the band without reasoning about viewport arithmetic.
  vi.doMock('../core/layout-cache', () => ({ geometryInBand: (r: DOMRect) => r.x === 1 }));
  vi.doMock('../observe/intersection-tracker', () => ({ VIEWPORT_MARGIN_PX: 1000 }));
  vi.doMock('../scan/scanner', () => ({
    getPerfCounters: () => ({ scans: 7 }),
    resetPerfCounters: () => { resets.push('scan'); },
  }));
  vi.doMock('../observe/limbo', () => ({ rebindCounters: rebindCountersMock }));
  vi.doMock('./harness-hooks', () => ({ harnessHooksEnabled: () => harnessEnabled }));
  vi.doMock('./message-counters', () => ({
    messageCountersSnapshot: () => ({ sent: 4 }),
    resetMessageCounters: () => { resets.push('message'); },
  }));
  vi.doMock('./perf-counters', () => ({
    claimCounters: claimCountersMock,
    lifecycleCounters: lifecycleCountersMock,
    computeCpuShare: (advance: boolean) => { shareCalls.push(advance); return { pct: 1 }; },
    cpuBucketsSnapshot: () => ({ walk: 1 }),
    longtaskSnapshot: () => ({ n: 0 }),
    watchdogSnapshot: () => ({ n: 0 }),
    rearmCpuShareBaseline: () => { rearmed.push('cpu'); },
    rearmWatchdogBaseline: () => { rearmed.push('watchdog'); },
    resetCpuCounters: () => { resets.push('cpu'); },
    resetLifecycleCounters: () => { resets.push('lifecycle'); },
    resetLongtask: () => { resets.push('longtask'); },
    resetWatchdog: () => { resets.push('watchdog'); },
  }));
  return await import('./perf-snapshot');
}

function setTopFrame(isTop: boolean): void {
  Object.defineProperty(window, 'top', {
    configurable: true,
    get: () => (isTop ? window : ({} as Window)),
  });
}

beforeEach(() => {
  wrappers.length = 0;
  harnessEnabled = true;
  shareCalls = []; rearmed = []; resets = []; intervals = []; listeners = []; sent = [];
  sendResult = () => Promise.resolve();
  observers = [];
  claimCountersMock.trackerPathClaimed = 5;
  lifecycleCountersMock.longStopRescues = 6;
  rebindCountersMock.rebinds = 2;
  appliedMock.last.show = 1;
  appliedMock.total.show = 9;
  globalThis.MutationObserver = class extends RealMutationObserver {
    constructor(cb: MutationCallback) { super(cb); observers.push(this); }
  };
  setTopFrame(true);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: (msg: Record<string, unknown>) => { sent.push(msg); return sendResult(); } },
  };
  delete document.documentElement.dataset.branchkitPerf;
  delete document.documentElement.dataset.branchkitResetPerf;
});

afterEach(() => {
  for (const o of observers) o.disconnect();
  globalThis.MutationObserver = RealMutationObserver;
  vi.restoreAllMocks();
  for (const m of ['../core/store', '../lifecycle/page-session', '../core/layout-cache',
    '../observe/intersection-tracker', '../scan/scanner', '../observe/limbo',
    './harness-hooks', './message-counters', './perf-counters']) vi.doUnmock(m);
  delete (window as unknown as Record<string, unknown>).branchkitPerfStats;
  delete (window as unknown as Record<string, unknown>).branchkitResetPerf;
});

describe('buildPerfSnapshot store walk', () => {
  it('splits limbo, disconnected-out-of-limbo and in-band into disjoint buckets', async () => {
    const m = await load();
    wrappers.push(
      // A limbo wrapper whose element is ALSO disconnected and ALSO reports a
      // band rect. It must be counted once, as limbo. This is the assertion
      // that fails if the `continue` goes, or if the two guards swap order.
      wrapper({ limbo: true, connected: false, inBand: true, codeword: 'ab' }),
      wrapper({ connected: false }),                       // sentinel: dropped by isConnected
      wrapper({ inBand: true, codeword: 'cd' }),
      wrapper({ inBand: true, codeword: '' }),             // in band, no codeword yet
      wrapper({ inBand: false, codeword: 'ef' }),          // out of band, codeword ignored
    );
    const s = m.buildPerfSnapshot();
    expect(s.wrapperCount).toBe(5);
    expect(s.wrapperLimboCount).toBe(1);
    expect(s.wrapperDisconnectedOutOfLimbo).toBe(1);
    expect(s.inViewportWrappers).toBe(2);
    expect(s.inViewportWithCodeword).toBe(1);
  });

  it('survives a wrapper whose rect read throws, and counts it in no bucket', async () => {
    const m = await load();
    wrappers.push(wrapper({ rectThrows: true, codeword: 'ab' }), wrapper({ inBand: true, codeword: 'cd' }));
    const s = m.buildPerfSnapshot();
    expect(s.inViewportWrappers).toBe(1);
    expect(s.wrapperDisconnectedOutOfLimbo).toBe(0);
  });

  it('carries the counter surfaces and the settle engine\'s applied counts', async () => {
    const m = await load();
    const s = m.buildPerfSnapshot() as unknown as Record<string, unknown>;
    expect(s.scans).toBe(7);                                     // spread from getPerfCounters
    expect(s.claim).toEqual({ trackerPathClaimed: 5 });
    expect(s.rebindCounters).toEqual({ rebinds: 2 });
    expect(s.messages).toEqual({ sent: 4 });
    expect(s.reconcileApplied).toEqual({ passes: 3, last: { show: 1 }, total: { show: 9 } });
  });

  it('copies the mutable counter objects rather than aliasing them', async () => {
    const m = await load();
    const s = m.buildPerfSnapshot();
    // An aliased snapshot keeps mutating after it is taken, which is exactly
    // what "reset → soak → read" and any two-snapshot diff cannot tolerate.
    // Mutating the SOURCE object is the only way to see the difference — an
    // identity check against a hand-written duplicate passes either way.
    claimCountersMock.trackerPathClaimed = 99;
    lifecycleCountersMock.longStopRescues = 99;
    rebindCountersMock.rebinds = 99;
    appliedMock.last.show = 99;
    appliedMock.total.show = 99;
    expect(s.claim).toEqual({ trackerPathClaimed: 5 });
    expect(s.lifecycleCounters).toEqual({ longStopRescues: 6 });
    expect(s.rebindCounters).toEqual({ rebinds: 2 });
    expect(s.reconcileApplied.last).toEqual({ show: 1 });
    expect(s.reconcileApplied.total).toEqual({ show: 9 });
  });
});

describe('the cpu.share baseline gate', () => {
  it('reads without advancing by default and advances only when asked', async () => {
    const m = await load();
    m.buildPerfSnapshot();
    m.buildPerfSnapshot(true);
    expect(shareCalls).toEqual([false, true]);
  });

  it('the 250ms dataset publisher reads without consuming the delta', async () => {
    const m = await load();
    m.publishPerfSnapshot();
    expect(shareCalls).toEqual([false]);
  });

  it('the 5s durable ship is the one that advances the window', async () => {
    const m = await load();
    m.shipPerfReport();
    expect(shareCalls).toEqual([true]);
  });
});

describe('publishPerfSnapshot', () => {
  it('writes the snapshot to the dataset when harness hooks are on', async () => {
    const m = await load();
    wrappers.push(wrapper({ inBand: true, codeword: 'ab' }));
    m.publishPerfSnapshot();
    const parsed = JSON.parse(document.documentElement.dataset.branchkitPerf!);
    expect(parsed.inViewportWithCodeword).toBe(1);
  });

  it('writes nothing at all when harness hooks are off', async () => {
    harnessEnabled = false;
    const m = await load();
    m.publishPerfSnapshot();
    expect(document.documentElement.dataset.branchkitPerf).toBeUndefined();
    // Positive counterpart: the gate is what stopped it, not an inert body.
    harnessEnabled = true;
    m.publishPerfSnapshot();
    expect(document.documentElement.dataset.branchkitPerf).toBeDefined();
  });
});

describe('shipPerfReport', () => {
  it('classifies the browser from the user agent', async () => {
    const m = await load();
    const ua = (s: string) => vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(s);
    ua('Mozilla/5.0 (Macintosh) Gecko/20100101 Firefox/128.0');
    m.shipPerfReport();
    ua('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/126.0.0.0 Safari/537.36');
    m.shipPerfReport();
    ua('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/17.0 Safari/605.1.15');
    m.shipPerfReport();
    expect(sent.map((s) => s.browser)).toEqual(['firefox', 'chrome', 'other']);
    expect(sent.every((s) => s.type === 'PERF_REPORT')).toBe(true);
    expect((sent[0].snapshot as { wrapperCount: number }).wrapperCount).toBe(0);
  });

  it('swallows a rejected send — an invalidated context must not surface as an unhandled rejection', async () => {
    const m = await load();
    const unhandled: unknown[] = [];
    const onUnhandled = (r: unknown) => { unhandled.push(r); };
    process.on('unhandledRejection', onUnhandled);
    try {
      sendResult = () => Promise.reject(new Error('Extension context invalidated'));
      m.shipPerfReport();
      expect(sent).toHaveLength(1);
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('swallows a synchronous throw from a missing chrome.runtime', async () => {
    const m = await load();
    delete (globalThis as unknown as Record<string, unknown>).chrome;
    expect(() => m.shipPerfReport()).not.toThrow();
  });
});

describe('installPerfReporting', () => {
  it('installs the dataset mirror and the durable ship in the top frame', async () => {
    const m = await load();
    m.installPerfReporting();
    expect(intervals.map((i) => i.ms).sort((a, b) => a - b)).toEqual([250, 5000]);
    // The immediate publish: a tab loaded hidden must still mark itself live.
    expect(document.documentElement.dataset.branchkitPerf).toBeDefined();
    expect(listeners.map((l) => l.type)).toEqual(['visibilitychange']);
  });

  it('installs neither timer in a subframe, but keeps the console globals', async () => {
    setTopFrame(false);
    const m = await load();
    m.installPerfReporting();
    expect(intervals).toEqual([]);
    expect(listeners).toEqual([]);
    expect(document.documentElement.dataset.branchkitPerf).toBeUndefined();
    expect(typeof (window as unknown as Record<string, unknown>).branchkitPerfStats).toBe('function');
    expect(typeof (window as unknown as Record<string, unknown>).branchkitResetPerf).toBe('function');
  });

  it('keeps the durable ship but drops the page-readable dataset mirror in release', async () => {
    harnessEnabled = false;
    const m = await load();
    m.installPerfReporting();
    expect(intervals.map((i) => i.ms)).toEqual([5000]);
    expect(document.documentElement.dataset.branchkitPerf).toBeUndefined();
  });

  it('re-arms both baselines on the visible edge and neither on the hidden one', async () => {
    const m = await load();
    m.installPerfReporting();
    const fire = listeners.find((l) => l.type === 'visibilitychange')!.fn;
    const state = vi.spyOn(document, 'visibilityState', 'get');
    state.mockReturnValue('hidden');
    fire(new Event('visibilitychange'));
    expect(rearmed).toEqual([]);
    state.mockReturnValue('visible');
    fire(new Event('visibilitychange'));
    expect(rearmed).toEqual(['cpu', 'watchdog']);
  });

  it('branchkitResetPerf clears every counter group, watchdog included', async () => {
    const m = await load();
    m.installPerfReporting();
    (window as unknown as { branchkitResetPerf: () => void }).branchkitResetPerf();
    expect(resets.sort()).toEqual(['cpu', 'lifecycle', 'longtask', 'message', 'scan', 'watchdog']);
  });

  it('the main-world reset trigger resets, clears its own flag, and confirms with a fresh publish', async () => {
    const m = await load();
    m.installPerfReporting();
    delete document.documentElement.dataset.branchkitPerf;
    document.documentElement.dataset.branchkitResetPerf = '1';
    await new Promise((r) => setTimeout(r, 0));
    // Five groups, not six: this path has never re-armed the watchdog. Pinned
    // as the asymmetry it is — see the note in the module.
    expect(resets.sort()).toEqual(['cpu', 'lifecycle', 'longtask', 'message', 'scan']);
    // Clearing the flag is what stops the observer re-entering on its own write.
    expect(document.documentElement.dataset.branchkitResetPerf).toBeUndefined();
    // The confirmation publish: a driver diffs against this, so zeroed counters
    // must be readable before it takes its next sample.
    expect(document.documentElement.dataset.branchkitPerf).toBeDefined();
  });

  it('installs no reset observer when harness hooks are off', async () => {
    harnessEnabled = false;
    const m = await load();
    m.installPerfReporting();
    document.documentElement.dataset.branchkitResetPerf = '1';
    await new Promise((r) => setTimeout(r, 0));
    expect(resets).toEqual([]);
    expect(document.documentElement.dataset.branchkitResetPerf).toBe('1');
  });
});

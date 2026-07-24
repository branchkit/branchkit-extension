/**
 * BranchKit Browser — perf-report unit tests.
 *
 * Pins the stat decompositions over a faked wrapper store: the trailing-
 * window filter, the per-discovery-source split (including the mo_stamped
 * survivorship-bias fix — unstamped wrappers still count in attached/shown),
 * and the stage-delta percentile summaries.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type PerfReport = typeof import('./perf-report');

interface FakeWrapper {
  tAttached: number;
  tFirstShown: number | null;
  tDomSeen: number | null;
  tInBand: number | null;
  tClaimed: number | null;
  tBuildGated: number | null;
  domSeenByMo: boolean;
  inViewportAtAttach: boolean;
  discoverySource: string;
  hint: null;
  scanned: { codeword: string; in_strict_viewport: boolean };
}

const wrappers: FakeWrapper[] = [];

function wrapper(over: Partial<FakeWrapper>): FakeWrapper {
  return {
    tAttached: 1000, tFirstShown: null, tDomSeen: null, tInBand: null,
    tClaimed: null, tBuildGated: null, domSeenByMo: false,
    inViewportAtAttach: false, discoverySource: 'scan', hint: null,
    scanned: { codeword: '', in_strict_viewport: false },
    ...over,
  };
}

async function loadPerfReport(): Promise<PerfReport> {
  vi.resetModules();
  vi.doMock('../core/store', () => ({ store: { get all() { return wrappers; } } }));
  vi.doMock('../lifecycle/page-session', () => ({ pageSession: {} }));
  vi.doMock('../labels/label-reservoir', () => ({ labelReservoir: { stats: () => ({ free: 0 }) } }));
  vi.doMock('./perf-counters', () => ({ lifecycleCounters: {} }));
  vi.doMock('./churn-log', () => ({ churnStats: () => ({}) }));
  vi.doMock('./sync-trace', () => ({ syncTraceStats: () => ({}) }));
  vi.doMock('../observe/mutation-source', () => ({ getObserverFirstAttachedAt: () => null }));
  vi.doMock('../config', () => ({ getHintVisibility: () => 'always' }));
  return await import('./perf-report');
}

beforeEach(() => {
  wrappers.length = 0;
  vi.spyOn(performance, 'now').mockReturnValue(10_000);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock('../core/store');
  vi.doUnmock('../lifecycle/page-session');
  vi.doUnmock('../labels/label-reservoir');
  vi.doUnmock('./perf-counters');
  vi.doUnmock('./churn-log');
  vi.doUnmock('./sync-trace');
  vi.doUnmock('../observe/mutation-source');
  vi.doUnmock('../config');
});

describe('paintLatencyStats', () => {
  it('computes stage deltas only for wrappers shown inside the window', async () => {
    const pr = await loadPerfReport();
    wrappers.push(
      wrapper({ tAttached: 1000, tDomSeen: 900, tClaimed: 1100, tFirstShown: 1200 }),
      wrapper({ tFirstShown: 10_000 - 100_000 }), // outside the 90s window
      wrapper({ tFirstShown: null }),             // never shown
    );
    const stats = pr.paintLatencyStats();
    expect(stats.shown_in_window).toBe(1);
    expect(stats.dom_seen_to_attached).toMatchObject({ n: 1, p50: 100 });
    expect(stats.claimed_to_shown).toMatchObject({ n: 1, p50: 100 });
    expect(stats.attached_to_shown).toMatchObject({ n: 1, p50: 200 });
    // No band stamp → that decomposition stays empty, not fabricated.
    expect(stats.attached_to_band.n).toBe(0);
  });

  it('summarizes percentiles over the shown cohort', async () => {
    const pr = await loadPerfReport();
    for (const delta of [10, 20, 30, 40, 1000]) {
      wrappers.push(wrapper({ tAttached: 2000, tFirstShown: 2000 + delta }));
    }
    const s = pr.paintLatencyStats().attached_to_shown;
    expect(s.n).toBe(5);
    expect(s.p50).toBe(30);
    expect(s.max).toBe(1000);
  });
});

describe('discoverySourceStats', () => {
  it('splits by source and counts unstamped wrappers in attached/shown (no survivorship bias)', async () => {
    const pr = await loadPerfReport();
    wrappers.push(
      wrapper({ discoverySource: 'mutation', domSeenByMo: true, tDomSeen: 900, tFirstShown: 1300 }),
      wrapper({ discoverySource: 'band_sweep', tFirstShown: 1500 }), // no MO stamp
      wrapper({ discoverySource: 'band_sweep' }),                    // attached only
    );
    const stats = pr.discoverySourceStats();
    expect(stats.mutation).toMatchObject({ attached_in_window: 1, shown_in_window: 1, mo_stamped: 1 });
    expect(stats.band_sweep).toMatchObject({ attached_in_window: 2, shown_in_window: 1, mo_stamped: 0 });
    // The unstamped-but-shown wrapper still contributes attached→shown.
    expect(stats.band_sweep.attached_to_shown.n).toBe(1);
  });

  it('excludes wrappers attached before the trailing window', async () => {
    const pr = await loadPerfReport();
    wrappers.push(wrapper({ tAttached: 10_000 - 95_000 }));
    expect(Object.keys(pr.discoverySourceStats())).toHaveLength(0);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the collaborators before importing the module under test.
const claimed: string[][] = [];
const released: string[][] = [];
let nextClaim: string[] = [];
vi.mock('../labels/label-reservoir', () => ({
  labelReservoir: {
    claim: (count: number) => {
      const grant = nextClaim.slice(0, count);
      while (grant.length < count) grant.push('');
      claimed.push(grant.filter(l => l !== ''));
      return grant;
    },
    release: (labels: string[]) => { released.push(labels); },
  },
}));

const publishedRecords: Array<{ codeword: string }> = [];
const retired: string[][] = [];
let admitAll = true;
vi.mock('../labels/label-sync', () => ({
  publishRecords: async (records: Array<{ codeword: string }>) => {
    publishedRecords.push(...records);
    return new Set(admitAll ? records.map(r => r.codeword) : []);
  },
  retireRecords: (codewords: string[]) => { retired.push(codewords); },
}));

const toasts: string[] = [];
vi.mock('../render/toast', () => ({
  flashToast: (text: string) => { toasts.push(text); },
}));
vi.mock('../debug/bk-log', () => ({ bkLog: () => {} }));

import {
  startRangePick, resolveRangePick, cancelRangePick, isRangePickPending,
  MAX_RANGE_BADGES,
} from './range-disambiguation';

function makeRange(text = 'x'): Range {
  const el = document.createElement('p');
  el.textContent = text;
  document.body.appendChild(el);
  const r = document.createRange();
  r.selectNodeContents(el.firstChild!);
  return r;
}

function chipHosts(): Element[] {
  return [...document.querySelectorAll('[data-branchkit-hint]')];
}

describe('range-disambiguation pick', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    claimed.length = 0;
    released.length = 0;
    publishedRecords.length = 0;
    retired.length = 0;
    toasts.length = 0;
    nextClaim = ['alpha', 'bravo', 'charlie', 'delta'];
    admitAll = true;
    document.body.innerHTML = '';
  });
  afterEach(() => {
    cancelRangePick('test_teardown');
    vi.useRealTimers();
  });

  it('paints one chip per range, publishes the codewords, and resolves a pick', async () => {
    const picks: Range[] = [];
    const ranges = [makeRange('a'), makeRange('b'), makeRange('c')];
    startRangePick(ranges, (r) => picks.push(r));
    await Promise.resolve(); // let the publish settle
    expect(chipHosts()).toHaveLength(3);
    expect(publishedRecords.map(r => r.codeword)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(isRangePickPending()).toBe(true);
    expect(isRangePickPending('bravo')).toBe(true);
    expect(isRangePickPending('zulu')).toBe(false);

    expect(resolveRangePick('bravo')).toBe(true);
    expect(picks).toHaveLength(1);
    expect(picks[0]).toBe(ranges[1]);
    // Teardown: chips gone, codewords retired + released.
    expect(chipHosts()).toHaveLength(0);
    expect(isRangePickPending()).toBe(false);
    expect(retired.flat().sort()).toEqual(['alpha', 'bravo', 'charlie']);
    expect(released.flat().sort()).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('ignores codewords that are not part of the pick', () => {
    startRangePick([makeRange(), makeRange()], () => {});
    expect(resolveRangePick('zulu')).toBe(false);
    expect(isRangePickPending()).toBe(true);
  });

  it('auto-cancels after the pick window', () => {
    const picks: Range[] = [];
    startRangePick([makeRange(), makeRange()], (r) => picks.push(r));
    vi.advanceTimersByTime(13_000);
    expect(isRangePickPending()).toBe(false);
    expect(chipHosts()).toHaveLength(0);
    expect(picks).toHaveLength(0);
    expect(released.flat()).toHaveLength(2);
  });

  it('a new pick replaces a pending one', () => {
    startRangePick([makeRange(), makeRange()], () => {});
    const firstReleased = released.length;
    startRangePick([makeRange(), makeRange()], () => {});
    expect(released.length).toBeGreaterThan(firstReleased);
    expect(chipHosts()).toHaveLength(2); // only the second pick's chips
  });

  it('caps badges at MAX_RANGE_BADGES with a visible toast (no silent truncation)', () => {
    nextClaim = Array.from({ length: 20 }, (_, i) => `cw${i}`);
    const ranges = Array.from({ length: 14 }, () => makeRange());
    startRangePick(ranges, () => {});
    expect(chipHosts()).toHaveLength(MAX_RANGE_BADGES);
    expect(toasts.some(t => t.includes('14 matches'))).toBe(true);
  });

  it('falls back to the first range when the pool is dry', () => {
    nextClaim = [];
    const picks: Range[] = [];
    const ranges = [makeRange('a'), makeRange('b')];
    startRangePick(ranges, (r) => picks.push(r));
    expect(picks).toEqual([ranges[0]]);
    expect(isRangePickPending()).toBe(false);
    expect(chipHosts()).toHaveLength(0);
  });

  it('drops chips for codewords the plugin refused', async () => {
    admitAll = false;
    startRangePick([makeRange(), makeRange()], () => {});
    await Promise.resolve(); // let the publish settle
    await Promise.resolve();
    expect(isRangePickPending()).toBe(false);
    expect(chipHosts()).toHaveLength(0);
  });
});

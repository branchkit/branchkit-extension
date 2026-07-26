import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Policy tests. The badge mechanics (band window, reaping, holder registration)
// belong to RangeBadgeSet and are covered by its own suite; what's asserted
// here is what makes SEARCH badges different from a disambiguation pick:
// they're additive rather than modal, armed on commit rather than keystroke,
// and a codeword means "go there" rather than "activate".

let matchRanges: Range[] = [];
let active = true;
const wentTo: string[] = [];
vi.mock('../scan/find', () => ({
  getMatchRanges: () => matchRanges.slice(),
  isFindActive: () => active,
  findGoToRange: (r: Range) => {
    if (!matchRanges.includes(r)) return false;
    wentTo.push(r.toString());
    return true;
  },
  FIND_HIGHLIGHT: '#ffeb3b',
}));

let pool: string[] = [];
const released: string[][] = [];
vi.mock('../labels/label-reservoir', () => ({
  labelReservoir: {
    claim: (n: number) => {
      const g = pool.splice(0, n);
      while (g.length < n) g.push('');
      return g;
    },
    release: (l: string[]) => { released.push(l); pool.unshift(...l); },
    stats: () => ({ free: pool.length, refillInFlight: false, outstanding: 0 }),
  },
}));
vi.mock('../labels/label-sync', () => ({
  publishRecords: async (r: Array<{ codeword: string }>) => new Set(r.map(x => x.codeword)),
  retireRecords: () => {},
  cancelPendingDelete: () => {},
}));
vi.mock('../labels/codeword-holders', () => ({
  registerCodewordHolder: () => () => {},
}));
const badgeInstances: Array<{ removed: boolean; variant: unknown; filtered: boolean }> = [];
vi.mock('../render/hints', () => ({
  HintBadge: class {
    removed = false; filtered = false; variant: unknown;
    badgeSize = { w: 20, h: 14 };
    constructor(_t: unknown, _l: unknown, _d: unknown, variant: unknown) {
      this.variant = variant;
      badgeInstances.push(this as unknown as { removed: boolean; variant: unknown; filtered: boolean });
    }
    show(): void {}
    remove(): void { this.removed = true; }
    setFiltered(f: boolean): void { this.filtered = f; }
    setMatchedChars(): void {}
    updatePosition(): void {}
  },
}));
vi.mock('../config', () => ({ getDisplayMode: () => 'letter' }));
vi.mock('../debug/bk-log', () => ({ bkLog: () => {} }));

import {
  armSearchBadges, clearSearchBadges, reconcileSearchBadges,
  resolveSearchBadge, filterSearchBadges, isSearchBadgePending,
} from './search-badges';
import { SEARCH_VARIANT } from '../render/badge-variant';

function makeRange(text: string): Range {
  const p = document.createElement('p');
  p.textContent = text;
  document.body.appendChild(p);
  const r = document.createRange();
  r.selectNodeContents(p.firstChild!);
  return r;
}

describe('search badges', () => {
  let restoreRects: () => void;
  beforeEach(() => {
    pool = ['a a', 'b b', 'c c', 'd d'];
    released.length = 0;
    wentTo.length = 0;
    badgeInstances.length = 0;
    active = true;
    document.body.innerHTML = '';
    matchRanges = [];
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
    restoreRects = () => { Range.prototype.getBoundingClientRect = original; };
  });
  afterEach(() => { clearSearchBadges('test'); restoreRects(); });

  it('arms over the committed matches, wearing the search variant', async () => {
    matchRanges = [makeRange('one'), makeRange('two')];
    armSearchBadges();
    await Promise.resolve();
    expect(isSearchBadgePending()).toBe(true);
    expect(badgeInstances).toHaveLength(2);
    expect(badgeInstances.every(b => b.variant === SEARCH_VARIANT)).toBe(true);
  });

  it('arms nothing when the commit found no matches', () => {
    matchRanges = [];
    armSearchBadges();
    expect(isSearchBadgePending()).toBe(false);
    expect(badgeInstances).toHaveLength(0);
  });

  it('a codeword jumps to its match rather than activating anything', async () => {
    matchRanges = [makeRange('one'), makeRange('two')];
    armSearchBadges();
    await Promise.resolve();

    expect(resolveSearchBadge('a a')).toBe('jumped');
    expect(wentTo).toEqual(['one']);
    // And the session stays live — this is navigation, not an answer.
    expect(isSearchBadgePending()).toBe(true);
  });

  it('does NOT claim codewords it does not own — link hints stay speakable', async () => {
    // The core difference from a pick, which swallows every codeword while up.
    matchRanges = [makeRange('one')];
    armSearchBadges();
    await Promise.resolve();
    expect(resolveSearchBadge('z z')).toBe('not_mine');
    expect(wentTo).toEqual([]);
  });

  it('refuses a match that is off screen, keeping the session live', async () => {
    matchRanges = [makeRange('one'), makeRange('far')];
    armSearchBadges();
    await Promise.resolve();
    // 'far' scrolls out from under the badge.
    Range.prototype.getBoundingClientRect = function (this: Range): DOMRect {
      return (this.toString() === 'far'
        ? { top: -4000, bottom: -3980, left: 10, right: 60, width: 50, height: 20 }
        : { top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
    };
    expect(resolveSearchBadge('b b')).toBe('off_screen');
    expect(wentTo).toEqual([]);
    expect(isSearchBadgePending()).toBe(true);
  });

  it('a requery replaces the previous set rather than stacking', async () => {
    matchRanges = [makeRange('one'), makeRange('two')];
    armSearchBadges();
    await Promise.resolve();
    const first = badgeInstances.slice();

    matchRanges = [makeRange('three')];
    armSearchBadges();
    await Promise.resolve();

    expect(first.every(b => b.removed)).toBe(true);
    expect(released.flat().sort()).toEqual(['a a', 'b b']);
  });

  it('reconcile drops everything once the find session is gone', async () => {
    matchRanges = [makeRange('one')];
    armSearchBadges();
    await Promise.resolve();
    active = false;
    reconcileSearchBadges();
    expect(isSearchBadgePending()).toBe(false);
    expect(released.flat()).toEqual(['a a']);
  });

  it('mid-codeword progress dims the badges that cannot complete', async () => {
    matchRanges = [makeRange('one'), makeRange('two')];
    armSearchBadges();
    await Promise.resolve();
    expect(filterSearchBadges('a')).toBe(true);
    const [first, second] = badgeInstances;
    expect(first.filtered).toBe(false);  // 'a a' can still complete
    expect(second.filtered).toBe(true);  // 'b b' cannot
  });

  it('filter reports false with nothing armed, so the caller falls through', () => {
    expect(filterSearchBadges('a')).toBe(false);
  });
});

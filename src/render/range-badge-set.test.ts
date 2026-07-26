import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The pick's own suite (activate/range-disambiguation.test.ts) covers the
// window/eligibility/reap behaviour through the policy layer. What's tested
// HERE is the thing the split exists for: more than one set alive at once,
// each owning its own codewords, badges and holder registration. The old
// module-singleton made that impossible, and search-match badges need it.

let pool: string[] = [];
const released: string[][] = [];
vi.mock('../labels/label-reservoir', () => ({
  labelReservoir: {
    claim: (n: number) => {
      const grant = pool.splice(0, n);
      while (grant.length < n) grant.push('');
      return grant;
    },
    release: (l: string[]) => { released.push(l); pool.unshift(...l); },
  },
}));

const published: string[] = [];
vi.mock('../labels/label-sync', () => ({
  publishRecords: async (r: Array<{ codeword: string }>) => {
    published.push(...r.map(x => x.codeword));
    return new Set(r.map(x => x.codeword));
  },
  retireRecords: () => {},
  cancelPendingDelete: () => {},
}));

type Holder = { held: () => Iterable<string>; republish: () => void; onCodewordRejected: (c: string) => void };
const holders = vi.hoisted(() => ({ list: [] as Holder[] }));
vi.mock('../labels/codeword-holders', () => ({
  registerCodewordHolder: (h: Holder) => {
    holders.list.push(h);
    return () => { holders.list = holders.list.filter(x => x !== h); };
  },
}));

const badges: Array<{ removed: boolean; variant: unknown }> = [];
vi.mock('./hints', () => ({
  HintBadge: class {
    removed = false;
    variant: unknown;
    badgeSize = { w: 20, h: 14 };
    constructor(_t: unknown, _l: unknown, _d: unknown, variant: unknown) {
      this.variant = variant;
      badges.push(this as unknown as { removed: boolean; variant: unknown });
    }
    show(): void {}
    remove(): void { this.removed = true; }
    setFiltered(): void {}
    setMatchedChars(): void {}
    updatePosition(): void {}
  },
}));
vi.mock('../config', () => ({ getDisplayMode: () => 'letter' }));
vi.mock('../debug/bk-log', () => ({ bkLog: () => {} }));

import { RangeBadgeSet } from './range-badge-set';
import { HINT_VARIANT, RANGE_PICK_VARIANT } from './badge-variant';

function makeRange(text: string): Range {
  const p = document.createElement('p');
  p.textContent = text;
  document.body.appendChild(p);
  const r = document.createRange();
  r.selectNodeContents(p.firstChild!);
  return r;
}

describe('RangeBadgeSet', () => {
  let restoreRects: () => void;
  beforeEach(() => {
    pool = ['a a', 'b b', 'c c', 'd d', 'e e', 'f f'];
    released.length = 0;
    published.length = 0;
    badges.length = 0;
    holders.list = [];
    document.body.innerHTML = '';
    const original = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
    restoreRects = () => { Range.prototype.getBoundingClientRect = original; };
  });
  afterEach(() => restoreRects());

  it('two sets coexist, each owning its own codewords and holder', async () => {
    const first = RangeBadgeSet.create({
      ranges: [makeRange('one'), makeRange('two')],
      variant: RANGE_PICK_VARIANT, budget: 2,
    })!;
    const second = RangeBadgeSet.create({
      ranges: [makeRange('three')],
      variant: HINT_VARIANT, budget: 1,
    })!;
    await Promise.resolve();

    expect(first.size).toBe(2);
    expect(second.size).toBe(1);
    // Disjoint codewords — they draw from one pool without colliding.
    const overlap = first.codewords.filter(cw => second.has(cw));
    expect(overlap).toEqual([]);
    // Two holder registrations, so both are visible to the store-scoped sweeps.
    expect(holders.list).toHaveLength(2);
  });

  it('disposing one set leaves the other intact', async () => {
    const first = RangeBadgeSet.create({
      ranges: [makeRange('one'), makeRange('two')],
      variant: RANGE_PICK_VARIANT, budget: 2,
    })!;
    const second = RangeBadgeSet.create({
      ranges: [makeRange('three')], variant: HINT_VARIANT, budget: 1,
    })!;
    await Promise.resolve();
    const survivor = second.codewords[0];

    first.dispose('test');

    expect(first.size).toBe(0);
    expect(second.size).toBe(1);
    expect(second.has(survivor)).toBe(true);
    expect(holders.list).toHaveLength(1); // only the survivor's
    // The disposed set gave its codewords back; the survivor kept its own.
    expect(released.flat()).not.toContain(survivor);
  });

  it('each set carries its own variant to its badges', async () => {
    RangeBadgeSet.create({
      ranges: [makeRange('one')], variant: RANGE_PICK_VARIANT, budget: 1,
    });
    RangeBadgeSet.create({
      ranges: [makeRange('two')], variant: HINT_VARIANT, budget: 1,
    });
    await Promise.resolve();
    expect(badges.map(b => b.variant)).toEqual([RANGE_PICK_VARIANT, HINT_VARIANT]);
  });

  it('create returns null when the pool is dry, claiming nothing', () => {
    pool = [];
    const set = RangeBadgeSet.create({
      ranges: [makeRange('one')], variant: RANGE_PICK_VARIANT, budget: 9,
    });
    expect(set).toBeNull();
    // And it must not leave a holder registered for a set that never existed.
    expect(holders.list).toEqual([]);
  });

  it('dispose is idempotent and releases exactly once', async () => {
    const set = RangeBadgeSet.create({
      ranges: [makeRange('one')], variant: RANGE_PICK_VARIANT, budget: 1,
    })!;
    await Promise.resolve();
    set.dispose('first');
    set.dispose('second');
    expect(released.flat()).toHaveLength(1);
    expect(holders.list).toEqual([]);
  });

  it('reports membership changes so an owner can re-arm a projection', async () => {
    const changes: string[][] = [];
    const set = RangeBadgeSet.create({
      ranges: [makeRange('one'), makeRange('two')],
      variant: RANGE_PICK_VARIANT, budget: 2,
      onMembershipChanged: (cws) => changes.push(cws),
    })!;
    await Promise.resolve();
    expect(changes).toHaveLength(1);
    expect(changes[0].sort()).toEqual(set.codewords.sort());
  });
});

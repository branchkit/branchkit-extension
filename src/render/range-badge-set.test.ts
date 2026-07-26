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
// Codewords the "plugin" refuses. Everything else in a publish is admitted.
const refused = new Set<string>();
vi.mock('../labels/label-sync', () => ({
  publishRecords: async (r: Array<{ codeword: string }>) => {
    published.push(...r.map(x => x.codeword));
    return new Set(r.map(x => x.codeword).filter(cw => !refused.has(cw)));
  },
  retireRecords: () => {},
  cancelPendingDelete: () => {},
}));

// The voice alphabet gate. Real by default (unloaded in a bare test env, which
// is the keyboard-only case); flipped on for the admission tests.
const voice = vi.hoisted(() => ({ loaded: false }));
vi.mock('../labels/words', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../labels/words')>()),
  isVoiceAlphabetLoaded: () => voice.loaded,
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

import { RangeBadgeSet, RangeHolderSpec } from './range-badge-set';
import { HINT_VARIANT, RANGE_PICK_VARIANT } from './badge-variant';
import {
  __resetHolderRegistry, holdersByPriority, rejectAll,
} from '../labels/holder-registry';

// The sets register in the REAL registry; the holder spec is the owner's
// policy half, faked minimally here (mechanism is what this file tests).
let nextHolderId = 0;
function testHolder(claim: 'exclusive' | 'additive' = 'additive'): RangeHolderSpec {
  return {
    id: `set_${nextHolderId++}`,
    priority: 100,
    claim,
    resolve: () => 'not_mine',
  };
}

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
    refused.clear();
    voice.loaded = false;
    __resetHolderRegistry();
    nextHolderId = 0;
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
      variant: RANGE_PICK_VARIANT, budget: 2, holder: testHolder(),
    })!;
    const second = RangeBadgeSet.create({
      ranges: [makeRange('three')],
      variant: HINT_VARIANT, budget: 1, holder: testHolder(),
    })!;
    await Promise.resolve();

    expect(first.size).toBe(2);
    expect(second.size).toBe(1);
    // Disjoint codewords — they draw from one pool without colliding.
    const overlap = first.codewords.filter(cw => second.has(cw));
    expect(overlap).toEqual([]);
    // Two holder registrations, so both are visible to the registry sweeps.
    expect(holdersByPriority()).toHaveLength(2);
  });

  it('disposing one set leaves the other intact', async () => {
    const first = RangeBadgeSet.create({
      ranges: [makeRange('one'), makeRange('two')],
      variant: RANGE_PICK_VARIANT, budget: 2, holder: testHolder(),
    })!;
    const second = RangeBadgeSet.create({
      ranges: [makeRange('three')], variant: HINT_VARIANT, budget: 1,
      holder: testHolder(),
    })!;
    await Promise.resolve();
    const survivor = second.codewords[0];

    first.dispose('test');

    expect(first.size).toBe(0);
    expect(second.size).toBe(1);
    expect(second.has(survivor)).toBe(true);
    expect(holdersByPriority()).toHaveLength(1); // only the survivor's
    // The disposed set gave its codewords back; the survivor kept its own.
    expect(released.flat()).not.toContain(survivor);
  });

  it('each set carries its own variant to its badges', async () => {
    RangeBadgeSet.create({
      ranges: [makeRange('one')], variant: RANGE_PICK_VARIANT, budget: 1,
      holder: testHolder(),
    });
    RangeBadgeSet.create({
      ranges: [makeRange('two')], variant: HINT_VARIANT, budget: 1,
      holder: testHolder(),
    });
    await Promise.resolve();
    expect(badges.map(b => b.variant)).toEqual([RANGE_PICK_VARIANT, HINT_VARIANT]);
  });

  it('create returns null when the pool is dry, claiming nothing', () => {
    pool = [];
    const set = RangeBadgeSet.create({
      ranges: [makeRange('one')], variant: RANGE_PICK_VARIANT, budget: 9,
      holder: testHolder(),
    });
    expect(set).toBeNull();
    // And it must not leave a holder registered for a set that never existed.
    expect(holdersByPriority()).toEqual([]);
  });

  it('dispose is idempotent and releases exactly once', async () => {
    const set = RangeBadgeSet.create({
      ranges: [makeRange('one')], variant: RANGE_PICK_VARIANT, budget: 1,
      holder: testHolder(),
    })!;
    await Promise.resolve();
    set.dispose('first');
    set.dispose('second');
    expect(released.flat()).toHaveLength(1);
    expect(holdersByPriority()).toEqual([]);
  });

  // Admission governs SPEECH, and only speech. A badge the plugin didn't take
  // is still typeable, so it stays — the one rejection that costs a badge is
  // the pool's cross-document arbitration (onCodewordRejected).
  describe('admission', () => {
    it('keeps a badge the plugin refused, and retries it on reconcile', async () => {
      voice.loaded = true;
      refused.add('a a');
      const set = RangeBadgeSet.create({
        ranges: [makeRange('one'), makeRange('two')],
        variant: RANGE_PICK_VARIANT, budget: 2, holder: testHolder(),
      })!;
      await Promise.resolve();
      await Promise.resolve();

      // Painted and typeable, just not speakable yet.
      expect(set.has('a a')).toBe(true);
      expect(set.size).toBe(2);
      expect(badges.some(b => b.removed)).toBe(false);
      expect(set.matchesPrefix('a')).toBe(true);

      // The refusal clears (voice came back / the plugin recovered): the next
      // settle re-publishes it, without a repaint.
      published.length = 0;
      refused.clear();
      set.reconcile();
      await Promise.resolve();
      expect(published).toContain('a a');

      // ...and once admitted it stops being retried.
      published.length = 0;
      set.reconcile();
      await Promise.resolve();
      expect(published).toEqual([]);
    });

    it('does not empty the set when nothing is admitted', async () => {
      voice.loaded = true;
      refused.add('a a');
      const emptied: string[] = [];
      const set = RangeBadgeSet.create({
        ranges: [makeRange('one')], variant: RANGE_PICK_VARIANT, budget: 1,
        onEmpty: (r) => emptied.push(r), holder: testHolder(),
      })!;
      await Promise.resolve();
      await Promise.resolve();
      // A whole-batch refusal is a transport failure or a plugin that isn't
      // listening — both local and both recoverable. Tearing the pick down
      // here is what put "Lost the highlighted matches" on a page where the
      // pick was fine.
      expect(emptied).toEqual([]);
      expect(set.size).toBe(1);
      expect(released.flat()).toEqual([]);
    });

    it('drops a badge the pool arbitrated to another document', async () => {
      voice.loaded = true;
      const set = RangeBadgeSet.create({
        ranges: [makeRange('one'), makeRange('two')],
        variant: RANGE_PICK_VARIANT, budget: 2, holder: testHolder(),
      })!;
      await Promise.resolve();
      await Promise.resolve();

      rejectAll('a a');
      expect(set.has('a a')).toBe(false);
      expect(set.size).toBe(1);
    });

    it('with no voice alphabet, badges stay and reconcile keeps retrying', async () => {
      const set = RangeBadgeSet.create({
        ranges: [makeRange('one')], variant: RANGE_PICK_VARIANT, budget: 1,
        holder: testHolder(),
      })!;
      await Promise.resolve();
      expect(set.size).toBe(1);
      expect(published).toEqual([]); // nothing to publish to

      voice.loaded = true;
      set.reconcile();
      await Promise.resolve();
      expect(published).toEqual(set.codewords);
    });
  });

  it('reports membership changes so an owner can re-arm a projection', async () => {
    const changes: string[][] = [];
    const set = RangeBadgeSet.create({
      ranges: [makeRange('one'), makeRange('two')],
      variant: RANGE_PICK_VARIANT, budget: 2,
      onMembershipChanged: (cws) => changes.push(cws), holder: testHolder(),
    })!;
    await Promise.resolve();
    expect(changes).toHaveLength(1);
    expect(changes[0].sort()).toEqual(set.codewords.sort());
  });
});

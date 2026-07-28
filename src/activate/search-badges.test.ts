import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Policy tests. The badge mechanics (band window, reaping, holder registration)
// belong to RangeBadgeSet and are covered by its own suite; what's asserted
// here is what makes SEARCH badges different from a disambiguation pick:
// they're additive rather than modal, armed on commit rather than keystroke,
// and a codeword means "go there" rather than "activate".

let matchRanges: Range[] = [];
let active = true;
const wentTo: string[] = [];
// The deactivate registration is CAPTURED, not stubbed away: this module
// registers it at its own module scope now (it used to be a content.ts relay),
// and holding what it handed over is the only way a test can tell a real
// registration from none. Declared inside the factory — vi.mock is hoisted
// above every top-level binding, and this one is written at import time.
vi.mock('../scan/find', () => {
  let deactivated: ((handoff: boolean) => void) | null = null;
  let committed: (() => void) | null = null;
  return {
    getMatchRanges: () => matchRanges.slice(),
    isFindActive: () => active,
    findGoToRange: (r: Range) => {
      if (!matchRanges.includes(r)) return false;
      wentTo.push(r.toString());
      return true;
    },
    onFindDeactivated: (fn: ((handoff: boolean) => void) | null) => { deactivated = fn; },
    _fireFindDeactivated: (handoff: boolean) => deactivated?.(handoff),
    // The commit multicast. Captured for the same reason as the deactivate:
    // this module subscribes at its own module scope now, and holding what it
    // registered is the only way to tell a real subscription from none.
    onFindCommitted: (fn: () => void) => { committed = fn; return () => { committed = null; }; },
    _fireFindCommitted: () => committed?.(),
  };
});

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
  armSearchBadges, clearSearchBadges, isSearchBadgePending, retrySearchBadgeArm,
} from './search-badges';
import * as find from '../scan/find';

/** Fire the deactivate this module registered with find (see the fake above). */
const fireFindDeactivated = (handoff: boolean): void =>
  (find as unknown as { _fireFindDeactivated(h: boolean): void })._fireFindDeactivated(handoff);

/** Fire the commit this module subscribed to (see the fake above). */
const fireFindCommitted = (): void =>
  (find as unknown as { _fireFindCommitted(): void })._fireFindCommitted();
import { SEARCH_VARIANT } from '../render/badge-variant';
import {
  __resetHolderRegistry, resolveCodeword, narrowByPrefix,
  anyHolderMatchesPrefix, reconcileAll, rejectAll, disposeAllHolders,
} from '../labels/holder-registry';

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
    __resetHolderRegistry();
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

  // The badges exist only for a live find, so the find ending must end them.
  // This wiring was a content.ts relay until 2026-07-27 and had no test
  // anywhere; the module registers it itself now, which is what makes it
  // reachable from here. Both handoff values, because the badges go either way
  // — only the badge SCREEN borrow distinguishes them, and that is find's.
  it('a find ending clears the badges, handoff or not', async () => {
    for (const handoff of [false, true]) {
      matchRanges = [makeRange('one'), makeRange('two')];
      armSearchBadges();
      await Promise.resolve();
      expect(isSearchBadgePending()).toBe(true);

      fireFindDeactivated(handoff);
      expect(isSearchBadgePending()).toBe(false);
    }
  });

  // The commit's own scroll is SMOOTH and still in flight when onCommit fires
  // (scan/find.ts scrollToCurrent, pinned by find.test.ts "slides rather than
  // teleports"), so arming measures every match against the viewport the user
  // is LEAVING. Search for something far down a long page and nothing is within
  // the ±1000px band: RangeBadgeSet.create returns null, unregisters the
  // holder, and no reconcile can ever fire — so that find gets no search badges
  // at all, permanently. Found by review 2026-07-27.
  it('a match outside the band arms nothing NOW, and recovers when the scroll settles', () => {
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 5000, bottom: 5020, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
    matchRanges = [makeRange('one'), makeRange('two')];

    armSearchBadges();
    expect(isSearchBadgePending()).toBe(false); // nothing in band, as before

    // The scroll lands: the matches are now where the user is looking.
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
    retrySearchBadgeArm();
    expect(isSearchBadgePending()).toBe(true);
    expect(badgeInstances).toHaveLength(2);
  });

  // Arming is a REACTION to a commit, not a command, and this module subscribes
  // to it at import — it was a content.ts composition until 2026-07-27, ordered
  // against the caret's extend on an argument that did not survive review.
  // Nothing else observes the subscription, so without this the arm-on-commit
  // behaviour is untested, exactly as it was while it lived in content.ts.
  it('subscribes to find commits at import, and arms from that signal alone', () => {
    matchRanges = [makeRange('one'), makeRange('two')];
    expect(isSearchBadgePending()).toBe(false);

    fireFindCommitted(); // no direct armSearchBadges() call anywhere here
    expect(isSearchBadgePending()).toBe(true);
    expect(badgeInstances).toHaveLength(2);
  });

  it('the settle retry is a no-op when the arm already succeeded', () => {
    matchRanges = [makeRange('one')];
    armSearchBadges();
    expect(badgeInstances).toHaveLength(1);

    retrySearchBadgeArm();
    expect(badgeInstances).toHaveLength(1); // not re-armed, no codeword churn
  });

  it('the settle retry is a no-op once find has ended', () => {
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 5000, bottom: 5020, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
    matchRanges = [makeRange('one')];
    armSearchBadges();
    expect(isSearchBadgePending()).toBe(false);

    active = false; // the user closed find before scrolling
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
    retrySearchBadgeArm();
    expect(isSearchBadgePending()).toBe(false); // no badges over a dead session
  });

  // A pending retry belongs to the session that armed it. Left set, it fires
  // into the NEXT find — and that find may be open and typing rather than
  // committed, so it would arm badges per keystroke, which is precisely what
  // commit-only arming exists to avoid ("arming per keystroke would churn
  // codewords on every character typed"). isFindActive() does not catch this:
  // the new session IS active.
  it('a pending arm does not survive its own session into the next find', () => {
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 5000, bottom: 5020, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
    matchRanges = [makeRange('one')];
    armSearchBadges();
    expect(isSearchBadgePending()).toBe(false); // retry now armed

    fireFindDeactivated(false); // that session ends

    // A new find is open and matching as the user types — nothing committed.
    Range.prototype.getBoundingClientRect = () =>
      ({ top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
    matchRanges = [makeRange('two')];
    retrySearchBadgeArm();
    expect(isSearchBadgePending()).toBe(false);
    expect(badgeInstances).toHaveLength(0);
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

    expect(resolveCodeword('a a')).toEqual({ kind: 'acted', holder: 'search' });
    expect(wentTo).toEqual(['one']);
    // And the session stays live — this is navigation, not an answer.
    expect(isSearchBadgePending()).toBe(true);
  });

  it('does NOT claim codewords it does not own — link hints stay speakable', async () => {
    // The core difference from a pick, which swallows every codeword while up.
    matchRanges = [makeRange('one')];
    armSearchBadges();
    await Promise.resolve();
    // Additive: the registry falls through past the badges, and with nothing
    // else registered the answer is 'none' — never a swallow.
    expect(resolveCodeword('z z')).toEqual({ kind: 'none' });
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
    expect(resolveCodeword('b b')).toEqual({ kind: 'off_screen', holder: 'search' });
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
    reconcileAll('general');
    expect(isSearchBadgePending()).toBe(false);
    expect(released.flat()).toEqual(['a a']);
  });

  it('reconcile with the find session live rolls the set, keeping it armed', async () => {
    matchRanges = [makeRange('one')];
    armSearchBadges();
    await Promise.resolve();
    // Every settle kind reaches the holder (the discriminated hook); it
    // self-selects 'general' and stays live either way.
    reconcileAll('general');
    reconcileAll('scroll');
    expect(isSearchBadgePending()).toBe(true);
    expect(released.flat()).toEqual([]);
  });

  it('drops a stale set when the match list moved between paint and speech', async () => {
    matchRanges = [makeRange('one')];
    armSearchBadges();
    await Promise.resolve();
    // A requery replaced the matches under the badges: findGoToRange refuses
    // the stale range, and the set drops rather than pretend — the codeword
    // leaves held() in the same call, so declining it is legal.
    matchRanges = [makeRange('other')];
    expect(resolveCodeword('a a')).toEqual({ kind: 'none' });
    expect(wentTo).toEqual([]);
    expect(isSearchBadgePending()).toBe(false);
  });

  it('empties itself when the pool arbitrates every codeword away', async () => {
    matchRanges = [makeRange('one')];
    armSearchBadges();
    await Promise.resolve();
    rejectAll('a a');
    expect(isSearchBadgePending()).toBe(false);
  });

  it('the registry dispose fan-out clears the set (orphan teardown)', async () => {
    matchRanges = [makeRange('one')];
    armSearchBadges();
    await Promise.resolve();
    disposeAllHolders('teardown_orphan');
    expect(isSearchBadgePending()).toBe(false);
    expect(released.flat()).toEqual(['a a']);
  });

  it('mid-codeword progress dims the badges that cannot complete', async () => {
    matchRanges = [makeRange('one'), makeRange('two')];
    armSearchBadges();
    await Promise.resolve();
    narrowByPrefix('a');
    const [first, second] = badgeInstances;
    expect(first.filtered).toBe(false);  // 'a a' can still complete
    expect(second.filtered).toBe(true);  // 'b b' cannot
  });

  it('with nothing armed the accept gate refuses, so the caller falls through', () => {
    expect(anyHolderMatchesPrefix('a')).toBe(false);
    expect(() => narrowByPrefix('a')).not.toThrow();
  });
});

/**
 * Codeword ownership: ONE order, asked the same way by every input.
 *
 * The module is a router, so these are routing tests — the holders are fakes.
 * What's pinned is the thing that had two implementations and drifted: which
 * holder gets a codeword first, who swallows what, and — the live failure that
 * prompted the split — that mid-codeword progress does NOT re-paint the page's
 * link hints when the prefix belongs to a search badge.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Holder fakes ---------------------------------------------------------
// Modelled on the real signatures, including the null-means-"nobody is asking"
// convention the prefix queries use.
const pick = {
  pending: false,
  prefixMatch: null as boolean | null,
  soleMatch: null as string | null,
  outcome: 'not_mine' as 'picked' | 'off_screen' | 'not_mine',
  filtered: [] as string[],
  resolved: [] as string[],
};
const search = {
  prefixMatch: null as boolean | null,
  soleMatch: null as string | null,
  outcome: 'not_mine' as 'jumped' | 'off_screen' | 'not_mine',
  filtered: [] as string[],
  resolved: [] as string[],
};

vi.mock('./range-disambiguation', () => ({
  isRangePickPending: () => pick.pending,
  rangePickPrefixMatch: (_p: string) => pick.prefixMatch,
  rangePickSoleMatch: (_p: string) => pick.soleMatch,
  filterRangePickChips: (p: string) => { if (!pick.pending) return false; pick.filtered.push(p); return true; },
  resolveRangePick: (cw: string) => { pick.resolved.push(cw); return pick.outcome; },
}));
vi.mock('./search-badges', () => ({
  searchBadgePrefixMatch: (_p: string) => search.prefixMatch,
  searchBadgeSoleMatch: (_p: string) => search.soleMatch,
  filterSearchBadges: (p: string) => { search.filtered.push(p); return true; },
  resolveSearchBadge: (cw: string) => { search.resolved.push(cw); return search.outcome; },
}));

import {
  setStoreCodewordHooks, anyHolderMatchesPrefix, narrowByPrefix,
  resolveHolderCodeword, resolveCodeword, soleHolderMatch,
} from './codeword-routing';

const store = {
  /** Which prefixes the page's link hints can complete. */
  prefixes: [] as string[],
  narrowed: [] as string[],
  reveals: 0,
  resolvable: [] as string[],
  activated: [] as string[],
};
setStoreCodewordHooks({
  matchesPrefix: (p) => store.prefixes.some((c) => c.startsWith(p)),
  narrow: (p) => { store.narrowed.push(p); },
  reveal: () => { store.reveals++; },
  resolve: (cw) => {
    if (!store.resolvable.includes(cw)) return false;
    store.activated.push(cw);
    return true;
  },
});

beforeEach(() => {
  pick.pending = false; pick.prefixMatch = null; pick.soleMatch = null;
  pick.outcome = 'not_mine'; pick.filtered.length = 0; pick.resolved.length = 0;
  search.prefixMatch = null; search.soleMatch = null; search.outcome = 'not_mine';
  search.filtered.length = 0; search.resolved.length = 0;
  store.prefixes = []; store.narrowed.length = 0; store.reveals = 0;
  store.resolvable = []; store.activated.length = 0;
});

describe('anyHolderMatchesPrefix (the keyboard\'s accept gate)', () => {
  it('a live pick answers alone — a letter no chip can finish is refused', () => {
    pick.prefixMatch = false;
    store.prefixes = ['ab'];          // a hint could finish it, but the pick is up
    search.prefixMatch = true;
    expect(anyHolderMatchesPrefix('a')).toBe(false);
  });

  it('with no pick up, a search badge or a hint is enough', () => {
    search.prefixMatch = true;
    expect(anyHolderMatchesPrefix('a')).toBe(true);
    search.prefixMatch = null;
    store.prefixes = ['zz'];
    expect(anyHolderMatchesPrefix('z')).toBe(true);
    expect(anyHolderMatchesPrefix('q')).toBe(false);
  });
});

describe('narrowByPrefix (mid-codeword progress)', () => {
  it('a live pick takes progress and nothing else hears it', () => {
    pick.pending = true;
    store.prefixes = ['ab'];
    narrowByPrefix('a');
    expect(pick.filtered).toEqual(['a']);
    expect(search.filtered).toEqual([]);
    expect(store.narrowed).toEqual([]);
    expect(store.reveals).toBe(0);
  });

  // The acceptance case. During a find session the page's link hints are
  // hidden (find's onActivate hides them) while their codewords stay published
  // — so a prefix arrives for badges nobody can see. The spoken path used to
  // reveal them unconditionally, which re-painted every hint find had just
  // hidden; the typed path never did.
  it('does NOT reveal the page hints for a prefix a search badge owns', () => {
    search.prefixMatch = true;
    store.prefixes = ['ab'];          // a hint starts with 'a' too
    narrowByPrefix('a');
    expect(store.reveals).toBe(0);
    // ...but the hints still NARROW: they coexist with search badges, so both
    // sets show the same progress.
    expect(search.filtered).toEqual(['a']);
    expect(store.narrowed).toEqual(['a']);
  });

  it('reveals hidden hints when only they can finish the prefix', () => {
    search.prefixMatch = false;
    store.prefixes = ['zx'];
    narrowByPrefix('z');
    expect(store.reveals).toBe(1);
    expect(store.narrowed).toEqual(['z']);
  });

  it('does not reveal for a prefix nothing can finish, or for a reset', () => {
    store.prefixes = ['zx'];
    narrowByPrefix('q');
    narrowByPrefix('');
    expect(store.reveals).toBe(0);
    expect(store.narrowed).toEqual(['q', '']);
  });
});

describe('resolveHolderCodeword (the order both inputs share)', () => {
  it('a search badge jumps before any element resolution', () => {
    search.outcome = 'jumped';
    expect(resolveHolderCodeword('a a')).toEqual({ kind: 'jumped' });
    expect(pick.resolved).toEqual([]);   // never consulted — search answered
  });

  it('a live pick swallows a codeword a search badge would have claimed', () => {
    pick.pending = true;
    pick.outcome = 'not_mine';
    search.outcome = 'jumped';           // would jump if it were ever asked
    expect(resolveHolderCodeword('a a')).toEqual({ kind: 'not_mine' });
    expect(search.resolved).toEqual([]);
  });

  it('tags which holder refused an off-screen match', () => {
    search.outcome = 'off_screen';
    expect(resolveHolderCodeword('a a')).toEqual({ kind: 'off_screen', holder: 'search' });
    search.outcome = 'not_mine';
    pick.outcome = 'off_screen';
    expect(resolveHolderCodeword('b b')).toEqual({ kind: 'off_screen', holder: 'pick' });
  });

  it('falls through when neither holder owns it', () => {
    expect(resolveHolderCodeword('zz')).toEqual({ kind: 'not_mine' });
    expect(search.resolved).toEqual(['zz']);
    expect(pick.resolved).toEqual(['zz']);
  });
});

describe('resolveCodeword (the keyboard\'s whole-codeword path)', () => {
  it('reaches the store only after both holders decline', () => {
    store.resolvable = ['zz'];
    expect(resolveCodeword('zz')).toEqual({ kind: 'activated' });
    expect(store.activated).toEqual(['zz']);
  });

  it('never reaches the store when a holder claimed it', () => {
    search.outcome = 'jumped';
    store.resolvable = ['a a'];
    expect(resolveCodeword('a a')).toEqual({ kind: 'jumped' });
    expect(store.activated).toEqual([]);
  });

  it('reports none when nothing owns the codeword', () => {
    expect(resolveCodeword('qq')).toEqual({ kind: 'none' });
  });
});

describe('soleHolderMatch', () => {
  it('answers for the holders and deliberately not for the store', () => {
    pick.soleMatch = 'a b';
    expect(soleHolderMatch('a')).toBe('a b');
    pick.soleMatch = null;
    search.soleMatch = 'c d';
    expect(soleHolderMatch('c')).toBe('c d');
    search.soleMatch = null;
    store.prefixes = ['ef'];           // a lone store hint is NOT a sole match:
    expect(soleHolderMatch('e')).toBe(null); // content.ts completes those itself
    expect(soleHolderMatch('')).toBe(null);
  });
});

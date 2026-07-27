/**
 * The typing rule, pinned. Both halves of this module were unified out of
 * hand-written copies (firing 2026-07-26, narrowing 2026-07-27) and NEITHER
 * unification broke a test — nothing had ever pinned the behaviour, which is
 * exactly how the copies drifted unnoticed. These are the tests that were
 * missing; each names the divergence it exists to catch.
 */

import { describe, it, expect } from 'vitest';
import {
  letterFormOf, exactCodewordMatch, anyCodewordMatchesPrefix, narrowBadge,
  type NarrowableBadge,
} from './codeword-typing';

/** [codeword, letterForm] entries, the shape every holder projects into. */
const entries = (...codewords: string[]) =>
  codewords.map((cw) => [cw, letterFormOf(cw)] as const);

/** Records the two writes in order, so a MISSING write is visible. */
function fakeBadge() {
  const writes: string[] = [];
  const badge: NarrowableBadge = {
    setFiltered: (f) => { writes.push(`filtered:${f}`); },
    setMatchedChars: (n) => { writes.push(`matched:${n}`); },
  };
  return { badge, writes };
}

describe('letterFormOf', () => {
  it('strips the pair separator', () => {
    expect(letterFormOf('a s')).toBe('as');
    expect(letterFormOf('a')).toBe('a');
  });
});

describe('exactCodewordMatch — firing', () => {
  it('fires only on the WHOLE letter form, never on a unique prefix', () => {
    // The field bug: a sparse set gives unique first letters, so a bare 'a'
    // resolved the pick mid-word. Uniqueness is a property of the page, not
    // of anything the user can see.
    const sparse = entries('a s', 'd f');
    expect(exactCodewordMatch(sparse, 'a')).toBeNull();
    expect(exactCodewordMatch(sparse, 'as')).toBe('a s');
  });

  it('never fires on the empty prefix', () => {
    expect(exactCodewordMatch(entries('a s'), '')).toBeNull();
  });

  it('returns the CODEWORD, not the letter form — the pool is keyed on it', () => {
    expect(exactCodewordMatch(entries('a s'), 'as')).toBe('a s');
  });
});

describe('anyCodewordMatchesPrefix — the keyboard gate', () => {
  it("'' asks 'do you hold anything', which is the opposite of what it means to narrow", () => {
    expect(anyCodewordMatchesPrefix(entries('a s'), '')).toBe(true);
    expect(anyCodewordMatchesPrefix(entries(), '')).toBe(false);
  });

  it('accepts a partial letter form and refuses a stray key', () => {
    expect(anyCodewordMatchesPrefix(entries('a s', 'd f'), 'a')).toBe(true);
    expect(anyCodewordMatchesPrefix(entries('a s', 'd f'), 'z')).toBe(false);
  });

  it('matches across the pair boundary, not just the first word', () => {
    expect(anyCodewordMatchesPrefix(entries('a s'), 'as')).toBe(true);
  });
});

describe('narrowBadge — the two writes are a pair', () => {
  it('marks a candidate and shows its matched chars', () => {
    const { badge, writes } = fakeBadge();
    narrowBadge(badge, 'as', 'a');
    expect(writes).toEqual(['filtered:false', 'matched:1']);
  });

  it('RESETS matched chars on a badge that stops matching', () => {
    // The drift this unification closed: the store's copy wrote setFiltered
    // but skipped setMatchedChars on a non-candidate, so the badge kept the
    // previous prefix's text split (setMatchedChars REWRITES the badge text;
    // only 0 restores the full label). Benign only because link hints HIDE
    // non-candidates — the range sets, which dim, wrote the 0. A variant flag
    // away from being visible.
    const { badge, writes } = fakeBadge();
    narrowBadge(badge, 'df', 'a');
    expect(writes).toEqual(['filtered:true', 'matched:0']);
  });

  it("'' resets rather than filtering everything out", () => {
    const { badge, writes } = fakeBadge();
    narrowBadge(badge, 'as', '');
    expect(writes).toEqual(['filtered:false', 'matched:0']);
  });

  it('counts the whole prefix, not one char — every display mode inherits it', () => {
    const { badge, writes } = fakeBadge();
    narrowBadge(badge, 'as', 'as');
    expect(writes).toEqual(['filtered:false', 'matched:2']);
  });

  it('is a no-op for an unpainted member, and a non-candidate for an unlabelled one', () => {
    // Callers hand over their whole membership without pre-filtering it.
    narrowBadge(null, 'as', 'a'); // must not throw
    const { badge, writes } = fakeBadge();
    narrowBadge(badge, null, 'a');
    expect(writes).toEqual(['filtered:true', 'matched:0']);
  });
});

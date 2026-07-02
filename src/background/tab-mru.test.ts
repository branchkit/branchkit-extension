import { describe, it, expect } from 'vitest';
import { pushMru, previousCandidates } from './tab-mru';

describe('pushMru', () => {
  it('puts the new id on top', () => {
    expect(pushMru([1, 2], 3)).toEqual([3, 1, 2]);
  });

  it('dedupes a re-activated id instead of stacking it', () => {
    expect(pushMru([3, 1, 2], 1)).toEqual([1, 3, 2]);
  });

  it('is a no-op reorder when the top re-activates', () => {
    expect(pushMru([3, 1], 3)).toEqual([3, 1]);
  });

  it('trims to the cap, dropping the oldest', () => {
    expect(pushMru([1, 2, 3], 4, 3)).toEqual([4, 1, 2]);
  });
});

describe('previousCandidates', () => {
  it('excludes the current tab, preserving recency order', () => {
    expect(previousCandidates([3, 1, 2], 3)).toEqual([1, 2]);
  });

  it('returns the whole stack when current is unknown', () => {
    expect(previousCandidates([3, 1], null)).toEqual([3, 1]);
  });

  it('keeps ids of closed tabs — the caller skips the dead ones', () => {
    // A closed tab's id stays until it ages off the cap; existence is
    // checked at use time via chrome.tabs.get.
    expect(previousCandidates([99, 1], 1)).toEqual([99]);
  });
});

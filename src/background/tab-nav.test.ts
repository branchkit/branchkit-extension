import { describe, it, expect } from 'vitest';
import { cycleTabIndex } from './tab-nav';

describe('cycleTabIndex', () => {
  it('moves to the next tab', () => {
    expect(cycleTabIndex(0, 3, 'next')).toBe(1);
    expect(cycleTabIndex(1, 3, 'next')).toBe(2);
  });

  it('moves to the previous tab', () => {
    expect(cycleTabIndex(2, 3, 'previous')).toBe(1);
    expect(cycleTabIndex(1, 3, 'previous')).toBe(0);
  });

  it('wraps forward from the last tab to the first', () => {
    expect(cycleTabIndex(2, 3, 'next')).toBe(0);
  });

  it('wraps backward from the first tab to the last', () => {
    expect(cycleTabIndex(0, 3, 'previous')).toBe(2);
  });

  it('handles a two-tab window', () => {
    expect(cycleTabIndex(0, 2, 'next')).toBe(1);
    expect(cycleTabIndex(1, 2, 'next')).toBe(0);
    expect(cycleTabIndex(0, 2, 'previous')).toBe(1);
  });
});

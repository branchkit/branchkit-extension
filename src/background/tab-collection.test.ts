import { describe, it, expect } from 'vitest';
import { buildTabEntries, type OpenTab } from './tab-collection';

// Tab titles/domains are no longer projected into the voice grammar (removed
// 2026-07-12 — privacy + churn). buildTabEntries now publishes only each tab's
// stable MARK codeword; title-word matching is gone.
describe('buildTabEntries', () => {
  const tab = (tabId: number, title: string, url: string): OpenTab => ({ tabId, title, url });

  it('publishes nothing without marks (titles/domains are not projected)', () => {
    const entries = buildTabEntries(
      [tab(1, 'Quarterly Report', 'https://docs.google.com/x')],
      [1],
    );
    expect(entries).toEqual([]);
  });

  it('publishes each tab’s mark codeword', () => {
    const entries = buildTabEntries(
      [tab(1, 'Docs', 'https://a.com'), tab(2, 'Mail', 'https://b.com')],
      [1, 2],
      new Map([[1, 'arch'], [2, 'bam']]),
    );
    const bySpoken = Object.fromEntries(entries.map((e) => [e.spoken, e.tab_id]));
    expect(bySpoken).toEqual({ arch: '1', bam: '2' });
  });

  it('never publishes the same mark twice', () => {
    const entries = buildTabEntries(
      [tab(1, 'A', 'https://a.com'), tab(2, 'B', 'https://b.com')],
      [1, 2],
      new Map([[1, 'arch'], [2, 'arch']]), // colliding marks (shouldn't happen, but guard)
    );
    const words = entries.map((e) => e.spoken);
    expect(new Set(words).size).toBe(words.length);
  });

  it('is deterministic and sorted for the unchanged-set guard', () => {
    const tabs = [tab(2, 'Zebra', 'https://zebra.dev'), tab(1, 'Apple', 'https://apple.dev')];
    const marks = new Map([[1, 'arch'], [2, 'zoom']]);
    const a = buildTabEntries(tabs, [1, 2], marks);
    const b = buildTabEntries([...tabs].reverse(), [1, 2], marks);
    expect(a).toEqual(b);
    expect(a.map((e) => e.spoken)).toEqual([...a.map((e) => e.spoken)].sort());
  });

  it('stamps tab_id as a string and trims long titles', () => {
    const long = 'word '.repeat(40) + 'end';
    const entries = buildTabEntries([tab(7, long, 'https://example.com')], [], new Map([[7, 'arch']]));
    expect(entries[0].tab_id).toBe('7');
    expect(entries[0].title.length).toBeLessThanOrEqual(80);
  });

  it('includes the mark for a tab with an empty title', () => {
    const entries = buildTabEntries([tab(5, '', 'about:blank')], [], new Map([[5, 'arch']]));
    expect(entries).toEqual([{ spoken: 'arch', tab_id: '5', title: '' }]);
  });
});

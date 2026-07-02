import { describe, it, expect } from 'vitest';
import { titleWords, domainWords, buildTabEntries, type OpenTab } from './tab-collection';

describe('titleWords', () => {
  it('lowercases and keeps only pure a-z words of 3+ chars', () => {
    expect(titleWords('BranchKit — PR #42 review')).toEqual(['branchkit', 'review']);
  });

  it('drops digits and punctuation-bearing tokens entirely (lexicon gap)', () => {
    // "v2.1" fragments to "v" (too short); "(3)" contributes nothing.
    expect(titleWords('(3) Inbox v2.1 notes')).toEqual(['inbox', 'notes']);
  });

  it('drops stopwords and boilerplate', () => {
    expect(titleWords('How to get the most from your new tab page')).toEqual(['most']);
  });

  it('dedupes while preserving first-seen order', () => {
    expect(titleWords('rust rust book — the rust book')).toEqual(['rust', 'book']);
  });

  it('splits non-ASCII as boundaries rather than emitting it', () => {
    // The accented char is a boundary; the ASCII fragment survives if long
    // enough (a fragment absent from the BPE lexicon is dropped engine-side,
    // which is harmless).
    expect(titleWords('café menu')).toEqual(['caf', 'menu']);
  });
});

describe('domainWords', () => {
  it('returns the registrable label first, subdomains after', () => {
    expect(domainWords('https://mail.google.com/mail/u/0')).toEqual(['google', 'mail']);
  });

  it('handles bare domains', () => {
    expect(domainWords('https://github.com/foo/bar')).toEqual(['github']);
  });

  it('drops www and short labels', () => {
    expect(domainWords('https://www.nytimes.com/section')).toEqual(['nytimes']);
  });

  it('yields nothing for non-http URLs', () => {
    expect(domainWords('chrome://settings')).toEqual([]);
    expect(domainWords('about:blank')).toEqual([]);
    expect(domainWords('not a url')).toEqual([]);
  });

  it('skips labels with digits or hyphens (lexicon gap)', () => {
    expect(domainWords('https://s3-us-west.amazonaws.com/x')).toEqual(['amazonaws']);
  });
});

describe('buildTabEntries', () => {
  const tab = (tabId: number, title: string, url: string): OpenTab => ({ tabId, title, url });

  it('gives each tab its unique title words plus domain words', () => {
    const entries = buildTabEntries(
      [tab(1, 'Quarterly Report', 'https://docs.google.com/x')],
      [1],
    );
    const bySpoken = Object.fromEntries(entries.map((e) => [e.spoken, e.tab_id]));
    expect(bySpoken).toEqual({ quarterly: '1', report: '1', google: '1' });
  });

  it('assigns a shared word to the MRU-most claimant only', () => {
    const entries = buildTabEntries(
      [
        tab(1, 'BranchKit PR alpha', 'https://github.com/a'),
        tab(2, 'BranchKit PR beta', 'https://github.com/b'),
      ],
      [2, 1], // tab 2 most recent
    );
    const githubOwners = entries.filter((e) => e.spoken === 'github');
    expect(githubOwners).toHaveLength(1);
    expect(githubOwners[0].tab_id).toBe('2');
    // Unique title words still reach each tab.
    expect(entries.find((e) => e.spoken === 'alpha')?.tab_id).toBe('1');
    expect(entries.find((e) => e.spoken === 'beta')?.tab_id).toBe('2');
  });

  it('never publishes the same spoken word twice', () => {
    const entries = buildTabEntries(
      [
        tab(1, 'News feed', 'https://news.example.com'),
        tab(2, 'News archive', 'https://news.example.com/old'),
        tab(3, 'News search', 'https://news.example.com/find'),
      ],
      [1, 2, 3],
    );
    const words = entries.map((e) => e.spoken);
    expect(new Set(words).size).toBe(words.length);
  });

  it('caps words per tab at 3, preferring unique title words', () => {
    const entries = buildTabEntries(
      [tab(1, 'alpha bravo charlie delta echo', 'https://example.com')],
      [1],
    );
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.spoken).sort()).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('leaves a fully-shadowed tab with no entries (palette handles the rest)', () => {
    const entries = buildTabEntries(
      [
        tab(1, 'Inbox', 'https://mail.example.com'),
        tab(2, 'Inbox', 'https://mail.example.com'),
      ],
      [1, 2], // tab 1 wins every shared word
    );
    expect(entries.every((e) => e.tab_id === '1')).toBe(true);
  });

  it('handles chrome:// tabs via title words only', () => {
    const entries = buildTabEntries([tab(1, 'Extensions', 'chrome://extensions')], []);
    expect(entries).toEqual([{ spoken: 'extensions', tab_id: '1', title: 'Extensions' }]);
  });

  it('is deterministic and sorted for the unchanged-set guard', () => {
    const tabs = [
      tab(2, 'Zebra docs', 'https://zebra.dev'),
      tab(1, 'Apple docs', 'https://apple.dev'),
    ];
    const a = buildTabEntries(tabs, [1, 2]);
    const b = buildTabEntries([...tabs].reverse(), [1, 2]);
    expect(a).toEqual(b);
    expect(a.map((e) => e.spoken)).toEqual([...a.map((e) => e.spoken)].sort());
  });

  it('stamps tab_id as a string and trims long titles', () => {
    const long = 'word '.repeat(40) + 'end';
    const entries = buildTabEntries([tab(7, long, 'https://example.com')], []);
    expect(entries[0].tab_id).toBe('7');
    expect(entries[0].title.length).toBeLessThanOrEqual(80);
  });
});

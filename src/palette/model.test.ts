import { describe, it, expect } from 'vitest';
import {
  searchWords, buildTabItems, buildCommandItems, buildBookmarkItems, scoreItem, filterPalette,
  resolvePaletteQuery, searchUrl, buildSearchSection, destinationUrl, buildUrlSection,
  type PaletteTab, type PaletteItem,
} from './model';
import type { CommandMeta, KeymapEntry } from '../keymap/command-catalog';
import { COMMAND_CATALOG, DEFAULT_KEYMAP } from '../keymap/command-catalog';

const TABS: PaletteTab[] = [
  { tabId: 1, title: 'GitHub — pull requests', url: 'https://github.com/branchkit/app/pulls' },
  { tabId: 2, title: 'Rust Book', url: 'https://doc.rust-lang.org/book/' },
  { tabId: 3, title: 'Inbox (3) — Gmail', url: 'https://mail.google.com/mail/u/0/' },
  { tabId: 4, title: '', url: 'https://news.ycombinator.com/' },
];

describe('searchWords', () => {
  it('splits on non-alphanumeric, lowercases, dedupes', () => {
    expect(searchWords('GitHub — pull-requests: pull')).toEqual(['github', 'pull', 'requests']);
  });

  it('keeps digits (palette matching is typed, not spoken)', () => {
    expect(searchWords('Tab 9 v2')).toEqual(['tab', '9', 'v2']);
  });
});

describe('buildTabItems', () => {
  it('mirrors the tab strip — input order, active tab in place', () => {
    // Recency lives in the CURSOR (the caller's job), not the order.
    const items = buildTabItems(TABS);
    expect(items.map((i) => i.dispatch)).toEqual([
      { kind: 'switch_tab', tabId: 1 },
      { kind: 'switch_tab', tabId: 2 },
      { kind: 'switch_tab', tabId: 3 },
      { kind: 'switch_tab', tabId: 4 },
    ]);
  });

  it('falls back to host when a tab has no title, and indexes host words', () => {
    const items = buildTabItems(TABS);
    const hn = items.find((i) => i.id === 'tab:4')!;
    expect(hn.title).toBe('news.ycombinator.com');
    expect(hn.words).toContain('ycombinator');
  });

  it('carries a stable row id per tab', () => {
    const items = buildTabItems(TABS);
    expect(items.map((i) => i.id).sort()).toEqual(['tab:1', 'tab:2', 'tab:3', 'tab:4']);
  });
});

describe('buildCommandItems', () => {
  const items = buildCommandItems(COMMAND_CATALOG, DEFAULT_KEYMAP as KeymapEntry[]);

  it('includes only mappable commands', () => {
    const ids = items.map((i) => i.id);
    expect(ids).toContain('cmd:scroll_down');
    expect(ids).not.toContain('cmd:activate_hint'); // runtime codeword — not dispatchable bare
    expect(ids).not.toContain('cmd:switch_to_tab'); // the tabs source IS its palette analog
  });

  it('shows the live keybind display for a bound command', () => {
    const sd = items.find((i) => i.id === 'cmd:scroll_down')!;
    expect(sd.keys).toEqual(['j']);
  });

  it('indexes voice phrases so typing a spoken form finds the command', () => {
    const sd = items.find((i) => i.id === 'cmd:scroll_down')!;
    expect(scoreItem(sd, ['scroll'])).toBeGreaterThan(0);
  });

  it('binds catalog param defaults into the dispatch payload', () => {
    // Synthetic fixture — exercises enum-param default binding generically,
    // independent of which real catalog commands currently carry enum params.
    const cat: CommandMeta[] = [{
      id: 'demo_enum_cmd', label: 'Demo enum command', group: 'Hints',
      description: 'x', mappable: true,
      params: [{ name: 'category', type: 'enum', options: ['link'], default: 'link' }],
    }];
    const [item] = buildCommandItems(cat, []);
    expect(item.dispatch).toEqual({
      kind: 'command', command: 'demo_enum_cmd', params: { category: 'link' },
    });
  });

  it('excludes the palette toggle itself', () => {
    expect(items.map((i) => i.id)).not.toContain('cmd:toggle_palette');
  });

  it('applies phrase overrides to the shown + indexed voice forms', () => {
    const cat: CommandMeta[] = [{
      id: 'scroll_down', label: 'Scroll down', group: 'Scroll',
      description: 'x', mappable: true, params: [],
      voice: [{ pattern: 'scroll down' }],
    }];
    const overrides = new Map([['scroll_down\0scroll down', 'zoom']]);
    const [item] = buildCommandItems(cat, [], undefined, overrides);
    expect(item.voice).toEqual(['zoom']);
    // The override phrase is searchable (it flows into the item's words).
    expect(scoreItem(item, ['zoom'])).toBeGreaterThan(0);
  });
});

describe('buildTabItems — window sections (DESIGN_TAB_NAVIGATION.md)', () => {
  // Two windows: 10/11 in window 1 (the palette's window), 20/21 in window 2.
  const W: PaletteTab[] = [
    { tabId: 10, title: 'Docs', url: 'https://docs.example.com/', windowId: 1 },
    { tabId: 11, title: 'Mail', url: 'https://mail.example.com/', windowId: 1 },
    { tabId: 20, title: 'CI', url: 'https://ci.example.com/', windowId: 2 },
    { tabId: 21, title: 'Chat', url: 'https://chat.example.com/', windowId: 2 },
  ];

  it('groups by window, this window first, strip order within', () => {
    const items = buildTabItems(W, 1);
    expect(items.map((i) => [i.id, i.group])).toEqual([
      ['tab:10', 'This window'],
      ['tab:11', 'This window'],
      ['tab:20', 'Window 2'],
      ['tab:21', 'Window 2'],
    ]);
  });

  it('annotates other-window rows in the subtitle; this window stays clean', () => {
    const items = buildTabItems(W, 1);
    expect(items.find((i) => i.id === 'tab:21')!.subtitle).toBe('chat.example.com · Window 2');
    expect(items.find((i) => i.id === 'tab:11')!.subtitle).toBe('mail.example.com');
  });

  it('single window (or no window info) stays flat — no groups', () => {
    expect(buildTabItems(W.map((t) => ({ ...t, windowId: 1 })), 1)
      .every((i) => i.group === undefined)).toBe(true);
    expect(buildTabItems(W, undefined).every((i) => i.group === undefined)).toBe(true);
  });

  it('browse mode sections by window; search mode is one ranked list', () => {
    const items = buildTabItems(W, 1);
    const browse = filterPalette(items, [], '');
    expect(browse.map((sec) => sec.label)).toEqual(['This window', 'Window 2']);
    const search = filterPalette(items, [], 'example');
    expect(search.map((sec) => sec.label)).toEqual(['Tabs']);
    expect(search[0].items.length).toBe(4);
  });
});

describe('scoreItem', () => {
  const item = (words: string[]): PaletteItem => ({
    source: 'tabs', id: 't', title: '', subtitle: '', keys: [], voice: [], words,
    dispatch: { kind: 'switch_tab', tabId: 1 },
  });

  it('requires every query token to match', () => {
    expect(scoreItem(item(['github', 'pull']), ['github', 'zzz'])).toBe(0);
  });

  it('ranks prefix above substring', () => {
    expect(scoreItem(item(['x', 'github']), ['git']))
      .toBeGreaterThan(scoreItem(item(['x', 'digithub']), ['git']));
  });

  it('gives a first-word lead bonus', () => {
    expect(scoreItem(item(['github', 'x']), ['git']))
      .toBeGreaterThan(scoreItem(item(['x', 'github']), ['git']));
  });
});

describe('filterPalette', () => {
  const tabs = buildTabItems(TABS);
  const commands = buildCommandItems(COMMAND_CATALOG, DEFAULT_KEYMAP as KeymapEntry[]);

  it('empty query keeps empty-state order and both sections (flat launcher)', () => {
    const sections = filterPalette(tabs, commands, '');
    expect(sections.map((s) => s.source)).toEqual(['tabs', 'commands']);
    expect(sections[0].items[0].dispatch).toEqual({ kind: 'switch_tab', tabId: 1 });
    expect(sections[1].items.length).toBe(commands.length);
  });

  it('groupedBrowse splits the empty-query commands into per-group sections', () => {
    const sections = filterPalette(tabs, commands, '', true);
    expect(sections[0].source).toBe('tabs');
    // Same headers as the help overlay, first-appearance order, covering
    // every command exactly once.
    const cmdSections = sections.slice(1);
    expect(cmdSections.every((s) => s.source === 'commands')).toBe(true);
    expect(cmdSections.map((s) => s.label)).toEqual(
      [...new Set(commands.map((c) => c.group))]);
    expect(cmdSections.reduce((n, s) => n + s.items.length, 0)).toBe(commands.length);
    for (const s of cmdSections) {
      expect(s.items.every((i) => i.group === s.label)).toBe(true);
    }
  });

  it('bookmark items search by title, host, and folder path; dispatch opens the url', () => {
    const bms = buildBookmarkItems([
      { title: 'Pull requests', url: 'https://github.com/branchkit/app/pulls', path: 'Bookmarks Bar / Work' },
      { title: 'Recipes', url: 'https://cooking.example.com/', path: '' },
    ]);
    expect(bms[0].dispatch).toEqual({ kind: 'navigate', url: 'https://github.com/branchkit/app/pulls' });
    expect(bms[0].subtitle).toBe('github.com — Bookmarks Bar / Work');
    expect(scoreItem(bms[0], ['work'])).toBeGreaterThan(0);   // folder path
    expect(scoreItem(bms[0], ['github'])).toBeGreaterThan(0); // host
    expect(bms[1].subtitle).toBe('cooking.example.com');
  });

  it('browse mode sections bookmarks by folder path, tree order', () => {
    const bms = buildBookmarkItems([
      { title: 'PRs', url: 'https://github.com/pulls', path: 'Bookmarks Bar / Work' },
      { title: 'CI', url: 'https://ci.example.com/', path: 'Bookmarks Bar / Work' },
      { title: 'Recipes', url: 'https://cooking.example.com/', path: 'Other Bookmarks' },
      { title: 'Rootless', url: 'https://example.com/', path: '' },
    ]);
    const sections = filterPalette([], [], '', false, bms);
    expect(sections.every((s) => s.source === 'bookmarks')).toBe(true);
    expect(sections.map((s) => s.label)).toEqual(
      ['Bookmarks Bar / Work', 'Other Bookmarks', 'Bookmarks']);
    expect(sections[0].items.map((i) => i.title)).toEqual(['PRs', 'CI']);
  });

  it('gathers a folder split around a subfolder in the DFS walk', () => {
    // Walk order: Work leaf, subfolder leaf, Work leaf again — the Work
    // section must not split around the subfolder.
    const bms = buildBookmarkItems([
      { title: 'PRs', url: 'https://a.example.com/', path: 'Work' },
      { title: 'Dash', url: 'https://b.example.com/', path: 'Work / Infra' },
      { title: 'CI', url: 'https://c.example.com/', path: 'Work' },
    ]);
    expect(bms.map((i) => [i.group, i.title])).toEqual([
      ['Work', 'PRs'], ['Work', 'CI'], ['Work / Infra', 'Dash'],
    ]);
  });

  it('a typed query keeps bookmark folder headers, best-hit folder first', () => {
    const bms = buildBookmarkItems([
      { title: 'Recipes', url: 'https://cooking.example.com/', path: 'Home' },
      { title: 'Open prs list', url: 'https://dash.example.com/', path: 'Home' },
      { title: 'PRs', url: 'https://github.com/pulls', path: 'Work' },
    ]);
    // First-word hit in Work outranks the mid-title hit in Home: the Work
    // section leads even though Home comes first in tree order, and neither
    // header degrades to a generic "Bookmarks".
    const sections = filterPalette([], [], 'prs', false, bms);
    expect(sections.map((s) => s.label)).toEqual(['Work', 'Home']);
    expect(sections[0].items.map((i) => i.title)).toEqual(['PRs']);
    expect(sections[1].items.map((i) => i.title)).toEqual(['Open prs list']);
  });

  it('searching a folder name surfaces that folder as a named section', () => {
    const bms = buildBookmarkItems([
      { title: 'Recipes', url: 'https://cooking.example.com/', path: 'Home' },
      { title: 'PRs', url: 'https://github.com/pulls', path: 'Work' },
      { title: 'CI', url: 'https://ci.example.com/', path: 'Work' },
    ]);
    const sections = filterPalette([], [], 'work', false, bms);
    expect(sections.map((s) => s.label)).toEqual(['Work']);
    expect(sections[0].items.map((i) => i.title)).toEqual(['PRs', 'CI']);
  });

  it('a typed query collapses commands to one ranked section even under groupedBrowse', () => {
    const sections = filterPalette(tabs, commands, 'tab', true);
    const cmdSections = sections.filter((s) => s.source === 'commands');
    expect(cmdSections.length).toBe(1);
    expect(cmdSections[0].label).toBe('Commands');
  });

  it('query filters both sections and drops empty ones', () => {
    const sections = filterPalette(tabs, commands, 'rust');
    expect(sections.length).toBe(1);
    expect(sections[0].source).toBe('tabs');
    expect(sections[0].items.map((i) => i.id)).toEqual(['tab:2']);
  });

  it('finds commands by label words', () => {
    const sections = filterPalette(tabs, commands, 'pin');
    const cmds = sections.find((s) => s.source === 'commands')!;
    expect(cmds.items[0].id).toBe('cmd:pin_tab');
  });

  it('ranks a title-prefix tab above a mention elsewhere', () => {
    const sections = filterPalette(tabs, commands, 'github');
    expect(sections[0].items[0].id).toBe('tab:1');
  });
});

describe('resolvePaletteQuery', () => {
  const items = buildTabItems(TABS);

  it('uses the box text verbatim when it matches', () => {
    expect(resolvePaletteQuery('github', '', items)).toEqual({ query: 'github', reason: null });
  });

  it('leaves an empty box alone', () => {
    expect(resolvePaletteQuery('', '', items)).toEqual({ query: '', reason: null });
  });

  it('drops the earlier utterance when a second dictation ran into it', () => {
    // The dictation sink types at the caret, so re-querying appends:
    // "gmail" + "github" = a query matching nothing, with the real one last.
    expect(resolvePaletteQuery('gmailgithub', 'github', items))
      .toEqual({ query: 'github', reason: 'dictated_retry' });
  });

  it('keeps a chunked transcript whole rather than adopting its tail', () => {
    // A long transcript arrives as consecutive insertions too — the retry only
    // fires when the tail alone beats the whole, which a mid-phrase tail can't.
    expect(resolvePaletteQuery('rust book', 'rust book', items))
      .toEqual({ query: 'rust book', reason: null });
  });

  it('phonetically corrects a misheard query against the palette words', () => {
    // Vowels are the axis ASR errors move along: "rest book" → "rust book".
    const r = resolvePaletteQuery('rest book', '', items);
    expect(r.reason).toBe('phonetic');
    expect(r.query).toBe('rust book');
  });

  it('leaves a query that matches nothing alone (empty state, not a wrong row)', () => {
    expect(resolvePaletteQuery('zzzqqq', '', items)).toEqual({ query: 'zzzqqq', reason: null });
  });

  it('does not rewrite a typed query the user is still building', () => {
    // "gith" prefix-matches, so no fallback runs even though it is incomplete.
    expect(resolvePaletteQuery('gith', '', items)).toEqual({ query: 'gith', reason: null });
  });
});

describe('searchUrl', () => {
  it('substitutes the encoded query for %s', () => {
    expect(searchUrl('https://duckduckgo.com/?q=%s', 'rust book'))
      .toBe('https://duckduckgo.com/?q=rust%20book');
  });

  it('appends when the template has no %s (broken setting still searches)', () => {
    expect(searchUrl('https://example.com/search?q=', 'a&b'))
      .toBe('https://example.com/search?q=a%26b');
  });
});

describe('buildSearchSection', () => {
  const TEMPLATE = 'https://www.google.com/search?q=%s';

  it('is absent at empty query — the browse state must not grow a row', () => {
    expect(buildSearchSection('', TEMPLATE)).toBeNull();
    expect(buildSearchSection('   ', TEMPLATE)).toBeNull();
  });

  it('builds one navigate-dispatch row from the trimmed query', () => {
    const s = buildSearchSection(' quantum papers ', TEMPLATE)!;
    expect(s.source).toBe('query');
    expect(s.items).toHaveLength(1);
    expect(s.items[0].id).toBe('query:search');
    expect(s.items[0].title).toBe('Search for “quantum papers”');
    expect(s.items[0].subtitle).toBe('www.google.com');
    expect(s.items[0].dispatch)
      .toEqual({ kind: 'navigate', url: 'https://www.google.com/search?q=quantum%20papers' });
  });

  // REGRESSION GUARDS (DESIGN_PALETTE_URL_SEARCH.md): resolvePaletteQuery's
  // recoveries fire only when the literal box text matches NOTHING. A row
  // that matches every query would make hits() universally true and silently
  // kill both. The structural fix is that the caller appends the row after
  // resolution; these tests pin the defensive layer under it — the row can't
  // match even if it leaks into the corpus.

  it('scores 0 for every query — unrankable by construction', () => {
    const row = buildSearchSection('github', TEMPLATE)!.items[0];
    expect(row.words).toEqual([]);
    expect(scoreItem(row, ['github'])).toBe(0);
    expect(scoreItem(row, ['search'])).toBe(0); // not even its own title words
  });

  it('leaves both recoveries live even when leaked into the corpus', () => {
    const items = buildTabItems(TABS);
    const leaked = [...items, buildSearchSection('gmailgithub', TEMPLATE)!.items[0]];
    expect(resolvePaletteQuery('gmailgithub', 'github', leaked))
      .toEqual({ query: 'github', reason: 'dictated_retry' });
    const r = resolvePaletteQuery('rest book', '', leaked);
    expect(r).toEqual({ query: 'rust book', reason: 'phonetic' });
  });
});

describe('destinationUrl', () => {
  // The row this gates sits FIRST and owns Enter, so the table leans hard
  // toward null: a missed URL still reaches its destination through the
  // search row (engines redirect bare domains); a false positive hijacks
  // Enter onto a browser error page.
  const CASES: Array<[string, string | null]> = [
    // strong signals — accepted
    ['github.com', 'https://github.com/'],
    ['github.com/anthropics', 'https://github.com/anthropics'],
    ['GitHub.Com', 'https://github.com/'],
    ['news.ycombinator.com', 'https://news.ycombinator.com/'],
    ['example.com:8080/path', 'https://example.com:8080/path'],
    ['https://example.org/x?y=1', 'https://example.org/x?y=1'],
    ['http://example.org', 'http://example.org/'],
    ['localhost', 'http://localhost/'],
    ['localhost:21551/traffic', 'http://localhost:21551/traffic'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080/'],
    // ambiguous — refused, the search row handles them
    ['rust book', null],            // whitespace: a query, never an address
    ['github', null],               // no dot
    ['node.js', null],              // real TLD, but a thing people SEARCH for
    ['main.rs', null],              // file-extension collision, same
    ['foo.bar', null],              // real TLD, not in the conservative list
    ['a@b.com', null],              // email being searched, not credentials
    ['999.1.1.1', null],            // not an IP, 999 not a TLD
    ['github.com.', null],          // trailing dot: empty label
    ['', null],
    ['   ', null],
  ];
  for (const [input, expected] of CASES) {
    it(`${JSON.stringify(input)} → ${expected === null ? 'null' : expected}`, () => {
      expect(destinationUrl(input)).toBe(expected);
    });
  }
});

describe('buildUrlSection', () => {
  it('is absent for anything that is not URL-shaped', () => {
    expect(buildUrlSection('rust book')).toBeNull();
    expect(buildUrlSection('')).toBeNull();
  });

  it('builds one navigate row showing the normalized form', () => {
    const s = buildUrlSection('github.com/anthropics')!;
    expect(s.source).toBe('query');
    expect(s.items).toHaveLength(1);
    expect(s.items[0].id).toBe('query:url');
    expect(s.items[0].title).toBe('Go to https://github.com/anthropics');
    expect(s.items[0].subtitle).toBe('github.com');
    expect(s.items[0].dispatch)
      .toEqual({ kind: 'navigate', url: 'https://github.com/anthropics' });
  });

  it('shares the corpus-exclusion contract (words empty, scores 0)', () => {
    const row = buildUrlSection('github.com')!.items[0];
    expect(row.words).toEqual([]);
    expect(scoreItem(row, ['github'])).toBe(0);
  });
});

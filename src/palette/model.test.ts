import { describe, it, expect } from 'vitest';
import {
  searchWords, buildTabItems, buildCommandItems, buildBookmarkItems, scoreItem, filterPalette,
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
  it('orders by MRU with the active tab demoted to the end', () => {
    // MRU says 3 is current, 1 was previous. Active = 3, so 1 leads.
    const items = buildTabItems(TABS, [3, 1, 2], 3);
    expect(items.map((i) => i.dispatch)).toEqual([
      { kind: 'switch_tab', tabId: 1 },
      { kind: 'switch_tab', tabId: 2 },
      { kind: 'switch_tab', tabId: 4 }, // absent from MRU → after ranked ones
      { kind: 'switch_tab', tabId: 3 }, // active last
    ]);
  });

  it('falls back to host when a tab has no title, and indexes host words', () => {
    const items = buildTabItems(TABS, [], null);
    const hn = items.find((i) => i.id === 'tab:4')!;
    expect(hn.title).toBe('news.ycombinator.com');
    expect(hn.words).toContain('ycombinator');
  });

  it('carries a stable row id per tab', () => {
    const items = buildTabItems(TABS, [], null);
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
    expect(sd.keys).toEqual(['J']);
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
  const tabs = buildTabItems(TABS, [3, 1], 3);
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
    expect(bms[0].dispatch).toEqual({ kind: 'open_bookmark', url: 'https://github.com/branchkit/app/pulls' });
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

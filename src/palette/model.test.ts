import { describe, it, expect } from 'vitest';
import {
  searchWords, buildTabItems, buildCommandItems, scoreItem, filterPalette,
  type PaletteTab, type PaletteItem,
} from './model';
import type { CommandMeta, KeymapEntry } from '../command-catalog';
import { COMMAND_CATALOG, DEFAULT_KEYMAP } from '../command-catalog';

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
    const cat: CommandMeta[] = [{
      id: 'show_hints_category', label: 'Show hints by category', group: 'Hints',
      description: 'x', mappable: true,
      params: [{ name: 'category', type: 'enum', options: ['link'], default: 'link' }],
    }];
    const [item] = buildCommandItems(cat, []);
    expect(item.dispatch).toEqual({
      kind: 'command', command: 'show_hints_category', params: { category: 'link' },
    });
  });

  it('excludes the palette toggle itself', () => {
    expect(items.map((i) => i.id)).not.toContain('cmd:toggle_palette');
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

  it('empty query keeps empty-state order and both sections', () => {
    const sections = filterPalette(tabs, commands, '');
    expect(sections.map((s) => s.source)).toEqual(['tabs', 'commands']);
    expect(sections[0].items[0].dispatch).toEqual({ kind: 'switch_tab', tabId: 1 });
    expect(sections[1].items.length).toBe(commands.length);
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

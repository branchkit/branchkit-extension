/**
 * BranchKit Browser — command palette model (Layer 2 of
 * notes/DESIGN_TAB_NAVIGATION.md).
 *
 * Pure: builds the palette's item sets from plain data and filters/ranks them
 * for a typed query. The chrome.* glue (tab query, MRU load, keymap load,
 * dispatch messaging) lives in palette-page.ts; this module is unit-tested.
 *
 * Sources are declared, not hardcoded: each source contributes items carrying
 * their own searchable words and dispatch payload, plus an empty-state order.
 * Launch sources are open tabs (MRU-first) and the command catalog; bookmarks
 * become source #3 by adding one more builder with the same item shape.
 */

import type { CommandMeta, KeymapEntry } from '../keymap/command-catalog';
import { comboDisplay } from '../activate/key-combo';
import { effectiveVoice, type OverrideMap, type OverrideRecord } from '../keymap/command-override';

export type PaletteSourceId = 'tabs' | 'commands' | 'bookmarks';

export type PaletteDispatch =
  | { kind: 'switch_tab'; tabId: number }
  | { kind: 'open_bookmark'; url: string }
  | { kind: 'command'; command: string; params?: Record<string, string> };

export interface PaletteItem {
  source: PaletteSourceId;
  /** Stable row id ("tab:12", "cmd:scroll_down") — the future voice-codeword
   *  anchor, so a row keeps its badge across re-renders. */
  id: string;
  title: string;
  /** Host for tabs, catalog description for commands. */
  subtitle: string;
  /** Display key combos bound to a command row (e.g. ["Shift+J"]). */
  keys: string[];
  /** Spoken phrases for a command row (e.g. ["scroll down"]). */
  voice: string[];
  /** Lowercase haystack the query matches against. */
  words: string[];
  /** Browse-state section header: catalog group for command rows ("Scroll",
   *  "Palette", …), folder path for bookmark rows ("Bookmarks Bar / Work").
   *  Absent for tabs. */
  group?: string;
  dispatch: PaletteDispatch;
}

export interface PaletteSection {
  source: PaletteSourceId;
  label: string;
  items: PaletteItem[];
}

/** The chrome.tabs.Tab fields the model consumes. */
export interface PaletteTab {
  tabId: number;
  title: string;
  url: string;
}

/** One flattened bookmark (background/palette.ts loadBookmarks): a leaf with
 *  its folder chain ("Bookmarks Bar / Work"). */
export interface PaletteBookmark {
  title: string;
  url: string;
  path: string;
}

/** Lowercase searchable words from free text: alphanumeric runs, deduped. */
export function searchWords(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (w.length > 0 && !out.includes(w)) out.push(w);
  }
  return out;
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname : url;
  } catch {
    return '';
  }
}

/**
 * Tab items in empty-state order: the MRU stack ranks them (index 0 = most
 * recent), tabs absent from the stack keep tab-strip order after the ranked
 * ones, and the currently active tab drops to the END — so open-palette +
 * Enter lands on the *previous* tab, the half of switcher usage that needs
 * zero typing.
 */
export function buildTabItems(
  tabs: readonly PaletteTab[],
  mru: readonly number[],
  activeTabId: number | null,
): PaletteItem[] {
  const mruRank = new Map<number, number>();
  mru.forEach((id, i) => { if (!mruRank.has(id)) mruRank.set(id, i); });
  const ordered = [...tabs].sort((a, b) => {
    const aActive = a.tabId === activeTabId ? 1 : 0;
    const bActive = b.tabId === activeTabId ? 1 : 0;
    if (aActive !== bActive) return aActive - bActive; // active tab last
    const ar = mruRank.get(a.tabId) ?? mru.length;
    const br = mruRank.get(b.tabId) ?? mru.length;
    return ar - br;
  });
  return ordered.map((t) => {
    const host = hostOf(t.url);
    const title = t.title.trim() || host || t.url;
    return {
      source: 'tabs' as const,
      id: `tab:${t.tabId}`,
      title,
      subtitle: host,
      keys: [],
      voice: [],
      words: [...searchWords(title), ...searchWords(host)],
      dispatch: { kind: 'switch_tab' as const, tabId: t.tabId },
    };
  });
}

/**
 * Bookmark items in tree order, with each folder's leaves gathered together
 * (the DFS walk interleaves a parent's trailing leaves after its subfolders;
 * a folder's section must not split around that). Folder order = first
 * appearance in tree order, so the user's own organization is still the
 * empty-state order. Array order is both the browse render order and the
 * codeword assignment order, so voice badges read consecutively within a
 * folder section. Subtitle shows host + folder path; both are searchable, so
 * "work github" finds the GitHub bookmark in the Work folder.
 */
export function buildBookmarkItems(bookmarks: readonly PaletteBookmark[]): PaletteItem[] {
  const folderRank = new Map<string, number>();
  for (const b of bookmarks) {
    if (!folderRank.has(b.path)) folderRank.set(b.path, folderRank.size);
  }
  const ordered = [...bookmarks].sort(
    (a, b) => folderRank.get(a.path)! - folderRank.get(b.path)!,
  );
  return ordered.map((b, i) => {
    const host = hostOf(b.url);
    return {
      source: 'bookmarks' as const,
      id: `bm:${i}`,
      title: b.title,
      subtitle: b.path ? `${host} — ${b.path}` : host,
      keys: [],
      voice: [],
      words: [...searchWords(b.title), ...searchWords(host), ...searchWords(b.path)],
      group: b.path || undefined,
      dispatch: { kind: 'open_bookmark' as const, url: b.url },
    };
  });
}

/** Default params for a command's bare dispatch, from its ParamSchema. */
function defaultParams(meta: CommandMeta): Record<string, string> | undefined {
  const entries = meta.params
    .filter((p) => p.default !== undefined)
    .map((p) => [p.name, p.default as string] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

/**
 * Command items in catalog order. Only statically dispatchable commands
 * appear: `mappable: false` entries need a runtime value (a codeword, a
 * query) no palette row can supply — their live analogs are other sources
 * (tabs) or hint mode itself. The palette's own toggle is excluded: running
 * it from inside would just close the palette.
 */
export function buildCommandItems(
  catalog: readonly CommandMeta[],
  keymap: readonly KeymapEntry[],
  excludeIds: readonly string[] = ['toggle_palette'],
  overrides?: OverrideMap,
  aliases?: readonly OverrideRecord[],
): PaletteItem[] {
  const keysByCommand = new Map<string, string[]>();
  for (const e of keymap) {
    const arr = keysByCommand.get(e.command) ?? [];
    arr.push(e.keys.split(' ').map(comboDisplay).join(' '));
    keysByCommand.set(e.command, arr);
  }
  const out: PaletteItem[] = [];
  for (const c of catalog) {
    if (!c.mappable || excludeIds.includes(c.id)) continue;
    const keys = keysByCommand.get(c.id) ?? [];
    // Effective phrases (user overrides applied) so a searched/shown phrase
    // matches what the actuator actually hears.
    const voice = effectiveVoice(c.id, (c.voice ?? []).map((v) => v.pattern), overrides, aliases);
    out.push({
      source: 'commands',
      id: `cmd:${c.id}`,
      title: c.label,
      subtitle: c.description,
      keys,
      voice,
      group: c.group,
      words: [
        ...searchWords(c.label),
        ...searchWords(c.group),
        ...searchWords(c.description),
        ...voice.flatMap(searchWords),
        ...keys.flatMap(searchWords),
      ],
      dispatch: { kind: 'command', command: c.id, params: defaultParams(c) },
    });
  }
  return out;
}

/**
 * Relevance of `item` for tokenized query words. Every query token must match
 * some item word — prefix matches (2) outrank mid-word substrings (1), and a
 * match on the item's first word gets a small lead bonus so "git" ranks the
 * "GitHub — home" tab above one merely mentioning it. 0 = no match.
 */
export function scoreItem(item: PaletteItem, queryWords: readonly string[]): number {
  let total = 0;
  for (const q of queryWords) {
    let best = 0;
    for (let i = 0; i < item.words.length; i++) {
      const w = item.words[i];
      let s = 0;
      if (w.startsWith(q)) s = 2;
      else if (w.includes(q)) s = 1;
      if (s > 0 && i === 0) s += 0.5;
      if (s > best) best = s;
    }
    if (best === 0) return 0;
    total += best;
  }
  return total;
}

/** Distinct `group` labels in first-appearance order, `fallback` for ungrouped. */
function groupLabels(items: readonly PaletteItem[], fallback: string): string[] {
  const groups: string[] = [];
  for (const item of items) {
    const g = item.group ?? fallback;
    if (!groups.includes(g)) groups.push(g);
  }
  return groups;
}

/**
 * Filter both sources for a query and shape the sectioned result.
 *
 * Empty query = browse mode: tabs first (MRU order), then bookmarks, then the
 * commands. Bookmarks split into one section per folder path (first-appearance
 * = tree order) — the user's own organization is the browse structure. With
 * `groupedBrowse` (the commands-only palette — the "browse the catalog"
 * surface) the commands split into one section per catalog group, in catalog
 * order — the same headers as the `?` help overlay. The full palette keeps a
 * single flat Commands section: it is a launcher, and group headers would
 * push the recent tabs down. With a query = search mode: always one ranked
 * section per SOURCE (per-group sections would fragment relevance ordering —
 * the best match must be first, not under the third header). Sections that
 * match nothing are dropped.
 */
export function filterPalette(
  tabItems: readonly PaletteItem[],
  commandItems: readonly PaletteItem[],
  query: string,
  groupedBrowse = false,
  bookmarkItems: readonly PaletteItem[] = [],
): PaletteSection[] {
  const sections: PaletteSection[] = [];
  const q = searchWords(query);
  const build = (source: PaletteSourceId, label: string, items: readonly PaletteItem[]): void => {
    let picked: PaletteItem[];
    if (q.length === 0) {
      picked = [...items];
    } else {
      picked = items
        .map((item, i) => ({ item, i, score: scoreItem(item, q) }))
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || a.i - b.i)
        .map((r) => r.item);
    }
    if (picked.length) sections.push({ source, label, items: picked });
  };
  build('tabs', 'Tabs', tabItems);
  if (q.length === 0) {
    for (const g of groupLabels(bookmarkItems, 'Bookmarks')) {
      build('bookmarks', g, bookmarkItems.filter((i) => (i.group ?? 'Bookmarks') === g));
    }
  } else {
    build('bookmarks', 'Bookmarks', bookmarkItems);
  }
  if (groupedBrowse && q.length === 0) {
    for (const g of groupLabels(commandItems, 'Commands')) {
      build('commands', g, commandItems.filter((i) => (i.group ?? 'Commands') === g));
    }
  } else {
    build('commands', 'Commands', commandItems);
  }
  return sections;
}

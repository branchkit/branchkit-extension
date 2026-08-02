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
import { bestPageMatch } from '../scan/fuzzy-find';

export type PaletteSourceId = 'tabs' | 'commands' | 'bookmarks';

export type PaletteDispatch =
  | { kind: 'switch_tab'; tabId: number }
  | { kind: 'navigate'; url: string }
  | { kind: 'command'; command: string; params?: Record<string, string> };

export interface PaletteItem {
  /** `'query'` marks a query-derived row (DESIGN_PALETTE_URL_SEARCH.md) — a
   *  different structural role from the enumerated sources: synthesized from
   *  the query itself, appended after filtering, never ranked, and never part
   *  of the corpus `resolvePaletteQuery` recovers against. */
  source: PaletteSourceId | 'query';
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
  source: PaletteSourceId | 'query';
  label: string;
  items: PaletteItem[];
}

/** The chrome.tabs.Tab fields the model consumes. */
export interface PaletteTab {
  tabId: number;
  title: string;
  url: string;
  /** Chrome window the tab lives in. Absent in old fixtures/wires → the
   *  single-window (ungrouped) rendering. */
  windowId?: number;
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
 *
 * With window info (DESIGN_TAB_NAVIGATION.md, window/desk sections): items
 * carry a `group` — "This window" first, then "Window 2"… in tab-strip
 * order — and browse mode sections by it. Search mode ignores groups (one
 * ranked list; a hunt must not fragment by window) but other-window rows
 * carry the window in their subtitle. The GLOBAL previous tab stays the
 * first row regardless of its window (pinned into a one-row "Previous"
 * group when it is cross-window) — Enter's meaning survives the grouping.
 * Without window info (old wire, single window) nothing changes: no groups,
 * the flat MRU list as always.
 */
export function buildTabItems(
  tabs: readonly PaletteTab[],
  mru: readonly number[],
  activeTabId: number | null,
  activeWindowId?: number | null,
  order: 'mru' | 'strip' = 'mru',
): PaletteItem[] {
  const mruRank = new Map<number, number>();
  mru.forEach((id, i) => { if (!mruRank.has(id)) mruRank.set(id, i); });
  const rank = (t: PaletteTab): number => mruRank.get(t.tabId) ?? mru.length;
  const byMruActiveLast = (a: PaletteTab, b: PaletteTab): number => {
    const aActive = a.tabId === activeTabId ? 1 : 0;
    const bActive = b.tabId === activeTabId ? 1 : 0;
    if (aActive !== bActive) return aActive - bActive; // active tab last
    return rank(a) - rank(b);
  };
  const mkItem = (t: PaletteTab, group?: string, windowNote?: string): PaletteItem => {
    const host = hostOf(t.url);
    const title = t.title.trim() || host || t.url;
    return {
      source: 'tabs' as const,
      id: `tab:${t.tabId}`,
      title,
      subtitle: windowNote ? `${host} · ${windowNote}` : host,
      keys: [],
      voice: [],
      words: [...searchWords(title), ...searchWords(host)],
      group,
      dispatch: { kind: 'switch_tab' as const, tabId: t.tabId },
    };
  };

  const windowIds = [...new Set(
    tabs.map((t) => t.windowId).filter((w): w is number => typeof w === 'number'),
  )];
  // STRIP order (the tab palette): the list mirrors the tab strip — same
  // left-to-right order you see in the window, active tab in place, no
  // Previous pin (the caller starts the SELECTION on the current tab, so
  // movement is relative to where you are; MRU's Enter-means-previous is
  // the launcher's contract, not the switcher's). chrome.tabs.query returns
  // strip order per window already.
  const sortFor = (arr: readonly PaletteTab[]): PaletteTab[] =>
    order === 'strip' ? [...arr] : [...arr].sort(byMruActiveLast);
  const grouped = typeof activeWindowId === 'number'
    && windowIds.includes(activeWindowId) && windowIds.length > 1;
  if (!grouped) {
    return sortFor(tabs).map((t) => mkItem(t));
  }

  // Window order: this window first, the rest in tab-strip enumeration
  // order. Labels are ordinals ("Window 2"), stable for the palette's
  // lifetime — phase 2 appends the desk here when BranchKit is connected.
  const otherIds = windowIds.filter((w) => w !== activeWindowId);
  const labelFor = new Map<number, string>();
  otherIds.forEach((w, i) => labelFor.set(w, `Window ${i + 2}`));

  const out: PaletteItem[] = [];
  // The global previous tab (best MRU rank that isn't the active tab). When
  // it lives in another window, pin it ahead of the sections — MRU order
  // only; strip order has no pin (see above).
  const previous = [...tabs].filter((t) => t.tabId !== activeTabId).sort((a, b) => rank(a) - rank(b))[0];
  const pinned = order === 'mru' && previous !== undefined && previous.windowId !== activeWindowId
    && rank(previous) < mru.length ? previous : undefined;
  if (pinned) {
    out.push(mkItem(pinned, 'Previous', labelFor.get(pinned.windowId ?? -1)));
  }
  const inWindow = (w: number): PaletteTab[] => sortFor(tabs.filter((t) => t.windowId === w));
  for (const t of inWindow(activeWindowId)) out.push(mkItem(t, 'This window'));
  for (const w of otherIds) {
    const label = labelFor.get(w)!;
    for (const t of inWindow(w)) {
      if (t.tabId === pinned?.tabId) continue; // already pinned up top
      out.push(mkItem(t, label, label));
    }
  }
  return out;
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
      dispatch: { kind: 'navigate' as const, url: b.url },
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

/** Why the effective query differs from the text in the box. */
export type QueryFallback = 'dictated_retry' | 'phonetic';

export interface ResolvedQuery {
  /** The query to filter with. */
  query: string;
  /** Null when the box text was used verbatim. */
  reason: QueryFallback | null;
}

/**
 * Resolve the query to filter with, given the box text and the text the most
 * recent dictation burst inserted.
 *
 * Dictation reaches the palette the same way it reaches any focused field —
 * the platform's sink types the transcript at the caret (CGEvent unicode
 * injection), so the palette needs no voice plumbing to be dictatable. Two
 * consequences are handled here:
 *
 * - **A second utterance appends.** "gmail" then "github" leaves "gmailgithub"
 *   in the box, which matches nothing. When the literal box text finds nothing
 *   but the last utterance alone does, that utterance is the query — the user
 *   is re-querying, not extending. Purely result-driven (no timers, no
 *   utterance-boundary signal): it can only fire where it strictly improves
 *   the result set, so a long transcript arriving as several chunks — which
 *   also lands as consecutive insertions — is unaffected (a mid-word tail
 *   matches nothing on its own).
 * - **The recognizer mishears.** Falling back to the phonetic correction the
 *   find bar uses (`bestPageMatch`), against the palette's own words as the
 *   candidate set — the same "match against what's actually there" move that
 *   turns a recognition problem into a matching problem.
 *
 * Exact-first throughout: a query that matches literally is never rewritten,
 * so typing behaves exactly as before.
 */
export function resolvePaletteQuery(
  raw: string,
  dictated: string,
  items: readonly PaletteItem[],
): ResolvedQuery {
  const hits = (q: string): boolean => {
    const words = searchWords(q);
    return words.length > 0 && items.some((it) => scoreItem(it, words) > 0);
  };
  const box = raw.trim();
  if (box === '' || hits(box)) return { query: raw, reason: null };
  const utterance = dictated.trim();
  if (utterance !== '' && utterance !== box && hits(utterance)) {
    return { query: utterance, reason: 'dictated_retry' };
  }
  const corpus = [...new Set(items.flatMap((it) => it.words))].join(' ');
  for (const candidate of [box, utterance]) {
    if (candidate === '') continue;
    const match = bestPageMatch(candidate, corpus);
    if (match && hits(match.term)) return { query: match.term, reason: 'phonetic' };
  }
  return { query: raw, reason: null };
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
 * push the recent tabs down.
 *
 * With a query = search mode: tabs and commands collapse to one ranked
 * section per source (per-group sections would fragment relevance ordering —
 * the best match must be first, not under the third header). Bookmarks are
 * the exception: their headers are the user's OWN folder names, and a header
 * that flips to a generic "Bookmarks" the moment you type reads as the folder
 * being renamed (field report 2026-07-25). Ranked bookmark results regroup
 * under their real folder, sections ordered by each folder's best hit — the
 * global best match is still the first row. Sections that match nothing are
 * dropped.
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
  const rank = (items: readonly PaletteItem[]): PaletteItem[] => items
    .map((item, i) => ({ item, i, score: scoreItem(item, q) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((r) => r.item);
  const build = (source: PaletteSourceId, label: string, items: readonly PaletteItem[]): void => {
    const picked = q.length === 0 ? [...items] : rank(items);
    if (picked.length) sections.push({ source, label, items: picked });
  };
  // Browse mode sections tabs by window group when present ("Previous" /
  // "This window" / "Window 2"…, first-appearance order — the build order).
  // Search mode collapses to ONE ranked section: a hunt must not fragment
  // by window; the subtitle carries the window instead.
  if (q.length === 0 && tabItems.some((i) => i.group !== undefined)) {
    for (const g of groupLabels(tabItems, 'Tabs')) {
      build('tabs', g, tabItems.filter((i) => (i.group ?? 'Tabs') === g));
    }
  } else {
    build('tabs', 'Tabs', tabItems);
  }
  if (q.length === 0) {
    for (const g of groupLabels(bookmarkItems, 'Bookmarks')) {
      build('bookmarks', g, bookmarkItems.filter((i) => (i.group ?? 'Bookmarks') === g));
    }
  } else {
    // Regroup the ranked hits under their folder: insertion order of the
    // groups follows each folder's best-ranked item, so the first section
    // opens with the global best match.
    const byFolder = new Map<string, PaletteItem[]>();
    for (const item of rank(bookmarkItems)) {
      const g = item.group ?? 'Bookmarks';
      const arr = byFolder.get(g) ?? [];
      arr.push(item);
      byFolder.set(g, arr);
    }
    for (const [label, items] of byFolder) {
      sections.push({ source: 'bookmarks', label, items });
    }
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

/**
 * TLDs the bare-domain heuristic accepts. Deliberately a SHORT list, not
 * IANA's: the failure modes are asymmetric (DESIGN_PALETTE_URL_SEARCH.md).
 * A missed URL still has the search row — engines redirect bare domains —
 * while a false positive steals the first row and breaks Enter. So common
 * TLDs only, and none that collide with file extensions ("main.rs",
 * "node.js" are things people SEARCH for; .rs and .js stay out even though
 * they are real TLDs).
 */
const COMMON_TLDS = new Set([
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'io', 'dev', 'app', 'ai',
  'co', 'me', 'tv', 'fm', 'gg', 'xyz', 'info', 'biz', 'blog', 'shop', 'news',
  'wiki', 'site', 'online', 'store', 'cloud', 'uk', 'de', 'fr', 'jp', 'cn',
  'ca', 'au', 'us', 'br', 'in', 'ru', 'nl', 'se', 'no', 'fi', 'dk', 'pl',
  'ch', 'at', 'be', 'es', 'it', 'pt', 'ie', 'nz', 'cz', 'gr',
]);

/**
 * The normalized URL when `query` parses as a destination, else null — the
 * gate on the "Go to …" row, which sits FIRST and therefore owns Enter. It
 * claims "URL" only on strong signals; everything ambiguous falls through to
 * the search row, which handles it correctly anyway:
 * - an explicit http(s) scheme;
 * - localhost / an IPv4 address (optional port; http, not https — dev
 *   servers rarely speak TLS);
 * - a dotted host whose tail is a COMMON_TLDS member, no whitespace.
 * Detection never rewrites the typed text — normalization lives in the
 * returned URL, which the row displays, so Enter has no surprises.
 */
export function destinationUrl(query: string): string | null {
  const q = query.trim();
  if (q === '' || /\s/.test(q)) return null;
  if (/^https?:\/\//i.test(q)) {
    try { return new URL(q).href; } catch { return null; }
  }
  // host[:port][/path…] — userinfo deliberately unmatched ("a@b.com" is an
  // email being searched, not a URL with credentials).
  const m = /^([^/?#:]+)(:\d{1,5})?([/?#].*)?$/.exec(q);
  if (!m) return null;
  const host = m[1].toLowerCase();
  const labels = host.split('.');
  const isIp = labels.length === 4
    && labels.every((l) => /^\d{1,3}$/.test(l) && Number(l) <= 255);
  const isDotted = labels.length >= 2
    && labels.every((l) => /^[a-z0-9-]+$/.test(l))
    && COMMON_TLDS.has(labels[labels.length - 1]);
  const scheme = host === 'localhost' || isIp ? 'http' : 'https';
  if (host !== 'localhost' && !isIp && !isDotted) return null;
  try { return new URL(`${scheme}://${q}`).href; } catch { return null; }
}

/**
 * The "Go to …" row (phase 2): present only when the query parses as a
 * destination, positioned FIRST by the caller — URL-shaped input is
 * unambiguous intent and Enter should honor it (the omnibox/Vomnibar rule).
 * Same corpus-exclusion contract as buildSearchSection.
 */
export function buildUrlSection(query: string): PaletteSection | null {
  const url = destinationUrl(query);
  if (url === null) return null;
  return {
    source: 'query',
    label: 'Address',
    items: [{
      source: 'query',
      id: 'query:url',
      title: `Go to ${url}`,
      subtitle: hostOf(url),
      keys: [],
      voice: [],
      words: [],
      dispatch: { kind: 'navigate', url },
    }],
  };
}

/** The query substituted into an engine template. No `%s` in the template is
 *  tolerated (append) rather than validated — a broken setting must still
 *  produce a working search, not a dead row. */
export function searchUrl(template: string, query: string): string {
  const q = encodeURIComponent(query);
  return template.includes('%s') ? template.replace('%s', q) : template + q;
}

/**
 * The web-search row (DESIGN_PALETTE_URL_SEARCH.md phase 1): a query-derived
 * section the caller appends AFTER `resolvePaletteQuery` and `filterPalette`
 * have run. Null at empty query — the browse state and its Enter-lands-on-
 * previous-tab default must not grow a row.
 *
 * Two properties are load-bearing, one structural and one defensive:
 * - the caller never passes this row to `resolvePaletteQuery` — a row that
 *   matches every query would make `hits()` universally true and silently
 *   kill both of its recoveries (the appended-utterance retry and the
 *   phonetic correction);
 * - `words` is empty, so even a leaked row scores 0 and can't match. Belt
 *   under the suspenders, tested as such.
 *
 * Position (last) is the caller's job: this row is the fallthrough, not the
 * guess — a ranked match above it is usually right.
 */
export function buildSearchSection(query: string, template: string): PaletteSection | null {
  const q = query.trim();
  if (q === '') return null;
  const url = searchUrl(template, q);
  return {
    source: 'query',
    label: 'Web',
    items: [{
      source: 'query',
      id: 'query:search',
      title: `Search for “${q}”`,
      subtitle: hostOf(url),
      keys: [],
      voice: [],
      words: [],
      dispatch: { kind: 'navigate', url },
    }],
  };
}

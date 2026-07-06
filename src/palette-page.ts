/**
 * BranchKit Browser — command palette page (Layer 2 of
 * notes/DESIGN_TAB_NAVIGATION.md).
 *
 * Runs in the extension-served iframe the content script injects
 * (render/palette-host.ts). Extension origin, so (a) the host page cannot
 * observe keystrokes — the Vomnibar isolation rationale — and (b) it reads
 * chrome.tabs / storage directly instead of round-tripping through content.
 *
 * All selection/dispatch leaves through PALETTE_ACTION messages to the
 * background, which closes the overlay in the origin tab and then executes —
 * a tab switch directly, a command via PALETTE_COMMAND into the origin tab's
 * content dispatcher (exact keyboard-bind semantics).
 *
 * The list model (sources, ranking) is pure and lives in palette/model.ts.
 */

import { COMMAND_CATALOG } from './command-catalog';
import { loadKeymap } from './keymap-storage';
import { overridesFromList, type OverrideRecord } from './command-override';
import { loadMru } from './background/tab-mru';
import {
  buildTabItems, buildCommandItems, filterPalette,
  type PaletteItem, type PaletteSection, type PaletteTab,
} from './palette/model';
import { assignCodewords, codewordDisplay, classifyMarkInput } from './palette/codewords';
import { loadMarkerMap, markToSpokenWords, type MarkerMap } from './background/tab-markers';
import { stripTabMarker } from './tab-marker-format';
import type { BadgeDisplayMode } from './types';
import type { Message, PaletteVoiceEntry, PaletteVoiceRow } from './types';

const queryInput = document.getElementById('query') as HTMLInputElement;
const listEl = document.getElementById('list') as HTMLDivElement;
const backdrop = document.getElementById('backdrop') as HTMLDivElement;

// Scope from the host URL: 'tabs' shows only the open-tabs source (Ctrl+T /
// voice "tab"); anything else is the full command station.
const scope = new URLSearchParams(location.search).get('scope') === 'tabs' ? 'tabs' : 'all';

let tabItems: PaletteItem[] = [];
let commandItems: PaletteItem[] = [];
/** Flat render order of the current sections — the selection index space. */
let flat: PaletteItem[] = [];
let selected = 0;
/** Spoken badge per row id, assigned ONCE at open (publish-once discipline —
 *  refiltering never reassigns, so a row's badge is stable for the palette's
 *  lifetime). Empty when the voice alphabet isn't loaded. */
let codewords: Map<string, string> = new Map();
/** The alphabet the codewords were assigned from (for letter display). */
let voiceAlphabet: string[] = [];
/** tabId → stable strip mark (letter token). In tabs scope the palette rows
 *  use these instead of ephemeral codewords, so the strip and the palette show
 *  the SAME letter. */
let markMap: MarkerMap = {};
/** Shared badge display setting — the same `badgeDisplayMode` the page hints
 *  read, so palette badges show letters/words per the user's one preference.
 *  Same 'letter' fallback as config.ts. */
let displayMode: BadgeDisplayMode = 'letter';

// Tab-palette input model (notes/DESIGN_TAB_MARKERS.md): the tab palette opens
// in LETTER mode — like a page of tab hints, you type a tab's mark letter to
// jump (prefix-free marks activate instantly). `/` switches to FUZZY title
// search, matching the page's "hints vs / find" model. The full palette
// (scope=all) is always fuzzy.
type PaletteMode = 'letter' | 'fuzzy';
let mode: PaletteMode = 'fuzzy';
/** The mark letters typed so far in letter mode ("i" waiting for a pair). */
let markPrefix = '';

function send(action: Extract<Message, { type: 'PALETTE_ACTION' }>['action']): void {
  chrome.runtime.sendMessage({ type: 'PALETTE_ACTION', action } as Message).catch(() => {});
}

function close(): void {
  send({ kind: 'close' });
}

function dispatchItem(item: PaletteItem | undefined): void {
  if (item) send(item.dispatch);
}

/** The tab hosting this palette. getCurrent works from an extension frame
 * embedded in a tab; the active-tab query is the fallback (the palette only
 * ever opens in the focused window's active tab). */
async function currentTabId(): Promise<number | null> {
  try {
    const t = await chrome.tabs.getCurrent();
    if (t?.id != null) return t.id;
  } catch { /* fall through */ }
  try {
    const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
    return t?.id ?? null;
  } catch {
    return null;
  }
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function render(sections: PaletteSection[]): void {
  flat = sections.flatMap((s) => s.items);
  if (selected >= flat.length) selected = Math.max(0, flat.length - 1);
  listEl.textContent = '';
  if (flat.length === 0) {
    listEl.appendChild(el('div', 'empty', 'No matching tabs or commands.'));
    return;
  }
  let idx = 0;
  for (const s of sections) {
    listEl.appendChild(el('div', 'sec', s.label));
    for (const item of s.items) {
      const i = idx++;
      const row = el('div', i === selected ? 'row sel' : 'row');
      const cw = codewords.get(item.id);
      if (cw) {
        // Tabs scope: the codeword IS the stable mark letter — show it as-is so
        // the badge matches the strip. Full palette: word codewords → display
        // per badgeDisplayMode.
        const badge = scope === 'tabs' ? cw : codewordDisplay(cw, voiceAlphabet, displayMode);
        row.appendChild(el('span', 'cw', badge));
      }
      row.appendChild(el('span', 'title', item.title));
      if (item.subtitle && item.subtitle !== item.title) {
        row.appendChild(el('span', 'sub', item.subtitle));
      }
      const meta = el('div', 'meta');
      if (item.voice.length) meta.appendChild(el('span', 'say', `“${item.voice[0]}”`));
      for (const k of item.keys) meta.appendChild(el('kbd', undefined, k));
      if (meta.childNodes.length) row.appendChild(meta);
      row.addEventListener('mousedown', (ev) => ev.preventDefault()); // keep input focus
      row.addEventListener('click', () => dispatchItem(item));
      listEl.appendChild(row);
    }
  }
  listEl.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
}

/** Render for the current mode: letter mode narrows tabs by mark prefix; fuzzy
 *  mode filters by the typed title query. */
function renderCurrent(): void {
  if (scope === 'tabs' && mode === 'letter') {
    const items = markPrefix === ''
      ? tabItems
      : tabItems.filter((it) => (codewords.get(it.id) ?? '').startsWith(markPrefix));
    render([{ source: 'tabs', label: 'Tabs', items }]);
  } else {
    render(filterPalette(tabItems, commandItems, queryInput.value));
  }
}

function moveSelection(delta: number): void {
  if (flat.length === 0) return;
  selected = (selected + delta + flat.length) % flat.length;
  renderCurrent();
}

// A mark letter in letter mode. Prefix-free marks make this crisp: an exact
// match jumps immediately (a single-letter mark can't be the start of a pair);
// a prefix narrows the list; anything else is a no-op (never blanks the list).
function typeMarkLetter(ch: string): void {
  const next = markPrefix + ch;
  switch (classifyMarkInput([...codewords.values()], next)) {
    case 'exact': {
      const item = tabItems.find((it) => codewords.get(it.id) === next);
      if (item) dispatchItem(item);
      return;
    }
    case 'none':
      return; // no mark continues this — ignore the keystroke
    case 'prefix':
      markPrefix = next;
      queryInput.value = markPrefix;
      selected = 0;
      renderCurrent();
  }
}

function backspaceMark(): void {
  if (markPrefix.length === 0) return;
  markPrefix = markPrefix.slice(0, -1);
  queryInput.value = markPrefix;
  selected = 0;
  renderCurrent();
}

function enterFuzzyMode(): void {
  mode = 'fuzzy';
  markPrefix = '';
  queryInput.readOnly = false;
  queryInput.value = '';
  queryInput.placeholder = 'Search tabs…';
  queryInput.focus();
  selected = 0;
  renderCurrent();
}

function enterLetterMode(): void {
  mode = 'letter';
  markPrefix = '';
  queryInput.readOnly = true;
  queryInput.value = '';
  queryInput.placeholder = 'Type a tab’s letter — or / to search';
  selected = 0;
  renderCurrent();
}

// Fuzzy typing only — letter mode captures keys in the keydown handler and the
// input is readonly there, so this fires only in fuzzy mode.
queryInput.addEventListener('input', () => {
  if (scope === 'tabs' && mode === 'letter') return;
  selected = 0;
  renderCurrent();
});

window.addEventListener('keydown', (e) => {
  // Common navigation (both modes). Ctrl+K closes either palette (the full
  // palette's opener toggles it; a convenience for the tab palette). The tab
  // palette opens with bare `T`, which is a mark letter inside letter mode, so
  // it can't toggle-close — Escape / backdrop close it, like Vimium-C.
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
    e.preventDefault(); close(); return;
  }
  if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault(); moveSelection(1); return;
  }
  if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
    e.preventDefault(); moveSelection(-1); return;
  }
  if (e.key === 'Enter') {
    e.preventDefault(); dispatchItem(flat[selected]); return;
  }

  // Letter mode (tab palette default): keystroke-capture for mark-jump.
  if (scope === 'tabs' && mode === 'letter') {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (markPrefix) {
        // Two-stage: clear the typed prefix first, then a second Escape closes.
        markPrefix = '';
        queryInput.value = '';
        selected = 0;
        renderCurrent();
      } else {
        close();
      }
      return;
    }
    if (e.key === '/') { e.preventDefault(); enterFuzzyMode(); return; }
    if (e.key === 'Backspace') { e.preventDefault(); backspaceMark(); return; }
    if (/^[a-z]$/i.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); typeMarkLetter(e.key.toLowerCase()); return;
    }
    return; // swallow anything else in letter mode
  }

  // Fuzzy mode: Escape returns to letter mode (tab palette) or closes (full).
  if (e.key === 'Escape') {
    e.preventDefault();
    if (scope === 'tabs') enterLetterMode(); else close();
  }
});

backdrop.addEventListener('click', (e) => {
  if (e.target === backdrop) close();
});

// OS focus leaving the browser closes the palette. Load-bearing beyond UX:
// the plugin holds an EXCLUSIVE palette tag while our rows are published, and
// an exclusive tag left active while another app is frontmost would suppress
// every other command system-wide. Closing drains the entries → clears the
// tag through the normal path (the plugin's focus-loss drain is the backstop).
window.addEventListener('blur', () => close());

const tabIdOf = (rowId: string): number | null =>
  rowId.startsWith('tab:') ? Number(rowId.slice(4)) : null;

/**
 * Assign each row's codeword and, if voice is connected, publish the spoken
 * entries + row→dispatch map so the exclusive-tag voice half can resolve them.
 *
 * Tabs scope CONVERGES on the stable strip marks: a row's codeword is its
 * tab's mark letter (badge matches the strip), and the spoken form is that
 * mark's alphabet-overlay words. With no alphabet (voice off) the marks still
 * badge the rows — keyboard-usable — but nothing is published, so no exclusive
 * tag is set. Full palette keeps ephemeral word codewords.
 */
function assignAndPublish(alphabet: string[]): void {
  voiceAlphabet = alphabet;
  const all = [...tabItems, ...commandItems];
  if (scope === 'tabs') {
    codewords = new Map();
    for (const item of tabItems) {
      const id = tabIdOf(item.id);
      const mark = id != null ? markMap[id] : undefined;
      if (mark) codewords.set(item.id, mark);
    }
  } else {
    codewords = assignCodewords(all.map((r) => r.id), alphabet);
  }
  if (codewords.size === 0) return;

  const entries: PaletteVoiceEntry[] = [];
  const rows: PaletteVoiceRow[] = [];
  for (const item of all) {
    const cw = codewords.get(item.id);
    if (!cw) continue;
    // Tabs: cw is a mark letter → spoken is its overlay words (empty when no
    // alphabet). Full palette: cw is already the spoken word.
    const spoken = scope === 'tabs' ? markToSpokenWords(cw, alphabet) : cw;
    if (spoken) entries.push({ spoken, row_id: item.id });
    rows.push({ row_id: item.id, dispatch: item.dispatch });
  }
  // No spoken entries (voice off) → don't open a voice session / exclusive tag.
  if (entries.length === 0) return;
  chrome.runtime.sendMessage({ type: 'PALETTE_PUBLISH', entries, rows } as Message).catch(() => {});
}

async function init(): Promise<void> {
  queryInput.focus();
  const [tabs, mru, keymap, activeId, stored, sync, marks, overridesResp] = await Promise.all([
    chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]),
    loadMru().catch(() => [] as number[]),
    loadKeymap().catch(() => []),
    currentTabId(),
    chrome.storage.local.get('alphabet').catch(() => ({} as Record<string, unknown>)),
    chrome.storage.sync.get('badgeDisplayMode').catch(() => ({} as Record<string, unknown>)),
    loadMarkerMap().catch(() => ({} as MarkerMap)),
    chrome.runtime.sendMessage({ type: 'GET_COMMAND_OVERRIDES' }).catch(() => undefined),
  ]);
  const overrides = overridesFromList(
    ((overridesResp as { overrides?: OverrideRecord[] } | undefined)?.overrides) ?? [],
  );
  if (typeof sync.badgeDisplayMode === 'string') {
    displayMode = sync.badgeDisplayMode as BadgeDisplayMode;
  }
  markMap = marks;
  const open: PaletteTab[] = tabs
    .filter((t): t is chrome.tabs.Tab & { id: number } => typeof t.id === 'number')
    // Strip the marker decoration from titles — the mark shows as the row's
    // badge, not baked into the title text.
    .map((t) => ({ tabId: t.id, title: stripTabMarker(t.title ?? ''), url: t.url ?? '' }));
  tabItems = buildTabItems(open, mru, activeId);
  // Tabs-only scope drops the command source entirely — same overlay, one
  // source (the Vomnibar "scoped by trigger key" pattern).
  commandItems = scope === 'tabs' ? [] : buildCommandItems(COMMAND_CATALOG, keymap, undefined, overrides);
  const alphabet = Array.isArray(stored.alphabet) ? (stored.alphabet as string[]) : [];
  assignAndPublish(alphabet);
  // Tab palette opens in letter mode when marks exist (the fast path); with no
  // marks (feature off / pool empty) fall back to fuzzy so the palette is still
  // usable. Full palette is always fuzzy.
  if (scope === 'tabs' && codewords.size > 0) enterLetterMode();
  else if (scope === 'tabs') { mode = 'fuzzy'; queryInput.placeholder = 'Search tabs…'; }
  renderCurrent();
}

void init();

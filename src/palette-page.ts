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
import { loadMru } from './background/tab-mru';
import {
  buildTabItems, buildCommandItems, filterPalette,
  type PaletteItem, type PaletteSection, type PaletteTab,
} from './palette/model';
import { assignCodewords, codewordDisplay } from './palette/codewords';
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

function refilter(): void {
  render(filterPalette(tabItems, commandItems, queryInput.value));
}

function moveSelection(delta: number): void {
  if (flat.length === 0) return;
  selected = (selected + delta + flat.length) % flat.length;
  refilter();
}

queryInput.addEventListener('input', () => {
  selected = 0;
  refilter();
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    close();
  } else if (e.key === 'ArrowDown' || (e.key === 'Tab' && !e.shiftKey)) {
    e.preventDefault();
    moveSelection(1);
  } else if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
    e.preventDefault();
    moveSelection(-1);
  } else if (e.key === 'Enter') {
    e.preventDefault();
    dispatchItem(flat[selected]);
  } else if ((e.ctrlKey || e.metaKey) && (e.code === 'KeyK' || e.code === 'KeyT')) {
    // Either opening chord (Ctrl+K full, Ctrl+T tabs) toggles closed.
    e.preventDefault();
    close();
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
  if (scope === 'tabs') queryInput.placeholder = 'Search tabs…';
  queryInput.focus();
  const [tabs, mru, keymap, activeId, stored, sync, marks] = await Promise.all([
    chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]),
    loadMru().catch(() => [] as number[]),
    loadKeymap().catch(() => []),
    currentTabId(),
    chrome.storage.local.get('alphabet').catch(() => ({} as Record<string, unknown>)),
    chrome.storage.sync.get('badgeDisplayMode').catch(() => ({} as Record<string, unknown>)),
    loadMarkerMap().catch(() => ({} as MarkerMap)),
  ]);
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
  commandItems = scope === 'tabs' ? [] : buildCommandItems(COMMAND_CATALOG, keymap);
  const alphabet = Array.isArray(stored.alphabet) ? (stored.alphabet as string[]) : [];
  assignAndPublish(alphabet);
  refilter();
}

void init();

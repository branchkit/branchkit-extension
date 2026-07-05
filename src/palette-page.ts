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
import type { Message } from './types';

const queryInput = document.getElementById('query') as HTMLInputElement;
const listEl = document.getElementById('list') as HTMLDivElement;
const backdrop = document.getElementById('backdrop') as HTMLDivElement;

let tabItems: PaletteItem[] = [];
let commandItems: PaletteItem[] = [];
/** Flat render order of the current sections — the selection index space. */
let flat: PaletteItem[] = [];
let selected = 0;

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
  } else if ((e.ctrlKey || e.metaKey) && e.code === 'KeyK') {
    // The opening chord toggles closed — same key, same result.
    e.preventDefault();
    close();
  }
});

backdrop.addEventListener('click', (e) => {
  if (e.target === backdrop) close();
});

async function init(): Promise<void> {
  queryInput.focus();
  const [tabs, mru, keymap, activeId] = await Promise.all([
    chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]),
    loadMru().catch(() => [] as number[]),
    loadKeymap().catch(() => []),
    currentTabId(),
  ]);
  const open: PaletteTab[] = tabs
    .filter((t): t is chrome.tabs.Tab & { id: number } => typeof t.id === 'number')
    .map((t) => ({ tabId: t.id, title: t.title ?? '', url: t.url ?? '' }));
  tabItems = buildTabItems(open, mru, activeId);
  commandItems = buildCommandItems(COMMAND_CATALOG, keymap);
  refilter();
}

void init();

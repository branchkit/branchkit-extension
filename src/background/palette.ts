/**
 * BranchKit Browser — palette voice session (service-worker side).
 *
 * Voice half of the command palette's Layer 2 (notes/DESIGN_TAB_NAVIGATION.md).
 * While the palette is open with badges, the plugin holds its EXCLUSIVE
 * palette tag and the `browser_palette` collection maps spoken codewords to
 * row ids. The row_id → dispatch map never leaves the extension — the plugin
 * round-trips only the opaque row id, and this module resolves it back to the
 * same close-then-execute path the keyboard uses.
 *
 * One session max: a palette only ever opens in the focused window's active
 * tab, and the plugin's projection is single-conn to match. Lifted out of
 * background.ts (notes/DESIGN_RESTRUCTURE_ROUND3.md).
 */

import { PaletteVoiceEntry, PaletteVoiceRow } from '../types';
import type { PaletteDispatch, PaletteBookmark } from '../palette/model';
import { ensureConnected, postToPlugin } from '../plugin/actuator-client';
import { focusWindowAndActivateTab } from './tab-actions';
import { connId } from './state';
import { loadMru } from './tab-mru';
import { loadMarkerMap } from './tab-markers';

/**
 * Flatten the bookmark tree to leaf bookmarks with their folder path (for the
 * subtitle + search haystack). Root containers ("Bookmarks Bar", "Other
 * Bookmarks" on Chrome; "Bookmarks Menu" etc. on Firefox) are kept in the
 * path — they disambiguate duplicates and cost nothing.
 */
export async function loadBookmarks(): Promise<{ list: PaletteBookmark[]; error?: string }> {
  const out: PaletteBookmark[] = [];
  const walk = (nodes: chrome.bookmarks.BookmarkTreeNode[], path: string[]): void => {
    for (const n of nodes) {
      if (n.url) out.push({ title: n.title || n.url, url: n.url, path: path.join(' / ') });
      else if (n.children) walk(n.children, n.title ? [...path, n.title] : path);
    }
  };
  // Loud, not empty (the palette's bootstrap rule): a failure names itself in
  // the response so the overlay + fdiag can show it — a silent [] reads as
  // "you have no bookmarks" and costs a field round-trip. It did (2026-07-25).
  if (!chrome.bookmarks?.getTree) {
    return { list: [], error: 'bookmarks API unavailable — permission not granted? (re-toggle the extension)' };
  }
  try {
    walk(await chrome.bookmarks.getTree(), []);
  } catch (e) {
    return { list: [], error: String(e) };
  }
  return { list: out };
}

/**
 * PALETTE_BOOTSTRAP: privileged palette data, fetched here because the
 * Firefox palette iframe has content-script privileges only (relay doc in
 * palette/relay.ts). activeTabId = the sender's tab — the palette can only be
 * open in the tab that hosts it. Returns true (async sendResponse).
 */
export function handlePaletteBootstrap(
  sender: chrome.runtime.MessageSender,
  sendResponse: (r: unknown) => void,
): boolean {
  const activeTabId = sender.tab?.id ?? null;
  Promise.all([
    chrome.tabs.query({}).catch(() => [] as chrome.tabs.Tab[]),
    loadMru().catch(() => [] as number[]),
    loadMarkerMap().catch(() => ({})),
    loadBookmarks(),
  ]).then(([tabs, mru, marks, bm]) => {
    sendResponse({
      tabs: tabs
        .filter((t) => typeof t.id === 'number')
        .map((t) => ({ tabId: t.id, title: t.title ?? '', url: t.url ?? '' })),
      mru, marks, bookmarks: bm.list, bookmarksError: bm.error, activeTabId,
    });
  }).catch(() => sendResponse({ tabs: [], mru: [], marks: {}, bookmarks: [], activeTabId }));
  return true;
}

interface PaletteVoiceSession {
  tabId: number;
  rows: Map<string, PaletteDispatch>;
}
let paletteVoice: PaletteVoiceSession | null = null;

export async function publishPaletteVoice(
  tabId: number,
  entries: PaletteVoiceEntry[],
  rows: PaletteVoiceRow[],
): Promise<void> {
  paletteVoice = { tabId, rows: new Map(rows.map((r) => [r.row_id, r.dispatch])) };
  if (!(await ensureConnected())) return;
  await postToPlugin('/palette', { conn_id: connId, entries });
}

// Idempotent teardown — called from every close path (PALETTE_CLOSED from
// content, dispatch, tab close). The empty POST drains the plugin's entries,
// which Deletes the exclusive tag; a stuck tag would suppress every other
// command system-wide, so this errs on firing redundantly.
export async function clearPaletteVoice(reason: string): Promise<void> {
  if (!paletteVoice) return;
  paletteVoice = null;
  console.log(`[BranchKit BG] palette voice cleared (${reason})`);
  await postToPlugin('/palette', { conn_id: connId, entries: [] });
}

// Command palette selection (Layer 2). Always close the overlay in the origin
// tab FIRST — a tab switch moves focus away and must not leave a dead palette
// behind, and a command dispatch (e.g. focus_input) needs page focus restored
// before it runs. The close message round-trips (content sendResponse) so
// ordering is real, not racy.
export async function handlePaletteAction(
  action: PaletteDispatch | { kind: 'close' },
  originTabId: number | undefined,
): Promise<void> {
  // Direct teardown besides the content-side PALETTE_CLOSED signal: if the
  // content script is gone (catch below), the signal never fires, and the
  // exclusive tag must not outlive the palette.
  void clearPaletteVoice('palette_action');
  if (typeof originTabId === 'number') {
    try {
      await chrome.tabs.sendMessage(originTabId, { type: 'PALETTE_CLOSE' }, { frameId: 0 });
    } catch { /* content script gone — the iframe died with the page */ }
  }
  if (action.kind === 'switch_tab') {
    // A stale id (tab closed while the palette was open) is a silent no-op.
    await focusWindowAndActivateTab(action.tabId);
  } else if (action.kind === 'open_bookmark') {
    // New focused tab: picking a bookmark should never eat the page you were
    // on (and the palette can't open on the browser's native new-tab page —
    // no content script there — so "open in place" has no natural home).
    await chrome.tabs.create({ url: action.url, active: true }).catch(() => {});
  } else if (action.kind === 'command' && typeof originTabId === 'number') {
    // Through the content dispatcher in the top frame — the exact semantics
    // of pressing the command's keybind (tab verbs bounce back here as
    // TAB_ACTION, page commands run in place).
    try {
      await chrome.tabs.sendMessage(originTabId, {
        type: 'PALETTE_COMMAND', action: action.command, params: action.params ?? {},
      }, { frameId: 0 });
    } catch { /* content script gone */ }
  }
}

// Voice selection off the SSE stream: the matched codeword's row_id comes back
// from the browser_palette collection; resolve it through the session's
// dispatch map and reuse the keyboard path (close overlay, then execute). An
// unknown row id (stale utterance racing a re-open) just closes the palette.
// The matcher already cleared the exclusive tag (ClearsTags at match time);
// handlePaletteAction's clearPaletteVoice drains the entries to match.
export function handlePaletteVoiceSelect(rowId: string | undefined): void {
  const pv = paletteVoice;
  if (!pv) return;
  const dispatch = pv.rows.get(rowId ?? '');
  void handlePaletteAction(dispatch ?? { kind: 'close' }, pv.tabId);
}

export function handlePaletteVoiceDismiss(): void {
  if (paletteVoice) void handlePaletteAction({ kind: 'close' }, paletteVoice.tabId);
}

// Backstop for tabs.onRemoved: a palette whose host tab died can't send
// PALETTE_CLOSED.
export function clearPaletteForClosedTab(tabId: number): void {
  if (paletteVoice?.tabId === tabId) void clearPaletteVoice('tab_removed');
}

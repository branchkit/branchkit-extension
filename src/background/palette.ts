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

import type { MessageHandler } from '../core/message-router';
import { PaletteVoiceEntry, PaletteVoiceRow } from '../types';
import type { PaletteDispatch, PaletteBookmark } from '../palette/model';
import { ensureConnected, postToPlugin } from '../plugin/actuator-client';
import { focusWindowAndActivateTab } from './tab-actions';
import { connId } from './state';
import { loadMarkerMap } from './tab-markers';
import { loadPaletteOpenDefault } from '../palette-open-storage';

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
    loadMarkerMap().catch(() => ({})),
    loadBookmarks(),
  ]).then(([tabs, marks, bm]) => {
    sendResponse({
      tabs: tabs
        .filter((t) => typeof t.id === 'number')
        .map((t) => ({ tabId: t.id, title: t.title ?? '', url: t.url ?? '', windowId: t.windowId })),
      marks, bookmarks: bm.list, bookmarksError: bm.error, activeTabId,
      activeWindowId: sender.tab?.windowId ?? null,
    });
  }).catch(() => sendResponse({ tabs: [], marks: {}, bookmarks: [], activeTabId }));
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

/** Where a navigate dispatch (bookmark, URL, or web-search row) lands: a new
 *  focused tab (DEFAULT), a new background tab ("stash"), or the origin tab
 *  itself ("here" — spoken "here" + badge, or Shift+Enter). Non-navigate
 *  rows ignore it. */
export type OpenWhere = 'here' | 'blank' | 'stash';

// Command palette selection (Layer 2). Always close the overlay in the origin
// tab FIRST — a tab switch moves focus away and must not leave a dead palette
// behind, and a command dispatch (e.g. focus_input) needs page focus restored
// before it runs. The close message round-trips (content sendResponse) so
// ordering is real, not racy.
export async function handlePaletteAction(
  action: PaletteDispatch | { kind: 'close' },
  originTabId: number | undefined,
  where?: OpenWhere,
): Promise<void> {
  // An unmodified pick means whatever the user configured it to mean
  // (palette-open-storage.ts); explicit modifiers arrive as a concrete
  // `where` and skip the lookup. Read per pick — no cached copy.
  const landing = where ?? (action.kind === 'navigate' ? await loadPaletteOpenDefault() : 'blank');
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
  } else if (action.kind === 'navigate') {
    // A NEW FOCUSED TAB by the shipped default (changed 2026-07-29): a
    // bookmark is somewhere you want to go *as well as* where you already
    // are, so replacing the origin tab throws away context you didn't ask
    // to lose — the reverse of a page hint, where a bare activation
    // navigates in place because following a link IS the browsing flow.
    // The user can flip the unmodified-pick default (options page); the
    // spoken modifiers and Shift+Enter stay absolute either way.
    if (landing === 'here' && typeof originTabId === 'number') {
      await chrome.tabs.update(originTabId, { url: action.url }).catch(() => {});
    } else {
      await chrome.tabs.create({ url: action.url, active: landing !== 'stash' }).catch(() => {});
    }
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
// `where` is deliberately WITHOUT a default and passed straight through:
// handlePaletteAction owns the one default disposition. This used to default to
// 'here' independently, so the keyboard and voice paths each carried their own
// copy — and flipping the default in one place silently left the other behind.
export function handlePaletteVoiceSelect(rowId: string | undefined, where?: OpenWhere): void {
  const pv = paletteVoice;
  if (!pv) return;
  const dispatch = pv.rows.get(rowId ?? '');
  // Query rows exist only while the box holds a query; their codewords are
  // published for the palette's whole lifetime. Speaking one while its row
  // is absent is a no-op, NOT a close — the unknown-row close below is for
  // stale utterances racing a re-open, and these ids are never stale, just
  // currently rowless.
  if (!dispatch && (rowId?.startsWith('query:') ?? false)) return;
  void handlePaletteAction(dispatch ?? { kind: 'close' }, pv.tabId, where);
}

export function handlePaletteVoiceDismiss(): void {
  if (paletteVoice) void handlePaletteAction({ kind: 'close' }, paletteVoice.tabId);
}

// Backstop for tabs.onRemoved: a palette whose host tab died can't send
// PALETTE_CLOSED.
export function clearPaletteForClosedTab(tabId: number): void {
  if (paletteVoice?.tabId === tabId) void clearPaletteVoice('tab_removed');
}

/** Message handlers owned by this module (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md). */
export const paletteMessageHandlers: Record<string, MessageHandler> = {
  /**
   * A palette bind fired in a subframe; the overlay must live in the top frame.
   * Route it there as a PALETTE_COMMAND through the dispatcher.
   */
  PALETTE_OPEN: (message, sender) => {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') return;
    const action = message.command ?? 'toggle_palette';
    chrome.tabs.sendMessage(tabId, { type: 'PALETTE_COMMAND', action }, { frameId: 0 }).catch(() => {});
  },

  /**
   * From the palette iframe (extension origin, embedded in a tab — so
   * sender.tab is set). Close-then-execute; see handlePaletteAction.
   */
  PALETTE_ACTION: (message, sender) => {
    if (!message.action?.kind) return;
    void handlePaletteAction(message.action, sender.tab?.id, message.where);
  },

  /**
   * Palette iframe badged its rows: start the voice session. Sender is the
   * iframe embedded in the host tab, so sender.tab names the origin tab.
   */
  PALETTE_PUBLISH: (message, sender) => {
    if (!Array.isArray(message.entries)) return;
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') return;
    void publishPaletteVoice(tabId, message.entries, message.rows ?? []);
  },

  /**
   * The query-derived rows' current dispatches (URL/search rows — their
   * spoken entries published at open, their dispatch embeds the query).
   * Reconcile: clear both ids, set what the frame says is on screen now.
   */
  PALETTE_QUERY_ROWS: (message) => {
    if (!paletteVoice || !Array.isArray(message.rows)) return;
    for (const id of ['query:url', 'query:search']) paletteVoice.rows.delete(id);
    for (const r of message.rows) {
      if (typeof r?.row_id === 'string' && r.row_id.startsWith('query:') && r.dispatch) {
        paletteVoice.rows.set(r.row_id, r.dispatch);
      }
    }
  },

  /** Content removed the overlay (any path) — end the voice session. */
  PALETTE_CLOSED: () => { void clearPaletteVoice('overlay_closed'); },

  /**
   * Privileged palette data (tabs + MRU + marks + bookmarks). Adapts the
   * callback-shaped bootstrap onto the router's promise contract.
   */
  PALETTE_BOOTSTRAP: (_message, sender) =>
    new Promise((resolve) => { handlePaletteBootstrap(sender, resolve); }),
};

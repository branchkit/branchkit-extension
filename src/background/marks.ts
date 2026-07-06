/**
 * Marks — background side (notes/DESIGN_MARKS_AND_CARET.md, Part 1).
 *
 * The background owns all mark storage (never the page's own localStorage,
 * which Vimium uses but which the site can read/clear). Local marks live in
 * chrome.storage.session keyed by URL; global marks in chrome.storage.local
 * (durable) keyed by letter, and their goto finds the original tab, else any
 * tab with that URL, else opens a new one — ported from Vimium's
 * background_scripts/marks.js `goto`.
 */

import { baseUrl, localMarkKey, globalMarkKey, type StoredMark, type GlobalMark } from '../marks';

export async function setLocalMark(url: string, letter: string, mark: StoredMark): Promise<void> {
  await chrome.storage.session.set({ [localMarkKey(url, letter)]: mark });
}

export async function getLocalMark(url: string, letter: string): Promise<StoredMark | null> {
  const key = localMarkKey(url, letter);
  const items = await chrome.storage.session.get(key);
  return (items[key] as StoredMark | undefined) ?? null;
}

export async function setGlobalMark(letter: string, mark: GlobalMark): Promise<void> {
  await chrome.storage.local.set({ [globalMarkKey(letter)]: mark });
}

async function getGlobalMark(letter: string): Promise<GlobalMark | null> {
  const key = globalMarkKey(letter);
  const items = await chrome.storage.local.get(key);
  return (items[key] as GlobalMark | undefined) ?? null;
}

/** Activate a tab (and focus its window), then tell its content script to
 *  restore the saved position. */
async function gotoPositionInTab(tabId: number, mark: StoredMark): Promise<void> {
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId != null) {
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
  }
  chrome.tabs
    .sendMessage(tabId, { type: 'MARK_RESTORE', scrollX: mark.scrollX, scrollY: mark.scrollY, hash: mark.hash })
    .catch(() => {});
}

/** Prefer a tab in the current window, avoid the already-active tab when there
 *  are alternatives, then the shortest (closest) matching URL. Mirrors
 *  Vimium's pickTab. */
async function pickTab(tabs: chrome.tabs.Tab[]): Promise<chrome.tabs.Tab> {
  const win = await chrome.windows.getCurrent().catch(() => null);
  const inWindow = tabs.filter((t) => t.windowId === win?.id);
  let candidates = inWindow.length > 0 ? inWindow : tabs;
  if (candidates.length > 1) {
    const notActive = candidates.filter((t) => !t.active);
    if (notActive.length > 0) candidates = notActive;
  }
  return [...candidates].sort((a, b) => (a.url?.length ?? 0) - (b.url?.length ?? 0))[0];
}

/** Restore a freshly-opened tab's position once its content script is ready.
 *  Best-effort: fires on the tab's first `complete` and then unsubscribes. */
function scrollAfterLoad(tabId: number, mark: StoredMark): void {
  const listener = (id: number, info: chrome.tabs.TabChangeInfo) => {
    if (id === tabId && info.status === 'complete') {
      chrome.tabs.onUpdated.removeListener(listener);
      void gotoPositionInTab(tabId, mark);
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
}

/**
 * Jump to a global mark. Returns false if the mark isn't set. Tries the
 * original tab (id still valid + URL matches), then any tab with the mark's
 * URL, then opens a new tab and restores once it loads.
 */
export async function gotoGlobalMark(letter: string): Promise<boolean> {
  const mark = await getGlobalMark(letter);
  if (!mark) return false;

  // Original tab still open on the same base URL?
  if (mark.tabId != null) {
    let tab: chrome.tabs.Tab | undefined;
    try {
      tab = await chrome.tabs.get(mark.tabId);
    } catch {
      // Tab is gone — fall through to URL match.
    }
    if (tab?.url && baseUrl(tab.url) === mark.url && tab.id != null) {
      await gotoPositionInTab(tab.id, mark);
      return true;
    }
  }

  // Any existing tab with the URL. Require an exact URL when the mark is
  // scrolled (scrolling only makes sense on the same page); a prefix otherwise.
  const markIsScrolled = mark.scrollX > 0 || mark.scrollY > 0;
  const query = markIsScrolled ? mark.url : `${mark.url}*`;
  const tabs = await chrome.tabs.query({ url: query });
  if (tabs.length > 0) {
    const picked = await pickTab(tabs);
    if (picked?.id != null) {
      await gotoPositionInTab(picked.id, mark);
      return true;
    }
  }

  // No matching tab — open one and restore when it's ready.
  const created = await chrome.tabs.create({ url: mark.url });
  if (created.id != null) scrollAfterLoad(created.id, mark);
  return true;
}

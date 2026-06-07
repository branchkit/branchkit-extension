/**
 * BranchKit Browser — frame routing (service worker side).
 *
 * Picks which tab + frame a voice/plugin message should reach: resolve the
 * active content tab, look up which frame owns a codeword, send (lazy-injecting
 * + retrying once on "no receiving end"), broadcast, and resolve a hint from a
 * specific tab. Extracted from background.ts module scope (Tier 3 of
 * notes/DESIGN_EXTENSION_RESTRUCTURE.md), reading the shared active-tab cache
 * from background/state and the inject helpers from background/injection.
 */

import { Message } from '../types';
import { getFrameForLabel } from '../labels/label-pool';
import { bgState } from './state';
import { isInjectableURL, withInjectLock, injectContentScriptFiles } from './injection';

// Tell the newly-active tab to republish its grammar. Because the relay drops
// grammar batches from non-active tabs, a tab that was backgrounded while
// scanning never populated the (global) hint collections. On activation it
// must re-push from scratch so the active tab is the sole, complete contributor
// to the global vocabulary. The content script's `reactivate` handler flips its
// local active flag back on and re-queues its whole wrapper store.
export function republishActiveTab(tabId: number): void {
  chrome.tabs.sendMessage(tabId, {
    type: 'BRANCHKIT_ACTION',
    payload: { action: 'reactivate', params: { reason: 'tab_activated' } },
  } as Message).catch(() => {});
}

export async function broadcastToAllTabs(message: Message): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('moz-extension://')) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {});
      }
    }
  } catch {
    // Extension context may be invalidated
  }
}

/**
 * Pick the tab that voice actions should dispatch to. Avoids the
 * `lastFocusedWindow: true` trap — when devtools (or any extension
 * popup, panel, or about:debugging window) is the most recently
 * focused window, `chrome.tabs.query` would return either no tab or
 * the about:* tab inside the devtools window, neither of which has a
 * content script. We explicitly restrict the search to type='normal'
 * windows (regular browser windows) and within those prefer the
 * focused one; ignore tabs whose URL is in our injection blocklist.
 */
export async function resolveActiveContentTab(): Promise<number | null> {
  // Cached value, set by tabs.onActivated, is usually correct.
  if (bgState.cachedActiveTabId !== null) return bgState.cachedActiveTabId;

  try {
    const windows = await chrome.windows.getAll({
      populate: true,
      windowTypes: ['normal'],
    });
    // Prefer the currently-focused normal window.
    const focused = windows.find(w => w.focused);
    const orderedWindows = focused
      ? [focused, ...windows.filter(w => w !== focused)]
      : windows;
    for (const w of orderedWindows) {
      const tab = w.tabs?.find(t => t.active);
      if (tab?.id === undefined) continue;
      if (!isInjectableURL(tab.url ?? '')) continue;
      bgState.cachedActiveTabId = tab.id;
      return tab.id;
    }
  } catch {
    // ignore — fall through
  }
  return null;
}

export async function notifyActiveTab(message: Message): Promise<void> {
  try {
    const tabId = await resolveActiveContentTab();
    if (tabId === null) {
      console.warn('[BranchKit SW] no active tab found');
      return;
    }

    const frameId = await routeFrameForAction(tabId, message);
    const tid = tabId;
    const trySend = (): Promise<unknown> =>
      frameId !== null
        ? chrome.tabs.sendMessage(tid, message, { frameId })
        : chrome.tabs.sendMessage(tid, message);

    trySend().catch(async (e: Error) => {
      // "Receiving end does not exist" means the tab has no content
      // script — typically a pre-existing tab from before the extension
      // was sideloaded (Firefox temp add-ons don't auto-inject into
      // tabs that loaded earlier; Chrome's onInstalled re-injection
      // doesn't always cover every edge case either). Lazy-inject and
      // retry once.
      if (!/Receiving end does not exist|Could not establish connection/i.test(e.message)) {
        console.warn('[BranchKit SW] sendMessage failed:', e.message);
        return;
      }
      // Lazy-inject under the per-tab lock so a concurrent reinject/lazy
      // recovery doesn't race us and double-inject this tab. If lock was held
      // (returns undefined), another caller is injecting — proceed to the
      // retry send anyway; the in-flight inject will satisfy it.
      const injected = await withInjectLock(tid, () => injectContentScriptFiles(tid));
      if (injected === false) {
        console.warn('[BranchKit SW] sendMessage failed and lazy-inject did not apply:', e.message);
        return;
      }
      trySend().catch((e2: Error) => {
        console.warn('[BranchKit SW] sendMessage failed after lazy-inject:', e2.message);
      });
    });
  } catch (e) {
    console.warn('[BranchKit SW] notifyActiveTab error:', e);
  }
}

/**
 * If the message is a hint activation that names a codeword, look up which
 * frame owns that codeword in the tab's label pool and return its frameId.
 * Returns null for actions that don't carry a codeword (show_hints, rescan,
 * reactivate, etc.) — caller then sends with no frameId, which delivers to
 * every frame in the tab (both Chrome and Firefox treat an omitted frameId as
 * "all frames"). Frames with nothing to do early-out cheaply on their side
 * (e.g. republishForActivation skips frames with no claimed codewords).
 *
 * The voice plugin sends `params.codeword` directly (the full string, e.g.
 * "arch" or "zone arch") per the Sprint A.5 protocol. Older keyboard-derived
 * actions used `params.word` + optional `params.word2`; we still honor that
 * shape for backwards compatibility within the extension's own dispatcher.
 */
async function routeFrameForAction(tabId: number, message: Message): Promise<number | null> {
  if (message.type !== 'BRANCHKIT_ACTION') return null;
  const params = message.payload.params;
  if (!params) return null;

  let codeword = params.codeword;
  if (!codeword) {
    // Legacy keyboard shape — word/word2 split.
    const word = params.word;
    if (!word) return null;
    codeword = params.word2 ? `${word} ${params.word2}` : word;
  }
  return await getFrameForLabel(tabId, codeword);
}

export async function resolveHintFromTab(tabId: number, codeword: string) {
  const trimmed = codeword.trim();
  if (!trimmed) return { ok: false, reason: 'Codeword is empty.' };
  const frameId = await getFrameForLabel(tabId, trimmed);
  if (frameId == null) {
    return { ok: false, reason: `Codeword "${trimmed}" is not visible in that tab. Make sure hints are showing.` };
  }
  try {
    return await chrome.tabs.sendMessage(
      tabId,
      { type: 'RESOLVE_HINT', codeword: trimmed },
      { frameId },
    );
  } catch (err) {
    return { ok: false, reason: `Could not reach tab frame: ${String((err as Error)?.message ?? err)}` };
  }
}

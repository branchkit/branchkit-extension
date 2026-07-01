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

import { Message, ResolveHintResponse } from '../types';
import { getFrameForLabel } from '../labels/label-pool';
import { spokenCodewordToToken, spokenWordToLetter } from '../labels/words';
import { bgState } from './state';
import { isInjectableURL, withInjectLock, injectContentScriptFiles } from './injection';

/**
 * Voice overlay translation (inbound): the plugin addresses hints by spoken
 * codeword ("cape glad" / prefix word "cape"); the label pool and content
 * script are keyed on letter tokens ("c g" / letter "c"). Rewrite a voice
 * action's params to letters before routing + forwarding, so both the SW pool
 * lookup and the frame resolve against the same letter identity. Identity when
 * no overlay is loaded (letters pass through), and a no-op for actions without
 * voice params.
 */
function translateInboundAction(message: Message): Message {
  if (message.type !== 'BRANCHKIT_ACTION') return message;
  const params = message.payload.params;
  if (!params) return message;
  const next: Record<string, string> = { ...params };
  if (typeof params.codeword === 'string') next.codeword = spokenCodewordToToken(params.codeword);
  if (typeof params.prefix === 'string') next.prefix = spokenWordToLetter(params.prefix);
  if (typeof params.word === 'string') next.word = spokenWordToLetter(params.word);
  if (typeof params.word2 === 'string') next.word2 = spokenWordToLetter(params.word2);
  return { ...message, payload: { ...message.payload, params: next } };
}

// Tell the newly-active tab to republish its grammar. Because the relay drops
// grammar batches from non-active tabs, a tab that was backgrounded while
// scanning never populated the (global) hint collections. On activation it
// must re-push from scratch so the active tab is the sole, complete contributor
// to the global vocabulary. The content script's `reactivate` handler flips its
// local active flag back on and re-queues its whole wrapper store.
export function republishActiveTab(tabId: number, reason = 'tab_activated'): void {
  chrome.tabs.sendMessage(tabId, {
    type: 'BRANCHKIT_ACTION',
    payload: { action: 'reactivate', params: { reason } },
  } as Message).catch(() => {});
}

export async function broadcastToAllTabs(message: Message): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      // isInjectableURL is the one URL filter — this loop used to maintain
      // its own narrower prefix list (missed about:, view-source:, …).
      // Sends to CS-less tabs are swallowed either way; this just keeps the
      // two filters from drifting.
      if (tab.id && tab.url && isInjectableURL(tab.url)) {
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

    // Translate spoken voice params to letter tokens once: routing (the SW
    // label pool) and the frame both key on letters.
    const translated = translateInboundAction(message);
    const frameId = await routeFrameForAction(tabId, translated);
    const tid = tabId;
    const trySend = (): Promise<unknown> =>
      frameId !== null
        ? chrome.tabs.sendMessage(tid, translated, { frameId })
        : chrome.tabs.sendMessage(tid, translated);

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
 * By the time this runs, `translateInboundAction` has already rewritten the
 * spoken codeword to its letter token (e.g. "c g"), which is what the label
 * pool is keyed on. `params.codeword` is the full token; older keyboard-derived
 * actions used `params.word` + optional `params.word2` (also letters now).
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

  // We don't pre-route via getFrameForLabel: the typed codeword is usually
  // the displayed badge form (e.g. "cg" in letter mode), which the label
  // pool doesn't key on (its keys are spoken word pairs). Instead ask every
  // frame to resolve it against its own visible badges and take the first
  // that recognizes it. This also reaches badges inside iframes (QuickBase)
  // transparently. Only the manual picker uses this path; voice/keyboard
  // routing still goes through getFrameForLabel.
  let frameIds: number[];
  try {
    const frames = await chrome.webNavigation.getAllFrames({ tabId });
    frameIds = frames && frames.length > 0 ? frames.map(f => f.frameId) : [0];
  } catch {
    frameIds = [0];
  }

  let lastReason = `Codeword "${trimmed}" is not visible in that tab. Make sure hints are showing.`;
  for (const frameId of frameIds) {
    let resp: ResolveHintResponse;
    try {
      resp = await chrome.tabs.sendMessage(
        tabId,
        { type: 'RESOLVE_HINT', codeword: trimmed },
        { frameId },
      );
    } catch {
      // Frame has no content script (cross-origin / not injectable) — skip.
      continue;
    }
    if (resp?.ok) return resp;
    if (resp?.reason) lastReason = resp.reason;
  }
  return { ok: false, reason: lastReason };
}

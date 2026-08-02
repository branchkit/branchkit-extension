/**
 * BranchKit Browser — what an SSE event MEANS.
 *
 * `plugin/sse-transport.ts` owns the stream's LIFECYCLE (backoff ladder,
 * voice-pause intent, the offscreen-vs-direct split). This is the behaviour
 * half of that split: given an event off the wire, who acts on it — this
 * service worker, one tab, or all of them.
 *
 * The last residue section 7 named after phase 1, and the reason the offscreen
 * bridge registered from the entry point: `SSE_EVENT` and `ALPHABET` closed
 * over two functions that had nowhere else to live. They have one now, and the
 * bridge comes with them.
 *
 * ROUTING ORDER IS THE CONTRACT, not an accident of how the chain grew. The
 * chrome.tabs verbs are answered here BEFORE anything is forwarded, because
 * they act on the browser regardless of what page is focused — a content script
 * cannot reach the API, and the active page may not have one at all. Media is
 * next and routes by media-target priority rather than by focus, so "pause"
 * from an unrelated app reaches the background tab that is actually playing.
 * Everything left is a page action, and only then does the active-tab /
 * broadcast decision at the bottom apply.
 */

import { setAlphabet } from '../labels/words';
import { alphabetsEqual } from '../labels/label-pool';
import { isVoicePaused } from '../plugin/sse-transport';
import {
  TAB_ACTION_BY_ID, ZOOM_ACTION_BY_ID, handleTabAction, handleZoomAction, switchToTabById,
} from './tab-actions';
import { SURGERY_ACTIONS, handleSurgeryAction } from './tab-surgery';
import {
  MEDIA_ACTIONS, resolveMediaTargetTab, sendMediaActionToTab, handleMediaAllAction,
} from './media';
import { handlePaletteVoiceSelect, handlePaletteVoiceDismiss } from './palette';
import { notifyActiveTab, broadcastToAllTabs } from './frame-router';
import type { MessageHandler } from '../core/message-router';

// --- Alphabet ---

// Persist the BranchKit voice alphabet so content scripts on every page see
// the same codewords voice will recognize. content.ts reads this on load
// and subscribes to chrome.storage.onChanged for live updates.
//
// Short-circuits the storage write when the incoming alphabet matches the one
// already stored. Voice re-pushes the alphabet on a hot path (688 pushes in a
// single observed session, almost all identical); each distinct push wakes
// every content script (storage.onChanged) into a grammar re-push + re-render,
// so the dedup avoids that churn. The overlay itself is updated every call
// (idempotent) so the SW translation layer is always current.
export async function storeAlphabet(words: string[]): Promise<void> {
  if (!Array.isArray(words) || words.length !== 26) return;
  if (words.some(w => typeof w !== 'string' || w.length === 0)) return;

  // Install the SW-realm voice overlay so postGrammarBatch / frame-router can
  // translate letter tokens <-> spoken codewords at the plugin boundary. The
  // pool itself builds from fixed letters and is NOT touched by an alphabet
  // change — hint identities stay stable when voice connects/disconnects.
  setAlphabet(words);

  try {
    const current = await chrome.storage.local.get('alphabet');
    // Skip a no-op push: an unchanged alphabet would still wake every content
    // script (storage.onChanged) into a needless grammar re-push + re-render.
    if (Array.isArray(current.alphabet) && alphabetsEqual(current.alphabet, words)) {
      return;
    }
    await chrome.storage.local.set({ alphabet: words });
  } catch (err) {
    console.error('[BranchKit BG] alphabet store error:', err);
  }
}
// --- SSE Event Handling (shared by both paths) ---

/**
 * Actions whose effect is per-TAB rather than per-focused-page, so every tab
 * has to hear them and not only the active one.
 *
 * A named set rather than an `action === … || action === …` chain, and that
 * is load-bearing rather than style. Lint D reads that shape across a
 * ROUTE_FILE as proof an id is ROUTED there, and this is a DELIVERY decision:
 * both ids fall straight through to the content script, whose arms in
 * activate/voice-dispatch.ts are what actually handle them. While it was a
 * chain it vouched for 'rescan', and deleting that real arm passed tsc, both
 * lint scripts and 2278 tests — the same shadow the keyboard hint verbs cast
 * in content.ts, from the other direction.
 */
const BROADCAST_ACTIONS = new Set(['rescan', 'set_badge_mode']);

export function handleSSEEvent(data: any): void {
  // Paused: drop any action from a stream that outlived the teardown (a
  // surviving offscreen doc, an in-flight event mid-pause). Voice must not act
  // while the user has it paused. The stream is torn down on pause and on a
  // paused wake, so this is defense-in-depth for the race window.
  if (isVoicePaused()) return;
  // Tab verbs are handled here, not forwarded to content: they act on
  // chrome.tabs regardless of what page is focused (content scripts can't
  // reach the API, and the active page may not even have one).
  const tabAction = TAB_ACTION_BY_ID[data.action];
  if (tabAction) {
    const n = parseInt(data.params?.index ?? '', 10);
    void handleTabAction(tabAction, Number.isFinite(n) ? n : undefined);
    return;
  }

  // Tab-surgery request/response (plugin tab-to-desk orchestration) — like
  // the tab verbs, background-only chrome.windows/tabs work; each request is
  // answered on POST /surgery/result. See background/tab-surgery.ts.
  if (SURGERY_ACTIONS.has(data.action)) {
    handleSurgeryAction(data.action, data.params);
    return;
  }

  // Page zoom — also chrome.tabs, also handled here so it works regardless of
  // the active page's content-script state.
  const zoomAction = ZOOM_ACTION_BY_ID[data.action];
  if (zoomAction) {
    void handleZoomAction(zoomAction);
    return;
  }

  // Media verbs route by the media-target priority, not the active tab —
  // "pause" from an unrelated app must reach the background tab that's
  // actually playing. The *_all forms fan out to every audible tab.
  if (data.action === 'media_pause_all' || data.action === 'media_mute_all') {
    handleMediaAllAction(data.action);
    return;
  }
  if (MEDIA_ACTIONS.has(data.action)) {
    const target = resolveMediaTargetTab();
    if (target !== null) {
      sendMediaActionToTab(target, data);
      return;
    }
    // No known target anywhere — fall through to the active tab, the
    // pre-background behavior (its frames no-op if truly nothing's there).
  }

  // "tab <codeword>" — like the tab verbs, handled here so it works
  // regardless of the active page's content-script state.
  if (data.action === 'switch_to_tab') {
    const id = parseInt(data.params?.tab_id ?? '', 10);
    if (Number.isFinite(id)) void switchToTabById(id);
    return;
  }

  // Palette voice selection: the matched codeword's row_id comes back from
  // the browser_palette collection; resolve it through the session's dispatch
  // map and reuse the keyboard path (close overlay, then execute). An unknown
  // row id (stale utterance racing a re-open) just closes the palette. The
  // matcher already cleared the exclusive tag (ClearsTags at match time);
  // handlePaletteAction's clearPaletteVoice drains the entries to match.
  if (data.action === 'palette_select') {
    handlePaletteVoiceSelect(data.params?.row_id);
    return;
  }
  // "blank"/"stash" + badge: same resolution, different landing spot for
  // bookmark rows (new focused / background tab instead of the origin tab).
  if (data.action === 'palette_select_newtab') {
    handlePaletteVoiceSelect(data.params?.row_id, 'blank');
    return;
  }
  if (data.action === 'palette_select_background') {
    handlePaletteVoiceSelect(data.params?.row_id, 'stash');
    return;
  }
  // "here" + badge: navigate the origin tab itself — the explicit opt-out
  // of the new-tab default.
  if (data.action === 'palette_select_here') {
    handlePaletteVoiceSelect(data.params?.row_id, 'here');
    return;
  }
  if (data.action === 'palette_dismiss') {
    handlePaletteVoiceDismiss();
    return;
  }

  // Multi-target hint verbs ("stash huge gap arch same"): the plugin delivers
  // the matched targets as a JSON-encoded ordered list under params.targets
  // (SSE params are string-keyed). Fan out to one per-target action, awaited
  // in spoken order, so per-codeword frame routing and the content script's
  // single-target handling work unchanged.
  if (typeof data.params?.targets === 'string') {
    let targets: unknown;
    try {
      targets = JSON.parse(data.params.targets);
    } catch {
      console.warn('[BranchKit BG] multi-target action with unparseable targets:', data.action);
      return;
    }
    if (!Array.isArray(targets)) return;
    void (async () => {
      for (const t of targets) {
        if (t === null || typeof t !== 'object') continue;
        const params: Record<string, string> = {};
        for (const [k, v] of Object.entries(t)) params[k] = String(v);
        await notifyActiveTab({
          type: 'BRANCHKIT_ACTION',
          payload: { action: data.action, params, correlation_id: data.correlation_id },
        });
      }
    })();
    return;
  }

  // Active-tab-only routing for events that carry params.target === 'active'.
  // The plugin uses this for focus-driven rescans where only the active
  // tab's state matters — broadcasting to every tab would multiply the
  // refocus latency by tab count for no functional benefit.
  if (data.params?.target === 'active') {
    notifyActiveTab({
      type: 'BRANCHKIT_ACTION',
      payload: data,
    });
    return;
  }

  if (BROADCAST_ACTIONS.has(data.action)) {
    // Broadcast to ALL tabs
    broadcastToAllTabs({
      type: 'BRANCHKIT_ACTION',
      payload: data,
    });
  } else {
    notifyActiveTab({
      type: 'BRANCHKIT_ACTION',
      payload: data,
    });
  }
}
/**
 * The offscreen bridge (Chrome path): the offscreen document holds the
 * EventSource and forwards what it reads. Firefox connects the stream directly
 * in the service worker and reaches the two functions above without a message.
 */
export const sseBridgeMessageHandlers: Record<string, MessageHandler> = {
  // Offscreen doc forwarded an SSE event (Chrome path) — route to tabs.
  SSE_EVENT: (message) => { handleSSEEvent(message.data); },

  // Offscreen doc forwarded an alphabet event (Chrome path).
  ALPHABET: (message) => {
    if (!Array.isArray(message.words)) return;
    void storeAlphabet(message.words);
  },
};

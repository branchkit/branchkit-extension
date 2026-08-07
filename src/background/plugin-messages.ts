/**
 * BranchKit Browser — content-script messages that forward to the plugin.
 *
 * Lifted out of background.ts's message chain
 * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md). The transport lives in
 * plugin/plugin-api.ts; this module is the stamp-and-forward edge.
 *
 * Everything here exists because **a content script does not know its own tab
 * or frame id — only the SW does** — and the plugin needs both to scope state
 * to the right frame. So each handler's real job is to stamp sender identity
 * onto a payload the content script could not have completed itself.
 */

import {
  forwardDispatchResult, forwardDebugLog, forwardPerfReport, postGrammarBatch,
  transportFailure, setRangePick, setQueryFieldActive,
} from '../plugin/plugin-api';
import type { MessageHandler } from '../core/message-router';

export const pluginMessageHandlers: Record<string, MessageHandler> = {
  /**
   * Content's batched doScan (Option B) sent a grammar batch. Stamp
   * tab_id + frame_id and POST.
   *
   * No active-tab gate: every tab POSTs freely. The plugin stores each batch in
   * its own per-source session and projects only the OS-focused source's
   * grammar into the live collections, so a background tab's push can no longer
   * clobber the focused tab's vocabulary. See §8 of
   * docs/completed/DESIGN_ELEMENT_IDENTITY_REGISTRY.md.
   */
  GRAMMAR_BATCH: (message, sender) => {
    const tabId = sender.tab?.id;
    const frameId = sender.frameId;
    if (typeof tabId !== 'number' || typeof frameId !== 'number') {
      return transportFailure(message.request);
    }
    // Also from the sender: the tab's window id. The content script can't know
    // it; the plugin uses it to pick the projection source among a browser's
    // windows (notes/DESIGN_HINT_PROJECTION_SELF_HEAL.md). 0 if unavailable —
    // the plugin fails open on window then.
    const windowId = sender.tab?.windowId ?? 0;
    for (const el of message.request.elements) {
      el.frame_id = frameId;
    }
    // A rejection here used to leave the sender awaiting forever — the old
    // `.then(sendResponse)` carried no catch. The router now closes the channel
    // on a rejected handler, so the scan fails fast instead of hanging.
    return postGrammarBatch(tabId, frameId, windowId, message.request);
  },

  DISPATCH_RESULT: (message) => {
    forwardDispatchResult(message.payload);
  },

  DEBUG_LOG: (message) => {
    if (typeof message.tag !== 'string') return;
    forwardDebugLog(message.tag, message.data);
  },

  /**
   * Tab id comes from the sender; the content script doesn't know its own tab
   * id. Prefer the content script's live location.href (message.url) over
   * sender.url — sender.url is the URL the script was *injected* into and does
   * not follow SPA navigation, so on YouTube it stays "www.youtube.com/" after
   * a homepage→/watch transition, mislabeling /watch samples in the trail and
   * hiding them from /watch-filtered analysis.
   */
  PERF_REPORT: (message, sender) => {
    if (!message.snapshot) return;
    forwardPerfReport({
      url: (message.url as string) ?? sender.url ?? '',
      tab_id: sender.tab?.id ?? -1,
      browser: typeof message.browser === 'string' ? message.browser : 'unknown',
      snapshot: message.snapshot,
    });
  },

  QUERY_FIELD_ACTIVE: (message) => {
    void setQueryFieldActive(message.active);
  },

  /**
   * The plugin scopes the hint-projection narrow to (conn, tab) so a background
   * tab keeps projecting its full hint set. A release (empty codewords) with no
   * tab id is still worth sending: the plugin honors releases from any source,
   * and the tab id is only read on arm.
   */
  RANGE_PICK: (message, sender) => {
    const tabId = sender.tab?.id;
    if (typeof tabId === 'number' || message.codewords.length === 0) {
      void setRangePick(tabId ?? 0, message.codewords);
    }
  },
};

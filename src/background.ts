/**
 * BranchKit Browser — Service worker (background script).
 *
 * Responsibilities:
 * - Discover browser plugin port/token via actuator
 * - Push grammar to plugin on scan results
 * - Route SSE events from offscreen doc (Chrome) or direct SSE (Firefox) to content scripts
 * - Manage offscreen document lifecycle (Chrome only)
 */

import { Message, HintVisibility } from './types';
import { clearAllStacks, alphabetsEqual } from './labels/label-pool';
import { setAlphabet } from './labels/words';
import { buildCommandContributions } from './keymap/command-catalog';
import { discoverPlugin, postToPlugin } from './plugin/actuator-client';
import { recordTabActivated } from './background/tab-mru';
import { scheduleTabPublish, resetTabPublishCache } from './background/tab-collection';
import {
  pushTabMarker, reapplyTabMarker as reapplyTabMarkerFor, releaseTabMarker, transferTabMarker, setTabMarkersEnabled,
} from './background/tab-markers';
import { ensureContentScriptInjected } from './background/injection';
import { bgState, connId } from './background/state';
import { republishActiveTab, broadcastToAllTabs, resolveActiveContentTab, notifyActiveTab, setUnroutablePullReporter } from './background/frame-router';
import {
  initSSETransport, connectSSE, ensureOffscreen, scheduleSSERetry,
  isVoicePaused, restoreVoicePaused, runConnectionCheck,
} from './plugin/sse-transport';
import {
  forwardDispatchResult, forwardDebugLog, forwardHintsSessionEnd, forwardHintsSessionStart,
  postGrammarBatch, postFocus, postActiveTab, assertFocusIfFocused,
} from './plugin/plugin-api';
import { reassertMirror } from './background/mode-mirror';
import { initFrameLiveness } from './background/frame-liveness';
import { pushReferenceNames, hydrateReferencesFromCollection } from './background/references';
import { forwardCoalesced } from './background/log-coalesce';
import { installUncaughtCapture } from './debug/uncaught';
import { TAB_ACTION_BY_ID, ZOOM_ACTION_BY_ID, handleTabAction, handleZoomAction, switchToTabById } from './background/tab-actions';
import { SURGERY_ACTIONS, handleSurgeryAction } from './background/tab-surgery';
import {
  clearPaletteVoice, handlePaletteAction,
  handlePaletteVoiceSelect, handlePaletteVoiceDismiss, clearPaletteForClosedTab } from './background/palette';
import {
  MEDIA_ACTIONS, syncMediaActive, clearTabMediaOnNav, clearTabMediaOnClose,
  resolveMediaTargetTab, sendMediaActionToTab, handleMediaAllAction, setBrowserWindowFocused, initMedia,
} from './background/media';
import { purgeTab, logTabSwitch, scheduleSpaRescan, cancelSpaRescan, startDeadTabSweep } from './background/tab-sessions';
import { registerMessageHandlers, routeMessage } from './background/message-router';
import { commandOverrideMessageHandlers } from './background/command-overrides';
import { voiceStatusMessageHandlers } from './background/voice-status';
import { labelMessageHandlers } from './background/label-messages';
import { pluginMessageHandlers } from './background/plugin-messages';
import { mediaMessageHandlers } from './background/media';
import { referenceMessageHandlers } from './background/references';
import { logMessageHandlers } from './background/log-coalesce';
import { debugSnapshotMessageHandlers } from './background/debug-snapshot';
import { frameLivenessMessageHandlers } from './background/frame-liveness';
import { frameRouterMessageHandlers } from './background/frame-router';
import { tabMarkerMessageHandlers } from './background/tab-markers';
import { tabActionMessageHandlers } from './background/tab-actions';
import { markMessageHandlers } from './background/marks';
import { modeMirrorMessageHandlers } from './background/mode-mirror';
import { paletteMessageHandlers } from './background/palette';

// --- State ---
//
// The shared connection/tab state (bgState + connId, imported above) lives in
// background/state.ts so the extracted background modules share it — see
// notes/DESIGN_EXTENSION_RESTRUCTURE.md (Tier 3). The SSE stream lifecycle
// (backoff ladder, voice-pause intent, offscreen/direct split) lives in
// plugin/sse-transport.ts; the hooks wired below are what a connect/event
// MEANS — the behavior half of that split.

let hintVisibility: HintVisibility = 'always';

// SW crashes land in browser.log as BK_UNCAUGHT — via the coalescer so a pending boot summary flushes first.
installUncaughtCapture((tag, data, level) => forwardCoalesced(tag, data, level), 'sw');

initSSETransport({
  // The plugin's HTTP server is up once creds exist: contribute the command
  // vocabulary so voice scroll/find/nav are live for this session, and
  // re-assert the active tab's video presence — a plugin restart or SSE
  // reconnect drained its mirror.
  onPreConnect: () => {
    void contributeCommands();
    void syncMediaActive();
  },
  // The connect-edge heal. Runs on EVERY connected event (a `connected` means
  // a NEW stream, so the host/plugin may have restarted). Reactivate is
  // idempotent (same rotate+re-Put as every tab focus) and connects are rare.
  onConnectedEdge: () => {
    // Cold-start focus handshake: this browser may already be frontmost when
    // its extension connects, so no onFocusChanged fires to claim focus.
    void assertFocusIfFocused();
    reassertMirror(); // a fresh stream may be a restarted plugin — replay the tag derivation
    hydrateReferencesFromCollection().then(() => pushReferenceNames());
    rescanActiveTab();
    // Host (BranchKit app) restart healer. A host restart drops the SSE but
    // does NOT kill the extension service worker, so the per-frame liveness
    // Ports never drop and their onResync (the SW-restart healer) never fires.
    // The restarted plugin lost every frame's grammar, and rescanActiveTab
    // only re-scans the DOM — it does not re-emit codewords. Reactivate the
    // active tab so its grammar is rebuilt into the fresh plugin (rotate
    // session + re-Put). Other tabs heal on next focus via tab_activated.
    // Without this, badges paint but aren't matchable after an app restart —
    // which production hits on every update/crash.
    // See notes/DESIGN_HOST_RESTART_RESYNC.md.
    if (bgState.cachedActiveTabId != null) {
      republishActiveTab(bgState.cachedActiveTabId, 'sse_reconnect');
    }
    // Seed the open-tab voice collection ("tab <codeword>"). The publish cache
    // is cleared first: a reconnected plugin may have restarted and lost its
    // per-connection tab entries, so the unchanged-set guard must not suppress
    // this re-seed.
    resetTabPublishCache();
    scheduleTabPublish();
  },
  onEvent: (data) => handleSSEEvent(data),
  onAlphabet: (words) => { void storeAlphabet(words); },
});

function rescanActiveTab(): void {
  if (bgState.cachedActiveTabId == null) return;
  forwardDebugLog('pipeline.bg_rescan_dispatched', { tab_id: bgState.cachedActiveTabId, source: 'rescanActiveTab' });
  chrome.tabs.sendMessage(bgState.cachedActiveTabId, {
    type: 'BRANCHKIT_ACTION',
    payload: { action: 'rescan' },
  }).catch(() => {});
}

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
async function storeAlphabet(words: string[]): Promise<void> {
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

// Pull-resolution "no such hint" (ext notes/DESIGN_STATIC_PAIR_GRAMMAR.md 0c):
// a sealed-alphabet activate whose pair no frame claims reports through the
// same dispatch-result channel the content script uses, with a distinct
// detail the plugin can surface as feedback.
setUnroutablePullReporter((codeword, action) => {
  void forwardDispatchResult({
    action,
    codeword,
    resolution: 'none',
    elem_tag: '',
    taken: 'skipped',
    ok: false,
    frame: '',
    detail: 'no_such_hint',
    fp: '',
  });
});


// --- SSE connect-time contribution ---

// Contribute the extension's static command vocabulary (scroll/find/nav voice
// phrases from command-catalog.ts) to the browser plugin, which registers them
// as a thin registrar. Fired on every (re)connect — the plugin REPLACE-stores
// the set and re-runs its command push, so a re-POST is idempotent. Best-effort:
// a failure self-heals on the next connect. See notes/DESIGN_COMMAND_CONTRIBUTION.md.
async function contributeCommands(): Promise<void> {
  try {
    // conn_id scopes the contribution to THIS browser. The plugin used to keep
    // one global set replaced wholesale, so a second browser — or this one
    // reconnecting mid-boot — with a partially-assembled catalog deleted the
    // other's commands, silently: a missing command just stops being speakable
    // and its words leave the engine grammar, so a mishear takes its place.
    await postToPlugin('/commands/contribute', {
      conn_id: connId,
      commands: buildCommandContributions(),
    });
  } catch {
    // Plugin unreachable — retried on the next connect.
  }
}

// --- SSE Event Handling (shared by both paths) ---

function handleSSEEvent(data: any): void {
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

  if (data.action === 'rescan' || data.action === 'set_badge_mode') {
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

// --- Message Listener ---

// Every message type is owned by the module that owns its concern; this is the
// composition point and nothing more. See notes/DESIGN_ENTRY_POINT_TOPOLOGY.md.
registerMessageHandlers(commandOverrideMessageHandlers);
registerMessageHandlers(voiceStatusMessageHandlers);
registerMessageHandlers(labelMessageHandlers);
registerMessageHandlers(pluginMessageHandlers);
registerMessageHandlers(mediaMessageHandlers);
registerMessageHandlers(referenceMessageHandlers);
registerMessageHandlers(logMessageHandlers);
registerMessageHandlers(debugSnapshotMessageHandlers);
registerMessageHandlers(frameLivenessMessageHandlers);
registerMessageHandlers(frameRouterMessageHandlers);
registerMessageHandlers(tabMarkerMessageHandlers);
registerMessageHandlers(tabActionMessageHandlers);
registerMessageHandlers(markMessageHandlers);
registerMessageHandlers(modeMirrorMessageHandlers);
registerMessageHandlers(paletteMessageHandlers);

// The offscreen-bridge pair still closes over handleSSEEvent / storeAlphabet
// above, so it registers from here rather than from a module. That is the
// remaining residue in this file, and it moves when the SSE fan-out does.
registerMessageHandlers({
  // Offscreen doc forwarded an SSE event (Chrome path) — route to tabs.
  SSE_EVENT: (message) => { handleSSEEvent(message.data); },

  // Offscreen doc forwarded an alphabet event (Chrome path).
  ALPHABET: (message) => {
    if (!Array.isArray(message.words)) return;
    void storeAlphabet(message.words);
  },

  // Dev keepalive — the WAKE is the point (dev-keepalive.ts).
  DEV_PING: () => {},
});

chrome.runtime.onMessage.addListener(routeMessage);

// (Per-frame liveness Ports moved to background/frame-liveness.ts — the
// lifetime signal every doc-scoped cleanup keys off.)
initFrameLiveness();

// Note on switch-away badges: in always-mode hint badges are a persistent
// visual property of every browser tab — never hide them on switch-away
// (rescan doesn't re-show in always mode, so they'd stay hidden forever).
// The user can't see the inactive tab anyway, so leaving badges painted
// there is cosmetically free. (The per-switch session_end that used to live
// here retired with display-grade demotion phase 1 — the plugin deprojects
// and derives the hints tag from its own focus recompute.)

chrome.tabs.onActivated.addListener((activeInfo) => {
  const oldTabId = bgState.cachedActiveTabId;
  bgState.cachedActiveTabId = activeInfo.tabId;
  // Recency stack for the `last_active` tab verb (and the future fuzzy
  // switcher's MRU ranking).
  void recordTabActivated(activeInfo.tabId);
  // MRU order is the tiebreak for shared tab-collection words, so an
  // activation can reassign an ambiguous word to this tab. The word SET is
  // unchanged (payload-only diff plugin-side), so this never rebuilds the
  // engine grammar.
  scheduleTabPublish();
  if (oldTabId !== activeInfo.tabId) {
    logTabSwitch('tab_activated', oldTabId, activeInfo.tabId);
    // Report the new active tab to the plugin (accepted only if this is the
    // focused browser). Authoritative focused-tab signal for Option B.
    void postActiveTab(activeInfo.tabId);
    // Mirror the new tab's video presence (last known; its reporter resumes
    // within one 2s tick if the tab was hidden).
    void syncMediaActive();
    // No session_end and no republish on tab switch (display-grade demotion
    // phase 1): the plugin deprojects the old tab and reprojects + re-arms
    // the hints tag from the postActiveTab recompute above, with zero
    // extension traffic. Session-start stays as idempotent skeleton insurance.
    if (hintVisibility === 'always') {
      forwardHintsSessionStart('tab_switch', activeInfo.tabId);
    }
  }
  // Lazy injection for tabs that loaded before the extension was
  // installed. Firefox temporary add-ons don't fire `onInstalled`
  // re-injection reliably enough to cover every pre-existing tab, and
  // even on Chrome the install-time pass can miss tabs that were
  // restored after the install (session restore, BFCache). Pinging
  // first means this is a no-op for tabs that already have the
  // content script. For tabs that Firefox just started restoring from
  // disk, `tabs.onUpdated` below catches them once the restore
  // completes — `tab.discarded` is racy here.
  void ensureContentScriptInjected(activeInfo.tabId);
});

// Catch tabs finishing load — Firefox restoring a discarded tab fires
// onActivated before restoration completes, so the onActivated handler
// can see `tab.discarded === true` and bail. The status=='complete'
// transition fires once the page is actually live, by which time
// executeScript can reach it. Pinging first keeps this a no-op for
// tabs whose manifest content_scripts already ran.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'complete') {
    void ensureContentScriptInjected(tabId);
  }
  // Tab-collection churn signal: only title/URL changes can alter the
  // published word set. SPA retitle bursts (notification counters,
  // now-playing) coalesce in the publish debounce and no-op through the
  // unchanged-set guard when the words don't change.
  if (changeInfo.title !== undefined || changeInfo.url !== undefined) {
    scheduleTabPublish();
  }
  // Tab markers: on a page-driven title change, tell the tab to re-apply its
  // marker (guarded re-apply on the content side). No-op when the feature is
  // off. Our own decoration write also fires onUpdated(title), but the
  // content-side echo guard makes that re-apply a no-op.
  if (changeInfo.title !== undefined) {
    reapplyTabMarkerFor(tabId);
  }
});

// New tabs join the voice collection once they have a title/URL; the
// onUpdated hook above covers the loading transitions, but a restored or
// pre-rendered tab can arrive fully formed.
chrome.tabs.onCreated.addListener((tab) => {
  scheduleTabPublish();
  // Pre-assign + decorate a fully-formed (restored/pre-rendered) tab; a plain
  // new tab has no content script yet and bootstraps via GET_TAB_MARKER.
  if (typeof tab.id === 'number') void pushTabMarker(tab.id, tab.title ?? undefined);
});

// Chrome discards/replaces a tab (memory pressure, prerender swap): carry the
// marker to the new id so the visible mark doesn't jump, then re-push it.
chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  void transferTabMarker(removedTabId, addedTabId).then(() => pushTabMarker(addedTabId));
});

// SPA navigation (History API pushState/replaceState, or in-page hash
// routing): the tab's top-frame URL changes with no document reload, so
// the content script stays alive but is now looking at a different page.
// Without a signal it relies entirely on absorbing the mutation firehose
// to notice — the exact path that trips the unresponsive-script killer on
// YouTube /watch. We route the change into the content script's existing
// bounded rescan (from_cache: drop dead wrappers, re-sync grammar, then
// one deferred DOM walk).
//
// We use webNavigation rather than tabs.onUpdated because they are NOT
// distinguishable by changeInfo alone: a History-API nav on YouTube
// reports `{status:'loading', url}` then `{status:'complete'}` — exactly
// like a full document load — so any tabs.onUpdated guess either misses
// real SPA navs or fires redundant rescans on every full load.
// onHistoryStateUpdated / onReferenceFragmentUpdated fire ONLY for
// same-document URL changes, never for full loads, so the full-load path
// (manifest content_scripts → fresh scan) and the SPA path stay disjoint.
// We can't detect this from the content script either: its History API
// patch runs in the isolated world and never sees the page's main-world
// pushState calls.
function isHintableUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

function onSameDocumentNav(details: { tabId: number; frameId: number; url: string }): void {
  // Top frame only — subframe history changes (ad/embed SPAs) shouldn't
  // trigger a whole-tab rescan.
  if (details.frameId !== 0) return;
  if (!isHintableUrl(details.url)) return;
  scheduleSpaRescan(details.tabId, details.url);
}

chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDocumentNav);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDocumentNav);

// Full document load: the old page's frames (and their media-presence
// reports) are gone; drop the tab's frame map so a stale `true` can't
// outlive the page, and release the resume memory if it pointed here (the
// media it remembered no longer exists). The new page's reporters
// re-populate within one tick. SPA navs (above) keep frames alive, so
// their entries stay valid.
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  clearTabMediaOnNav(details.tabId);
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  // All browser windows lost OS focus (user switched to another app). Tell the
  // plugin this connection is no longer focused so its grammar gate and
  // dispatch scoping stop treating this browser as frontmost.
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    setBrowserWindowFocused(false);
    void postFocus(false);
    // media_active survives unfocus by design (background control); re-post
    // so the plugin's mirror is asserted from THIS conn even while unfocused.
    void syncMediaActive();
    return;
  }
  setBrowserWindowFocused(true);
  try {
    // Only follow focus into normal browser windows. Devtools / popups
    // / extension panels would otherwise blank the active-tab cache (they
    // either have no tabs or their "tab" is an about:* URL), breaking
    // voice routing while devtools is open. Skip the update; the last
    // known content tab stays cached.
    const win = await chrome.windows.get(windowId);
    if (win.type !== 'normal') return;

    // This browser gained OS focus. Claim it so the plugin binds this
    // connection to whatever bundle the OS reports as frontmost — the
    // browser never names itself (see DESIGN_BROWSER_IDENTITY_FOCUS_HANDSHAKE).
    void postFocus(true);
    // Replay drained tags after the focus claim — replaces the content-side
    // 300 ms caret re-assert timer (background/mode-mirror.ts).
    reassertMirror();

    const tabs = await chrome.tabs.query({ active: true, windowId });
    const newActive = tabs[0]?.id ?? null;
    const oldTabId = bgState.cachedActiveTabId;
    bgState.cachedActiveTabId = newActive;
    // This browser just gained OS focus — report its active tab so the plugin's
    // focused-tab signal tracks the window switch even when the tab itself
    // didn't change. Authoritative focused-tab source for Option B.
    void postActiveTab(newActive);
    // Re-assert video presence: the plugin drained its mirror on unfocus.
    void syncMediaActive();
    if (oldTabId != null && oldTabId !== newActive) {
      logTabSwitch('window_focus', oldTabId, newActive);
      // Same as the tab-switch path: the postActiveTab recompute above
      // deprojects/reprojects and derives the hints tag plugin-side
      // (display-grade demotion phase 1).
      if (newActive != null && hintVisibility === 'always') {
        forwardHintsSessionStart('window_focus', newActive);
      }
    }
  } catch {
    // Don't blank the active-tab cache on error — fall back to the last
    // known content tab so voice routing keeps working through transient
    // window state.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const wasActive = bgState.cachedActiveTabId === tabId;
  if (wasActive) {
    bgState.cachedActiveTabId = null;
    // Tab closed: end its hint session (no badges to hide — tab is gone —
    // but the plugin's hints tag still needs clearing).
    forwardHintsSessionEnd('tab_closed', tabId);
  }
  clearTabMediaOnClose(tabId);
  cancelSpaRescan(tabId);
  purgeTab(tabId);
  // Drop the closed tab's words from the voice collection.
  scheduleTabPublish();
  // Backstop: a palette whose host tab died can't send PALETTE_CLOSED.
  clearPaletteForClosedTab(tabId);
  // Return the closed tab's marker to the free pool.
  void releaseTabMarker(tabId);
});

// Audible-tab registry + seed (background/media.ts) and the dead-tab
// label-stack sweep (background/tab-sessions.ts) — explicit wiring per the
// round-3 feature-module convention.
initMedia();
startDeadTabSweep();

// --- Startup ---

async function init(): Promise<void> {
  // Clear every per-tab label pool. Frames from prior SW sessions
  // may have died without firing the port.onDisconnect handler that
  // releases their labels (Chrome can lose port subscriptions across
  // SW idle-termination and extension reload). Without this, the
  // pool stays near-exhausted: claims return empty, batches have
  // zero elements, and badges never paint. Sacrifices label
  // stability across SW restart in exchange for correctness.
  await clearAllStacks();

  const result = await chrome.storage.sync.get(['hintVisibility', 'tabMarkersEnabled']);
  if (result.hintVisibility) {
    hintVisibility = result.hintVisibility;
  }
  // Tab markers: default ON (absent → on; only an explicit false disables).
  // Letter-first, so marks paint immediately — no connection dependency.
  void setTabMarkersEnabled(result.tabMarkersEnabled !== false);

  // Prime the active-tab cache so the first active_tab_id signal to the plugin
  // (and rescanActiveTab) has a value before the first tabs.onActivated /
  // onFocusChanged fires. No longer load-bearing for grammar correctness —
  // the plugin projects only the focused source, so a stale/null active tab
  // can't cause a clobber — but it keeps the focus signal accurate from boot.
  await resolveActiveContentTab();

  // Voice-pause intent (sticky across SW restart). Load BEFORE any auto-connect
  // decision and honor it: a paused SW must not discover or connect on wake.
  if (await restoreVoicePaused()) return;

  const found = await discoverPlugin();

  await ensureOffscreen();

  if (found) {
    // branchkitConnected stays false until the stream's real `connected`
    // signal (onSSEConnected) — discovery success is not connection success.
    connectSSE();
  } else {
    // Host down at boot: arm the retry ladder now instead of waiting up to
    // 30s for the connection-check alarm. With no host at all (standalone
    // keyboard/hints use) this settles at one discovery fetch per 30s — the
    // same steady-state the alarm already produced.
    //
    // Reconcile the content-facing connection mirror. A browser restart with
    // the host down leaves a stale `true` from the previous session — no
    // disconnect event ever fires to correct it (onSSEDisconnected needs a
    // connection to lose), so the mode chip would claim a live connection
    // forever. Written only on discovery FAILURE: the discovery-succeeded
    // path converges through the stream's own connected/error events, and an
    // unconditional write here would flap the mirror on every SW idle-wake.
    void chrome.storage.local.set({ branchkitConnected: false });
    scheduleSSERetry();
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.hintVisibility) {
    hintVisibility = changes.hintVisibility.newValue || 'always';
  }
  // Tab-markers toggle flipped: decorate every tab, or strip every tab live.
  // Default ON — only an explicit false disables.
  if (changes.tabMarkersEnabled) {
    void setTabMarkersEnabled(changes.tabMarkersEnabled.newValue !== false);
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  // Re-inject content scripts into already-open tabs on install/update so the
  // user doesn't need to F5 every tab after reloading the extension. Canonical
  // Chrome MV3 pattern — see
  // https://www.codestudy.net/blog/chrome-extension-content-script-re-injection-after-upgrade-or-install/
  //
  // Orphan content scripts from the previous extension generation are still in
  // those frames' isolated worlds; reinjectContentScripts clears their
  // idempotency flag (flushOrphanGuard) before file injection so the fresh
  // content.js runs to completion. Pairs with the guard at the top of
  // content.ts and the self-quiesce in liveness/quiesceOrphan.
  //
  // We await init() first so the plugin connection + active-tab signal are
  // primed before the re-injection storm. A background tab racing in early is
  // now harmless: the plugin stores every source's grammar but projects only
  // the focused one (Option B), so a re-injected background tab can't clobber
  // the focused tab's codewords the way the old fail-open gate allowed.
  const reinject = details.reason === 'install' || details.reason === 'update';
  // First-run onboarding: on a fresh install (not update/reload), open the
  // welcome page so the user — and a store reviewer — discovers the core
  // gesture (press F). Without this, a fresh install shows no cue that the
  // whole product is behind a keypress. Update/browser_update/etc. stay silent.
  if (details.reason === 'install') {
    void chrome.tabs.create({ url: chrome.runtime.getURL('welcome.html') }).catch(() => {});
  }
  // One-time cleanup: a 2026-06-05 experiment registered dynamic content
  // scripts under these IDs (bk-bootstrap, bk-content) with
  // persistAcrossSessions:true. The experiment was reverted but persisted
  // registrations survive extension reload, causing double-injection +
  // page-hang on heavy pages. Safe no-op for clean installs (the ids are
  // not registered) and for instances that never ran the experiment.
  void chrome.scripting
    .unregisterContentScripts({ ids: ['bk-bootstrap', 'bk-content'] })
    .catch(() => {});
  void init().then(() => {
    if (reinject) void reinjectContentScripts();
  });
});
chrome.runtime.onStartup.addListener(() => init());

async function reinjectContentScripts(): Promise<void> {
  let tabs: chrome.tabs.Tab[];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    console.warn('[BranchKit] reinject: tabs.query failed', e);
    return;
  }
  const targets = tabs.filter((tab): tab is chrome.tabs.Tab & { id: number } => {
    if (typeof tab.id !== 'number') return false;
    // Firefox aggressively discards inactive tabs to save memory;
    // executeScript can't reach a discarded tab. Skip — the lazy-inject
    // on tabs.onActivated handles them when the user clicks back in
    // (Firefox restores the tab from disk first).
    if (tab.discarded) return false;
    const url = tab.url ?? '';
    return !(url.startsWith('chrome://') || url.startsWith('chrome-extension://')
      || url.startsWith('moz-extension://') || url.startsWith('edge://')
      || url.startsWith('about:') || url.startsWith('devtools://')
      || url.startsWith('view-source:'));
  });
  void forwardDebugLog('pipeline.bg_reinject_dispatched', { count: targets.length });
  // Fan the tabs out concurrently. Each goes through the ping-first idempotent
  // path (ensureContentScriptInjected: ping → retry → withInjectLock → re-ping
  // → flushOrphanGuard → inject), so a tab that already carries a fresh CS is
  // never double-injected — double-injection + page-hang was the failure mode
  // of the reverted 2026-06-05 registerContentScripts experiment. An orphan
  // from the previous generation can't answer the ping (its runtime context is
  // dead), so it correctly falls through to a fresh inject. Concurrency keeps
  // the per-tab ping-retry latency from serializing across every open tab;
  // withInjectLock still serializes per-tab against a lazy-inject racing in
  // from tabs.onUpdated during the reload. See notes/DESIGN_EXTENSION_RELOAD_SURVIVAL.md.
  await Promise.all(targets.map(async (tab) => {
    void forwardDebugLog('pipeline.bg_reinject_tab', { tab_id: tab.id });
    // fromReload: skip the dual-CS-race retry — a reload doesn't re-fire the
    // manifest CS, so an already-open tab here holds a dead orphan, not a
    // booting CS (notes/DESIGN_HINT_SHOW_LATENCY.md).
    await ensureContentScriptInjected(tab.id, { fromReload: true });
  }));
}

// Safety net: check connection every 30s. Probes the actual stream state
// rather than trusting branchkitConnected — the offscreen document (or its
// EventSource) can die without a HEALTH_STATUS(false) ever reaching the SW,
// and a stale `true` used to disable this net entirely. That silent-drop
// window is what let stale creds wedge every POST (review 2026-06-29).
// Worst-case detection latency for a silent drop is one alarm period.
// notes/DESIGN_SSE_RESILIENCE.md (4).
chrome.alarms.create('connection-check', { periodInMinutes: 0.5 });

// Firefox MV3 treats host permissions as opt-in, so a fresh install can sit
// permission-blocked: every discovery fetch to 127.0.0.1 dies on CORS inside
// discoverPlugin's catch and the extension silently settles into standalone
// mode (hints paint, voice never connects — 2026-07-03 incident). When the
// user grants host access (the popup's "Grant local access" button, or
// about:addons), connect NOW rather than through scheduleSSERetry — after
// minutes of blocked attempts the backoff ladder sits at its 30s cap, and a
// just-granted permission should feel instant. Chrome grants host
// permissions at install, so this listener never fires there in practice.
chrome.permissions?.onAdded?.addListener(async (added) => {
  if (isVoicePaused()) return; // a just-granted permission must not override a pause
  if (bgState.branchkitConnected) return;
  if (!added.origins?.length) return;
  const found = await discoverPlugin();
  if (found) connectSSE();
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'connection-check') {
    await runConnectionCheck();
  }
});

// Init immediately (service worker may be waking from alarm)
init();

// --- Dev auto-reload (stripped from production builds by esbuild) ---
// Direct guard, not typeof: every build path defines __DEV_RELOAD__
// (dev.mjs true, build.mjs true/--release false), and a literal `if (false)`
// is the form esbuild's dead-branch elimination actually removes — the
// typeof chain left the socket URL in release output.
declare const __DEV_RELOAD__: boolean;
if (__DEV_RELOAD__) {
  // 127.0.0.1, not localhost: Firefox's MV3 default extension CSP carries
  // upgrade-insecure-requests, and its potentially-trustworthy exemption has
  // not reliably covered ws://localhost — the literal loopback IP is exempt
  // everywhere. With ws://localhost the Firefox background NEVER connected
  // (verified via the server's connection log, 2026-07-27), which is what
  // made every reload broadcast miss it.
  const DEV_WS_URL = 'ws://127.0.0.1:35729';
  // When THIS build generation started running. Sent on every (re)connect so
  // the server can heal a client that slept through a reload broadcast —
  // Firefox event pages miss fire-and-forget signals whenever they're
  // suspended at broadcast time, and a missed one meant a stale build until
  // someone noticed by hand (2026-07-26). storage.session, not a top-level
  // Date.now(): event-page WAKE re-runs this whole script, and a wake-time
  // stamp would launder a stale build as fresh. Session storage survives
  // suspends and clears on the extension (re)load — the generation boundary.
  const devGeneration: Promise<number> = (async () => {
    const got = await chrome.storage.session.get('devLoadedAt');
    if (typeof got.devLoadedAt === 'number') return got.devLoadedAt;
    const now = Date.now();
    await chrome.storage.session.set({ devLoadedAt: now });
    return now;
  })();
  function devConnect() {
    try {
      const ws = new WebSocket(DEV_WS_URL);
      ws.onopen = () => { void devGeneration.then((t) => ws.send(`hello ${t}`)); };
      ws.onmessage = (e) => {
        if (e.data === 'reload') {
          console.log('[BranchKit Dev] reloading extension...');
          chrome.runtime.reload();
        }
      };
      ws.onclose = () => setTimeout(devConnect, 2000);
      ws.onerror = () => ws.close();
    } catch {
      // Constructor threw (server down in a way that throws synchronously).
      // MUST reschedule — a bare swallow here permanently killed the reload
      // chain for the background's lifetime (Firefox stale-background,
      // 2026-07-25 "stash air" field report).
      setTimeout(devConnect, 2000);
    }
  }
  devConnect();
}

/**
 * BranchKit Browser — Service worker (background script).
 *
 * Responsibilities:
 * - Discover browser plugin port/token via actuator
 * - Push grammar to plugin on scan results
 * - Route SSE events from offscreen doc (Chrome) or direct SSE (Firefox) to content scripts
 * - Manage offscreen document lifecycle (Chrome only)
 */

import { Message, ScannedElement, HintVisibility } from './types';
import { claimLabels, confirmLabels, releaseLabels, releaseDocument, clearAllStacks, alphabetsEqual, senderMayMutatePool } from './labels/label-pool';
import { setAlphabet } from './labels/words';
import { buildCommandContributions } from './command-catalog';
import { rememberCodewords, clearCodewordMemory, recallCodewords } from './labels/codeword-memory';
import { discoverPlugin, ensureConnected, postToPlugin, getFromPlugin, getActuatorJson } from './plugin/actuator-client';
import { buildReconcileReport, type ReconcileWrapper, type ReconcileReport, type MatchableView } from './debug/reconcile';
import { setLocalMark, getLocalMark, setGlobalMark, gotoGlobalMark } from './background/marks';
import { baseUrl, type GlobalMark, type StoredMark } from './marks';
import { recordTabActivated } from './background/tab-mru';
import { scheduleTabPublish, resetTabPublishCache } from './background/tab-collection';
import {
  getTabMarker, pushTabMarker, reapplyTabMarker as reapplyTabMarkerFor,
  releaseTabMarker, transferTabMarker, setTabMarkersEnabled,
} from './background/tab-markers';
import { ensureContentScriptInjected } from './background/injection';
import { bgState, connId } from './background/state';
import { republishActiveTab, broadcastToAllTabs, resolveActiveContentTab, notifyActiveTab, resolveHintFromTab, setUnroutablePullReporter } from './background/frame-router';
import {
  initSSETransport, connectSSE, ensureOffscreen, scheduleSSERetry,
  onSSEConnected, onSSEDisconnected, pauseVoice, resumeVoice, isVoicePaused,
  restoreVoicePaused, runConnectionCheck,
} from './plugin/sse-transport';
import {
  forwardDispatchResult, forwardDebugLog, forwardPerfReport, forwardPluginDebugLog,
  forwardHintsSessionEnd, forwardHintsSessionStart, postGrammarBatch, transportFailure,
  postFocus, postActiveTab, assertFocusIfFocused, setCaretActive,
} from './plugin/plugin-api';
import { saveReferenceToCollection, pushReferenceNames, hydrateReferencesFromCollection } from './background/references';
import { TAB_ACTION_BY_ID, ZOOM_ACTION_BY_ID, handleTabAction, handleZoomAction, switchToTabById } from './background/tab-actions';
import {
  publishPaletteVoice, clearPaletteVoice, handlePaletteAction,
  handlePaletteVoiceSelect, handlePaletteVoiceDismiss, clearPaletteForClosedTab,
} from './background/palette';
import {
  MEDIA_ACTIONS, syncMediaActive, setVideoPresence, clearTabMediaOnNav,
  clearTabMediaOnClose, resolveMediaTargetTab, sendMediaActionToTab,
  handleMediaAllAction, setBrowserWindowFocused, initMedia,
} from './background/media';
import { purgeTab, logTabSwitch, scheduleSpaRescan, cancelSpaRescan, startDeadTabSweep } from './background/tab-sessions';

// --- State ---
//
// The shared connection/tab state (bgState + connId, imported above) lives in
// background/state.ts so the extracted background modules share it — see
// notes/DESIGN_EXTENSION_RESTRUCTURE.md (Tier 3). The SSE stream lifecycle
// (backoff ladder, voice-pause intent, offscreen/direct split) lives in
// plugin/sse-transport.ts; the hooks wired below are what a connect/event
// MEANS — the behavior half of that split.

let hintVisibility: HintVisibility = 'always';

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

// Hint-diagnostics snapshot (Phase 2b). Content script fires a
// DEBUG_SNAPSHOT message with the structured payload it built (per
// docs/completed/DESIGN_HINT_DIAGNOSTICS.md §2). We:
//
//   1. POST the JSON to /debug-snapshot (plugin writes snapshot.json).
//   2. captureVisibleTab on the sender's tab.windowId. §2.5(d) — using
//      sender.tab.windowId rather than the currently-focused-tab id
//      avoids the race where the user has switched tabs between
//      pressing Ctrl+Alt+A and the SW handling the message.
//   3. POST the PNG (or capture error) to /debug-snapshot/screenshot
//      so the plugin can attach it / patch screenshot_error per §2.5(e).
//
// Best-effort end to end: any failure logs to the console and abandons
// the snapshot. The plugin endpoint either succeeded (snapshot.json on
// disk) or didn't; partial state is OK because /debug-snapshot/screenshot
// is keyed by snapshot_id and the plugin tolerates missing follow-ups.
async function handleDebugSnapshot(
  payload: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<void> {
  // Snapshots can be triggered at any time — including before plugin
  // discovery has run. Auto-discover before bailing.
  if (!(await ensureConnected())) {
    console.warn('[branchkit] debug snapshot: plugin not discovered');
    return;
  }
  const snapshotId =
    typeof payload === 'object' && payload !== null && 'snapshot_id' in payload
      ? String((payload as { snapshot_id: unknown }).snapshot_id)
      : '';
  if (!snapshotId) {
    console.warn('[branchkit] debug snapshot: missing snapshot_id');
    return;
  }

  // Layer-2 painted/matchable reconcile (one-shot, demand-driven). Fetches the
  // actuator's matchable view and joins it with the painted set already in
  // `payload`, attaching a classified report so it lands in snapshot.json and
  // the SW log. Non-fatal: a failed fetch must not block the snapshot. Runs
  // only here, on the debug-snapshot trigger — zero steady-state cost.
  try {
    const matchable = await getActuatorJson('/inspector/matchable');
    const snap = payload as { wrappers?: ReconcileWrapper[]; reconcile?: ReconcileReport };
    const report = buildReconcileReport(snap.wrappers ?? [], matchable as MatchableView | null);
    snap.reconcile = report;
    console.log('[branchkit] painted/matchable reconcile:', report.verdict.join(' | '), report);
  } catch (e) {
    console.warn('[branchkit] reconcile failed (non-fatal):', e);
  }

  // Step 1: structured-state POST.
  const res = await postToPlugin('/debug-snapshot', payload);
  if (!res) {
    console.warn('[branchkit] debug-snapshot POST exception');
    return;
  }
  if (!res.ok) {
    console.warn(`[branchkit] debug-snapshot POST failed: HTTP ${res.status}`);
    return;
  }

  // Step 2: captureVisibleTab on the sender's window. Per §2.5(d), use
  // sender.tab.windowId (not the focused-window default) to avoid
  // capturing a different tab if the user has switched focus since
  // pressing Ctrl+Alt+A. If windowId is unavailable (rare — message
  // came from a context without a tab), record an error rather than
  // letting Chrome silently fall back.
  const windowId = sender.tab?.windowId;
  let pngBase64 = '';
  let captured = false;
  let captureError = '';
  if (windowId === undefined) {
    captureError = 'sender.tab.windowId unavailable';
  } else {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      const match = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
      if (match) {
        pngBase64 = match[1];
        captured = true;
      } else {
        captureError = `unexpected dataUrl shape: ${dataUrl.slice(0, 40)}`;
      }
    } catch (e) {
      captureError = e instanceof Error ? e.message : String(e);
    }
  }

  // Step 3: screenshot follow-up. Exactly one of png_base64 / error.
  const body: Record<string, string> = { snapshot_id: snapshotId };
  if (captured) body.png_base64 = pngBase64;
  else body.error = captureError || 'unknown';
  await postToPlugin('/debug-snapshot/screenshot', body);
}

// --- SSE connect-time contribution ---

// Contribute the extension's static command vocabulary (scroll/find/nav voice
// phrases from command-catalog.ts) to the browser plugin, which registers them
// as a thin registrar. Fired on every (re)connect — the plugin REPLACE-stores
// the set and re-runs its command push, so a re-POST is idempotent. Best-effort:
// a failure self-heals on the next connect. See notes/DESIGN_COMMAND_CONTRIBUTION.md.
async function contributeCommands(): Promise<void> {
  try {
    await postToPlugin('/commands/contribute', { commands: buildCommandContributions() });
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

// Map a failed plugin phrase-write to an editor-friendly message. A 400 carries
// the actuator's validation text (user-actionable — relay it); a 404 means the
// running BranchKit predates these routes (needs a rebuild); anything else is a
// transport/availability problem. Avoids surfacing raw "404 page not found".
async function phraseWriteError(resp: Response | null): Promise<string> {
  if (!resp) return 'BranchKit isn’t running.';
  if (resp.status === 400) {
    const detail = (await resp.text().catch(() => '')).trim();
    return detail || 'That phrase isn’t allowed.';
  }
  if (resp.status === 404) return 'Update BranchKit — this build can’t edit voice phrases yet.';
  return 'Couldn’t save — is BranchKit up to date and running?';
}

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message.type === 'VIDEO_PRESENCE') {
    const tabId = _sender.tab?.id;
    const frameId = _sender.frameId;
    if (typeof tabId === 'number' && typeof frameId === 'number') {
      setVideoPresence(tabId, frameId, message.present === true);
    }
    return false;
  }
  if (message.type === 'GRAMMAR_BATCH') {
    // Content's batched doScan (Option B) sent a grammar batch. Stamp
    // tab_id + frame_id and POST. Returning true keeps sendResponse
    // alive across the await — Chrome closes the channel otherwise.
    //
    // Content scripts don't know their own frameId — only the SW does —
    // but the plugin needs it to scope ids to the right frame on
    // dispatch. See §8 of docs/completed/DESIGN_ELEMENT_IDENTITY_REGISTRY.md.
    const tabId = _sender.tab?.id;
    const frameId = _sender.frameId;
    if (typeof tabId !== 'number' || typeof frameId !== 'number') {
      sendResponse(transportFailure(message.request));
      return false;
    }
    // No active-tab gate: every tab POSTs freely. The plugin stores each
    // batch in its own per-source session and projects only the OS-focused
    // source's grammar into the live collections (Option B), so a background
    // tab's push can no longer clobber the focused tab's vocabulary.
    for (const el of message.request.elements) {
      el.frame_id = frameId;
    }
    postGrammarBatch(tabId, frameId, message.request).then(sendResponse);
    return true;
  }

  if (message.type === 'SSE_EVENT') {
    // Offscreen doc forwarded an SSE event (Chrome path) — route to tabs
    handleSSEEvent(message.data);
    return false;
  }

  if (message.type === 'OPEN_TAB_BACKGROUND') {
    // "stash" hint verb: open the resolved href without moving focus.
    // openerTabId groups the new tab with the page it came from (inserted
    // next to the opener, like a ctrl-click). Content validated the scheme,
    // but re-check here — any frame can send runtime messages.
    if (typeof message.url === 'string' && /^https?:\/\//i.test(message.url)) {
      const openerTabId = _sender.tab?.id;
      chrome.tabs.create({
        url: message.url,
        active: false,
        ...(openerTabId !== undefined ? { openerTabId } : {}),
      }).catch((e) => console.warn('[BranchKit BG] stash tab create failed:', e));
    }
    return false;
  }

  if (message.type === 'ALPHABET' && Array.isArray(message.words)) {
    // Offscreen doc forwarded an alphabet event (Chrome path)
    storeAlphabet(message.words);
    return false;
  }

  if (message.type === 'REFERENCE_NAMES_CHANGED') {
    pushReferenceNames();
    return false;
  }

  if (message.type === 'REFERENCE_SAVED') {
    saveReferenceToCollection(message.host, message.name, message.reference);
    return false;
  }

  if (message.type === 'DISPATCH_RESULT') {
    forwardDispatchResult(message.payload);
    return false;
  }

  if (message.type === 'DEBUG_LOG' && typeof message.tag === 'string') {
    forwardDebugLog(message.tag, message.data);
    return false;
  }

  if (message.type === 'PERF_REPORT' && message.snapshot) {
    // Tab id comes from the sender; the content script doesn't know its
    // own tab id. URL is the frame's URL — useful for attributing the
    // report to a YouTube vs Gmail tab in the JSONL trail.
    const tabId = _sender.tab?.id ?? -1;
    // Prefer the content script's live location.href (message.url) over
    // _sender.url. _sender.url is the URL the script was *injected* into and
    // does not follow SPA navigation — on YouTube it stays "www.youtube.com/"
    // after a homepage→/watch transition, mislabeling /watch samples in the
    // trail and hiding them from /watch-filtered analysis.
    const url = (message.url as string) ?? _sender.url ?? '';
    const browser = typeof message.browser === 'string' ? message.browser : 'unknown';
    forwardPerfReport({ url, tab_id: tabId, browser, snapshot: message.snapshot });
    return false;
  }

  if (message.type === 'PLUGIN_DEBUG_LOG' && typeof message.tag === 'string') {
    const level = typeof message.level === 'string' ? message.level : 'debug';
    forwardPluginDebugLog(message.tag, message.data, level);
    return false;
  }

  if (message.type === 'DEBUG_SNAPSHOT' && message.payload) {
    handleDebugSnapshot(message.payload, _sender);
    return false;
  }

  if (message.type === 'TAB_ACTION' && typeof message.action === 'string') {
    void handleTabAction(message.action, typeof message.index === 'number' ? message.index : undefined);
    return false;
  }

  if (message.type === 'ZOOM_ACTION' && typeof message.action === 'string') {
    void handleZoomAction(message.action);
    return false;
  }

  if (message.type === 'MARK_SET') {
    // Content captured the position; the background owns storage. For a global
    // mark the tab id/URL come from the sender (the tab it was set in).
    const mark: StoredMark = { scrollX: message.scrollX, scrollY: message.scrollY, hash: message.hash };
    if (message.scope === 'global') {
      const global: GlobalMark = {
        ...mark,
        url: baseUrl(_sender.tab?.url ?? message.url),
        tabId: _sender.tab?.id,
      };
      void setGlobalMark(message.letter, global);
    } else {
      void setLocalMark(message.url, message.letter, mark);
    }
    return false;
  }

  if (message.type === 'MARK_JUMP') {
    if (message.scope === 'global') {
      gotoGlobalMark(message.letter).then((ok) => sendResponse({ ok }));
    } else {
      getLocalMark(message.url, message.letter).then((mark) => sendResponse({ mark }));
    }
    return true; // async sendResponse
  }

  if (message.type === 'CARET_ACTIVE') {
    void setCaretActive(message.active);
    return false;
  }

  if (message.type === 'PALETTE_OPEN') {
    // A palette bind fired in a subframe; the overlay must live in the top
    // frame. Route it there as a PALETTE_COMMAND through the dispatcher.
    const tabId = _sender.tab?.id;
    if (typeof tabId === 'number') {
      const action = message.command === 'toggle_tab_palette' ? 'toggle_tab_palette' : 'toggle_palette';
      chrome.tabs.sendMessage(tabId, { type: 'PALETTE_COMMAND', action }, { frameId: 0 })
        .catch(() => {});
    }
    return false;
  }

  if (message.type === 'PALETTE_ACTION' && message.action?.kind) {
    // From the palette iframe (extension origin, embedded in a tab — so
    // _sender.tab is set). Close-then-execute; see handlePaletteAction.
    void handlePaletteAction(message.action, _sender.tab?.id);
    return false;
  }

  if (message.type === 'PALETTE_PUBLISH' && Array.isArray(message.entries)) {
    // Palette iframe badged its rows: start the voice session. Sender is the
    // iframe embedded in the host tab, so sender.tab names the origin tab.
    const tabId = _sender.tab?.id;
    if (typeof tabId === 'number') {
      void publishPaletteVoice(tabId, message.entries, message.rows ?? []);
    }
    return false;
  }

  if (message.type === 'PALETTE_CLOSED') {
    // Content removed the overlay (any path) — end the voice session.
    void clearPaletteVoice('overlay_closed');
    return false;
  }

  if (message.type === 'GET_TAB_MARKER') {
    // Content bootstrapping its tab marker on load. Assign lazily, reply with
    // the letter form (title supplies a preferred marker for reconciliation).
    const tabId = _sender.tab?.id;
    if (typeof tabId !== 'number') { sendResponse({ letters: null }); return false; }
    getTabMarker(tabId, _sender.tab?.title ?? undefined)
      .then((letters) => sendResponse({ letters }))
      .catch(() => sendResponse({ letters: null }));
    return true; // async response
  }

  if (message.type === 'GET_VOICE_STATUS') {
    // The keymap editor sources voice phrases from its own catalog now; it only
    // needs to know whether BranchKit is connected (for the not-connected note).
    ensureConnected()
      .then((connected) => sendResponse({ connected }))
      .catch(() => sendResponse({ connected: false }));
    return true; // async response
  }

  // --- Command-phrase overrides (editor on the keyboard-shortcuts page) ---
  // The keymap editor can't reach the plugin directly; the SW forwards to the
  // browser plugin's passthrough, which relays to the actuator override layer.
  // See notes/DESIGN_COMMAND_PHRASE_OVERRIDES.md.

  if (message.type === 'GET_COMMAND_OVERRIDES') {
    ensureConnected()
      .then(() => getFromPlugin('/commands/overrides'))
      .then((data) => {
        const overrides = (data as { overrides?: unknown })?.overrides;
        sendResponse({ overrides: Array.isArray(overrides) ? overrides : [] });
      })
      .catch(() => sendResponse({ overrides: [] }));
    return true; // async response
  }

  if (message.type === 'SET_COMMAND_OVERRIDE') {
    ensureConnected()
      .then(() => postToPlugin('/commands/override', {
        action: message.action,
        default_pattern: message.defaultPattern,
        new_pattern: message.newPattern,
      }))
      .then(async (resp) => {
        if (resp && resp.ok) { sendResponse({ ok: true }); return; }
        sendResponse({ ok: false, error: await phraseWriteError(resp) });
      })
      .catch(() => sendResponse({ ok: false, error: 'Not connected to BranchKit.' }));
    return true; // async response
  }

  if (message.type === 'RESET_COMMAND_OVERRIDE') {
    ensureConnected()
      .then(() => postToPlugin('/commands/override/reset', {
        action: message.action,
        default_pattern: message.defaultPattern,
      }))
      .then((resp) => sendResponse({ ok: !!(resp && resp.ok) }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }

  // Aliases: extra spoken forms (the "+ voice" free list).

  if (message.type === 'GET_COMMAND_ALIASES') {
    ensureConnected()
      .then(() => getFromPlugin('/commands/aliases'))
      .then((data) => {
        const aliases = (data as { aliases?: unknown })?.aliases;
        sendResponse({ aliases: Array.isArray(aliases) ? aliases : [] });
      })
      .catch(() => sendResponse({ aliases: [] }));
    return true; // async response
  }

  if (message.type === 'ADD_COMMAND_ALIAS') {
    ensureConnected()
      .then(() => postToPlugin('/commands/alias', {
        action: message.action,
        default_pattern: message.defaultPattern,
        new_pattern: message.newPattern,
      }))
      .then(async (resp) => {
        if (resp && resp.ok) { sendResponse({ ok: true }); return; }
        sendResponse({ ok: false, error: await phraseWriteError(resp) });
      })
      .catch(() => sendResponse({ ok: false, error: 'Not connected to BranchKit.' }));
    return true; // async response
  }

  if (message.type === 'REMOVE_COMMAND_ALIAS') {
    ensureConnected()
      .then(() => postToPlugin('/commands/alias/remove', {
        action: message.action,
        default_pattern: message.defaultPattern,
        new_pattern: message.newPattern,
      }))
      .then((resp) => sendResponse({ ok: !!(resp && resp.ok) }))
      .catch(() => sendResponse({ ok: false }));
    return true; // async response
  }

  if (message.type === 'HEALTH_STATUS') {
    // The full connect/disconnect work runs on every report, not on flag
    // edges — edge-gating masked the reconnect healer (the reconnect paths
    // used to set the flag optimistically before the stream was up), and a
    // down report while already-marked-down still needs a retry armed
    // ("discovery succeeded but the SSE never came up"). scheduleSSERetry is
    // idempotent while a timer is pending. notes/DESIGN_SSE_RESILIENCE.md.
    if (message.branchkit) onSSEConnected();
    else onSSEDisconnected();
    return false;
  }

  if (message.type === 'GET_HEALTH') {
    // Three states the popup renders distinctly: connected, paused-by-choice,
    // and not-detected. `paused` lets it show "Voice paused" instead of
    // inferring "not detected" while the host may well be running.
    sendResponse({ branchkit: bgState.branchkitConnected, paused: isVoicePaused() });
    return false;
  }

  if (message.type === 'SET_VOICE_PAUSED') {
    // Popup toggle. Await the lifecycle so the response reflects the settled
    // state (the popup re-reads status right after).
    const fn = message.paused ? pauseVoice : resumeVoice;
    fn()
      .then(() => sendResponse({ paused: isVoicePaused(), branchkit: bgState.branchkitConnected }))
      .catch(() => sendResponse({ paused: isVoicePaused(), branchkit: bgState.branchkitConnected }));
    return true; // async response
  }

  // Per-tab label pool. Only trust messages from a content script in a tab —
  // popup / offscreen don't have a tab context and wouldn't be claiming labels.
  if (message.type === 'CLAIM_LABELS') {
    const tabId = _sender.tab?.id;
    const frameId = _sender.frameId;
    if (typeof tabId !== 'number' || typeof frameId !== 'number') {
      sendResponse({ labels: [] });
      return false;
    }
    // Prerender deny (DESIGN_PRERENDER_POOL_POISONING.md L1): a provisional
    // frame id must never enter the pool. Empty grant; the CS's level-
    // triggered claims retry after activation as the real frame 0.
    if (!senderMayMutatePool(_sender)) {
      void forwardDebugLog('pool.prerender_claim_denied', { tab_id: tabId, frame_id: frameId });
      sendResponse({ labels: [] });
      return false;
    }
    if (typeof message.doc_id !== 'string' || message.doc_id.length === 0) {
      sendResponse({ labels: [] });
      return false;
    }
    claimLabels(tabId, message.doc_id, frameId, message.count, message.preferred)
      .then(labels => sendResponse({ labels }))
      .catch(err => {
        console.warn('[BranchKit SW] CLAIM_LABELS error:', err);
        sendResponse({ labels: [] });
      });
    return true;
  }

  if (message.type === 'RELEASE_LABELS') {
    // Frame-scoped: only the owning frame's release frees a codeword. The
    // sender's frameId is authoritative (not message payload) — a frame with
    // a stale local copy of a codeword another frame won must not free the
    // winner's assignment. See releaseLabels.
    const tabId = _sender.tab?.id;
    if (typeof tabId !== 'number' || typeof message.doc_id !== 'string') return false;
    releaseLabels(tabId, message.doc_id, message.labels).catch(err => {
      console.warn('[BranchKit SW] RELEASE_LABELS error:', err);
    });
    return false;
  }

  if (message.type === 'CONFIRM_LABELS') {
    // Sent by the content script's reservoir after `claim()` actually hands
    // codewords to wrappers. An arbitrated EXCHANGE (review bug #5): promotes
    // reserved → assigned, directly acquires from free (the released-then-
    // locally-reclaimed case the old fire-and-forget silently dropped), and
    // answers `rejected` for codewords another frame won so the sender drops
    // them. Unconfirmed reserved labels remain NOT routable — the SW falls
    // back to broadcasting actions to all frames so iframe reservoirs holding
    // unused codewords don't capture activations meant for a sibling
    // frame's wrapper. See docs/completed/DESIGN_ELEMENT_IDENTITY_REGISTRY.md
    // and the QuickBase `fine jury` failure 2026-06-05T17:18:37.
    const tabId = _sender.tab?.id;
    const frameId = _sender.frameId;
    if (typeof tabId !== 'number' || typeof frameId !== 'number' || !Array.isArray(message.labels)) {
      sendResponse({ rejected: [] });
      return false;
    }
    // Prerender deny (DESIGN_PRERENDER_POOL_POISONING.md L1): nothing to
    // arbitrate — a prerender sender was never granted. Accept-nothing (an
    // empty rejected list) rather than reject: rejecting strips wrappers.
    if (!senderMayMutatePool(_sender)) {
      sendResponse({ rejected: [] });
      return false;
    }
    if (typeof message.doc_id !== 'string' || message.doc_id.length === 0) {
      sendResponse({ rejected: [] });
      return false;
    }
    confirmLabels(tabId, message.doc_id, frameId, message.labels)
      .then(result => sendResponse(result))
      .catch(err => {
        console.warn('[BranchKit SW] CONFIRM_LABELS error:', err);
        // Transient error: don't reject — rejecting nukes wrappers; the
        // codewords stay locally held and a later confirm re-arbitrates.
        sendResponse({ rejected: [] });
      });
    return true;
  }

  if (message.type === 'REMEMBER_CODEWORDS') {
    // Regime B (DESIGN_CODEWORD_STABILITY): persist this frame's
    // fingerprint→codeword pairs so a fresh content script after a
    // full-document reload can reclaim the same codewords. Separate from the
    // LabelStack (not pool-mutating), so no single-sender concern.
    const tabId = _sender.tab?.id;
    const frameId = _sender.frameId;
    if (typeof tabId !== 'number' || typeof frameId !== 'number') return false;
    if (!Array.isArray(message.entries)) return false;
    rememberCodewords(tabId, frameId, message.entries).catch(err => {
      console.warn('[BranchKit SW] REMEMBER_CODEWORDS error:', err);
    });
    return false;
  }

  if (message.type === 'RECALL_CODEWORDS') {
    // A fresh content script (post Regime-B reload) asks for this frame's
    // remembered fingerprint→codeword entries so it can seed preferredCodeword.
    const tabId = _sender.tab?.id;
    const frameId = _sender.frameId;
    if (typeof tabId !== 'number' || typeof frameId !== 'number') {
      sendResponse({ entries: [] });
      return false;
    }
    recallCodewords(tabId, frameId)
      .then(entries => sendResponse({ entries }))
      .catch(() => sendResponse({ entries: [] }));
    return true;
  }

  if (message.type === 'RESOLVE_HINT_FROM_TAB') {
    resolveHintFromTab(message.tabId, message.codeword)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: String(err?.message ?? err) }));
    return true;  // async response
  }

  return false;
});

// Per-frame liveness via long-lived Port. Each content-script context opens
// one Port at startup; when the context dies (iframe removed, navigation,
// tab closed, bfcache evict) Chrome closes the Port and onDisconnect fires
// here. Three cleanups run on disconnect: the per-tab label pool
// (`releaseFrame`), the browser plugin's per-frame hint session
// (`forwardHintsSessionEnd`), and the frame's fingerprint->codeword memory
// (`clearCodewordMemory`). Without them, dead frames' state leaks — label
// codewords until the next tab close, hint-session per-prefix contributions
// until the plugin's 30s TTL backstop fires, codeword-memory keys forever.
// See docs/completed/DESIGN_BROWSER_FRAME_POOL_EXHAUSTION.md for the
// label-pool half.
//
// The Port carries no messages — its lifetime IS the signal. Service worker
// idle-termination is a known small leak window (frames that die while the
// SW is asleep don't get cleaned by either path); the browser plugin's TTL
// backstop catches its share. The label pool's dead-TAB share is reclaimed
// by the periodic sweep below (sweepDeadTabState); dead FRAMES inside a
// still-open tab remain the accepted v1 gap.
const LIVENESS_PORT_NAME = 'frame-liveness';

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(`${LIVENESS_PORT_NAME}:`)) return;
  // The port name carries the document's pool-ownership identity
  // (DESIGN_DOCUMENT_SCOPED_POOL_OWNERSHIP.md) — available atomically at
  // connect, so the disconnect cleanup below can be document-scoped with no
  // handshake race.
  const docId = port.name.slice(LIVENESS_PORT_NAME.length + 1);
  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId;
  if (typeof tabId !== 'number' || typeof frameId !== 'number' || docId.length === 0) return;
  // Tell the content script its own frameId. Content has no API to
  // discover this on its own and uses it to detect misrouted activate
  // actions (id minted in frame A, dispatched into frame B by SW
  // routing drift). Sent on connect because it never changes for the
  // lifetime of this Port.
  try {
    port.postMessage({ type: 'FRAME_ID', frameId });
  } catch {
    // Port may already be closing; harmless.
  }
  port.onDisconnect.addListener(() => {
    // Doc-scoped: this document frees only ITS labels — never a bfcache-
    // restored predecessor's re-assertions (they share frame 0; they do not
    // share a docId).
    releaseDocument(tabId, docId).catch(() => {});
    forwardHintsSessionEnd('frame_liveness_disconnect', tabId, frameId).catch(() => {});
    // Evict this dead frame's fingerprint->codeword memory (chrome.storage.session).
    // The per-frame keys were previously only cleared on TAB close
    // (clearCodewordMemory(tabId)); the frame-scoped clear had no caller, so an
    // iframe-churny long-lived tab accumulated dead-frame keys indefinitely
    // (long-session-perf: codewordMemory accumulator). Frame death is the
    // eviction point — siblings' memory is untouched (frame-scoped key).
    clearCodewordMemory(tabId, frameId).catch(() => {});
  });
});

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
declare const __DEV_RELOAD__: boolean;
if (typeof __DEV_RELOAD__ !== 'undefined' && __DEV_RELOAD__) {
  const DEV_WS_URL = 'ws://localhost:35729';
  function devConnect() {
    try {
      const ws = new WebSocket(DEV_WS_URL);
      ws.onmessage = (e) => {
        if (e.data === 'reload') {
          console.log('[BranchKit Dev] reloading extension...');
          chrome.runtime.reload();
        }
      };
      ws.onclose = () => setTimeout(devConnect, 2000);
      ws.onerror = () => ws.close();
    } catch { /* dev server not running */ }
  }
  devConnect();
}

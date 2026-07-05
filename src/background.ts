/**
 * BranchKit Browser — Service worker (background script).
 *
 * Responsibilities:
 * - Discover browser plugin port/token via actuator
 * - Push grammar to plugin on scan results
 * - Route SSE events from offscreen doc (Chrome) or direct SSE (Firefox) to content scripts
 * - Manage offscreen document lifecycle (Chrome only)
 */

import { Message, ScannedElement, HintVisibility, DispatchResult, GrammarBatchRequest, GrammarBatchResponse, TabAction, PaletteVoiceEntry, PaletteVoiceRow } from './types';
import type { PaletteDispatch } from './palette/model';
import { claimLabels, confirmLabels, releaseLabels, releaseFrame, clearStack, clearAllStacks, sweepDeadStacks, alphabetsEqual } from './labels/label-pool';
import { setAlphabet, tokenToSpokenCodeword, spokenCodewordToToken } from './labels/words';
import { buildCommandContributions } from './command-catalog';
import { rememberCodewords, clearCodewordMemory, recallCodewords } from './labels/codeword-memory';
import { discoverPlugin, ensureConnected, postToPlugin, getPluginPort, getPluginToken, getActuatorJson } from './plugin/actuator-client';
import { buildReconcileReport, type ReconcileWrapper, type ReconcileReport, type MatchableView } from './debug/reconcile';
import { cycleTabIndex } from './background/tab-nav';
import { loadMru, previousCandidates, recordTabActivated } from './background/tab-mru';
import { scheduleTabPublish, resetTabPublishCache } from './background/tab-collection';
import {
  getTabMarkerLetters, pushTabMarker, reapplyTabMarker as reapplyTabMarkerFor,
  releaseTabMarker, transferTabMarker, setTabMarkersSetting,
  setTabMarkersConnected, refreshAllTabMarkers,
} from './background/tab-markers';
import { ensureContentScriptInjected } from './background/injection';
import { bgState, connId } from './background/state';
import { republishActiveTab, broadcastToAllTabs, resolveActiveContentTab, notifyActiveTab, resolveHintFromTab } from './background/frame-router';
import { SSEBackoff } from './background/sse-backoff';

// --- State ---
//
// The shared connection/tab state (bgState + connId, imported above) lives in
// background/state.ts so the extracted background modules share it — see
// notes/DESIGN_EXTENSION_RESTRUCTURE.md (Tier 3).

let hintVisibility: HintVisibility = 'always';

// Firefox direct SSE (no offscreen document needed)
let directSSE: EventSource | null = null;
// URL of the EventSource `directSSE` currently points at — the
// already-connecting guard in connectDirectSSE compares against it so a
// redundant connect with unchanged creds keeps the in-flight socket.
let directSSEUrl: string | null = null;

// SSE reconnect backoff state. Shared by Chrome (offscreen→HEALTH_STATUS)
// and Firefox (direct EventSource) paths. Policy (ladder + stable-connection
// reset) lives in SSEBackoff; only the timer lives here.
let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
const sseBackoff = new SSEBackoff();

function clearSSERetryTimer(): void {
  if (sseRetryTimer) {
    clearTimeout(sseRetryTimer);
    sseRetryTimer = null;
  }
}

function scheduleSSERetry(): void {
  if (sseRetryTimer) return;
  sseRetryTimer = setTimeout(async () => {
    sseRetryTimer = null;
    const found = await discoverPlugin();
    if (found) {
      // Discovery success is NOT connection success — the flag flips (and
      // the connect-edge work runs) only on the stream's real `connected`
      // signal via onSSEConnected. If the SSE never comes up, a
      // HEALTH_STATUS(false) / onerror / alarm probe re-arms the retry.
      connectSSE();
    } else {
      scheduleSSERetry();
    }
  }, sseBackoff.nextDelayMs(Date.now()));
}

// Ambient connection state on the toolbar icon (piece A1 of
// notes/DESIGN_EXTENSION_CONNECTION_HEALTH.md). State, not error: connected
// shows a quiet dot; standalone shows NO badge at all — running without
// BranchKit is a first-class mode, and the extension can't distinguish
// "standalone by choice" from "host vanished" (the side that can — the
// plugin — owns that nudge). Driven from the same transitions that flip
// branchkitConnected, so there's no new state to maintain; the calls are
// idempotent and the badge itself persists across SW idle-restarts.
function updateConnectionBadge(connected: boolean): void {
  try {
    void chrome.action.setBadgeText({ text: connected ? '•' : '' });
    if (connected) {
      void chrome.action.setBadgeBackgroundColor({ color: '#2e7d32' });
    }
  } catch {
    // chrome.action unavailable (shouldn't happen in MV3) — badge is cosmetic.
  }
}

// The one honest connect signal: the SSE stream's `connected` event, via
// Chrome's offscreen HEALTH_STATUS(true) or Firefox's direct EventSource.
// Runs on EVERY connected event, not just flag edges — a `connected` means a
// NEW stream was established, so the host/plugin may have restarted and the
// grammar heal is warranted. Edge-gating on branchkitConnected is what masked
// the b7399f5 healer: reconnect paths used to set the flag optimistically
// before the stream was up, so the "edge" never fired. Reactivate is
// idempotent (same rotate+re-Put as every tab focus) and connects are rare.
// See notes/DESIGN_SSE_RESILIENCE.md (1).
function onSSEConnected(): void {
  bgState.branchkitConnected = true;
  updateConnectionBadge(true);
  // Tab markers are voice-gated: paint them now the host is connected (the
  // alphabet arrives moments later via storeAlphabet → refreshAllTabMarkers).
  void setTabMarkersConnected(true);
  sseBackoff.onConnected(Date.now());
  clearSSERetryTimer();
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
  // Seed the open-tab voice collection ("switch to <tab>"). The publish cache
  // is cleared first: a reconnected plugin may have restarted and lost its
  // per-connection tab entries, so the unchanged-set guard must not suppress
  // this re-seed.
  resetTabPublishCache();
  scheduleTabPublish();
}

function onSSEDisconnected(): void {
  bgState.branchkitConnected = false;
  updateConnectionBadge(false);
  scheduleSSERetry();
  // Voice gone → strip every tab mark (a mark you can't speak is just clutter).
  void setTabMarkersConnected(false);
}

function rescanActiveTab(): void {
  if (bgState.cachedActiveTabId == null) return;
  forwardDebugLog('pipeline.bg_rescan_dispatched', { tab_id: bgState.cachedActiveTabId, source: 'rescanActiveTab' });
  chrome.tabs.sendMessage(bgState.cachedActiveTabId, {
    type: 'BRANCHKIT_ACTION',
    payload: { action: 'rescan' },
  }).catch(() => {});
}

// --- Feature Detection ---

const hasOffscreenAPI = typeof chrome !== 'undefined' && !!chrome.offscreen;

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
    // Alphabet is now available — (re)derive tab marks if the feature is
    // active. On a fresh connection the connect hook fires before this event,
    // so this is what actually paints the marks.
    void refreshAllTabMarkers();
  } catch (err) {
    console.error('[BranchKit BG] alphabet store error:', err);
  }
}

// --- Reference Names ---

const REFERENCES_STORAGE_KEY = 'branchkit_references';

async function loadAllReferenceNames(): Promise<string[]> {
  const result = await chrome.storage.local.get(REFERENCES_STORAGE_KEY);
  const store = result[REFERENCES_STORAGE_KEY] || {};
  const names = new Set<string>();
  for (const host of Object.keys(store)) {
    const refs = store[host]?.references;
    if (refs) {
      for (const name of Object.keys(refs)) {
        names.add(name);
      }
    }
  }
  return [...names];
}

async function saveReferenceToCollection(host: string, name: string, reference: Record<string, unknown>): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/reference/save', { host, name, reference });
}

async function pushReferenceNames(): Promise<void> {
  if (!(await ensureConnected())) return;
  const names = await loadAllReferenceNames();
  await postToPlugin('/references', { names });
}

async function hydrateReferencesFromCollection(): Promise<void> {
  if (!(await ensureConnected())) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab?.url) return;
    const host = new URL(tab.url).hostname;
    if (!host) return;

    // GET with query-param token (the references read endpoint's auth style).
    const resp = await fetch(
      `http://127.0.0.1:${getPluginPort()}/references?host=${encodeURIComponent(host)}&token=${getPluginToken()}`,
    );
    if (!resp.ok) return;
    const data = await resp.json();
    const refs = data?.references;
    if (!refs || Object.keys(refs).length === 0) return;

    const result = await chrome.storage.local.get(REFERENCES_STORAGE_KEY);
    const store = result[REFERENCES_STORAGE_KEY] || {};
    if (!store[host]) {
      store[host] = { references: {}, marks: {} };
    }
    for (const [name, ref] of Object.entries(refs)) {
      if (!store[host].references[name]) {
        store[host].references[name] = ref;
      }
    }
    await chrome.storage.local.set({ [REFERENCES_STORAGE_KEY]: store });
  } catch {
    // Plugin may be down or tab URL unavailable
  }
}

// Forward a content-script dispatch outcome to the plugin's POST
// /dispatch-result. Best-effort; the plugin can survive missing reports.
async function forwardDispatchResult(result: DispatchResult): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/dispatch-result', result);
}

async function forwardDebugLog(tag: string, data: unknown): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/debug-log', { tag, data });
}

// Sibling of forwardDebugLog. Pumps the content script's perf snapshot
// to the plugin's /perf-report endpoint, which appends to a JSONL trail
// for offline analysis. See plugins/browser/src/perf_report.go and
// src/content.ts (search PERF_REPORT). Diagnostic-only, no retry.
async function forwardPerfReport(payload: { url: string; tab_id: number; browser: string; snapshot: unknown }): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/perf-report', payload);
}

// Sibling of forwardDebugLog that targets the per-plugin debug log
// channel (plugin-logs/browser.log) instead of the shared actuator.log.
// Use for plugin-internal diagnostic chatter that doesn't belong
// interleaved with the actuator's cross-cutting coordination lines —
// see docs/completed/DESIGN_PLUGIN_LOGGING.md and DESIGN_PLUGIN_LOG_LEVELS.md.
//
// `level` is one of trace/debug/info/warn/error. Defaults to "debug"
// for callers that haven't migrated to v2's per-level emit. The
// underlying plugin endpoint also defaults missing/unknown levels to
// "debug" so the wire surface is robust to extension-side typos.
async function forwardPluginDebugLog(
  tag: string,
  data: unknown,
  level: string = 'debug',
): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/plugin-debug-log', { tag, data, level });
}

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

// Tab verbs (notes/DESIGN_TAB_NAVIGATION.md, "Tab verbs"). One handler for
// both entry points: the content dispatcher's TAB_ACTION message (keyboard)
// and the SSE action intercept (voice — handled here rather than in content
// so the verbs work even when the active page has no content script, e.g. a
// chrome:// page). `index` is goto's 1-based tab position.
async function handleTabAction(action: TabAction, index?: number): Promise<void> {
  if (action === 'new') {
    await chrome.tabs.create({});
    return;
  }
  if (action === 'restore') {
    // Most recently closed tab or window (browser Cmd/Ctrl+Shift+T).
    // Needs the `sessions` permission.
    try { await chrome.sessions.restore(); } catch { /* nothing to restore */ }
    return;
  }
  if (action === 'last_active') {
    // Walk the MRU stack for the newest still-existing tab that isn't the
    // current one; closed tabs stay in the stack, so skip the dead ids.
    for (const id of previousCandidates(await loadMru(), bgState.cachedActiveTabId)) {
      try {
        const t = await chrome.tabs.get(id);
        await chrome.windows.update(t.windowId, { focused: true });
        await chrome.tabs.update(id, { active: true });
        return;
      } catch { /* tab gone — try the next candidate */ }
    }
    return;
  }

  const tabs = await chrome.tabs.query({ currentWindow: true });
  const activeIdx = tabs.findIndex((t) => t.active);
  const active = tabs[activeIdx];
  if (activeIdx < 0 || active?.id == null) return;

  switch (action) {
    case 'next':
    case 'previous': {
      if (tabs.length < 2) return;
      const target = tabs[cycleTabIndex(activeIdx, tabs.length, action)];
      if (target?.id != null) await chrome.tabs.update(target.id, { active: true });
      return;
    }
    case 'close':
      await chrome.tabs.remove(active.id);
      return;
    case 'duplicate':
      await chrome.tabs.duplicate(active.id);
      return;
    case 'pin':
      await chrome.tabs.update(active.id, { pinned: !active.pinned });
      return;
    case 'mute':
      await chrome.tabs.update(active.id, { muted: !active.mutedInfo?.muted });
      return;
    case 'first':
    case 'last':
    case 'goto': {
      const pos = action === 'first' ? 1 : action === 'last' ? tabs.length : index ?? 1;
      const target = tabs[Math.min(Math.max(pos, 1), tabs.length) - 1];
      if (target?.id != null && !target.active) await chrome.tabs.update(target.id, { active: true });
      return;
    }
    case 'move_left':
    case 'move_right': {
      const to = Math.min(Math.max(activeIdx + (action === 'move_right' ? 1 : -1), 0), tabs.length - 1);
      if (to !== activeIdx) await chrome.tabs.move(active.id, { index: to });
      return;
    }
  }
}

// --- Palette voice session (voice half of Layer 2) ---
//
// While the palette is open with badges, the plugin holds its EXCLUSIVE
// palette tag and the `browser_palette` collection maps spoken codewords to
// row ids. The row_id → dispatch map never leaves the extension — the plugin
// round-trips only the opaque row id, and this background resolves it back
// to the same close-then-execute path the keyboard uses.
//
// One session max: a palette only ever opens in the focused window's active
// tab, and the plugin's projection is single-conn to match.
interface PaletteVoiceSession {
  tabId: number;
  rows: Map<string, PaletteDispatch>;
}
let paletteVoice: PaletteVoiceSession | null = null;

async function publishPaletteVoice(
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
async function clearPaletteVoice(reason: string): Promise<void> {
  if (!paletteVoice) return;
  paletteVoice = null;
  console.log(`[BranchKit BG] palette voice cleared (${reason})`);
  await postToPlugin('/palette', { conn_id: connId, entries: [] });
}

// Command palette selection (notes/DESIGN_TAB_NAVIGATION.md, Layer 2). Always
// close the overlay in the origin tab FIRST — a tab switch moves focus away
// and must not leave a dead palette behind, and a command dispatch (e.g.
// focus_input) needs page focus restored before it runs. The close message
// round-trips (content sendResponse) so ordering is real, not racy.
async function handlePaletteAction(
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
    // Same focus-window-then-activate dispatch as switchToTabById — cross-
    // window by design. A stale id (tab closed while the palette was open)
    // is a silent no-op.
    try {
      const t = await chrome.tabs.get(action.tabId);
      await chrome.windows.update(t.windowId, { focused: true });
      await chrome.tabs.update(action.tabId, { active: true });
    } catch { /* tab gone */ }
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

// Voice "switch to <tab>": the matched collection entry's tab_id arrives as an
// action param (the browser_tabs collection's value_field). Same focus-window-
// then-activate dispatch as handleTabAction's last_active branch — cross-window
// by design. A stale id (tab closed since the last publish) just refreshes the
// collection so the dead entry drops.
async function switchToTabById(tabId: number): Promise<void> {
  try {
    const t = await chrome.tabs.get(tabId);
    await chrome.windows.update(t.windowId, { focused: true });
    await chrome.tabs.update(tabId, { active: true });
  } catch {
    scheduleTabPublish();
  }
}

// Voice → tab verb intercept: catalog command id → TabAction. The ids are the
// same ones the content dispatcher registers for the keyboard path; this map
// is what lets the background claim them off the SSE stream first.
const TAB_ACTION_BY_ID: Readonly<Record<string, TabAction>> = {
  next_tab: 'next', previous_tab: 'previous', new_tab: 'new', close_tab: 'close',
  restore_tab: 'restore', duplicate_tab: 'duplicate', pin_tab: 'pin', mute_tab: 'mute',
  first_tab: 'first', last_tab: 'last', goto_tab: 'goto',
  move_tab_left: 'move_left', move_tab_right: 'move_right', last_active_tab: 'last_active',
};

// Tell the plugin to end a hint session. Two scopes:
//   - tab-wide: omit `frameId`. Plugin Deletes every frame's tracked
//     codewords for this tab and clears the hints tag. Used on tab
//     switch / tab close / navigation — the user can't be addressing
//     a stale tab's hints anymore.
//   - frame-scoped: pass `frameId`. Plugin Deletes only that frame's
//     codewords; hints tag stays held if other frames in the tab are
//     still live. Used on iframe removal / cross-document nav / bfcache
//     evict via the frame-liveness Port's onDisconnect — siblings in
//     the same tab may still be live.
//
// Both scopes are part of the Option B C7 cleanup story
// (notes/DESIGN_HINT_PIPELINE_RESYNC.md). The tab-wide call replaces
// the implicit "stop pushing" cleanup the old whole-grammar path did
// via diffPrefixesToDelete.
async function forwardHintsSessionEnd(reason: string, tabId: number, frameId?: number): Promise<void> {
  if (!(await ensureConnected())) return;
  const body: { reason: string; tab_id: number; frame_id?: number } = { reason, tab_id: tabId };
  if (typeof frameId === 'number') body.frame_id = frameId;
  await postToPlugin('/hints/session_end', body);
}

// Tell the plugin to pre-arm the hints tag for an imminent hints-eligible
// session on `tabId`. Triggered on tab activation in always-mode: the plugin
// fires its eager-arm bridge (same one used for browser app focus) so the
// codeword-vs-alphabet disambiguator is in place before the new tab's
// grammar push arrives. If grammar doesn't arrive within the eager-arm
// timeout (2s), the plugin auto-clears.
async function forwardHintsSessionStart(reason: string, tabId: number): Promise<void> {
  if (!(await ensureConnected())) return;
  await postToPlugin('/hints/session_start', { reason, tab_id: tabId });
}

// Per-batch grammar push (Option B). The content script's batched
// doScan sends one of these per 10-20 elements; the SW stamps
// tab_id + frame_id from sender and POSTs to /grammar/batch. Plugin
// runs the per-element Puts and returns a succeeded/failed split
// the content script uses to paint or releaseLabel each element.
//
// Failure modes (return value):
//  - Plugin unreachable → empty succeeded, every element failed
//    with reason "transport". Lets the content script unwind the
//    batch cleanly instead of mismatched state.
async function postGrammarBatch(
  tabId: number,
  frameId: number,
  request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'>,
): Promise<GrammarBatchResponse> {
  if (!getPluginPort() || !getPluginToken()) {
    // ensureConnected (not raw discoverPlugin): single-flight + negative
    // cache, so a burst of batches against a down host can't each fire a
    // discovery fetch + connectSSE cycle.
    const found = await ensureConnected();
    if (!found) return transportFailure(request);
    // Fresh creds (cold start, or a cred-clear after the old host died) —
    // bring the SSE up too. The connected flag flips on the stream's real
    // signal, not here.
    connectSSE();
  }

  // Voice overlay translation (outbound): the content script speaks in letter
  // tokens ("c g"); the plugin's grammar speaks in codewords ("cape glad").
  // Translate every element + queued delete here so the plugin is unchanged.
  // With no overlay loaded this is identity (letters pass through).
  const translatedElements = request.elements.map(e => ({
    ...e,
    codeword: tokenToSpokenCodeword(e.codeword),
  }));
  const translatedDeletes = request.delete_codewords?.map(tokenToSpokenCodeword);

  // Stamp the connection nonce here, not in the content script. The plugin's
  // cross-browser focus gate keys off the connId↔bundle binding (established
  // by the focus handshake) to accept grammar only from the OS-focused
  // browser. tab_id/frame_id come from the message sender.
  const fullRequest: GrammarBatchRequest = {
    ...request,
    elements: translatedElements,
    ...(translatedDeletes ? { delete_codewords: translatedDeletes } : {}),
    tab_id: tabId,
    frame_id: frameId,
    conn_id: connId,
  };
  const r = await postToPlugin('/grammar/batch', fullRequest);
  if (!r || !r.ok) return transportFailure(request);
  try {
    const resp = await r.json() as GrammarBatchResponse;
    // Translate the response's codewords back to letter tokens so the content
    // script — which only knows letters — matches them against its wrappers.
    return {
      ...resp,
      succeeded: (resp.succeeded ?? []).map(spokenCodewordToToken),
      failed: (resp.failed ?? []).map(f => ({ ...f, codeword: spokenCodewordToToken(f.codeword) })),
    };
  } catch {
    return transportFailure(request);
  }
}

function transportFailure(
  request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'>,
): GrammarBatchResponse {
  return {
    result: 'error',
    succeeded: [],
    failed: request.elements.map(e => ({ codeword: e.codeword, reason: 'transport' })),
  };
}

// Tell the plugin this browser's connection just gained (or lost) OS focus.
// The plugin binds connId to the OS-focused bundle on a focused:true claim;
// identity comes from the OS, this only says "which connection is focused now."
// Best-effort: a dropped focus POST self-heals on the next focus transition.
async function postFocus(focused: boolean): Promise<void> {
  // Bail-on-miss (no discovery): focus claims only matter when already connected.
  await postToPlugin('/focus', { conn_id: connId, focused });
}

// Tell the plugin which tab is active in this browser's window. Distinct from
// postFocus: this carries no focus claim and never affects the plugin's
// connection→bundle binding — it only updates the focused-tab signal the
// per-source grammar projection (Option B) keys off. The plugin accepts it
// only from the connection it currently treats as the focused browser, so
// sending it from a background window is harmless. Best-effort.
async function postActiveTab(tabId: number | null): Promise<void> {
  if (tabId == null) return;
  // Bail-on-miss (no discovery): never affects the connection→bundle binding.
  await postToPlugin('/active-tab', { conn_id: connId, tab_id: tabId });
}

// Claim focus at SSE-connect time if a window of this browser is currently the
// OS-focused window. Covers cold start: the browser is already frontmost when
// its extension connects, so no onFocusChanged fires to trigger the handshake.
async function assertFocusIfFocused(): Promise<void> {
  try {
    const win = await chrome.windows.getLastFocused();
    if (win.focused && win.type === 'normal') {
      void postFocus(true);
      void postActiveTab(bgState.cachedActiveTabId);
    }
  } catch {
    // window query unavailable; onFocusChanged covers subsequent transitions
  }
}

// --- SSE Connection (browser-adaptive) ---

/** Connect to the plugin's SSE stream using the best available method. */
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

function connectSSE(): void {
  const port = getPluginPort();
  const token = getPluginToken();
  if (!port || !token) return;

  // The plugin's HTTP server is up once we have a port+token; contribute the
  // command vocabulary now so voice scroll/find/nav are live for this session.
  void contributeCommands();

  if (hasOffscreenAPI) {
    // Chrome: delegate to offscreen document
    ensureOffscreen().then(() => notifyOffscreenConnect());
  } else {
    // Firefox: open EventSource directly in background script
    connectDirectSSE(port, token);
  }
}

// --- Chrome: Offscreen Document ---

async function ensureOffscreen(): Promise<void> {
  if (!hasOffscreenAPI) return;
  try {
    const exists = await chrome.offscreen.hasDocument();
    if (!exists) {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: 'Maintain SSE connection to BranchKit actuator',
      });
    }
  } catch {
    // May fail if already creating
  }
}

// Tell offscreen doc to connect (or reconnect) with current plugin info
function notifyOffscreenConnect(): void {
  const port = getPluginPort();
  const token = getPluginToken();
  if (!port || !token) return;
  chrome.runtime.sendMessage({
    type: 'CONNECT_SSE',
    port,
    token,
    connId,
  }).catch(() => {});
}

// --- Firefox: Direct SSE in background script ---

function connectDirectSSE(port: number, token: string): void {
  // conn_id identifies this connection; the plugin binds it to the OS-focused
  // bundle via the focus handshake so dispatch/rescan target only the focused
  // browser and a spoken command doesn't also fire in a background browser.
  const url = `http://127.0.0.1:${port}/events?token=${token}&conn_id=${encodeURIComponent(connId)}`;

  // Already-connecting guard (DESIGN_SSE_RESILIENCE.md's deliberately-open
  // item, closed 2026-07-04). connectSSE() fires un-awaited from several
  // sites (retry ladder, init, postGrammarBatch's fresh-creds path); this
  // path used to close and reopen the EventSource unconditionally, so a
  // burst landing while the prior socket was still CONNECTING churned
  // connect/disconnect under one conn_id and could abort onSSEConnected's
  // heal (rescan + grammar republish) mid-flight. Chrome is immune — the
  // offscreen document serializes CONNECT_SSE. Keep the existing socket iff
  // it targets the same creds and isn't CLOSED; changed creds (host restart
  // minted a new port/token) still tear down and reconnect.
  if (directSSE && directSSEUrl === url && directSSE.readyState !== EventSource.CLOSED) {
    return;
  }
  if (directSSE) {
    directSSE.close();
    directSSE = null;
  }

  directSSEUrl = url;
  directSSE = new EventSource(url);

  directSSE.addEventListener('connected', () => {
    console.log('[BranchKit BG] SSE connected (direct)');
    // Same connect-edge work as Chrome's HEALTH_STATUS(true). Firefox
    // previously did a partial inline version (focus + hydrate only), which
    // meant no rescan, no host-restart grammar heal, and no backoff
    // bookkeeping on this engine.
    onSSEConnected();
  });

  directSSE.addEventListener('action', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      handleSSEEvent(data);
    } catch (err) {
      console.error('[BranchKit BG] SSE parse error:', err);
    }
  });

  directSSE.addEventListener('alphabet', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      if (Array.isArray(data?.words)) {
        storeAlphabet(data.words);
      }
    } catch (err) {
      console.error('[BranchKit BG] alphabet parse error:', err);
    }
  });

  directSSE.onerror = () => {
    console.warn('[BranchKit BG] SSE disconnected (direct)');
    if (directSSE) {
      directSSE.close();
      directSSE = null;
    }
    onSSEDisconnected();
  };
}

// --- SSE Event Handling (shared by both paths) ---

function handleSSEEvent(data: any): void {
  // Tab verbs are handled here, not forwarded to content: they act on
  // chrome.tabs regardless of what page is focused (content scripts can't
  // reach the API, and the active page may not even have one).
  const tabAction = TAB_ACTION_BY_ID[data.action];
  if (tabAction) {
    const n = parseInt(data.params?.index ?? '', 10);
    void handleTabAction(tabAction, Number.isFinite(n) ? n : undefined);
    return;
  }

  // "switch to <tab>" — like the tab verbs, handled here so it works
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
    const pv = paletteVoice;
    if (pv) {
      const dispatch = pv.rows.get(data.params?.row_id ?? '');
      void handlePaletteAction(dispatch ?? { kind: 'close' }, pv.tabId);
    }
    return;
  }
  if (data.action === 'palette_dismiss') {
    if (paletteVoice) void handlePaletteAction({ kind: 'close' }, paletteVoice.tabId);
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

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
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

  if (message.type === 'PALETTE_OPEN') {
    // A toggle_palette bind fired in a subframe; the overlay must live in the
    // top frame. Route it there as a PALETTE_COMMAND through the dispatcher.
    const tabId = _sender.tab?.id;
    if (typeof tabId === 'number') {
      chrome.tabs.sendMessage(tabId, { type: 'PALETTE_COMMAND', action: 'toggle_palette' }, { frameId: 0 })
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
    getTabMarkerLetters(tabId, _sender.tab?.title ?? undefined)
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
    sendResponse({ branchkit: bgState.branchkitConnected });
    return false;
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
    claimLabels(tabId, frameId, message.count, message.preferred)
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
    const frameId = _sender.frameId;
    if (typeof tabId !== 'number' || typeof frameId !== 'number') return false;
    releaseLabels(tabId, frameId, message.labels).catch(err => {
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
    confirmLabels(tabId, frameId, message.labels)
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

// Clear a tab's label pool when the tab is closed (the sole call site is
// `chrome.tabs.onRemoved`). NOT called on navigation, and deliberately so:
// cross-document nav reclaims per-frame via the liveness Port's onDisconnect,
// and same-document (SPA) nav keeps the content script alive — it releases its
// own codewords through limbo→finalize, so a purge here would race that local
// ownership and corrupt the grammar. See notes/DESIGN_EXTENSION_RESTRUCTURE.md
// §5 step 3 (dropped 2026-05-30).
function purgeTab(tabId: number): void {
  clearStack(tabId).catch(() => {});
  // Codeword memory is meant to survive frame teardown (the point of Regime B),
  // but not the tab's whole lifetime — drop it on tab close.
  clearCodewordMemory(tabId).catch(() => {});
}

// Per-frame liveness via long-lived Port. Each content-script context opens
// one Port at startup; when the context dies (iframe removed, navigation,
// tab closed, bfcache evict) Chrome closes the Port and onDisconnect fires
// here. Two cleanups run on disconnect: the per-tab label pool
// (`releaseFrame`) and the browser plugin's per-frame hint session
// (`forwardHintsSessionEnd`). Without either, dead frames' state leaks —
// label codewords until the next tab close, hint-session per-prefix
// contributions until the plugin's 30s TTL backstop fires.
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
  if (port.name !== LIVENESS_PORT_NAME) return;
  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId;
  if (typeof tabId !== 'number' || typeof frameId !== 'number') return;
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
    releaseFrame(tabId, frameId).catch(() => {});
    forwardHintsSessionEnd('frame_liveness_disconnect', tabId, frameId).catch(() => {});
  });
});

// End the hint session on `oldTabId` (if any) before activating a new tab.
// Hints follow focus at the matcher level: clear the plugin's hints tag so
// a subsequent voice dispatch can't be routed via the new tab's content
// script onto a stale or coincidentally-matching element. We deliberately
// do NOT dispatch hide_hints to the old tab — in always-mode hint badges
// are a persistent visual property of every browser tab, and hiding them
// on switch-away destroys the case where the user switches back (rescan
// doesn't re-show in always mode, so badges would stay hidden forever).
// The user can't see the inactive tab anyway, so leaving badges painted
// there is cosmetically free.
function endHintSessionOnOldTab(oldTabId: number | null, reason: string): void {
  if (oldTabId == null) return;
  forwardHintsSessionEnd(reason, oldTabId);
}

// Log a tab switch to actuator.log so post-hoc debugging shows what the
// user actually did, not just opaque tab IDs.
async function logTabSwitch(reason: string, oldTabId: number | null, newTabId: number | null): Promise<void> {
  const lookup = async (id: number | null): Promise<{ id: number | null; url: string; title: string }> => {
    if (id == null) return { id: null, url: '', title: '' };
    try {
      const t = await chrome.tabs.get(id);
      return { id, url: t.url ?? '', title: t.title ?? '' };
    } catch {
      return { id, url: '<gone>', title: '' };
    }
  };
  const [from, to] = await Promise.all([lookup(oldTabId), lookup(newTabId)]);
  forwardDebugLog('tab_switch', { reason, from, to });
}

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
    endHintSessionOnOldTab(oldTabId, 'tab_switch');
    // Always-mode: signal the new tab's content script that it became the
    // active tab. The session-start path resets per-tab plugin state.
    if (hintVisibility === 'always') {
      forwardHintsSessionStart('tab_switch', activeInfo.tabId);
      // The relay suppressed this tab's grammar while it was backgrounded;
      // force a clean republish so it repopulates the global vocabulary.
      republishActiveTab(activeInfo.tabId);
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
const SPA_RESCAN_DEBOUNCE_MS = 150;
const spaRescanTimers = new Map<number, ReturnType<typeof setTimeout>>();

function isHintableUrl(url: string): boolean {
  return /^https?:\/\//.test(url);
}

function onSameDocumentNav(details: { tabId: number; frameId: number; url: string }): void {
  // Top frame only — subframe history changes (ad/embed SPAs) shouldn't
  // trigger a whole-tab rescan.
  if (details.frameId !== 0) return;
  if (!isHintableUrl(details.url)) return;
  scheduleSpaRescan(details.tabId);
}

chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDocumentNav);
chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDocumentNav);

// Coalesce bursts of same-document URL changes (SPAs often fire several
// pushState/replaceState calls settling on one route) into a single
// bounded rescan per tab.
function scheduleSpaRescan(tabId: number): void {
  const existing = spaRescanTimers.get(tabId);
  if (existing) clearTimeout(existing);
  spaRescanTimers.set(tabId, setTimeout(() => {
    spaRescanTimers.delete(tabId);
    forwardDebugLog('pipeline.bg_rescan_dispatched', { tab_id: tabId, source: 'spa_nav' });
    chrome.tabs.sendMessage(tabId, {
      type: 'BRANCHKIT_ACTION',
      payload: { action: 'rescan', params: { from_cache: 'true', reason: 'spa_nav' } },
    } as Message).catch(() => {});
  }, SPA_RESCAN_DEBOUNCE_MS));
}

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  // All browser windows lost OS focus (user switched to another app). Tell the
  // plugin this connection is no longer focused so its grammar gate and
  // dispatch scoping stop treating this browser as frontmost.
  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    void postFocus(false);
    return;
  }
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
    if (oldTabId != null && oldTabId !== newActive) {
      logTabSwitch('window_focus', oldTabId, newActive);
      endHintSessionOnOldTab(oldTabId, 'window_focus');
      if (newActive != null && hintVisibility === 'always') {
        forwardHintsSessionStart('window_focus', newActive);
        republishActiveTab(newActive);
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
  const pendingSpaRescan = spaRescanTimers.get(tabId);
  if (pendingSpaRescan) {
    clearTimeout(pendingSpaRescan);
    spaRescanTimers.delete(tabId);
  }
  purgeTab(tabId);
  // Drop the closed tab's words from the voice collection.
  scheduleTabPublish();
  // Backstop: a palette whose host tab died can't send PALETTE_CLOSED.
  if (paletteVoice?.tabId === tabId) void clearPaletteVoice('tab_removed');
  // Return the closed tab's marker to the free pool.
  void releaseTabMarker(tabId);
});

// Dead-tab label-stack sweep (long-session audit finding 6). tabs.onRemoved
// and the liveness Port's onDisconnect both miss when this background is
// asleep at the moment a tab dies. Chrome heals on the next SW recycle
// (init → clearAllStacks), but the persistent Firefox background can run
// for days — missed reclaims accumulate until the pool exhausts, claims
// return empty, and badges silently stop painting ("restart fixes it").
// Level-triggered reclaim: every 15 min, purge tracked stacks whose tab no
// longer exists (mirrors purgeTab: stack + codeword memory). setInterval,
// not chrome.alarms, on purpose — the leak only matters while THIS
// background instance stays alive; a fresh instance heals in init.
const DEAD_TAB_SWEEP_MS = 15 * 60_000;
async function sweepDeadTabState(): Promise<void> {
  try {
    const swept = await sweepDeadStacks(async () => {
      const tabs = await chrome.tabs.query({});
      const alive = new Set<number>();
      for (const t of tabs) if (typeof t.id === 'number') alive.add(t.id);
      return alive;
    });
    for (const tabId of swept) clearCodewordMemory(tabId).catch(() => {});
    if (swept.length > 0) {
      console.info('[BranchKit] dead-tab sweep reclaimed label stacks for tabs:', swept.join(','));
    }
  } catch {
    // tabs API unavailable (shutdown) — next tick or next init covers it.
  }
}
setInterval(sweepDeadTabState, DEAD_TAB_SWEEP_MS);

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
  // Sets the setting input only — marks paint once BranchKit connects
  // (onSSEConnected → setTabMarkersConnected), since they're voice-gated.
  void setTabMarkersSetting(result.tabMarkersEnabled !== false);

  // Prime the active-tab cache so the first active_tab_id signal to the plugin
  // (and rescanActiveTab) has a value before the first tabs.onActivated /
  // onFocusChanged fires. No longer load-bearing for grammar correctness —
  // the plugin projects only the focused source, so a stale/null active tab
  // can't cause a clobber — but it keeps the focus signal accurate from boot.
  await resolveActiveContentTab();

  const found = await discoverPlugin();

  if (hasOffscreenAPI) {
    await ensureOffscreen();
  }

  if (found) {
    // branchkitConnected stays false until the stream's real `connected`
    // signal (onSSEConnected) — discovery success is not connection success.
    connectSSE();
  } else {
    // Host down at boot: arm the retry ladder now instead of waiting up to
    // 30s for the connection-check alarm. With no host at all (standalone
    // keyboard/hints use) this settles at one discovery fetch per 30s — the
    // same steady-state the alarm already produced.
    scheduleSSERetry();
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.hintVisibility) {
    hintVisibility = changes.hintVisibility.newValue || 'always';
  }
  // Tab-markers toggle flipped: decorate every tab, or strip every tab live.
  // Default ON — only an explicit false disables. (No-op unless connected.)
  if (changes.tabMarkersEnabled) {
    void setTabMarkersSetting(changes.tabMarkersEnabled.newValue !== false);
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
  if (bgState.branchkitConnected) return;
  if (!added.origins?.length) return;
  const found = await discoverPlugin();
  if (found) connectSSE();
});
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'connection-check') {
    if (hasOffscreenAPI) {
      await ensureOffscreen();
      if (bgState.branchkitConnected && !(await probeOffscreenSSE())) {
        onSSEDisconnected();
      }
    } else if (
      bgState.branchkitConnected &&
      (!directSSE || directSSE.readyState !== EventSource.OPEN)
    ) {
      onSSEDisconnected();
    }

    // Kick off retry loop if not connected and no retry is pending
    if (!bgState.branchkitConnected) {
      scheduleSSERetry();
    }
  }
});

// Ask the offscreen document whether its EventSource is actually OPEN.
// No response (offscreen gone, message dropped) counts as dead. A probe can
// catch a mid-reconnect stream in CONNECTING and trigger one redundant
// retry cycle; that self-corrects and connects are rare.
async function probeOffscreenSSE(): Promise<boolean> {
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'SSE_STATUS' });
    return resp?.connected === true;
  } catch {
    return false;
  }
}

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

/**
 * BranchKit Browser — Service worker (background script).
 *
 * Responsibilities:
 * - Discover browser plugin port/token via actuator
 * - Push grammar to plugin on scan results
 * - Route SSE events from offscreen doc (Chrome) or direct SSE (Firefox) to content scripts
 * - Manage offscreen document lifecycle (Chrome only)
 */

import { Message, ScannedElement, HintVisibility, DispatchResult, GrammarBatchRequest, GrammarBatchResponse } from './types';
import { claimLabels, releaseLabels, releaseFrame, clearStack, clearAllStacks, regenerateAllStacks, getFrameForLabel, alphabetsEqual } from './labels/label-pool';

const ACTUATOR_URL = 'http://127.0.0.1:21551';

// --- State ---

let pluginPort: number | null = null;
let pluginToken: string | null = null;
let branchkitConnected = false;
let cachedActiveTabId: number | null = null;
let hintVisibility: HintVisibility = 'always';

// Firefox direct SSE (no offscreen document needed)
let directSSE: EventSource | null = null;

// SSE reconnect backoff state. Shared by Chrome (offscreen→HEALTH_STATUS)
// and Firefox (direct EventSource) paths.
let sseRetryTimer: ReturnType<typeof setTimeout> | null = null;
let sseRetryDelay = 1000;
const SSE_RETRY_CAP_MS = 30_000;

function cancelSSERetry(): void {
  if (sseRetryTimer) {
    clearTimeout(sseRetryTimer);
    sseRetryTimer = null;
  }
  sseRetryDelay = 1000;
}

function scheduleSSERetry(): void {
  if (sseRetryTimer) return;
  const delay = sseRetryDelay;
  sseRetryDelay = Math.min(sseRetryDelay * 2, SSE_RETRY_CAP_MS);
  sseRetryTimer = setTimeout(async () => {
    sseRetryTimer = null;
    const found = await discoverPlugin();
    if (found) {
      branchkitConnected = true;
      cancelSSERetry();
      connectSSE();
      rescanActiveTab();
    } else {
      scheduleSSERetry();
    }
  }, delay);
}

function rescanActiveTab(): void {
  if (cachedActiveTabId == null) return;
  forwardDebugLog('pipeline.bg_rescan_dispatched', { tab_id: cachedActiveTabId, source: 'rescanActiveTab' });
  chrome.tabs.sendMessage(cachedActiveTabId, {
    type: 'BRANCHKIT_ACTION',
    payload: { action: 'rescan' },
  }).catch(() => {});
}

// --- Feature Detection ---

const hasOffscreenAPI = typeof chrome !== 'undefined' && !!chrome.offscreen;

// --- Browser Bundle ID Detection ---

function detectBundleID(): string {
  const ua = navigator.userAgent;
  if (ua.includes('Chrome') && !ua.includes('Edg')) return 'com.google.Chrome';
  if (ua.includes('Edg')) return 'com.microsoft.edgemac';
  if (ua.includes('Safari') && !ua.includes('Chrome')) return 'com.apple.Safari';
  if (ua.includes('Firefox')) return 'org.mozilla.firefox';
  if (ua.includes('Arc')) return 'company.thebrowser.Browser';
  return '';
}

const browserBundleID = detectBundleID();

// --- Alphabet ---

// Persist the BranchKit voice alphabet so content scripts on every page see
// the same codewords voice will recognize. content.ts reads this on load
// and subscribes to chrome.storage.onChanged for live updates.
//
// Short-circuits when the incoming alphabet matches the one already in
// storage. Voice re-pushes the alphabet on a hot path (688 pushes in a
// single observed session, almost all identical content); running the
// full chain on each one wipes the per-tab label pools and creates a
// race window where existing wrappers retain codewords locally that
// the pool now considers free, producing duplicate badge assignments.
// `chrome.storage.local.set` of an unchanged value suppresses the
// `chrome.storage.onChanged` event, so content scripts never get the
// signal to clear their wrappers — but `regenerateAllStacks` runs
// anyway. Detecting the no-op here is the load-bearing check.
async function storeAlphabet(words: string[]): Promise<void> {
  if (!Array.isArray(words) || words.length !== 26) return;
  if (words.some(w => typeof w !== 'string' || w.length === 0)) return;

  try {
    const current = await chrome.storage.local.get('alphabet');
    // LOAD-BEARING: drop the no-op alphabet push before it touches the pool.
    // Relies on a Chrome behavior: `chrome.storage.local.set` of an unchanged
    // value suppresses `storage.onChanged`. If a future Chrome ever fires
    // onChanged for equal-value sets, this dedup becomes a slight optimization
    // rather than a correctness gate — but the pool-wipe race it prevents is
    // still real. Do NOT remove this dedup without also fixing the pool to
    // tolerate wipes-with-surviving-wrappers.
    if (Array.isArray(current.alphabet) && alphabetsEqual(current.alphabet, words)) {
      return;
    }
    await chrome.storage.local.set({ alphabet: words });
    await regenerateAllStacks();
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
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
  }
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/reference/save`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify({ host, name, reference }),
    });
  } catch {
    // Plugin may be down
  }
}

async function pushReferenceNames(): Promise<void> {
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
  }
  const names = await loadAllReferenceNames();
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/references`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify({ names }),
    });
  } catch {
    // Plugin may be down
  }
}

async function hydrateReferencesFromCollection(): Promise<void> {
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
  }
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab?.url) return;
    const host = new URL(tab.url).hostname;
    if (!host) return;

    const resp = await fetch(
      `http://127.0.0.1:${pluginPort}/references?host=${encodeURIComponent(host)}&token=${pluginToken}`,
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

// --- Plugin Discovery ---

async function discoverPlugin(): Promise<boolean> {
  try {
    const resp = await fetch(`${ACTUATOR_URL}/v1/plugins/browser/status`);
    if (!resp.ok) return false;
    const data = await resp.json();
    if (!data.enabled || !data.listen) return false;
    pluginPort = data.listen.port;
    pluginToken = data.listen.token;
    return true;
  } catch {
    return false;
  }
}

// Forward a content-script dispatch outcome to the plugin's POST
// /dispatch-result. Best-effort; the plugin can survive missing reports.
async function forwardDispatchResult(result: DispatchResult): Promise<void> {
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
  }
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/dispatch-result`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify(result),
    });
  } catch {
    // Plugin may be down; observability isn't worth retrying.
  }
}

async function forwardDebugLog(tag: string, data: unknown): Promise<void> {
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
  }
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/debug-log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify({ tag, data }),
    });
  } catch {
    // Plugin may be down; diagnostic-only, no retry.
  }
}

// Sibling of forwardDebugLog. Pumps the content script's perf snapshot
// to the plugin's /perf-report endpoint, which appends to a JSONL trail
// for offline analysis. See plugins/browser/src/perf_report.go and
// src/content.ts (search PERF_REPORT). Diagnostic-only, no retry.
async function forwardPerfReport(payload: { url: string; tab_id: number; browser: string; snapshot: unknown }): Promise<void> {
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
  }
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/perf-report`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Plugin may be down; diagnostic-only, no retry.
  }
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
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
  }
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/plugin-debug-log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify({ tag, data, level }),
    });
  } catch {
    // Plugin may be down; diagnostic-only, no retry.
  }
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
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) {
      console.warn('[branchkit] debug snapshot: plugin not discovered');
      return;
    }
  }
  const snapshotId =
    typeof payload === 'object' && payload !== null && 'snapshot_id' in payload
      ? String((payload as { snapshot_id: unknown }).snapshot_id)
      : '';
  if (!snapshotId) {
    console.warn('[branchkit] debug snapshot: missing snapshot_id');
    return;
  }

  // Step 1: structured-state POST.
  try {
    const res = await fetch(`http://127.0.0.1:${pluginPort}/debug-snapshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      console.warn(`[branchkit] debug-snapshot POST failed: HTTP ${res.status}`);
      return;
    }
  } catch (e) {
    console.warn(`[branchkit] debug-snapshot POST exception: ${e}`);
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
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/debug-snapshot/screenshot`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.warn(`[branchkit] debug-snapshot screenshot POST exception: ${e}`);
  }
}

// Tell the plugin to end a hint session. Two scopes:
//   - tab-wide: omit `frameId`. Plugin Deletes every frame's tracked
//     codewords for this tab and clears the hints tag. Used on tab
//     switch / tab close / navigation — the user can't be addressing
//     a stale tab's hints anymore.
//   - frame-scoped: pass `frameId`. Plugin Deletes only that frame's
//     codewords; hints tag stays held if other frames in the tab are
//     still live. Used by future frame-removal detection (the label-
//     pool's releaseFrame mention).
//
// Both scopes are part of the Option B C7 cleanup story
// (notes/DESIGN_HINT_PIPELINE_RESYNC.md). The tab-wide call replaces
// the implicit "stop pushing" cleanup the old whole-grammar path did
// via diffPrefixesToDelete.
async function forwardHintsSessionEnd(reason: string, tabId: number, frameId?: number): Promise<void> {
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
  }
  const body: { reason: string; tab_id: number; frame_id?: number } = { reason, tab_id: tabId };
  if (typeof frameId === 'number') body.frame_id = frameId;
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/hints/session_end`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify(body),
    });
  } catch {
    // Plugin may be down; the hints tag will eventually clear via other paths.
  }
}

// Tell the plugin to pre-arm the hints tag for an imminent hints-eligible
// session on `tabId`. Triggered on tab activation in always-mode: the plugin
// fires its eager-arm bridge (same one used for browser app focus) so the
// codeword-vs-alphabet disambiguator is in place before the new tab's
// grammar push arrives. If grammar doesn't arrive within the eager-arm
// timeout (2s), the plugin auto-clears.
async function forwardHintsSessionStart(reason: string, tabId: number): Promise<void> {
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
  }
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/hints/session_start`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify({ reason, tab_id: tabId }),
    });
  } catch {
    // Plugin may be down; grammar push will eventually set the tag if/when
    // it arrives. We just lose the eager-arm bridge for this one switch.
  }
}

// Tell the newly-active tab to republish its grammar. Because the relay drops
// grammar batches from non-active tabs, a tab that was backgrounded while
// scanning never populated the (global) hint collections. On activation it
// must re-push from scratch so the active tab is the sole, complete contributor
// to the global vocabulary. The content script's `reactivate` handler flips its
// local active flag back on and re-queues its whole wrapper store.
function republishActiveTab(tabId: number): void {
  chrome.tabs.sendMessage(tabId, {
    type: 'BRANCHKIT_ACTION',
    payload: { action: 'reactivate', params: { reason: 'tab_activated' } },
  } as Message).catch(() => {});
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
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return transportFailure(request);
    branchkitConnected = true;
    connectSSE();
  }

  const fullRequest: GrammarBatchRequest = { ...request, tab_id: tabId, frame_id: frameId };
  try {
    const r = await fetch(`http://127.0.0.1:${pluginPort}/grammar/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify(fullRequest),
    });
    if (!r.ok) return transportFailure(request);
    return await r.json() as GrammarBatchResponse;
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

// The sender tab isn't the active tab, so its push was suppressed before
// reaching the plugin. Distinct from `error` (a real failure): the content
// script keeps its wrappers and pauses syncing rather than releasing labels.
function inactiveResponse(
  request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'>,
): GrammarBatchResponse {
  return {
    result: 'inactive',
    succeeded: [],
    failed: request.elements.map(e => ({ codeword: e.codeword, reason: 'inactive' })),
  };
}

// --- SSE Connection (browser-adaptive) ---

/** Connect to the plugin's SSE stream using the best available method. */
function connectSSE(): void {
  if (!pluginPort || !pluginToken) return;

  if (hasOffscreenAPI) {
    // Chrome: delegate to offscreen document
    ensureOffscreen().then(() => notifyOffscreenConnect());
  } else {
    // Firefox: open EventSource directly in background script
    connectDirectSSE(pluginPort, pluginToken);
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
  if (!pluginPort || !pluginToken) return;
  chrome.runtime.sendMessage({
    type: 'CONNECT_SSE',
    port: pluginPort,
    token: pluginToken,
  }).catch(() => {});
}

// --- Firefox: Direct SSE in background script ---

function connectDirectSSE(port: number, token: string): void {
  if (directSSE) {
    directSSE.close();
    directSSE = null;
  }

  const url = `http://127.0.0.1:${port}/events?token=${token}`;
  directSSE = new EventSource(url);

  directSSE.addEventListener('connected', () => {
    console.log('[BranchKit BG] SSE connected (direct)');
    branchkitConnected = true;
    hydrateReferencesFromCollection().then(() => pushReferenceNames());
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
    branchkitConnected = false;
    scheduleSSERetry();
  };
}

// --- SSE Event Handling (shared by both paths) ---

function handleSSEEvent(data: any): void {
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

// --- Message Routing ---

async function broadcastToAllTabs(message: Message): Promise<void> {
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
async function resolveActiveContentTab(): Promise<number | null> {
  // Cached value, set by tabs.onActivated, is usually correct.
  if (cachedActiveTabId !== null) return cachedActiveTabId;

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
      cachedActiveTabId = tab.id;
      return tab.id;
    }
  } catch {
    // ignore — fall through
  }
  return null;
}

function isInjectableURL(url: string): boolean {
  return !!url
    && !url.startsWith('chrome://')
    && !url.startsWith('chrome-extension://')
    && !url.startsWith('moz-extension://')
    && !url.startsWith('edge://')
    && !url.startsWith('about:')
    && !url.startsWith('devtools://')
    && !url.startsWith('view-source:');
}

async function notifyActiveTab(message: Message): Promise<void> {
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
      const injected = await injectContentScriptFiles(tid);
      if (!injected) {
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
 * Inject bootstrap + content script into `tabId`. Used as a recovery
 * path when `chrome.tabs.sendMessage` fails with "Receiving end does
 * not exist" — typically a pre-existing tab from before sideload, OR
 * a Firefox temporary add-on where `onInstalled` didn't reach this
 * tab.
 *
 * Does NOT clear `__branchkitContentInjected` (unlike the install-time
 * `reinjectContentScripts` path which does, to flush orphans). Lazy
 * injection assumes "if a content script is alive in this tab, leave
 * it alone." If the script is already loaded, content.ts's top-level
 * guard throws "duplicate injection" — we catch that quietly (it's not
 * an error in this context, just the guard doing its job).
 *
 * Returns true on success; false if the tab URL is restricted
 * (about:, chrome://, etc.) or injection failed for another reason.
 */
async function injectContentScriptFiles(tabId: number): Promise<boolean> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return false;
  }
  // Firefox aggressively discards inactive tabs; executeScript can't
  // reach a discarded tab and Firefox reports the failure as a generic
  // "An unexpected error occurred". The next tabs.onActivated for this
  // tab will retry after Firefox restores it.
  if (tab.discarded) return false;
  const url = tab.url ?? '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')
      || url.startsWith('moz-extension://') || url.startsWith('edge://')
      || url.startsWith('about:') || url.startsWith('devtools://')
      || url.startsWith('view-source:')) {
    return false;
  }
  // Try allFrames first (covers same-origin iframes, what we want for
  // most sites). If it fails, fall back to top-frame-only — on Firefox
  // a single failing frame (CSP-locked cross-origin iframe, sandboxed
  // ad slot) rejects the entire call atomically, leaving even the main
  // frame uninjected. YouTube and Netflix are the canonical offenders.
  return await tryInject(tabId, url, { allFrames: true })
      || await tryInject(tabId, url, { frameIds: [0] });
}

async function tryInject(
  tabId: number,
  url: string,
  target: { allFrames?: boolean; frameIds?: number[] },
): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, ...target },
      files: ['bootstrap.js'],
      world: 'MAIN',
    });
    await chrome.scripting.executeScript({
      target: { tabId, ...target },
      files: ['content.js'],
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // content.ts throws "duplicate injection" if its guard is set —
    // that's the expected path when proactive injection hits a tab
    // that's already been injected. Not an error.
    if (msg.includes('duplicate injection')) return true;
    const scope = target.allFrames ? 'allFrames' : `frames=${target.frameIds?.join(',')}`;
    console.warn(`[BranchKit SW] inject failed for tab ${tabId} (${url}, ${scope}):`, msg);
    return false;
  }
}

/**
 * Ping the content script in `tabId` to see if it's listening. Returns
 * true if a response came back; false if no content script is loaded
 * (or the tab URL forbids messaging).
 *
 * Uses GET_FOCUS_STATUS as the ping because content.ts already handles
 * it synchronously — no extra message type needed.
 */
async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'GET_FOCUS_STATUS' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Proactive lazy-injection: if the tab doesn't have BranchKit's content
 * script yet (typically a pre-existing tab from before sideload), inject
 * it now so badges paint without the user needing to F5. No-op if the
 * script is already alive.
 */
async function ensureContentScriptInjected(tabId: number): Promise<void> {
  if (await pingContentScript(tabId)) return;
  await injectContentScriptFiles(tabId);
}

/**
 * If the message is a hint activation that names a codeword, look up which
 * frame owns that codeword in the tab's label pool and return its frameId.
 * Returns null for actions that don't carry a codeword (show_hints, rescan,
 * etc.) — caller falls back to top-frame delivery.
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
    // Active-tab scoping: the per-prefix hint collections are a global
    // namespace, so only the active tab may push grammar — a background tab's
    // REPLACE would clobber the focused tab's vocabulary (and LastTabID would
    // route clicks to the wrong tab). Reject batches from non-active tabs with
    // `inactive`; the content script then suppresses its push and flushes on
    // reactivation. Fail open when we don't yet know the active tab (SW just
    // started) so the first scan isn't silently dropped.
    if (cachedActiveTabId != null && tabId !== cachedActiveTabId) {
      sendResponse(inactiveResponse(message.request));
      return false;
    }
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

  if (message.type === 'HEALTH_STATUS') {
    const wasConnected = branchkitConnected;
    branchkitConnected = message.branchkit ?? false;

    // New connection — cancel any pending retry, hydrate, rescan
    if (!wasConnected && branchkitConnected) {
      cancelSSERetry();
      hydrateReferencesFromCollection().then(() => pushReferenceNames());
      rescanActiveTab();
    }

    // SSE dropped — retry with exponential backoff until plugin is back
    if (wasConnected && !branchkitConnected) {
      scheduleSSERetry();
    }
    return false;
  }

  if (message.type === 'GET_HEALTH') {
    sendResponse({ branchkit: branchkitConnected });
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
    claimLabels(tabId, frameId, message.count)
      .then(labels => sendResponse({ labels }))
      .catch(err => {
        console.warn('[BranchKit SW] CLAIM_LABELS error:', err);
        sendResponse({ labels: [] });
      });
    return true;
  }

  if (message.type === 'RELEASE_LABELS') {
    const tabId = _sender.tab?.id;
    if (typeof tabId !== 'number') return false;
    releaseLabels(tabId, message.labels).catch(err => {
      console.warn('[BranchKit SW] RELEASE_LABELS error:', err);
    });
    return false;
  }

  if (message.type === 'RESOLVE_HINT_FROM_TAB') {
    resolveHintFromTab(message.tabId, message.codeword)
      .then(sendResponse)
      .catch(err => sendResponse({ ok: false, reason: String(err?.message ?? err) }));
    return true;  // async response
  }

  return false;
});

// Look up which frame in `tabId` owns `codeword` and ask it to resolve.
// Returns ResolveHintResponse. Used by the options page to derive a stable
// selector from a visible-hint codeword without the user having to write
// CSS by hand.
async function resolveHintFromTab(tabId: number, codeword: string) {
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

// Clear a tab's label pool when the tab is closed (the sole call site is
// `chrome.tabs.onRemoved`). NOT called on navigation, and deliberately so:
// cross-document nav reclaims per-frame via the liveness Port's onDisconnect,
// and same-document (SPA) nav keeps the content script alive — it releases its
// own codewords through limbo→finalize, so a purge here would race that local
// ownership and corrupt the grammar. See notes/DESIGN_EXTENSION_RESTRUCTURE.md
// §5 step 3 (dropped 2026-05-30).
function purgeTab(tabId: number): void {
  clearStack(tabId).catch(() => {});
}

// Per-frame liveness via long-lived Port. Each content-script context opens
// one Port at startup; when the context dies (iframe removed, navigation,
// tab closed) Chrome closes the Port and onDisconnect fires here. Without
// this, dead frames' codewords leak from the per-tab label pool until tab
// close. See docs/completed/DESIGN_BROWSER_FRAME_POOL_EXHAUSTION.md.
//
// The Port carries no messages — its lifetime IS the signal. Service worker
// idle-termination is a known small leak window (frames that die while the
// SW is asleep don't get cleaned), accepted for v1.
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
  const oldTabId = cachedActiveTabId;
  cachedActiveTabId = activeInfo.tabId;
  if (oldTabId !== activeInfo.tabId) {
    logTabSwitch('tab_activated', oldTabId, activeInfo.tabId);
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
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    // Only follow focus into normal browser windows. Devtools / popups
    // / extension panels would otherwise blank cachedActiveTabId (they
    // either have no tabs or their "tab" is an about:* URL), breaking
    // voice routing while devtools is open. Skip the update; the last
    // known content tab stays cached.
    const win = await chrome.windows.get(windowId);
    if (win.type !== 'normal') return;

    const tabs = await chrome.tabs.query({ active: true, windowId });
    const newActive = tabs[0]?.id ?? null;
    const oldTabId = cachedActiveTabId;
    cachedActiveTabId = newActive;
    if (oldTabId != null && oldTabId !== newActive) {
      logTabSwitch('window_focus', oldTabId, newActive);
      endHintSessionOnOldTab(oldTabId, 'window_focus');
      if (newActive != null && hintVisibility === 'always') {
        forwardHintsSessionStart('window_focus', newActive);
        republishActiveTab(newActive);
      }
    }
  } catch {
    // Don't blank cachedActiveTabId on error — fall back to the last
    // known content tab so voice routing keeps working through transient
    // window state.
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const wasActive = cachedActiveTabId === tabId;
  if (wasActive) {
    cachedActiveTabId = null;
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
});

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

  const result = await chrome.storage.sync.get('hintVisibility');
  if (result.hintVisibility) {
    hintVisibility = result.hintVisibility;
  }

  const found = await discoverPlugin();
  branchkitConnected = found;

  if (hasOffscreenAPI) {
    await ensureOffscreen();
  }

  if (found) {
    connectSSE();
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.hintVisibility) {
    hintVisibility = changes.hintVisibility.newValue || 'always';
  }
});

chrome.runtime.onInstalled.addListener((details) => {
  init();
  // Re-inject content scripts into already-open tabs on install/update so
  // the user doesn't need to F5 every tab after reloading the extension.
  // Canonical Chrome MV3 pattern — see
  // https://www.codestudy.net/blog/chrome-extension-content-script-re-injection-after-upgrade-or-install/
  //
  // Orphan content scripts from the previous extension generation are still
  // in those frames' isolated worlds; we explicitly clear their idempotency
  // flag before file injection so the fresh content.js runs to completion.
  // Pairs with the guard at the top of content.ts.
  //
  // Step A of the orphan-CS plan (port.onDisconnect self-quiesce) is still
  // pending; until that lands, the orphan's bound observers/listeners keep
  // firing — most calls into chrome.runtime fail silently (invalidated
  // context) so the visible damage is limited to wasted CPU.
  if (details.reason === 'install' || details.reason === 'update') {
    void reinjectContentScripts();
  }
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
  for (const tab of tabs) {
    if (typeof tab.id !== 'number') continue;
    // Firefox aggressively discards inactive tabs to save memory;
    // executeScript can't reach a discarded tab. Skip — the lazy-inject
    // on tabs.onActivated handles them when the user clicks back in
    // (Firefox restores the tab from disk first).
    if (tab.discarded) continue;
    const tabId = tab.id;
    const url = tab.url ?? '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')
        || url.startsWith('moz-extension://') || url.startsWith('edge://')
        || url.startsWith('about:') || url.startsWith('devtools://')
        || url.startsWith('view-source:')) {
      continue;
    }
    // Best-effort orphan-guard flush across all frames. On Firefox this
    // routinely fails atomically on sites with CSP-locked iframes
    // (YouTube ads, Netflix DRM frame, Cloudflare challenges) — that's
    // fine, the lazy-inject path on tab activation handles those tabs
    // without trying to clear orphans (which a fresh tab doesn't have
    // anyway).
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        func: () => {
          delete (window as unknown as { __branchkitContentInjected?: boolean }).__branchkitContentInjected;
        },
      });
    } catch {
      // swallow — flush failure means orphans persist in some frames,
      // not the end of the world.
    }
    // Inject via the same fallback path lazy-inject uses, so YouTube /
    // Netflix / Cloudflare-challenged tabs get the top frame even when
    // allFrames refuses.
    await injectContentScriptFiles(tabId);
  }
}

// Safety net: check connection every 30s
chrome.alarms.create('connection-check', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'connection-check') {
    if (hasOffscreenAPI) {
      await ensureOffscreen();
    }

    // Kick off retry loop if not connected and no retry is pending
    if (!branchkitConnected) {
      scheduleSSERetry();
    }
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

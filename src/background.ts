/**
 * BranchKit Browser — Service worker (background script).
 *
 * Responsibilities:
 * - Discover browser plugin port/token via actuator
 * - Push grammar to plugin on scan results
 * - Route SSE events from offscreen doc (Chrome) or direct SSE (Firefox) to content scripts
 * - Manage offscreen document lifecycle (Chrome only)
 */

import { Message, ScannedElement, GrammarRequest, FieldInfo, ClickableInfo, TableLink, HintVisibility, DispatchResult, GrammarBatchRequest, GrammarBatchResponse } from './types';
import { claimLabels, releaseLabels, releaseFrame, clearStack, clearAllStacks, regenerateAllStacks, getFrameForLabel, alphabetsEqual } from './label-pool';

const ACTUATOR_URL = 'http://127.0.0.1:21551';

// --- State ---

let pluginPort: number | null = null;
let pluginToken: string | null = null;
let branchkitConnected = false;
let cachedActiveTabId: number | null = null;
let hintVisibility: HintVisibility = 'always';

// Per-tab grammar aggregation. Each frame's SCAN_RESULT lands here keyed
// by (tabId, frameId); on every update we rebuild the aggregate and push
// it to the voice plugin. Without this, the voice plugin only sees
// whichever frame pushed last — multi-frame grammar gets overwritten.
// See notes/DESIGN_BROWSER_GRAMMAR_PROTOCOL.md section 4.
const tabGrammars = new Map<number, Map<number, ScannedElement[]>>();

// Last-seen timestamp per tab, used for LRU eviction when the persisted
// cache hits the storage budget (F1, notes/DESIGN_HINT_PIPELINE_RESYNC.md).
// Stamped on every frame's SCAN_RESULT arrival + on tab activation so the
// freshest interaction wins. Restored from storage on SW startup so an
// LRU order survives across SW restarts.
const tabLastSeen = new Map<number, number>();
function markTabSeen(tabId: number): void {
  tabLastSeen.set(tabId, Date.now());
}

// Debounced push timers per tab. Mutation-heavy pages (Slack, Linear) can
// fire 10+ SCAN_RESULTs/sec across frames; without a coalescing window
// we'd hammer the voice plugin's /grammar endpoint. 120ms is short enough
// to feel snappy on first-render and long enough to absorb a mutation
// burst from a single user action (typing into a search field, etc.).
const aggregateTimers = new Map<number, ReturnType<typeof setTimeout>>();
const AGGREGATE_DEBOUNCE_MS = 120;

function schedulePushForTab(tabId: number): void {
  const existing = aggregateTimers.get(tabId);
  if (existing) clearTimeout(existing);
  // F3 — single-frame pages (the majority) have nothing to aggregate, so
  // skip the 120ms window and let the timer fire on the next macrotask.
  // Multi-frame pages keep the debounce so frame-N's SCAN_RESULT, arriving
  // a few ms after frame-(N-1)'s, still collapses into one POST per burst.
  const debounce = tabGrammars.get(tabId)?.size === 1 ? 0 : AGGREGATE_DEBOUNCE_MS;
  const timer = setTimeout(() => {
    aggregateTimers.delete(tabId);
    // Only the active tab's grammar is live in the plugin. Background tabs
    // accumulate scans into tabGrammars locally (so they're ready when the
    // user activates them) but don't POST. The active-tab guard runs at
    // timer fire — not at schedule time — so a tab activated during the
    // 120ms debounce window still gets its push.
    if (tabId !== cachedActiveTabId) return;
    pushGrammar(tabId, aggregateGrammarForTab(tabId));
  }, debounce);
  aggregateTimers.set(tabId, timer);
}

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
  tabGrammars.delete(cachedActiveTabId);
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
    // Drop every tab's cached grammar — entries reference codewords
    // from the prior alphabet. Frames will re-trigger doScan via the
    // alphabet onChanged listener and repopulate the map cleanly.
    tabGrammars.clear();
    tabLastSeen.clear();
    for (const timer of aggregateTimers.values()) clearTimeout(timer);
    aggregateTimers.clear();
    schedulePersist();
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

// --- Grammar Push ---

function scannedToGrammarRequest(elements: ScannedElement[]): GrammarRequest {
  const fields: FieldInfo[] = [];
  const clickables: ClickableInfo[] = [];
  const tables: TableLink[] = [];

  for (const el of elements) {
    const frameId = el.frame_id ?? 0;
    switch (el.category) {
      case 'input':
        fields.push({
          label: el.label,
          type: el.type,
          id: el.id,
          frame_id: frameId,
          position: fields.length,
          codeword: el.codeword,
        });
        break;
      case 'tables':
        tables.push({
          label: el.label,
          id: el.id,
          frame_id: frameId,
          href: '',
          table_id: '',
          codeword: el.codeword,
        });
        break;
      default:
        clickables.push({
          label: el.label,
          id: el.id,
          frame_id: frameId,
          type: el.type,
          codeword: el.codeword,
        });
        break;
    }
  }

  return {
    fields,
    clickables,
    tables,
    app_id: '',
    table_id: '',
    bundle_id: browserBundleID,
    hint_visibility: hintVisibility,
  };
}

/** Record a frame's latest grammar; replaces any prior entry for that frame. */
function recordFrameGrammar(tabId: number, frameId: number, elements: ScannedElement[]): void {
  let perTab = tabGrammars.get(tabId);
  if (!perTab) {
    perTab = new Map();
    tabGrammars.set(tabId, perTab);
  }
  perTab.set(frameId, elements);
  // F1: any tab with grammar gets cached, not just the active one, so a
  // later switch into a previously-visited tab skips the cold scan. Mark
  // it freshly seen for LRU ordering on the persist write.
  markTabSeen(tabId);
  schedulePersist();
}

/** Concat every frame's grammar for a tab. Insertion order = frame arrival. */
function aggregateGrammarForTab(tabId: number): ScannedElement[] {
  const perTab = tabGrammars.get(tabId);
  if (!perTab) return [];
  const out: ScannedElement[] = [];
  for (const els of perTab.values()) {
    out.push(...els);
  }
  return out;
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
  // Snapshots can be triggered at any time — including before SCAN_RESULT
  // has run discovery. Mirror forwardCommandsInvalidate's pattern and
  // auto-discover before bailing.
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

// Tell the plugin to wipe its commands.push memory so the next grammar
// arrival does a full re-registration. Best-effort; the plugin's
// invalidate endpoint is idempotent.
async function forwardCommandsInvalidate(reason: string): Promise<void> {
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
  }
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/commands/invalidate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify({ reason, tab_id: cachedActiveTabId ?? 0 }),
    });
  } catch {
    // Plugin may be down; the next grammar push will reconcile.
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

async function pushGrammar(tabId: number | null, elements: ScannedElement[]): Promise<void> {
  // Lazy discovery: service worker may have restarted and lost state
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
    branchkitConnected = true;
    connectSSE();
  }

  const req = scannedToGrammarRequest(elements);
  if (tabId != null) req.tab_id = tabId;

  forwardDebugLog('pipeline.bg_grammar_post_starting', { tab_id: tabId, elements: elements.length, hint_visibility: req.hint_visibility });
  try {
    await fetch(`http://127.0.0.1:${pluginPort}/grammar`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${pluginToken}`,
      },
      body: JSON.stringify(req),
    });
  } catch {
    // Plugin may be down
  }
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

async function notifyActiveTab(message: Message): Promise<void> {
  try {
    let tabId = cachedActiveTabId;
    if (tabId === null) {
      const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      tabId = tabs[0]?.id ?? null;
      if (tabId !== null) cachedActiveTabId = tabId;
    }
    if (tabId === null) {
      console.warn('[BranchKit SW] no active tab found');
      return;
    }

    const frameId = await routeFrameForAction(tabId, message);

    const send = frameId !== null
      ? chrome.tabs.sendMessage(tabId, message, { frameId })
      : chrome.tabs.sendMessage(tabId, message);
    send.catch((e: Error) => {
      console.warn('[BranchKit SW] sendMessage failed:', e.message);
    });
  } catch (e) {
    console.warn('[BranchKit SW] notifyActiveTab error:', e);
  }
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
  if (message.type === 'SCAN_RESULT') {
    // Content script scanned the DOM. Record this frame's grammar, then
    // push the tab-wide aggregate so multi-frame pages don't overwrite
    // each other's elements at the voice plugin.
    const tabId = _sender.tab?.id;
    const frameId = _sender.frameId;
    if (typeof tabId === 'number' && typeof frameId === 'number') {
      // Stamp frame_id onto each element. Content scripts don't know
      // their own frameId — only the SW does — but the plugin needs it
      // to scope ids to the right frame on dispatch. See §8 of
      // docs/completed/DESIGN_ELEMENT_IDENTITY_REGISTRY.md.
      for (const el of message.elements) {
        el.frame_id = frameId;
      }
      recordFrameGrammar(tabId, frameId, message.elements);
      forwardDebugLog('pipeline.bg_scan_result_received', { tab_id: tabId, frame_id: frameId, elements: message.elements.length });
      schedulePushForTab(tabId);
    }
    return false;
  }

  if (message.type === 'GRAMMAR_BATCH') {
    // Content's batched doScan (Option B) sent a grammar batch. Stamp
    // tab_id + frame_id and POST. Returning true keeps sendResponse
    // alive across the await — Chrome closes the channel otherwise.
    const tabId = _sender.tab?.id;
    const frameId = _sender.frameId;
    if (typeof tabId !== 'number' || typeof frameId !== 'number') {
      sendResponse(transportFailure(message.request));
      return false;
    }
    // Stamp frame_id onto every element so the plugin's per-element
    // payload carries the same frame the SW knows. Same rationale as
    // SCAN_RESULT above.
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

  if (message.type === 'PLUGIN_DEBUG_LOG' && typeof message.tag === 'string') {
    const level = typeof message.level === 'string' ? message.level : 'debug';
    forwardPluginDebugLog(message.tag, message.data, level);
    return false;
  }

  if (message.type === 'DEBUG_SNAPSHOT' && message.payload) {
    handleDebugSnapshot(message.payload, _sender);
    return false;
  }

  if (message.type === 'INVALIDATE_COMMANDS' && typeof message.reason === 'string') {
    forwardCommandsInvalidate(message.reason);
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

// Clear a tab's label pool + per-frame grammar + pending push timer when
// the tab is closed or starts navigating. Content scripts reload with no
// memory of prior state.
function purgeTab(tabId: number): void {
  clearStack(tabId).catch(() => {});
  tabGrammars.delete(tabId);
  tabLastSeen.delete(tabId);
  const timer = aggregateTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    aggregateTimers.delete(tabId);
  }
  // F1: drop from persisted cache too. Without this, a tab id we burned
  // through could linger in storage forever (chrome.tabs ids never
  // reused, but the entry still wastes budget).
  schedulePersist();
}

// Per-frame liveness via long-lived Port. Each content-script context opens
// one Port at startup; when the context dies (iframe removed, navigation,
// tab closed) Chrome closes the Port and onDisconnect fires here. Without
// this, dead frames' codewords leak from the per-tab label pool until tab
// close, and their stale ScannedElement entries leak from tabGrammars until
// the next purgeTab. See docs/completed/DESIGN_BROWSER_FRAME_POOL_EXHAUSTION.md.
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
    tabGrammars.get(tabId)?.delete(frameId);
    // Re-aggregate so the next push (or the immediate active-tab guard
    // below) reflects only surviving frames. schedulePushForTab no-ops if
    // tabId isn't the active tab; background tabs ship the cleanup when
    // they're next activated via onActivated's own pushGrammar.
    schedulePushForTab(tabId);
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
    // Always-mode: pre-arm hints on the new tab so a codeword spoken in
    // the gap before its grammar push arrives still gates correctly. The
    // plugin's eager-arm auto-clears in 2s if no grammar follows.
    if (hintVisibility === 'always') {
      forwardHintsSessionStart('tab_switch', activeInfo.tabId);
    }
  }
  markTabSeen(activeInfo.tabId);
  if (tabGrammars.has(activeInfo.tabId)) {
    // Cache hit (F1): push whatever we have. Previously this was only a
    // hit for the tab the SW restart fired from; now any tab visited in
    // this browser session that's still inside the LRU cap is a hit too.
    pushGrammar(activeInfo.tabId, aggregateGrammarForTab(activeInfo.tabId));
  } else {
    // Cold path: tab not in cache (never visited this session or LRU-evicted).
    // Don't push empty (that would clear the plugin's commands). Ask the
    // content script to re-scan; its SCAN_RESULT will repopulate and push.
    forwardDebugLog('pipeline.bg_rescan_dispatched', { tab_id: activeInfo.tabId, source: 'onActivated_cache_miss' });
    chrome.tabs.sendMessage(activeInfo.tabId, {
      type: 'BRANCHKIT_ACTION',
      payload: { action: 'rescan' },
    }).catch(() => {});
  }
  // Persist the new active tab id so the next SW restart restores the
  // right `cachedActiveTabId` for its initial-push.
  schedulePersist();
});

chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  try {
    const tabs = await chrome.tabs.query({ active: true, windowId });
    const newActive = tabs[0]?.id ?? null;
    const oldTabId = cachedActiveTabId;
    cachedActiveTabId = newActive;
    if (oldTabId != null && oldTabId !== newActive) {
      logTabSwitch('window_focus', oldTabId, newActive);
      endHintSessionOnOldTab(oldTabId, 'window_focus');
      if (newActive != null && hintVisibility === 'always') {
        forwardHintsSessionStart('window_focus', newActive);
      }
    }
    if (newActive != null) {
      markTabSeen(newActive);
      if (tabGrammars.has(newActive)) {
        pushGrammar(newActive, aggregateGrammarForTab(newActive));
      } else {
        forwardDebugLog('pipeline.bg_rescan_dispatched', { tab_id: newActive, source: 'onFocusChanged_cache_miss' });
        chrome.tabs.sendMessage(newActive, {
          type: 'BRANCHKIT_ACTION',
          payload: { action: 'rescan' },
        }).catch(() => {});
      }
      schedulePersist();
    }
  } catch {
    cachedActiveTabId = null;
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
  purgeTab(tabId);
  // Closing the active tab leaves the plugin holding its commands; clear
  // them with an empty push. Chrome will fire onActivated for the next-up
  // tab right after, which re-pushes that tab's grammar.
  if (wasActive) pushGrammar(null, []);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  // Only clear grammar cache on navigation, NOT the label pool. SPA
  // navigations fire onUpdated but the content script survives — its
  // wrappers still hold claimed codewords. Clearing the pool here would
  // let new elements claim the same codewords, creating duplicates.
  // The label pool is cleaned per-frame via releaseFrame when the
  // content script's liveness port actually disconnects (full nav).
  if (changeInfo.status === 'loading') {
    tabGrammars.delete(tabId);
    tabLastSeen.delete(tabId);
    const timer = aggregateTimers.get(tabId);
    if (timer) {
      clearTimeout(timer);
      aggregateTimers.delete(tabId);
    }
    // F1: a navigating tab's old grammar is now stale — drop it from
    // storage so the next SW restart doesn't replay codewords for elements
    // that no longer exist.
    schedulePersist();
  }
});

// --- Session-cache persistence (Layer 2 of hint sync) ---
//
// On a service-worker restart, `tabGrammars`, `tabLastSeen`, and
// `cachedActiveTabId` reset to empty. Without this cache the only way to
// repopulate any tab is to wait for the next content-script scan, which
// happens on DOM mutation or an explicit rescan. F1 extends the cache from
// active-tab-only to all visited tabs (capped at MAX_PERSISTED_TABS via
// LRU) so the post-SW-restart cold path covers tab switches into any
// previously-visited tab, not just the one that was active when the SW
// died.
//
// One combined key (vs per-tab) — simpler restore, atomic eviction, and
// chrome.storage.session handles multi-MB values fine. The stored payload
// stays small in practice: a 250-element hint-heavy page serializes to
// ~10-30 KB, so 30 tabs × ~20 KB ≈ 0.6 MB. Well under the 10 MB budget.
const SESSION_KEY_CACHE = 'branchkit.tabCache';
const MAX_PERSISTED_TABS = 30;

// Leading-edge rate limit. With F3 + per-tab pushes, schedulePushForTab
// can fire many times across many tabs in a single burst; we don't want
// one chrome.storage.session.set per frame's SCAN_RESULT. 500ms is short
// enough to lose minimal work on SW death, long enough to coalesce a
// scroll burst.
let persistTimer: ReturnType<typeof setTimeout> | null = null;
const PERSIST_DEBOUNCE_MS = 500;

interface PersistedTab {
  frames: Record<number, ScannedElement[]>;
  lastSeen: number;
}

interface PersistedCache {
  activeTabId: number | null;
  tabs: Record<number, PersistedTab>;
}

function schedulePersist(): void {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    persistAllTabGrammars();
  }, PERSIST_DEBOUNCE_MS);
}

async function persistAllTabGrammars(): Promise<void> {
  try {
    // Snapshot the tabs to persist, LRU-capped. tabLastSeen carries the
    // ordering signal; freshest interactions stay, oldest get dropped.
    const ordered = [...tabGrammars.keys()]
      .map(id => ({ id, lastSeen: tabLastSeen.get(id) ?? 0 }))
      .sort((a, b) => b.lastSeen - a.lastSeen)
      .slice(0, MAX_PERSISTED_TABS);

    const tabs: Record<number, PersistedTab> = {};
    for (const { id, lastSeen } of ordered) {
      const perTab = tabGrammars.get(id);
      if (!perTab || perTab.size === 0) continue;
      const frames: Record<number, ScannedElement[]> = {};
      for (const [frameId, elements] of perTab) {
        frames[frameId] = elements;
      }
      tabs[id] = { frames, lastSeen };
    }
    const cache: PersistedCache = { activeTabId: cachedActiveTabId, tabs };
    await chrome.storage.session.set({ [SESSION_KEY_CACHE]: cache });
  } catch {
    // Best effort — storage failures (quota, IO) shouldn't break the live
    // path. If the cache falls behind, the worst outcome is a cold scan on
    // the next tab switch.
  }
}

async function restoreAllTabGrammars(): Promise<void> {
  try {
    const result = await chrome.storage.session.get(SESSION_KEY_CACHE);
    const cache = result[SESSION_KEY_CACHE] as PersistedCache | undefined;
    if (!cache) return;

    if (typeof cache.activeTabId === 'number') {
      cachedActiveTabId = cache.activeTabId;
    }
    for (const [tabIdStr, entry] of Object.entries(cache.tabs)) {
      const tabId = Number(tabIdStr);
      const perTab = new Map<number, ScannedElement[]>();
      for (const [frameIdStr, elements] of Object.entries(entry.frames)) {
        perTab.set(Number(frameIdStr), elements);
      }
      tabGrammars.set(tabId, perTab);
      tabLastSeen.set(tabId, entry.lastSeen);
    }
  } catch {
    // Best effort.
  }
}

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

  // Restore cached grammar for every previously-visited tab BEFORE plugin
  // discovery so the post-discovery replay sees populated state in the
  // SW-restart case (F1).
  await restoreAllTabGrammars();

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
    // Replay cached grammar to the plugin so its view matches the badges
    // already drawn on the page. Without this, the plugin's per-prefix
    // collections stay empty until the content script triggers another
    // scan, leaving the user unable to activate visible hints for
    // seconds after SW restart.
    if (cachedActiveTabId != null && tabGrammars.has(cachedActiveTabId)) {
      pushGrammar(cachedActiveTabId, aggregateGrammarForTab(cachedActiveTabId));
    }
  }
}

chrome.storage.onChanged.addListener((changes) => {
  if (changes.hintVisibility) {
    hintVisibility = changes.hintVisibility.newValue || 'always';
    if (cachedActiveTabId != null) {
      pushGrammar(cachedActiveTabId, aggregateGrammarForTab(cachedActiveTabId));
    }
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
    // chrome:// and chrome-extension:// pages reject scripting.executeScript.
    // skip them silently. http(s):// and file:// (when permitted) succeed.
    const url = tab.url ?? '';
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')
        || url.startsWith('edge://') || url.startsWith('about:')
        || url.startsWith('devtools://') || url.startsWith('view-source:')) {
      continue;
    }
    try {
      // Step 1: clear any orphan's idempotency flag in every frame so the
      // about-to-be-injected fresh content.js init runs.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          delete (window as unknown as { __branchkitContentInjected?: boolean }).__branchkitContentInjected;
        },
      });
      // Step 2: re-inject the MAIN-world bootstrap (attachShadow wrapper).
      // Idempotent — bootstrap.ts guards its own re-installation.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['bootstrap.js'],
        world: 'MAIN',
      });
      // Step 3: re-inject content.js — the guard cleared in step 1 lets it
      // run; on completion it sets the guard again to block duplicates.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        files: ['content.js'],
      });
    } catch (e) {
      // Tab may have navigated, been closed, or hit a restricted URL we
      // didn't filter above. Per-tab errors are non-fatal — move on.
      const msg = e instanceof Error ? e.message : String(e);
      if (!msg.includes('Cannot access') && !msg.includes('No tab with id')) {
        console.warn(`[BranchKit] reinject: tab ${tab.id} (${url}):`, msg);
      }
    }
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

/**
 * BranchKit Browser — Service worker (background script).
 *
 * Responsibilities:
 * - Discover browser plugin port/token via actuator
 * - Push grammar to plugin on scan results
 * - Route SSE events from offscreen doc (Chrome) or direct SSE (Firefox) to content scripts
 * - Manage offscreen document lifecycle (Chrome only)
 */

import { Message, ScannedElement, GrammarRequest, FieldInfo, ClickableInfo, TableLink } from './types';
import { claimLabels, releaseLabels, clearStack, regenerateAllStacks, getFrameForLabel } from './label-pool';

const ACTUATOR_URL = 'http://127.0.0.1:21551';

// --- State ---

let pluginPort: number | null = null;
let pluginToken: string | null = null;
let branchkitConnected = false;

// Per-tab grammar aggregation. Each frame's SCAN_RESULT lands here keyed
// by (tabId, frameId); on every update we rebuild the aggregate and push
// it to the voice plugin. Without this, the voice plugin only sees
// whichever frame pushed last — multi-frame grammar gets overwritten.
// See notes/DESIGN_BROWSER_GRAMMAR_PROTOCOL.md section 4.
const tabGrammars = new Map<number, Map<number, ScannedElement[]>>();

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
  const timer = setTimeout(() => {
    aggregateTimers.delete(tabId);
    pushGrammar(aggregateGrammarForTab(tabId));
  }, AGGREGATE_DEBOUNCE_MS);
  aggregateTimers.set(tabId, timer);
}

// Firefox direct SSE (no offscreen document needed)
let directSSE: EventSource | null = null;

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
function storeAlphabet(words: string[]): void {
  if (!Array.isArray(words) || words.length !== 26) return;
  if (words.some(w => typeof w !== 'string' || w.length === 0)) return;
  chrome.storage.local.set({ alphabet: words })
    .then(() => regenerateAllStacks())
    .then(() => {
      // Drop every tab's cached grammar — entries reference codewords
      // from the prior alphabet. Frames will re-trigger doScan via the
      // alphabet onChanged listener and repopulate the map cleanly.
      tabGrammars.clear();
      for (const timer of aggregateTimers.values()) clearTimeout(timer);
      aggregateTimers.clear();
    })
    .catch(err => console.error('[BranchKit BG] alphabet store error:', err));
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
    switch (el.category) {
      case 'input':
        fields.push({
          fid: el.selector,
          label: el.label,
          type: el.type,
          selector: el.selector,
          id: '',
          position: fields.length,
          codeword: el.codeword,
        });
        break;
      case 'tables':
        tables.push({
          label: el.label,
          selector: el.selector,
          href: '',
          table_id: '',
          codeword: el.codeword,
        });
        break;
      default:
        clickables.push({
          label: el.label,
          selector: el.selector,
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

async function pushGrammar(elements: ScannedElement[]): Promise<void> {
  // Lazy discovery: service worker may have restarted and lost state
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
    branchkitConnected = true;
    connectSSE();
  }

  const req = scannedToGrammarRequest(elements);

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

    // Re-discover after a delay (plugin may have restarted on a new port)
    setTimeout(async () => {
      const found = await discoverPlugin();
      branchkitConnected = found;
      if (found) connectSSE();
    }, 2000);
  };
}

// --- SSE Event Handling (shared by both paths) ---

function handleSSEEvent(data: any): void {
  console.log('[BranchKit BG] SSE event:', JSON.stringify(data));

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
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const tab = tabs[0];
    if (!tab?.id) {
      console.warn('[BranchKit SW] no active tab found');
      return;
    }

    // If the action references a specific codeword, route to its owning frame.
    // Otherwise fall through to the top frame (chrome's default).
    const frameId = await routeFrameForAction(tab.id, message);
    console.log('[BranchKit SW] notifyActiveTab:', tab.id, frameId ?? 'top', tab.url?.slice(0, 60));

    const send = frameId !== null
      ? chrome.tabs.sendMessage(tab.id, message, { frameId })
      : chrome.tabs.sendMessage(tab.id, message);
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
      recordFrameGrammar(tabId, frameId, message.elements);
      schedulePushForTab(tabId);
    }
    return false;
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

  if (message.type === 'HEALTH_STATUS') {
    const wasConnected = branchkitConnected;
    branchkitConnected = message.branchkit ?? false;

    // SSE dropped — immediately re-discover plugin (port may have changed on restart)
    if (wasConnected && !branchkitConnected) {
      setTimeout(async () => {
        const found = await discoverPlugin();
        branchkitConnected = found;
        if (found) connectSSE();
      }, 2000); // brief delay for plugin to finish restarting
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

  return false;
});

// Clear a tab's label pool + per-frame grammar + pending push timer when
// the tab is closed or starts navigating. Content scripts reload with no
// memory of prior state.
function purgeTab(tabId: number): void {
  clearStack(tabId).catch(() => {});
  tabGrammars.delete(tabId);
  const timer = aggregateTimers.get(tabId);
  if (timer) {
    clearTimeout(timer);
    aggregateTimers.delete(tabId);
  }
}

chrome.tabs.onRemoved.addListener(purgeTab);

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') purgeTab(tabId);
});

// --- Startup ---

async function init(): Promise<void> {
  const found = await discoverPlugin();
  branchkitConnected = found;

  if (hasOffscreenAPI) {
    await ensureOffscreen();
  }

  if (found) {
    connectSSE();
  }
}

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());

// Safety net: check connection every 30s
chrome.alarms.create('connection-check', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'connection-check') {
    if (hasOffscreenAPI) {
      await ensureOffscreen();
    }

    // Retry plugin discovery if not connected
    if (!branchkitConnected) {
      const found = await discoverPlugin();
      branchkitConnected = found;
      if (found) connectSSE();
    }
  }
});

// Init immediately (service worker may be waking from alarm)
init();

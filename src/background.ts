/**
 * BranchKit Browser — Service worker (background script).
 *
 * Responsibilities:
 * - Discover browser plugin port/token via actuator
 * - Push grammar to plugin on scan results
 * - Route SSE events from offscreen doc to content scripts
 * - Manage offscreen document lifecycle
 */

import { Message, ScannedElement, GrammarRequest, FieldInfo, ClickableInfo, TableLink } from './types';

const ACTUATOR_URL = 'http://127.0.0.1:21551';

// --- State ---

let pluginPort: number | null = null;
let pluginToken: string | null = null;
let branchkitConnected = false;

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
        });
        break;
      case 'tables':
        tables.push({
          label: el.label,
          selector: el.selector,
          href: '',
          table_id: '',
        });
        break;
      default:
        clickables.push({
          label: el.label,
          selector: el.selector,
          type: el.type,
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

async function pushGrammar(elements: ScannedElement[]): Promise<void> {
  // Lazy discovery: service worker may have restarted and lost state
  if (!pluginPort || !pluginToken) {
    const found = await discoverPlugin();
    if (!found) return;
    branchkitConnected = true;
    notifyOffscreenConnect();
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

// --- Offscreen Document Management ---

async function ensureOffscreen(): Promise<void> {
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

// --- Message Routing ---

async function broadcastToAllTabs(message: Message): Promise<void> {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id && tab.url && !tab.url.startsWith('chrome://')) {
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
    console.log('[BranchKit SW] notifyActiveTab:', tab?.id, tab?.url?.slice(0, 60));
    if (tab?.id) {
      chrome.tabs.sendMessage(tab.id, message).catch((e) => {
        console.warn('[BranchKit SW] sendMessage failed:', e.message);
      });
    } else {
      console.warn('[BranchKit SW] no active tab found');
    }
  } catch (e) {
    console.warn('[BranchKit SW] notifyActiveTab error:', e);
  }
}

// --- Message Listener ---

chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message.type === 'SCAN_RESULT') {
    // Content script scanned the DOM — push grammar to plugin
    pushGrammar(message.elements);
    return false;
  }

  if (message.type === 'SSE_EVENT') {
    // Offscreen doc forwarded an SSE event — route to active tab
    const data = message.data;
    console.log('[BranchKit SW] SSE_EVENT received:', JSON.stringify(data));

    if (data.action === 'rescan' || data.action === 'set_badge_mode') {
      // Broadcast to ALL tabs — rescan re-pushes grammar, set_badge_mode updates display
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
        if (found) notifyOffscreenConnect();
      }, 2000); // brief delay for plugin to finish restarting
    }
    return false;
  }

  if (message.type === 'GET_HEALTH') {
    sendResponse({ branchkit: branchkitConnected });
    return false;
  }

  return false;
});

// --- Startup ---

async function init(): Promise<void> {
  const found = await discoverPlugin();
  branchkitConnected = found;

  await ensureOffscreen();

  if (found) {
    notifyOffscreenConnect();
  }
}

chrome.runtime.onInstalled.addListener(() => init());
chrome.runtime.onStartup.addListener(() => init());

// Safety net: check offscreen doc every 30s
chrome.alarms.create('offscreen-check', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'offscreen-check') {
    await ensureOffscreen();

    // Also retry plugin discovery if not connected
    if (!branchkitConnected) {
      const found = await discoverPlugin();
      branchkitConnected = found;
      if (found) notifyOffscreenConnect();
    }
  }
});

// Init immediately (service worker may be waking from alarm)
init();

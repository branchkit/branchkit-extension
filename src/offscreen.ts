/**
 * BranchKit Browser — Offscreen document.
 *
 * Holds persistent EventSource SSE connection to browser plugin.
 * Forwards action events to service worker via chrome.runtime.sendMessage.
 * This survives service worker termination (MV3 30s idle limit).
 */

let source: EventSource | null = null;

function connect(port: number, token: string, connId: string): void {
  if (source) {
    source.close();
    source = null;
  }

  // conn_id identifies this connection; the plugin binds it to the OS-focused
  // bundle via the focus handshake so dispatch/rescan target only the focused
  // browser. See notes/DESIGN_BROWSER_IDENTITY_FOCUS_HANDSHAKE.md.
  const url = `http://127.0.0.1:${port}/events?token=${token}&conn_id=${encodeURIComponent(connId)}`;
  // Handlers capture THIS instance (`es`), never the module `source`. The old
  // onerror closed whatever `source` pointed at, so when two CONNECT_SSE
  // raced, a superseded EventSource's error could close the NEW instance and
  // leave itself unclosed — a zombie auto-reconnecting (and reporting phantom
  // HEALTH_STATUS) forever, one more per race.
  const es = new EventSource(url);
  source = es;

  es.addEventListener('connected', () => {
    if (source !== es) return; // superseded while connecting
    console.log('[BranchKit Offscreen] SSE connected');
    chrome.runtime.sendMessage({ type: 'HEALTH_STATUS', branchkit: true }).catch(() => {});
  });

  es.addEventListener('action', (e: MessageEvent) => {
    if (source !== es) return;
    try {
      const data = JSON.parse(e.data);
      chrome.runtime.sendMessage({ type: 'SSE_EVENT', data }).catch(() => {});
    } catch (err) {
      console.error('[BranchKit Offscreen] SSE parse error:', err);
    }
  });

  es.addEventListener('alphabet', (e: MessageEvent) => {
    if (source !== es) return;
    try {
      const data = JSON.parse(e.data);
      if (Array.isArray(data?.words)) {
        chrome.runtime.sendMessage({ type: 'ALPHABET', words: data.words }).catch(() => {});
      }
    } catch (err) {
      console.error('[BranchKit Offscreen] alphabet parse error:', err);
    }
  });

  es.onerror = () => {
    // Close THIS instance immediately — don't let EventSource auto-reconnect
    // to a stale port. The service worker re-discovers and sends CONNECT_SSE.
    es.close();
    if (source !== es) return; // superseded instance — die silently
    source = null;
    console.warn('[BranchKit Offscreen] SSE disconnected');
    chrome.runtime.sendMessage({ type: 'HEALTH_STATUS', branchkit: false }).catch(() => {});
  };
}

// Listen for connection info from service worker
chrome.runtime.onMessage.addListener((message: any, _sender, sendResponse) => {
  if (message.type === 'CONNECT_SSE' && message.port && message.token) {
    connect(message.port, message.token, message.connId ?? '');
    return false;
  }
  // Liveness probe from the SW's connection-check alarm: report whether the
  // stream is actually OPEN. The SW treats no-answer as dead, so this must
  // stay synchronous. See notes/DESIGN_SSE_RESILIENCE.md (4).
  if (message.type === 'SSE_STATUS') {
    sendResponse({ connected: source !== null && source.readyState === EventSource.OPEN });
    return false;
  }
  return false;
});

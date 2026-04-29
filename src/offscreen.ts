/**
 * BranchKit Browser — Offscreen document.
 *
 * Holds persistent EventSource SSE connection to browser plugin.
 * Forwards action events to service worker via chrome.runtime.sendMessage.
 * This survives service worker termination (MV3 30s idle limit).
 */

let source: EventSource | null = null;

function connect(port: number, token: string): void {
  if (source) {
    source.close();
    source = null;
  }

  const url = `http://127.0.0.1:${port}/events?token=${token}`;
  source = new EventSource(url);

  source.addEventListener('connected', () => {
    console.log('[BranchKit Offscreen] SSE connected');
    chrome.runtime.sendMessage({ type: 'HEALTH_STATUS', branchkit: true }).catch(() => {});
  });

  source.addEventListener('action', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      chrome.runtime.sendMessage({ type: 'SSE_EVENT', data }).catch(() => {});
    } catch (err) {
      console.error('[BranchKit Offscreen] SSE parse error:', err);
    }
  });

  source.addEventListener('alphabet', (e: MessageEvent) => {
    try {
      const data = JSON.parse(e.data);
      if (Array.isArray(data?.words)) {
        chrome.runtime.sendMessage({ type: 'ALPHABET', words: data.words }).catch(() => {});
      }
    } catch (err) {
      console.error('[BranchKit Offscreen] alphabet parse error:', err);
    }
  });

  source.onerror = () => {
    console.warn('[BranchKit Offscreen] SSE disconnected');
    // Close immediately — don't let EventSource auto-reconnect to a stale port.
    // The service worker will re-discover the new port and send CONNECT_SSE.
    if (source) {
      source.close();
      source = null;
    }
    chrome.runtime.sendMessage({ type: 'HEALTH_STATUS', branchkit: false }).catch(() => {});
  };
}

// Listen for connection info from service worker
chrome.runtime.onMessage.addListener((message: any) => {
  if (message.type === 'CONNECT_SSE' && message.port && message.token) {
    connect(message.port, message.token);
  }
});

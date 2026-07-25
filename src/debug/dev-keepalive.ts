/**
 * Dev-build keepalive (content world, top frame only). The auto-reload WS
 * client lives in the background, and a SUSPENDED background can't hear
 * pings — Firefox event pages suspend aggressively, which left a stale
 * background running for hours while the palette frame (served fresh from
 * disk on every open) kept evolving: the split-brain build of 2026-07-25.
 *
 * Runtime messaging WAKES a suspended background, and waking re-executes
 * its top level — which reconnects the reload socket. So a periodic no-op
 * ping from any open page keeps the background effectively always-on in
 * dev, and with it the auto-reload loop. Folded out of release builds with
 * the rest of __DEV_RELOAD__.
 */
declare const __DEV_RELOAD__: boolean;
if (__DEV_RELOAD__ && window === window.top) {
  setInterval(() => {
    chrome.runtime.sendMessage({ type: 'DEV_PING' }).catch(() => {
      /* extension reloading / context gone — next interval retries */
    });
  }, 20_000);
}

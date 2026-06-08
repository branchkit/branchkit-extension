import { Message } from '../types';

/**
 * Emit a structured diagnostic to `plugin-logs/browser.log` via the per-plugin
 * debug channel (PLUGIN_DEBUG_LOG → background `forwardPluginDebugLog`).
 *
 * Use this for **connection / session lifecycle** events — liveness port
 * disconnect & reconnect, grammar resync, orphan teardown, session rotation,
 * content-script boot. Those were previously invisible on the content-script
 * side, which made grammar-loss bugs (a frame-liveness disconnect wiping the
 * plugin grammar) impossible to reconstruct from `browser.log` alone.
 *
 * Best-effort: the transport is the service worker, so a send issued while the
 * SW is down (or the runtime context is gone) is dropped. That's why lifecycle
 * events are logged on *recovery* (reconnect / boot) as well as at the
 * disconnect instant — the recovery line always lands once the SW is back.
 */
export function bkLog(
  tag: string,
  data?: unknown,
  level: 'info' | 'warn' | 'error' | 'debug' = 'info',
): void {
  try {
    chrome.runtime
      .sendMessage({ type: 'PLUGIN_DEBUG_LOG', tag, data, level } as Message)
      .catch(() => {});
  } catch {
    // Runtime context invalidated (extension reload) — nothing to send to.
  }
}

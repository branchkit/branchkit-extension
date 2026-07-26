import { Message } from '../types';

/**
 * Dispatch-scoped correlation context (piece C of
 * notes/DESIGN_EXTENSION_LOG_RETRIEVAL.md). The BRANCHKIT_ACTION handler
 * stamps the actuator's `tr_` id here on dispatch entry; every bkLog call
 * in the synchronous dispatch body then carries it, so `grep tr_XXX`
 * spans actuator.log, show-all, AND browser.log in one sweep.
 *
 * The context self-clears on the next microtask rather than via
 * try/finally at the call site: the dispatch handler is a long if/else
 * chain in content.ts and the synchronous body is exactly what a
 * microtask boundary delimits. Async continuations (post-await) lose the
 * context BY DESIGN — pass `correlationId` explicitly there, as the
 * activate path already does (activate-path-log.ts).
 */
let currentCorrelation: string | undefined;
let clearScheduled = false;

export function setLogCorrelation(id: string | undefined): void {
  currentCorrelation = id;
  if (id !== undefined && !clearScheduled) {
    clearScheduled = true;
    queueMicrotask(() => {
      currentCorrelation = undefined;
      clearScheduled = false;
    });
  }
}

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
  // Attach the dispatch-scoped tr_ where one is live and the payload can
  // carry it. An explicit correlationId in `data` wins (the caller knows
  // better — e.g. an async continuation threading its own).
  let payload = data;
  if (currentCorrelation !== undefined) {
    if (payload === undefined) {
      payload = { correlationId: currentCorrelation };
    } else if (
      typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      && !('correlationId' in payload)
    ) {
      payload = { ...payload, correlationId: currentCorrelation };
    }
  }
  try {
    chrome.runtime
      .sendMessage({ type: 'PLUGIN_DEBUG_LOG', tag, data: payload, level } as Message)
      .catch(() => {});
  } catch {
    // Runtime context invalidated (extension reload) — nothing to send to.
  }
}

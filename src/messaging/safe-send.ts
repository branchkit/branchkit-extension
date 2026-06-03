/**
 * Orphan-safe wrapper around `chrome.runtime.sendMessage`.
 *
 * When the extension is reloaded at chrome://extensions/, the old content
 * script's runtime context is invalidated but its JS execution context
 * (timers, observers, event listeners) keeps running for a brief window —
 * and on busy pages, much longer. Every `chrome.runtime.sendMessage` call
 * during that window throws *synchronously* with "Extension context
 * invalidated." The `.catch(() => {})` clauses we wrote at every call site
 * only handle async rejection — the sync throw escapes them and surfaces
 * as an uncaught error from whatever observer/handler called us. On a busy
 * page, this fires hundreds of times per second and renders the tab
 * unresponsive, forcing the user to close it.
 *
 * `safeSendMessage`:
 *   1. Checks `chrome.runtime?.id` upfront. If missing, the context is
 *      invalidated; return a resolved promise without calling sendMessage.
 *   2. Wraps the call in try/catch to absorb the sync throw if the check
 *      raced (context invalidated between the id read and the call).
 *   3. Forwards the async `.catch(() => {})` semantics so existing code
 *      chains continue to work — every call site already swallows errors.
 *
 * Pairs with `PageSession.cancelScheduled()` (cancels timers + aborts
 * owned event listeners) so the orphan window is short by construction;
 * this is the belt-and-suspenders for anything fired during the gap.
 */

export function safeSendMessage<T = unknown>(message: unknown): Promise<T | undefined> {
  // Orphan detection: chrome.runtime.id is undefined when the context is
  // invalidated. Cheap synchronous read; never throws (the property exists
  // on the runtime object, it's just undefined post-invalidation).
  if (typeof chrome === 'undefined' || !chrome.runtime?.id) {
    return Promise.resolve(undefined);
  }
  try {
    return (chrome.runtime.sendMessage(message) as Promise<T>).catch(() => undefined);
  } catch {
    // Race: context invalidated between the id check and the call. The
    // sync throw escapes the .catch above; absorb it here.
    return Promise.resolve(undefined);
  }
}

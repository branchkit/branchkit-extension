/**
 * BranchKit Browser — the `chrome.runtime.onMessage` router, shared by both
 * entry points.
 *
 * Replaces the 44-branch `if (message.type === …)` chain that used to be 38% of
 * background.ts, and the 11-branch one in content.ts. Handlers live with the
 * module that owns their concern and are composed here as data; the entry point
 * installs the table and knows nothing about who registered what. See
 * notes/DESIGN_ENTRY_POINT_TOPOLOGY.md.
 *
 * ## One module, two instances
 *
 * `content.ts` and `background.ts` are separate esbuild bundles, so each gets
 * its own copy of the table below — a content script cannot see the SW's
 * handlers, and vice versa. That is why this can be ONE module rather than a
 * factory, or (worse) two files kept in sync: the isolation the two contexts
 * need is already a property of the bundling.
 *
 * ## The response contract is carried by the RETURN VALUE, not a boolean
 *
 * Chrome's `onMessage` protocol is a footgun: returning `true` promises to call
 * `sendResponse` later, returning `false` promises never to. Get it wrong in
 * either direction and the failure is silent — the sender's await hangs, or a
 * late response lands on a closed channel. Across 44 hand-written branches that
 * is 44 chances to typo it.
 *
 * So handlers never write that boolean. A handler returns:
 *
 *   undefined      → fire-and-forget; no response      (was: `return false`)
 *   a value        → respond with it, synchronously    (was: sendResponse(v); return false)
 *   a Promise      → respond when it settles           (was: …then(sendResponse); return true)
 *
 * The router derives Chrome's boolean from which of those it got, in one place,
 * under test. "Returned true and forgot to respond" and "responded after
 * returning false" are no longer expressible.
 *
 * A handler that wants to answer nothing but still do async work returns
 * undefined and keeps its own floating promise — same as the old `void fn()`.
 *
 * ## Rejection is a routing bug, not a response
 *
 * Handlers own their fallbacks: the pool handlers answer `{ rejected: [] }` on a
 * transient error precisely because rejecting would strip wrappers, and that
 * decision belongs next to the pool, not here. A promise that rejects anyway has
 * escaped its handler's own catch, so the router closes the channel (an
 * undefined response) rather than leaving the sender awaiting forever, and logs
 * loudly — a hung content script is far harder to diagnose than a logged throw.
 */

import { reportCaught } from '../debug/uncaught';

export type MessageSender = chrome.runtime.MessageSender;

/**
 * Returning `undefined` means "no response". No handler answers with a literal
 * `undefined` payload today; if one ever needs to, it should answer `null`.
 */
export type MessageHandler = (
  message: any,
  sender: MessageSender,
) => unknown | Promise<unknown> | void;

const handlers = new Map<string, MessageHandler>();

let guard: (() => boolean) | null = null;

/**
 * A context-wide precondition, checked before any handler runs. Returning
 * `false` makes this context ignore every message.
 *
 * The content script needs it: a torn-down orphan (a superseded elder whose
 * `chrome.runtime` is still live) must not act on broadcasts, or it fires
 * navigations, clicks and grammar into a dead session alongside its successor
 * (notes/DESIGN_TEARDOWN_OWNERSHIP.md). That guard has to sit ABOVE the table
 * rather than inside eleven handlers, because the rule is "this context is
 * done", not "this message does not apply".
 *
 * Unset in the service worker, which has no such state.
 */
export function setMessageGuard(fn: (() => boolean) | null): void {
  guard = fn;
}

function isThenable(v: unknown): v is Promise<unknown> {
  return typeof (v as { then?: unknown } | null | undefined)?.then === 'function';
}

/**
 * Compose a module's exported handler map into the table.
 *
 * Duplicate registration throws at install time rather than letting the later
 * (or earlier — it was ordering-dependent) one silently win. Two modules both
 * claiming a message type is exactly the kind of merge accident the old
 * if-chain made invisible.
 */
export function registerMessageHandlers(map: Record<string, MessageHandler>): void {
  for (const [type, handler] of Object.entries(map)) {
    const existing = handlers.get(type);
    if (existing && existing !== handler) {
      throw new Error(`[BranchKit] duplicate message handler for '${type}'`);
    }
    handlers.set(type, handler);
  }
}

/** Test seam. Production installs once at boot and never clears. */
export function resetMessageHandlers(): void {
  handlers.clear();
  guard = null;
}

/** The registered types, sorted. Diagnostics and tests. */
export function registeredMessageTypes(): string[] {
  return [...handlers.keys()].sort();
}

/**
 * The single `chrome.runtime.onMessage` callback. Returns Chrome's
 * keep-the-channel-open boolean.
 *
 * An unknown type returns false, matching the old chain's fall-through to its
 * trailing `return false` — other listeners (and other extensions' frames) send
 * traffic we deliberately ignore.
 */
export function routeMessage(
  message: any,
  sender: MessageSender,
  sendResponse: (response?: unknown) => void,
): boolean {
  if (guard && !guard()) return false;

  const type = message?.type;
  if (typeof type !== 'string') return false;

  const handler = handlers.get(type);
  if (!handler) return false;

  let result: unknown;
  try {
    result = handler(message, sender);
  } catch (err) {
    // A synchronous throw means no response is coming. Close the channel.
    // Also to browser.log: before content.ts's chain became this table, a
    // synchronous throw here escaped the listener and installUncaughtCapture
    // turned it into a BK_UNCAUGHT line carrying the dispatch's tr_. Catching
    // it is right — the channel closes instead of hanging the sender — but a
    // console.warn is invisible to `dev plog`, and the biggest handler in the
    // extension routes through here.
    reportCaught(`message handler '${type}'`, err, { phase: 'sync' });
    console.warn(`[BranchKit] handler '${type}' threw:`, err);
    return false;
  }

  if (result === undefined) return false;

  if (isThenable(result)) {
    result.then(
      (value) => sendResponse(value),
      (err) => {
        reportCaught(`message handler '${type}'`, err, { phase: 'async' });
        console.warn(`[BranchKit] handler '${type}' rejected:`, err);
        sendResponse(undefined);
      },
    );
    return true;
  }

  sendResponse(result);
  return false;
}

/**
 * BranchKit Browser — content-script injection manager (service worker side).
 *
 * The lazy-inject + orphan-recovery state machine: ping a tab's content script,
 * and if it's absent (pre-existing tab) or an invalidated orphan (extension
 * reloaded), flush the stale idempotency guard and inject a fresh script — all
 * under a per-tab lock so concurrent recovery paths can't double-inject. This is
 * the extension-reload-survival machinery; see
 * notes/DESIGN_EXTENSION_RELOAD_SURVIVAL.md and the orphan-CS retrospective.
 *
 * Extracted verbatim from background.ts module scope (Tier 3 of
 * notes/DESIGN_EXTENSION_RESTRUCTURE.md) — behavior-identical relocation, no
 * logic change. Self-contained over chrome.* APIs plus the in-flight lock set.
 */

export function isInjectableURL(url: string): boolean {
  return !!url
    && !url.startsWith('chrome://')
    && !url.startsWith('chrome-extension://')
    && !url.startsWith('moz-extension://')
    && !url.startsWith('edge://')
    && !url.startsWith('about:')
    && !url.startsWith('devtools://')
    && !url.startsWith('view-source:');
}

/**
 * Inject bootstrap + content script into `tabId`. Used as a recovery
 * path when `chrome.tabs.sendMessage` fails with "Receiving end does
 * not exist" — typically a pre-existing tab from before sideload, OR
 * a Firefox temporary add-on where `onInstalled` didn't reach this
 * tab.
 *
 * Does NOT clear the idempotency guard itself — callers that reach
 * a tab on a recovery path (`ensureContentScriptInjected`,
 * `reinjectContentScripts`) flush the orphan guard via `flushOrphanGuard`
 * first. If a healthy script is still loaded, content.ts's top-level guard
 * throws "duplicate injection" — we catch that quietly (it's not an error
 * in this context, just the guard doing its job).
 *
 * Returns true on success; false if the tab URL is restricted
 * (about:, chrome://, etc.) or injection failed for another reason.
 */
export async function injectContentScriptFiles(tabId: number): Promise<boolean> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return false;
  }
  // Firefox aggressively discards inactive tabs; executeScript can't
  // reach a discarded tab and Firefox reports the failure as a generic
  // "An unexpected error occurred". The next tabs.onActivated for this
  // tab will retry after Firefox restores it.
  if (tab.discarded) return false;
  const url = tab.url ?? '';
  if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')
      || url.startsWith('moz-extension://') || url.startsWith('edge://')
      || url.startsWith('about:') || url.startsWith('devtools://')
      || url.startsWith('view-source:')) {
    return false;
  }
  // Try allFrames first (covers same-origin iframes, what we want for
  // most sites). If it fails, fall back to top-frame-only — on Firefox
  // a single failing frame (CSP-locked cross-origin iframe, sandboxed
  // ad slot) rejects the entire call atomically, leaving even the main
  // frame uninjected. YouTube and Netflix are the canonical offenders.
  return await tryInject(tabId, url, { allFrames: true })
      || await tryInject(tabId, url, { frameIds: [0] });
}

async function tryInject(
  tabId: number,
  url: string,
  target: { allFrames?: boolean; frameIds?: number[] },
): Promise<boolean> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, ...target },
      files: ['bootstrap.js'],
      world: 'MAIN',
    });
    await chrome.scripting.executeScript({
      target: { tabId, ...target },
      files: ['content.js'],
    });
    return true;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // content.ts throws "duplicate injection" if its guard is set —
    // that's the expected path when proactive injection hits a tab
    // that's already been injected. Not an error.
    if (msg.includes('duplicate injection')) return true;
    const scope = target.allFrames ? 'allFrames' : `frames=${target.frameIds?.join(',')}`;
    console.warn(`[BranchKit SW] inject failed for tab ${tabId} (${url}, ${scope}):`, msg);
    return false;
  }
}

/**
 * Ping the content script in `tabId` to see if it's listening. Returns
 * true if a response came back; false if no content script is loaded
 * (or the tab URL forbids messaging).
 *
 * Uses GET_FOCUS_STATUS as the ping because content.ts already handles
 * it synchronously — no extra message type needed.
 */
async function pingContentScript(tabId: number): Promise<boolean> {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'GET_FOCUS_STATUS' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Per-tab in-flight inject tracker. Multiple SW paths (`onInstalled.update`
 * → `reinjectContentScripts`, `tabs.onUpdated{status:'complete'}` →
 * `ensureContentScriptInjected`, `notifyActiveTab`'s sendMessage-failure
 * recovery) can all decide to flush+inject the same tab within the same
 * extension reload. If they interleave, the second path's `flushOrphanGuard`
 * deletes the guard flag the first path's CS just set, letting a second CS
 * instance pass the duplicate guard — observed via the page-world debug
 * bridge as two `cs_id` entries loaded ~90ms apart, each minting its own
 * session_id and ping-ponging cleanups in the plugin's per-prefix grammar.
 *
 * The fix: any flush-then-inject path acquires the tab's slot in this set
 * first. A concurrent caller that finds the slot occupied skips entirely —
 * the in-flight injector covers the work for both.
 */
const inflightInjects = new Set<number>();

export async function withInjectLock<T>(tabId: number, fn: () => Promise<T>): Promise<T | undefined> {
  if (inflightInjects.has(tabId)) return undefined;
  inflightInjects.add(tabId);
  try {
    return await fn();
  } finally {
    inflightInjects.delete(tabId);
  }
}

/**
 * Best-effort clear of the content-script idempotency guard (the
 * `data-branchkit-cs` documentElement attribute)
 * across every frame in `tabId`. An orphaned content script from a previous
 * extension generation leaves this flag set; until it's cleared a freshly
 * injected content.js bails on the top-level "duplicate injection" throw,
 * so the tab stays dead until the user closes and reopens it.
 *
 * Only call this on a recovery path where the live script (if any) is
 * already known unreachable — clearing the guard out from under a healthy
 * script would let a second copy initialize on top of it. Callers should
 * be inside a `withInjectLock(tabId, ...)` block; without that, a second
 * concurrent caller can flush the guard the first caller's just-injected
 * CS set, producing two CS instances in the same frame.
 *
 * On Firefox this routinely fails atomically on sites with CSP-locked
 * iframes (YouTube ads, Netflix DRM frame, Cloudflare challenges); that's
 * fine — the top-frame fallback in injectContentScriptFiles still runs.
 */
async function flushOrphanGuard(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => {
        // The guard is a DOM attribute (shared across sandboxes/worlds —
        // see content.ts's idempotency guard); the legacy window expando is
        // cleared too so an old-generation orphan can't strand a tab
        // across the changeover.
        document.documentElement.removeAttribute('data-branchkit-cs');
        delete (window as unknown as { __branchkitContentInjected?: boolean }).__branchkitContentInjected;
      },
    });
  } catch {
    // Swallow — flush failure means orphans persist in some frames, not
    // the end of the world; lazy-inject on a later activation retries.
  }
}

/**
 * Proactive lazy-injection: if the tab doesn't have BranchKit's content
 * script yet (typically a pre-existing tab from before sideload), inject
 * it now so badges paint without the user needing to F5. No-op if the
 * script is already alive.
 *
 * If the ping fails, the tab either has no script or holds an orphan whose
 * runtime was invalidated by an extension reload (the orphan no longer
 * answers messages but its idempotency guard lingers). We flush that guard
 * before injecting so the fresh script runs to completion — this is what
 * lets already-open tabs recover voice control after an extension reload
 * without a manual close-and-reopen.
 *
 * Retry-then-flush: a freshly-loading content script doesn't register its
 * runtime.onMessage listener until module init completes (~tens of ms,
 * longer on heavy pages). If `tabs.onUpdated{status:'complete'}` fires
 * faster than that — common on cache-warm reloads — the first ping arrives
 * mid-init and times out, exactly when the CS *is* about to come alive on
 * its own. The original code went straight to flush + inject in that
 * window, racing the manifest's auto-injection and producing two CS
 * instances in the same frame (one with its session_id, one with another),
 * which then ping-pong wipe each other's per-prefix grammar via
 * session_id_changed cleanups. Empirically verified on Netflix /watch via
 * the RDP debug bridge: two cs_ids loaded 72ms apart in the same top
 * frame. Retrying the ping after a short delay covers the "still loading"
 * case without affecting the genuine-orphan case (orphans never answer).
 */
const PING_RETRY_DELAY_MS = 500;

export async function ensureContentScriptInjected(tabId: number): Promise<void> {
  if (await pingContentScript(tabId)) return;
  await new Promise<void>((resolve) => setTimeout(resolve, PING_RETRY_DELAY_MS));
  if (await pingContentScript(tabId)) return;
  await withInjectLock(tabId, async () => {
    // Re-check inside the lock: the holder of the lock might have just
    // injected, so the CS is healthy by the time we get in here.
    if (await pingContentScript(tabId)) return;
    await flushOrphanGuard(tabId);
    await injectContentScriptFiles(tabId);
  });
}

/**
 * BranchKit Browser — MAIN-world bootstrap.
 *
 * Wraps Element.prototype.attachShadow so the ISOLATED-world content
 * script learns about every shadow root the page creates, even after
 * first paint. Without this, a static deepQuerySelectorAll only sees
 * shadow roots that exist at scan time — sites that lazy-mount custom
 * elements (GitHub PR review threads, modern Slack, ChatGPT message
 * list) would have invisible interactive surfaces.
 *
 * Pattern from DarkReader (`src/inject/dynamic-theme/stylesheet-proxy.ts`).
 *
 * Why this script runs in MAIN world: ISOLATED-world content scripts
 * can't observe page-level mutations of the prototype chain. The wrap
 * has to land before any page script calls attachShadow, so this
 * script is registered at document_start.
 *
 * The CustomEvent fires *before* the native call, so the shadow root
 * isn't attached yet when the listener runs synchronously. The
 * ISOLATED-world listener queues a microtask before reading
 * .shadowRoot — by then the native attach has completed.
 *
 * Closed shadow roots: the wrapper still fires the event, but the
 * .shadowRoot lookup returns null afterward. The host element is
 * visible to us; we just can't reach inside. Consistent with the
 * static-walk fallback.
 */

const SHADOW_EVENT = '__branchkit__shadow_attached';

(() => {
  const native = Element.prototype.attachShadow;
  if ((native as unknown as { __branchkit_wrapped?: boolean }).__branchkit_wrapped) {
    // Another instance of the bootstrap already ran (e.g. extension
    // reload during dev). Don't double-wrap.
    return;
  }

  function wrappedAttachShadow(this: Element, options: ShadowRootInit): ShadowRoot {
    try {
      if (this.isConnected) {
        this.dispatchEvent(new CustomEvent(SHADOW_EVENT, { bubbles: true, composed: true }));
      } else {
        // Disconnected host — the standard web-component pattern
        // (createElement → attachShadow in the constructor → populate →
        // append). An event dispatched on a disconnected element never
        // propagates past its detached tree, so the document listener
        // misses it entirely; dispatch on document instead, carrying the
        // host in detail. DOM nodes in detail cross the MAIN/ISOLATED
        // boundary; an engine that blocks it leaves detail.host
        // undefined and the listener degrades to the old behavior.
        document.dispatchEvent(new CustomEvent(SHADOW_EVENT, { detail: { host: this } }));
      }
    } catch {
      // Some pages override Event/CustomEvent; swallow to keep the page working.
    }
    return native.call(this, options);
  }

  (wrappedAttachShadow as unknown as { __branchkit_wrapped: boolean }).__branchkit_wrapped = true;
  Element.prototype.attachShadow = wrappedAttachShadow;
})();

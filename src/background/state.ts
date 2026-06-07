/**
 * BranchKit Browser — shared service-worker state.
 *
 * The cross-cutting connection/tab state that background.ts's transport, routing,
 * tab-session, and message-listener paths all read and write. Promoted out of
 * background.ts module scope (Tier 3 of notes/DESIGN_EXTENSION_RESTRUCTURE.md) so
 * the extracted background modules import the same instance instead of reaching
 * into the service-worker entry. A mutable object (not exported `let`s) so
 * importers can assign fields directly.
 */

export const bgState = {
  /** True while the plugin SSE stream is connected (set by SSE connect/
   * disconnect/retry and the offscreen HEALTH_STATUS handler). */
  branchkitConnected: false,
  /** The tab the plugin should treat as this browser's active tab. */
  cachedActiveTabId: null as number | null,
};

// The extension never names its own browser. UA-sniffing the macOS bundle ID
// is wrong for every fork of a supported engine (Brave reports as Chrome,
// Firefox Nightly as firefox, etc.), which broke the plugin's cross-browser
// focus gate. Instead we mint a connection nonce and let the OS-authoritative
// focus event name the browser: when this browser gains OS focus we POST /focus
// with connId, and the plugin binds connId to whatever bundle the OS reports as
// frontmost. See notes/DESIGN_BROWSER_IDENTITY_FOCUS_HANDSHAKE.md.
//
// Stable for this background's lifetime. On SW restart it regenerates and the
// SSE reconnect (init → connectSSE) re-establishes the mapping plugin-side.
export const connId = crypto.randomUUID();

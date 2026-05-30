/**
 * BranchKit Browser — frame liveness Port.
 *
 * One long-lived Port per content-script V8 context. We send no messages —
 * the Port's *lifetime* is the signal. When this context dies (iframe
 * removed, navigation, tab closed) Chrome closes the Port and the
 * background's onDisconnect handler releases this frame's labels and
 * clears its tabGrammars entry. See
 * docs/completed/DESIGN_BROWSER_FRAME_POOL_EXHAUSTION.md.
 *
 * The content-side onDisconnect handler below fires only when the SW
 * restarts (idle-terminated), not when this frame dies. On SW restart we
 * reopen a Port so the background can re-track us; we don't re-claim
 * labels because our existing claims survive in chrome.storage.session.
 *
 * This module owns the Port mechanics + the orphan-vs-transient
 * discrimination only. The orphan *teardown* (disconnecting the content
 * script's observers, removing badge hosts) is the caller's responsibility,
 * passed in as `onOrphan`, because it touches content.ts-owned state.
 *
 * Extracted from content.ts as part of the extension restructure (step 1,
 * carve leaf concerns). See notes/DESIGN_EXTENSION_RESTRUCTURE.md.
 */

const LIVENESS_PORT_NAME = 'frame-liveness';

export interface LivenessHandlers {
  /**
   * The SW reports this frame's frameId over the Port on connect. Used by
   * the activate path to detect misrouted actions (registry id minted in a
   * different frame).
   */
  onFrameId: (frameId: number) => void;
  /**
   * The runtime context is invalidated (extension reload/uninstall) and
   * can never reconnect. The caller should self-quiesce: tear down its
   * observers and remove its badge hosts so the freshly-injected content
   * script runs alone.
   */
  onOrphan: () => void;
}

let livenessPort: chrome.runtime.Port | null = null;

export function openLivenessPort(handlers: LivenessHandlers): void {
  try {
    const port = chrome.runtime.connect({ name: LIVENESS_PORT_NAME });
    livenessPort = port;
    port.onMessage.addListener((msg: unknown) => {
      if (typeof msg !== 'object' || msg === null) return;
      const m = msg as { type?: unknown; frameId?: unknown };
      if (m.type === 'FRAME_ID' && typeof m.frameId === 'number') {
        handlers.onFrameId(m.frameId);
      }
    });
    port.onDisconnect.addListener(() => {
      livenessPort = null;
      // Discriminate between two disconnect causes:
      //   1. Transient SW restart (idle timeout, browser sleep): Chrome
      //      will start a new SW on the next API call. Reconnect after a
      //      brief delay so the SW finishes its init pass.
      //   2. Extension reload/uninstall: this content script's runtime
      //      context is invalidated. `chrome.runtime` is undefined or
      //      `chrome.runtime.id` is undefined. We can't reconnect from
      //      here ever — the SW-side re-injection (background.ts) will
      //      inject a fresh content script that opens its own port. Our
      //      job is to self-quiesce so we stop polluting the page.
      let stillValid = false;
      try {
        stillValid = typeof chrome !== 'undefined' && !!chrome.runtime?.id;
      } catch {
        stillValid = false;
      }
      if (!stillValid) {
        handlers.onOrphan();
        return;
      }
      setTimeout(() => openLivenessPort(handlers), 500);
    });
  } catch {
    // Extension context invalidated (e.g., extension reloaded mid-page).
    // Page reload required to recover; nothing useful to do here.
    livenessPort = null;
  }
}

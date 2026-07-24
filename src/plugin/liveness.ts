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
 * reopen a Port so the background can re-track us. Label claims do NOT
 * survive the restart (the SW's init runs clearAllStacks()), so the resync
 * must also re-assert pool ownership of held codewords — content.ts's
 * onResync does this via labelReservoir.reconfirm() before rebuilding the
 * grammar.
 *
 * The grammar, however, does NOT survive: our port closing made the SW's
 * onDisconnect fire `frame_liveness_disconnect` → /hints/session_end, which
 * deletes this frame's per-prefix grammar collections on the plugin side.
 * Our delta-sync shadow (`sentCodewords`) still thinks it's all live, so it
 * would never re-emit — leaving painted badges un-matchable until a manual
 * rescan. So a reconnect fires `onResync`, letting the caller rebuild the
 * grammar (rotate the session + re-Put every live wrapper).
 *
 * This module owns the Port mechanics + the orphan-vs-transient
 * discrimination only. The orphan *teardown* (disconnecting the content
 * script's observers, removing badge hosts) is the caller's responsibility,
 * passed in as `onOrphan`, because it touches content.ts-owned state.
 *
 * Extracted from content.ts as part of the extension restructure (step 1,
 * carve leaf concerns). See notes/DESIGN_EXTENSION_RESTRUCTURE.md.
 */

import { bkLog } from '../debug/bk-log';
import { documentInstanceId } from '../labels/document-identity';

const LIVENESS_PORT_NAME = 'frame-liveness';
// The port NAME carries this document's pool-ownership identity so the SW
// has it atomically at onConnect (no handshake race for disconnect cleanup).
// See DESIGN_DOCUMENT_SCOPED_POOL_OWNERSHIP.md.

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
  /**
   * We reopened the Port after a transient SW restart. The plugin wiped
   * this frame's grammar when the prior Port dropped (frame_liveness_disconnect
   * → session_end), so the caller must rebuild it: rotate the delta-sync
   * session and re-emit every live wrapper. Not called on the initial open.
   */
  onResync: () => void;
}

let livenessPort: chrome.runtime.Port | null = null;

export function openLivenessPort(handlers: LivenessHandlers, isReconnect = false): void {
  let connected = false;
  try {
    const port = chrome.runtime.connect({ name: `${LIVENESS_PORT_NAME}:${documentInstanceId}` });
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
      //      brief delay so the SW finishes its init pass. The reconnect
      //      carries `isReconnect=true` so the caller resyncs the grammar
      //      the plugin wiped when this Port dropped.
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
      // Best-effort breadcrumb. When the cause is an SW death this won't
      // reach browser.log (the SW is the transport) — the matching
      // BK_LIVENESS_RECONNECT below lands on recovery and implies it.
      bkLog('BK_LIVENESS_DISCONNECT', { orphan: !stillValid });
      if (!stillValid) {
        handlers.onOrphan();
        return;
      }
      setTimeout(() => openLivenessPort(handlers, true), 500);
    });
    connected = true;
  } catch {
    // Extension context invalidated (e.g., extension reloaded mid-page).
    // Page reload required to recover; nothing useful to do here.
    livenessPort = null;
  }
  // Run the resync outside the try so a throwing handler can't be mistaken
  // for context invalidation. Only after a real reconnect, never first open.
  if (connected && isReconnect) {
    bkLog('BK_LIVENESS_RECONNECT', {});
    handlers.onResync();
  }
}

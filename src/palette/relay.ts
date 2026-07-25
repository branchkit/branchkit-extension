/**
 * Palette bootstrap relay protocol — the Firefox fallback path.
 *
 * On Firefox the palette iframe runs with content-script privileges and its
 * direct runtime.sendMessage round-trip to the background resolves undefined
 * (2026-07-25 field diagnosis). The HOST content script's messaging works —
 * it's how the palette opens — so the frame can ask the host to fetch
 * PALETTE_BOOTSTRAP on its behalf, over window.postMessage.
 *
 * The page shares the window on both legs, so the protocol is designed for
 * that audience:
 *  - HELLO (host → frame, targetOrigin = the extension origin): carries a
 *    random secret. The page cannot read a postMessage addressed to a
 *    cross-origin frame, so the secret stays between host and frame.
 *  - REQ (frame → parent window): the page CAN see this — it carries nothing
 *    but the type marker.
 *  - RESP (host → frame, extension targetOrigin): tabs/marks data plus the
 *    secret. Page can't read it; and because the page never learned the
 *    secret, a page-forged RESP (it holds the same contentWindow reference)
 *    fails the secret check in the frame. The host additionally ignores REQs
 *    whose event.source isn't its own frame's contentWindow.
 */

export const RELAY_HELLO = 'BK_PALETTE_RELAY_HELLO';
export const RELAY_REQ = 'BK_PALETTE_BOOTSTRAP_REQ';
export const RELAY_RESP = 'BK_PALETTE_BOOTSTRAP_RESP';
/** Frame → host lifecycle breadcrumb; the host forwards it to the plugin's
 * dispatch-result log, giving actuator.log an inside-the-frame trace on
 * browsers no harness can drive (Firefox). Page-visible — carries counts and
 * error names only, never tab data. */
export const RELAY_DIAG = 'BK_PALETTE_DIAG';

/** Wire shape of the bootstrap payload (mirrors PALETTE_BOOTSTRAP's response). */
export interface BootstrapWire {
  tabs?: Array<{ tabId: number; title: string; url: string }>;
  mru?: number[];
  marks?: Record<number, string>;
  activeTabId?: number | null;
}

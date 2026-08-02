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

/**
 * Frame → host, once per open: the codeword set the frame just assigned.
 *
 * The host registers a CodewordHolder on the frame's behalf and answers the
 * registry's synchronous questions (held / matchesPrefix / soleMatch /
 * resolve) from this mirror — the same host-as-proxy shape the mode stack
 * already uses (`modes.push('palette')` in palette-host.ts). Only the two
 * void-returning legs travel back into the frame.
 *
 * Carries NO secret, and must not: like REQ it travels frame → parent with
 * targetOrigin '*' (the frame cannot know the page's origin), so the page can
 * read it. The host authenticates this direction by `event.source` — a page
 * cannot spoof that without executing inside the extension frame. Row ids and
 * letter tokens are the palette's own badges, already visible on screen.
 */
export const RELAY_CODEWORDS = 'BK_PALETTE_CODEWORDS';

// Host → frame legs. These DO carry the secret: they travel to the extension
// targetOrigin (page-unreadable), but the page holds the frame's
// contentWindow reference and could post to it, and a forged ACTIVATE would
// dispatch a row the user never spoke.

/** Host → frame: mid-codeword narrowing ('' resets). Visual only. */
export const RELAY_NARROW = 'BK_PALETTE_NARROW';
/** Host → frame: activate this row (a codeword resolved to it). */
export const RELAY_ACTIVATE = 'BK_PALETTE_ACTIVATE';
/** Host → frame: alphabet or display mode changed — re-render badge text. */
export const RELAY_RELABEL = 'BK_PALETTE_RELABEL';

/**
 * One row's badge, as the frame assigned it.
 *
 * `token` is the CLAIM-LEVEL form the holder registry speaks: letters,
 * space-joined ("o", "o r"), matching the label pool's token shape so
 * `letterFormOf` / `anyCodewordMatchesPrefix` apply unchanged. The FRAME
 * computes it, because the frame owns the alphabet it assigned from —
 * deriving it host-side would make correctness depend on two independently
 * loaded alphabets agreeing.
 */
export interface PaletteCodewordWire {
  token: string;
  rowId: string;
}

/** Wire shape of the bootstrap payload (mirrors PALETTE_BOOTSTRAP's response). */
export interface BootstrapWire {
  tabs?: Array<{ tabId: number; title: string; url: string; windowId?: number }>;
  mru?: number[];
  marks?: Record<number, string>;
  bookmarks?: Array<{ title: string; url: string; path: string }>;
  /** Set when the bookmarks fetch failed (permission missing) — loud, not empty. */
  bookmarksError?: string;
  activeTabId?: number | null;
  activeWindowId?: number | null;
}

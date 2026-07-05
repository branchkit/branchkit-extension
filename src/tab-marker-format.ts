/**
 * BranchKit Browser — tab-marker title format (shared, pure, no chrome deps).
 *
 * The one place that knows how a tab marker is written into (and read back
 * out of) a tab title. Imported by BOTH the content decorator
 * (render/tab-title.ts) and the background grammar publisher
 * (background/tab-collection.ts) so the write side and the strip side can
 * never drift. See notes/DESIGN_TAB_MARKERS.md.
 *
 * The strip is deliberately LETTER-shaped (1–2 lowercase letters), matching
 * Rango's `^[a-z]{1,2} ?\| ?`. Tab titles are space-constrained, so the strip
 * decoration is always the compact letter form regardless of the user's
 * badgeDisplayMode (which still drives the HUD / palette). The spoken codeword
 * is unchanged — the strip just shows "a", you still say "arch".
 */

/** Delimiter between the marker letters and the real title: "a| GitHub". */
export const MARKER_DELIMITER = '| ';

// Anchored at string start, tolerant of Rango's compact ("a|") and spaced
// ("a | ") forms so a title decorated by an older format still strips clean.
// Case-insensitive for the uppercase display option (future).
const MARKER_PREFIX_RE = /^[a-z]{1,2} ?\| ?/i;

/**
 * Remove a leading marker decoration if present. Idempotent — a title with no
 * marker is returned unchanged, and a double-decorated title (shouldn't
 * happen, but defends re-entry) loses only the outermost marker per call.
 */
export function stripTabMarker(title: string): string {
  return title.replace(MARKER_PREFIX_RE, '');
}

/** True if the title currently carries a marker decoration. */
export function hasTabMarker(title: string): boolean {
  return MARKER_PREFIX_RE.test(title);
}

/** Compose a decorated title from bare letters + the undecorated title. */
export function decorateTitle(letters: string, bareTitle: string): string {
  return `${letters}${MARKER_DELIMITER}${bareTitle}`;
}

/**
 * BranchKit Browser — tab-marker title format (shared, pure, no chrome deps).
 *
 * The one place that knows how a tab marker is written into (and read back
 * out of) a tab title. Imported by BOTH the content decorator
 * (render/tab-title.ts) and the background grammar publisher
 * (background/tab-collection.ts) so the write side and the strip side can
 * never drift. See notes/DESIGN_TAB_MARKERS.md.
 *
 * The marker is a bracketed LETTER label prefix: "[a] GitHub". The brackets
 * bound the marker so it reads as a distinct label, not part of the title (the
 * earlier pipe form "a|" read like a stray letter). Tab titles are space-
 * constrained, so it's always the compact letter form regardless of the user's
 * badgeDisplayMode (which still drives the HUD / palette). The spoken codeword
 * is unchanged — the strip just shows "a", you still say "arch".
 */

// Anchored at string start. Matches the current bracket form "[a] " AND the
// previous pipe form "a| " so a title left over from an older build strips
// clean instead of double-marking; the pipe alternative is transitional and
// can go once no old-format tabs remain. Case-insensitive for a future
// uppercase display option.
const MARKER_PREFIX_RE = /^(?:\[[a-z]{1,2}\]|[a-z]{1,2} ?\|) ?/i;

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

/** Compose a decorated title from bare letters + the undecorated title:
 *  "a" + "GitHub" → "[a] GitHub". */
export function decorateTitle(letters: string, bareTitle: string): string {
  return `[${letters}] ${bareTitle}`;
}

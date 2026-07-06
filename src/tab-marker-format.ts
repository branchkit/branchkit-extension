/**
 * BranchKit Browser — tab-marker title format (shared, pure, no chrome deps).
 *
 * The one place that knows how a tab marker is written into (and read back
 * out of) a tab title. Imported by BOTH the content decorator
 * (render/tab-title.ts) and the background grammar publisher
 * (background/tab-collection.ts) so the write side and the strip side can
 * never drift. See notes/DESIGN_TAB_MARKERS.md.
 *
 * The marker is a bracketed label prefix: "[a] GitHub". The brackets bound the
 * marker so it reads as a distinct label, not part of the title (the earlier
 * pipe form "a|" read like a stray letter). The DISPLAYED content follows the
 * user's badgeDisplayMode, exactly like hint badges (render/tab-title.ts formats
 * it via labelToDisplay): "[a]" in letter mode, "[arch]" / "[iris zone]" in word
 * mode, "[arch]" / "[iris z]" in expand mode. The letter is still the machine
 * identity — the pool, palette letter-jump, and grammar all key off it — so the
 * displayed word is a pure overlay, present only when the voice alphabet is
 * loaded (word/expand fall back to letters otherwise).
 */

// Anchored at string start. Matches every emitted display form — letter "[a]",
// pair "[iz]", word "[iris zone]", expand "[iris z]" — plus the legacy pipe form
// "a| " so an old-build title strips clean instead of double-marking. LOWERCASE
// only (no /i): our emissions are always lowercase (letters + ascii alphabet
// words), and requiring lowercase keeps a page's own capitalized bracket prefix
// (e.g. "[Draft] ", "[TODO] ") from being mistaken for a marker and eaten. At
// most two space-separated letter tokens, matching the widest form (word-mode
// pair / expand-mode pair). The pipe alternative is transitional.
const MARKER_PREFIX_RE = /^(?:\[[a-z]+(?: [a-z]+)?\]|[a-z]{1,2} ?\|) ?/;

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

/** Compose a decorated title from the display form + the undecorated title:
 *  "a" + "GitHub" → "[a] GitHub"; "iris zone" + "GitHub" → "[iris zone] GitHub".
 *  The display form is chosen by render/tab-title.ts per badgeDisplayMode; this
 *  just brackets it. */
export function decorateTitle(display: string, bareTitle: string): string {
  return `[${display}] ${bareTitle}`;
}

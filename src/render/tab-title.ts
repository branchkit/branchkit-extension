/**
 * BranchKit Browser — tab title decorator (content side, Phase 1 of
 * notes/DESIGN_TAB_MARKERS.md).
 *
 * Writes this tab's marker as a `document.title` prefix ("[a] GitHub") and keeps
 * it applied as the page rewrites its own title. Top frame only —
 * `document.title` is a per-document, top-level concern.
 *
 * The background pushes the marker's LETTER token ("a" / "iz") — the stable
 * identity. What we DISPLAY follows the user's badgeDisplayMode, exactly like
 * hint badges: letter "[a]", word "[iris zone]", expand "[iris z]". Word/expand
 * need the voice alphabet overlay and fall back to letters when it's absent. The
 * letter stays the machine identity (pool, palette, grammar); the word is a pure
 * display overlay. `refreshTabMarker()` re-renders in place when the mode or the
 * alphabet changes, so switching the label setting updates open tabs live.
 *
 * The background owns assignment and pushes the letters (or null to clear);
 * this module owns only the write, with Rango's three anti-fight guards so we
 * never loop against our own writes or fight pages that edit titles
 * incrementally:
 *   - echo guard: ignore an update when the title is still our last write;
 *   - incremental-edit guard: if the page merely wrapped our decorated title
 *     (e.g. "▶︎ " prepended), adopt it as the new decorated baseline rather
 *     than re-stripping;
 *   - strip-before-apply: always strip any existing marker before prefixing,
 *     so re-entry and format changes are idempotent.
 */

import { stripTabMarker, decorateTitle } from '../tab-marker-format';
import { labelToDisplay, type LabelAssignment } from '../labels/words';
import { getDisplayMode } from '../config';

// The current marker letters ("a" / "qr"), or null when the feature is off /
// this tab is unmarked. Set by the background push.
let letters: string | null = null;

/**
 * The display form of the marker letters under the current badgeDisplayMode,
 * via the same labelToDisplay used for hint badges — so the tab prefix and the
 * on-page hint for the same letter always read identically. The marker token is
 * adjacent letters ("iz"); split it into the single-letter words labelToDisplay
 * expects. Falls back to the letters themselves when the voice overlay is absent
 * (word/expand have nothing to say without an alphabet).
 */
function markerDisplay(marker: string): string {
  const assignment: LabelAssignment = {
    words: marker.split(''),
    letter: marker,
    isSingle: marker.length === 1,
  };
  return labelToDisplay(assignment, getDisplayMode());
}
// Bare title before our decoration, and the exact decorated string we last
// wrote — the echo guard compares against the latter.
let lastUndecorated = typeof document !== 'undefined' ? document.title : '';
let lastDecorated = lastUndecorated;

/**
 * Strip whatever marker is on the title and re-apply the current letters.
 * Unconditional — always used when the marker itself changed (a title that's
 * byte-identical still needs rewriting when the letters differ).
 * Strip-before-apply makes it idempotent.
 */
function writeFromBare(): void {
  lastUndecorated = stripTabMarker(document.title);

  // Empty title (PDFs, pre-load): leave it alone — a bare "[a] " prefix on an
  // empty title reads as junk in the tab.
  if (lastUndecorated === '') {
    lastDecorated = document.title;
    return;
  }

  const next = letters ? decorateTitle(markerDisplay(letters), lastUndecorated) : lastUndecorated;
  if (next !== document.title) document.title = next;
  lastDecorated = next;
}

/** Background push: set (or clear, with null) this tab's marker letters. A
 *  marker change always rewrites, so this bypasses the page-echo guards. */
export function setTabMarker(next: string | null): void {
  if (typeof document === 'undefined') return;
  letters = next;
  writeFromBare();
}

/**
 * Re-render the marker in place — the letters are unchanged, but the display
 * form or the voice overlay moved (badgeDisplayMode switched, or the alphabet
 * loaded/changed). No-op on unmarked frames/tabs (letters === null), so a
 * mode-change broadcast to every frame only rewrites the one that's decorated.
 */
export function refreshTabMarker(): void {
  if (typeof document === 'undefined' || letters === null) return;
  writeFromBare();
}

/**
 * Re-apply after a page-driven title change (the background messages us on
 * `tabs.onUpdated(title)`; also safe to call directly). Runs the echo and
 * incremental-edit guards before rewriting, so we don't loop against our own
 * write or fight a page that edits titles incrementally.
 */
export function reapplyTabMarker(): void {
  if (typeof document === 'undefined') return;
  const current = document.title;

  // Echo guard — our own write coming back. Nothing to do.
  if (current === lastDecorated) return;

  // Incremental-edit guard — the page wrapped our decorated title (Bandcamp
  // prepends "▶︎ "). Adopt it as the baseline; don't re-strip the edit away.
  if (lastDecorated && current.includes(lastDecorated)) {
    lastDecorated = current;
    return;
  }

  writeFromBare();
}

/** Test-only reset. */
export function _resetTabTitleForTesting(): void {
  letters = null;
  lastUndecorated = document.title;
  lastDecorated = document.title;
}

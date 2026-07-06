/**
 * BranchKit Browser — Marks (Vimium `m` / `` ` ``).
 *
 * Pure helpers shared by the content script (scroll capture/restore) and the
 * background (cross-tab storage + global goto). All chrome.* and DOM access
 * lives at the call sites; this module is just data shapes + key derivation so
 * it's unit-testable. See notes/DESIGN_MARKS_AND_CARET.md (Part 1).
 *
 * Local marks (Vim `[a-z]`) = a scroll position on one page, keyed by URL.
 * Global marks (Vim `[A-Z]`, entered with Shift) = a URL + scroll in any tab.
 * The previous-position registers `` ` `` and `'` both hold the spot you were
 * at before the last jump, so `` `` `` returns you.
 */

/** A saved position within a page. `hash` lets a bare-anchor mark restore via
 *  location.hash instead of a scroll (matches Vimium). */
export interface StoredMark {
  scrollX: number;
  scrollY: number;
  hash: string;
}

/** A global mark also records where it lives so goto can find (or reopen) it. */
export interface GlobalMark extends StoredMark {
  /** Base URL (everything before the first '#'). */
  url: string;
  /** The tab it was set in; may be stale by goto time (tab closed / new
   *  session), in which case goto falls back to URL match / new tab. */
  tabId?: number;
}

/** Everything up to the first '#'. Marks match on this (the hash is stored
 *  separately and applied on restore). */
export function baseUrl(url: string): string {
  return url.split('#')[0];
}

/** chrome.storage key for a local mark — per base-URL + letter. */
export function localMarkKey(url: string, letter: string): string {
  return `mark:local:${baseUrl(url)}:${letter}`;
}

/** chrome.storage key for a global mark — letter only (it spans URLs). */
export function globalMarkKey(letter: string): string {
  return `mark:global:${letter}`;
}

/** The two Vim registers that always hold the pre-jump position. Never global,
 *  even with Shift held. */
export const PREV_POSITION_REGISTERS = ['`', "'"] as const;

export function isPrevPositionRegister(letter: string): boolean {
  return (PREV_POSITION_REGISTERS as readonly string[]).includes(letter);
}

/** A single printable character usable as a mark name (letters, `` ` ``, `'`, …
 *  — anything but a space or a multi-char key name like "Shift"/"Enter"). */
export function isMarkChar(key: string): boolean {
  return key.length === 1 && key !== ' ';
}

/** Restore decision: a hash-only mark (an anchor, no scroll) restores by
 *  setting location.hash; anything with a scroll offset restores by scrolling.
 *  Mirrors Vimium's marks.js. */
export function marksToHash(mark: StoredMark): boolean {
  return !!mark.hash && mark.scrollX === 0 && mark.scrollY === 0;
}

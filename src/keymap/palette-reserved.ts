/**
 * BranchKit Browser — palette navigation letters, derived from the keymap
 * (notes/DESIGN_PALETTE_KEYBOARD_NAV.md).
 *
 * The palette's letter mode consumes every bare single-character press as a
 * label letter, so a key cannot both navigate the list and type a mark. The nav
 * letters are therefore WITHHELD from the palette's label pools, and pressing
 * one moves the selection instead.
 *
 * Which letters those are is DERIVED, not hardcoded: whatever the user has bound
 * to the vertical list-navigation family. Anchoring on the command's structural
 * role in the catalog rather than a per-key list means a Colemak user on n/e gets
 * the same treatment automatically, and an arrow-key user reserves nothing.
 *
 * THE COLLISION TEST MIRRORS THE CONSUMER. A key collides exactly when it would
 * satisfy the predicate in palette-page.ts's letter-mode branch — a
 * single-character `e.key` with no Ctrl/Meta/Alt — because that branch calls
 * `typeMarkLetter(e.key.toLowerCase())`. Read straight off that condition:
 *
 *  - SHIFT COLLIDES. Shift is absent from the guard and the branch lowercases,
 *    so Shift+G types mark "g" today. `shift+KeyG` therefore reserves `g`.
 *  - CTRL / META / ALT DO NOT. Those chords never reach the mark path.
 *  - EVERY STEP OF A SEQUENCE COLLIDES, because the first press is eaten as a
 *    mark before the second can arrive. `KeyG KeyG` reserves `g`; a user who
 *    bound top to `KeyG KeyT` reserves both `g` and `t`.
 *
 * Horizontal scrolling (h/l) is deliberately NOT in the family: a list has no
 * horizontal axis, so those letters stay available as labels.
 */

import type { KeymapEntry } from './command-catalog';
import { parseCombo } from '../activate/key-combo';

/** What a reserved key does to the palette's selection. */
export type PaletteNavIntent =
  | 'next' | 'prev'
  | 'pageNext' | 'pagePrev'
  | 'first' | 'last';

/**
 * The vertical list-navigation family. Membership is the structural role —
 * "moves you along a one-dimensional list" — which is why `scroll_left` and
 * `scroll_right` are absent.
 */
const NAV_FAMILY: Readonly<Record<string, PaletteNavIntent>> = {
  scroll_down: 'next',
  scroll_up: 'prev',
  scroll_half_down: 'pageNext',
  scroll_half_up: 'pagePrev',
  scroll_top: 'first',
  scroll_bottom: 'last',
};

export interface PaletteNav {
  /** Letters withheld from every palette label pool. */
  reserved: ReadonlySet<string>;
  /**
   * Dispatch table keyed by `navKeyToken` — "j", "shift+g". Shift is part of the
   * key here (it distinguishes `g` from `G`) even though it is invisible to
   * reservation (both reserve the letter `g`).
   */
  bindings: ReadonlyMap<string, PaletteNavIntent>;
}

/**
 * The lowercase letter a combo would type into letter mode, or null when the
 * combo can't reach it. Shift is permitted — it does not stop the consumer.
 */
function typedLetterOf(spec: string): string | null {
  const c = parseCombo(spec);
  if (!c || c.ctrl || c.alt || c.meta) return null;
  const m = /^Key([A-Z])$/.exec(c.code);
  return m ? m[1].toLowerCase() : null;
}

/** Whether a combo carries Shift (only meaningful once it has a typed letter). */
function isShifted(spec: string): boolean {
  return parseCombo(spec)?.shift === true;
}

/**
 * The dispatch-table key for a live keypress. Call with the SAME normalization
 * the table was built from, so `G` and `shift+g` agree.
 */
export function navKeyToken(letter: string, shift: boolean): string {
  return shift ? `shift+${letter.toLowerCase()}` : letter.toLowerCase();
}

/**
 * Derive the reserved letters and their palette meanings from an effective
 * keymap.
 *
 * Reservation is per STEP (any step that could be eaten as a mark), while
 * dispatch attaches to the FIRST step only — a single `g` jumps to the top
 * rather than waiting for a second. That is safe because the jump is idempotent:
 * a `gg` habit produces "top" twice, so no sequence state or partial-match
 * timeout is needed inside the frame. On two family bindings claiming the same
 * token, first wins, mirroring the command registry.
 */
export function derivePaletteNav(keymap: readonly KeymapEntry[]): PaletteNav {
  const reserved = new Set<string>();
  const bindings = new Map<string, PaletteNavIntent>();
  for (const entry of keymap) {
    const intent = NAV_FAMILY[entry.command];
    if (!intent) continue;
    const steps = entry.keys.split(/\s+/).filter((s) => s.length > 0);
    let first = true;
    for (const step of steps) {
      const letter = typedLetterOf(step);
      if (letter === null) {
        // Unreachable from letter mode: reserves nothing, and a later step can
        // still collide, so keep walking.
        first = false;
        continue;
      }
      reserved.add(letter);
      if (first) {
        const token = navKeyToken(letter, isShifted(step));
        if (!bindings.has(token)) bindings.set(token, intent);
      }
      first = false;
    }
  }
  return { reserved, bindings };
}

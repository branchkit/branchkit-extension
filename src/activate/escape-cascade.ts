/**
 * The escape cascade — ONE declaration of what "get me out of this" peels, and
 * in what order, for both the Escape key and the spoken "escape" / "over".
 *
 * It used to be two. This module declared the order for voice; the key's order
 * emerged from the sequence of guards in activate/keyboard.ts plus whichever
 * handler saw the event first; and a comment here claimed they were "the same
 * order as the key" — a promise nothing enforced. They had already drifted:
 * pressing Escape in hint mode left it, saying "over" in hint mode peeled
 * nothing (2026-07-26).
 *
 * The coupling tightened when a range pick started capturing the keyboard: a
 * pick is now simultaneously a voice layer and a keyboard mode, so a fourth
 * layer added to one list and not the other would be silently unreachable from
 * the other input.
 *
 * Peels exactly ONE layer per invocation and names it, so the caller can decide
 * whether the key was consumed. Order is most-transient first:
 *
 *   1. range pick   — a question awaiting an answer outranks everything
 *   2. hint prefix  — typed letters only; abandons the codeword, not the mode
 *   3. hint mode    — the letters-are-hints keyboard mode
 *   4. selection    — caret/visual, itself staged (see CaretController.escape)
 *   5. find bar     — the query box
 *
 * Deliberately NOT in the cascade: badge visibility. "dismiss"/"hide"/toggle own
 * that — escape closes things, it doesn't mute them.
 *
 * Keyboard-only transients that are not layers (a half-typed mark, forced insert
 * mode) stay in keyboard.ts ahead of this, because voice can't be in them.
 *
 * Every frame of the active tab runs this; the per-frame guards make only the
 * frame that owns the open layer act.
 */
import { isRangePickPending, cancelRangePick } from './range-disambiguation';
import { caret } from './selection-commands';
import { isFindBarOpen, closeFindMode } from '../scan/find';
import { keyHandler } from '../core/singletons';

export type EscapeLayer =
  | 'range_pick' | 'hint_prefix' | 'hint_mode' | 'selection' | 'find' | '';

export function runEscapeCascade(reason: string): EscapeLayer {
  if (isRangePickPending()) {
    cancelRangePick(reason);
    return 'range_pick';
  }
  // The hint layers' state lives in keyboard.ts (typed prefix, mode flag), so
  // they are ASKED for here rather than reimplemented: the order is stated
  // once, the hint internals stay where they belong.
  const hint = keyHandler.escapeHintLayer();
  if (hint) return hint;
  if (caret.isActive()) {
    caret.escape();
    return 'selection';
  }
  if (isFindBarOpen()) {
    closeFindMode();
    return 'find';
  }
  return '';
}

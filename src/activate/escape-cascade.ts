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
 *   5. video        — the `w` bare-key layer
 *   6. find         — the search SESSION: query box or committed pill
 *
 * Video's rank: the only constraint the tree can actually observe is that video
 * outranks find, and that case is real — commit a search, press `w`, and the
 * find is genuinely the older layer underneath. Against selection it is
 * unobservable: neither mode can be entered from the other by key, because each
 * owns bare keys while live (`v` in video mode is the video layer's, `w` in
 * caret mode is a caret motion). So video is placed with selection, above the
 * find session both can sit on top of, and the pair's internal order is left
 * where it cannot be reached rather than defended as if it could.
 *
 * Deliberately NOT in the cascade: badge visibility. "dismiss"/"hide"/toggle own
 * that — escape closes things, it doesn't mute them.
 *
 * Keyboard-only transients that are not layers (a half-typed mark, forced insert
 * mode) stay in keyboard.ts, because voice can't be in them. They sit BEHIND
 * this in handleKeyDown, not ahead of it — so with a mark armed over an open
 * layer, Escape peels the layer and the mark arm survives to the next one. That
 * is the cascade's claim working as declared (a layer outranks a keystroke
 * mid-word), not an oversight; the comment here used to say "ahead", which
 * described neither the code nor the intent.
 *
 * Every frame of the active tab runs this; the per-frame guards make only the
 * frame that owns the open layer act.
 */
import { isRangePickPending, cancelRangePick } from './range-disambiguation';
import { caret } from './selection-commands';
import { isFindActive, closeFindMode } from '../scan/find';
import { keyHandler } from '../core/singletons';

export type EscapeLayer =
  | 'range_pick' | 'hint_prefix' | 'hint_mode' | 'selection' | 'video' | 'find' | '';

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
  // The `w` layer is STICKY (it holds bare keys until Escape/`q`/`w`), while
  // the plugin's `video_mode` tag is hold-scoped and clears at key release. The
  // two are not the same lifetime, which is why the plugin deliberately has no
  // video entry in its mode-mirror table — a forwarder there would tear this
  // layer down at every hold boundary. Peeling it here needs no plugin round
  // trip: with no exclusive tag held, the browser's own "over" is unsuppressed
  // and already reaches us. See notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS.md.
  // Asked UNRANKED (see KeyHandler.isVideoMode): getMode() reports 'caret' when
  // a caret session is also live, which would leave the video layer unpeelable
  // in exactly the state where being stuck is worst.
  if (keyHandler.isVideoMode()) {
    keyHandler.exitVideoMode();
    return 'video';
  }
  // The SESSION, not the box. `isFindBarOpen()` is false the moment Enter
  // commits, so asking it stranded the committed state: highlights, pill and
  // search badges survived with no spoken way out, while caret.escape() — one
  // layer up in this same cascade — had always asked the session-level
  // predicate. closeFindMode() ends either state (endSession clears the paint,
  // then removes whichever of bar/pill exists).
  if (isFindActive()) {
    closeFindMode();
    return 'find';
  }
  return '';
}

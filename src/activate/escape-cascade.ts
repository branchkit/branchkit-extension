/**
 * The escape cascade — what "get me out of this" peels, for both the Escape
 * key and the spoken "escape" / "over".
 *
 * Wave 3 C3: the ORDER is the mode stack's, derived — last pushed, first
 * peeled — not a declared list (notes/DESIGN_MODE_STACK_AND_CODEWORD_HOLDERS
 * .md, resolved question 1). The fixed ranking this replaces was an
 * approximation of temporal order that had already drifted twice between the
 * two inputs; every ranking it got right, temporal order derives:
 *
 *   - a pending pick peels before the hint mode under it because arming a
 *     pick ENTERS hint mode (the chips must be typable) and then pushes
 *     itself — newest by construction, not by rank;
 *   - the typed hint prefix peels before hint mode as hint's INTRA-mode
 *     transient (the peelInner probe — letters go, the mode stays);
 *   - a video layer entered over a committed find peels first, and a find
 *     committed over a caret session peels first, because each is simply the
 *     newer entry — the one direction the old fixed rank could observe and
 *     the one it couldn't are the same rule now.
 *
 * What lives HERE is only the per-mode EXIT EFFECT: peelTop pops the entry,
 * and the popped mode's own teardown runs (its internal pop of the entry it
 * no longer holds is a no-op). The palette is deliberately absent: it is
 * peelable only from its own focused document (this page-side cascade can
 * never see the key), so its spec declares peelable: false for this stack —
 * see MODE_SPECS.
 *
 * Peels exactly ONE layer per invocation and names it, so the caller can
 * decide whether the key was consumed.
 *
 * Deliberately NOT in the cascade: badge visibility. "dismiss"/"hide"/toggle
 * own that — escape closes things, it doesn't mute them. Keyboard-only
 * transients that are not layers (a half-typed mark, forced insert mode)
 * stay in keyboard.ts, because voice can't be in them; they sit BEHIND this
 * in handleKeyDown, so with a mark armed over an open layer, Escape peels
 * the layer and the mark arm survives to the next one.
 *
 * Every frame of the active tab runs this; each frame's stack holds only the
 * modes that frame owns, so only the frame with the open layer acts.
 */
import { modes } from '../core/modes';
import { cancelRangePick } from './range-disambiguation';
import { caret } from './selection-commands';
import { closeFindMode } from '../scan/find';
import { keyHandler } from '../core/singletons';

export type EscapeLayer =
  | 'range_pick' | 'hint_prefix' | 'hint_mode' | 'selection' | 'video' | 'find' | '';

export function runEscapeCascade(reason: string): EscapeLayer {
  const top = modes.top();
  const peeled = modes.peelTop(reason);
  if (peeled.peeled === 'none') return '';
  if (peeled.peeled === 'inner') {
    // An intra-mode transient consumed the escape; the entry stays. The
    // probe's name maps into the cascade's reporting vocabulary: hint's one
    // transient is the typed prefix; caret's staged unwind reports as the
    // selection layer, exactly as its escape() always has.
    return top === 'hint' ? 'hint_prefix' : 'selection';
  }
  switch (peeled.id) {
    case 'range_pick':
      cancelRangePick(reason);
      return 'range_pick';
    case 'hint':
      keyHandler.escapeHintMode();
      return 'hint_mode';
    case 'caret':
      caret.exit();
      return 'selection';
    case 'video':
      keyHandler.exitVideoMode();
      return 'video';
    case 'find':
      closeFindMode();
      return 'find';
    default:
      // Non-peelable specs never come back from peelTop; 'palette' is the
      // only such id today and its exit lives in its own document.
      return '';
  }
}

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
 *   - a pending pick and the hint mode around it peel newest-first in
 *     whichever order they were entered — a pick armed from hint mode sits
 *     above it, while `f` pressed to type at chips lands above the pick. The
 *     old fixed rank asserted one of those two orders as a law; temporal order
 *     just reports what happened. (Arming no longer enters hint mode on the
 *     user's behalf — see range-disambiguation.ts borrowScreen.)
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
 * own that — escape closes things, it doesn't mute them. The half-typed mark
 * arm is a keyboard-only transient, not a layer, and stays in keyboard.ts —
 * voice can't be in it; it sits BEHIND this in handleKeyDown, so with a mark
 * armed over an open layer, Escape peels the layer and the mark arm survives
 * to the next one. Forced insert ("pass all" / the i bind) is ALSO not a
 * layer — no capture, no frame ownership — but it IS voice-enterable, so its
 * exit lives here as the EPILOGUE: when the stack has nothing left to peel,
 * escape leaves pass-through. Same layers-first order the old keyboard-only
 * branch produced, now shared by both inputs.
 *
 * Every frame of the active tab runs this; each frame's stack holds only the
 * modes that frame owns, so only the frame with the open layer acts.
 */
import { modes } from '../core/modes';
import { cancelRangePick } from './range-disambiguation';
import { caret } from './selection-commands';
import { closeFindMode } from '../scan/find';
import { keyHandler } from '../core/singletons';
import { setInnerTransientProbe } from '../core/mode-stack';

// Hint's intra-mode transient (the peelInner probe the header describes): the
// typed prefix peels before the mode does. One implementation — escapeHintLayer
// and the stack's peelTop both route through peelHintPrefix.
//
// Registered HERE rather than in content.ts, which is where it sat, and there
// was never a cycle stopping it: core/mode-stack has zero imports of any kind,
// and this module already holds keyHandler (:48, via core/singletons). It sits
// at module scope for the same reason its two siblings do —
// selection-commands.ts registers 'caret' and range-disambiguation.ts
// registers 'range_pick' the same way. A pure map write: no I/O, no listener,
// no ordering (an unregistered probe reads as "no transient", so registering
// EARLIER is strictly safer, and clearInnerTransientProbes has no production
// caller).
//
// Not on KeyHandler's constructor, though it owns hint mode and owns
// peelHintPrefix: tests build their own `new KeyHandler(...)`, and a
// constructor write would have each of them clobber the singleton's
// registration in the one shared map.
setInnerTransientProbe('hint', () => keyHandler.peelHintPrefix());

// And the Escape KEY itself runs this cascade — the same one the spoken
// "escape"/"over" runs, so the two inputs unwind through one declared order
// rather than two that drift. That is this module's whole thesis, so the
// wiring that makes it true belongs here rather than in the entry point.
//
// core/singletons is the other candidate and is NOT legal: it already carries
// three keyHandler hook assignments of exactly this shape, but this module
// imports IT (:48), so registering there would close a real 2-cycle. The one
// place the graph allows is also the one that owns the claim.
keyHandler.setEscapeHook(() => runEscapeCascade('key_escape'));

export type EscapeLayer =
  | 'range_pick' | 'hint_prefix' | 'hint_mode' | 'selection' | 'video' | 'find'
  | 'insert' | '';

export function runEscapeCascade(reason: string): EscapeLayer {
  const peeled = modes.peelTop(reason);
  if (peeled.peeled === 'none') {
    // The epilogue (see header): forced insert exits only once the stack is
    // empty — layers always peel first.
    if (keyHandler.isForcedInsert()) {
      keyHandler.exitInsertMode();
      return 'insert';
    }
    return '';
  }
  if (peeled.peeled === 'inner') {
    // An intra-mode transient consumed the escape; the entry stays. The
    // probe's NAME maps into the cascade's reporting vocabulary: hint's one
    // transient is the typed prefix; caret's staged unwind ('visual') reports
    // as the selection layer, exactly as its escape() always has.
    //
    // Keyed on what was peeled rather than on which entry was on top, because
    // those stopped being the same thing: a range pick shares hint's typed
    // prefix (MODE_SPECS), so a prefix peel can land with the PICK on top and
    // would have reported itself as a selection unwind.
    return peeled.name === 'hint_prefix' ? 'hint_prefix' : 'selection';
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

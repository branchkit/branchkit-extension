/**
 * BranchKit Browser — the keyboard-mode dispatcher bindings.
 *
 * Pass-through: hand the keyboard to the page (its own shortcuts work) until
 * Escape. See notes/DESIGN_PASS_THROUGH.md.
 *
 * ## Why this is not part of `keyboard.ts`
 *
 * `core/singletons` CONSTRUCTS the `KeyHandler`, so `keyboard.ts` importing the
 * dispatcher back would be a cycle — the same shape as media-commands.ts, and
 * the boot hazard lint F rejects. The handler stays below the singletons; its
 * command bindings sit above them, here.
 *
 * Other keyHandler-driven commands are still registered from the modules that
 * own their feature (`mark_set`/`mark_jump` in selection-commands.ts,
 * `video_mode`/`video_exit` in media-commands.ts). Those are bound to a
 * feature; everything here is bound to nothing but the keyboard's own modes —
 * pass-through, and the five hint-action arms.
 */

import { dispatcher, keyHandler } from '../core/singletons';

/**
 * Enter hint mode with an action armed: the codeword the user then types acts
 * ON the element instead of following it.
 *
 * The action type is DERIVED from `armHintAction` rather than imported —
 * keyboard.ts deliberately does not export the union, so that no second module
 * can hold a copy of it. Deriving keeps the literals below checked at their own
 * call sites, which is the invariant that comment protects.
 */
type HintActionArg = Parameters<typeof keyHandler.armHintAction>[0];

const armHint = (action: HintActionArg) => () => {
  keyHandler.armHintAction(action);
  keyHandler.enterHintMode();
};

export function registerKeyboardCommands(): void {
  dispatcher.register('insert_mode', () => { keyHandler.enterInsertMode(); });
  dispatcher.register('pass_next_key', () => { keyHandler.armPassNextKey(); });

  // Yank a link via hint (Vimium yf): the resolved codeword copies the link's
  // URL instead of following it. Keyboard-only.
  dispatcher.register('yank_hint', armHint('yank'));
  // Focus a badge's element without activating it, then type via Insert.
  // Distinct from focus_input (first field) — this picks any element.
  dispatcher.register('focus_hint', armHint('focus'));
  // Copy a badge's visible text (vs yank_hint's URL).
  dispatcher.register('copytext_hint', armHint('copytext'));
  // Hover a badge's element (reveal menus/controls) — keyboard twin of the
  // voice "hover {hint}" (plugin-contributed; DESIGN_HINT_ACTION_MODES.md 3b).
  dispatcher.register('hover_hint', armHint('hover'));
  // Start a caret/visual selection at a badge's element (Vimium hint→caret) —
  // then drive it by keyboard or voice ("select word" / "copy that").
  dispatcher.register('caret_hint', armHint('caret'));
}

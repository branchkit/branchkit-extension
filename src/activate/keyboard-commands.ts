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
 * `video_mode`/`video_exit` in media-commands.ts). Those are bound to a feature;
 * these two are bound to nothing but the keyboard's own modes.
 */

import { dispatcher, keyHandler } from '../core/singletons';

export function registerKeyboardCommands(): void {
  dispatcher.register('insert_mode', () => { keyHandler.enterInsertMode(); });
  dispatcher.register('pass_next_key', () => { keyHandler.armPassNextKey(); });
}

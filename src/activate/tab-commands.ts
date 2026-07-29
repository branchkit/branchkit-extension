/**
 * BranchKit Browser — tab and zoom command bindings.
 *
 * Seventeen registrations behind two loops, lifted from content.ts
 * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md phase 3b). Both families do the same
 * thing: forward the verb to the service worker, because content scripts
 * cannot touch `chrome.tabs` at all.
 *
 * **These serve the KEYBOARD path only.** Voice never reaches them — the
 * background intercepts tab and zoom actions off the SSE stream, so they work
 * on pages that have no content script. Registering here is what makes them
 * keyboard-bindable; it is not the voice path's route.
 *
 * The SW ends of these are `background/tab-actions.ts`'s handler map.
 */

import { dispatcher } from '../core/singletons';
import type { Message, TabAction, ZoomAction } from '../types';

const TAB_COMMANDS: ReadonlyArray<readonly [string, TabAction]> = [
  ['next_tab', 'next'], ['previous_tab', 'previous'],
  ['first_tab', 'first'], ['last_tab', 'last'], ['goto_tab', 'goto'],
  ['last_active_tab', 'last_active'],
  ['new_tab', 'new'], ['close_tab', 'close'], ['restore_tab', 'restore'],
  ['duplicate_tab', 'duplicate'], ['pin_tab', 'pin'], ['mute_tab', 'mute'],
  ['move_tab_left', 'move_left'], ['move_tab_right', 'move_right'],
];

const ZOOM_COMMANDS: ReadonlyArray<readonly [string, ZoomAction]> = [
  ['zoom_in', 'in'], ['zoom_out', 'out'], ['zoom_reset', 'reset'],
];

/** Fire-and-forget to the SW. A dead context is not worth reporting here. */
function forward(msg: Message): void {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

export function registerTabCommands(): void {
  for (const [command, action] of TAB_COMMANDS) {
    dispatcher.register(command, (params) => {
      // `goto_tab` carries a 1-based position; the rest carry nothing. A
      // non-numeric or absent index must OMIT the field rather than send NaN,
      // which JSON-serialises to null and reaches the SW as a real value.
      const n = parseInt(params.index ?? '', 10);
      forward(Number.isFinite(n)
        ? { type: 'TAB_ACTION', action, index: n }
        : { type: 'TAB_ACTION', action });
    });
  }

  for (const [command, action] of ZOOM_COMMANDS) {
    dispatcher.register(command, () => {
      forward({ type: 'ZOOM_ACTION', action } as Message);
    });
  }
}

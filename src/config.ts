/**
 * BranchKit Browser — storage-backed user settings.
 *
 * Owns the two persisted display preferences read throughout content.ts —
 * badge display mode and hint visibility. State lives here (private);
 * content.ts reads it through getDisplayMode / getHintVisibility and
 * applies side effects via the handlers passed to loadConfig.
 *
 * Deliberately NOT here: the per-machine `alphabet` adoption (storage.local
 * + its onChanged branch). That's vocab adoption coupled to the delta-sync
 * session state (sessionId, pendingPuts, sentCodewords), not a user setting,
 * so it stays in content.ts — as does other runtime UI state that isn't
 * storage-backed.
 *
 * Extracted from content.ts as part of the extension restructure (step 1,
 * carve leaf concerns). See notes/DESIGN_EXTENSION_RESTRUCTURE.md.
 */

import { BadgeDisplayMode, HintVisibility } from './types';
import { migrateDisplayMode } from './labels/words';

let displayMode: BadgeDisplayMode = 'letter';
let hintVisibility: HintVisibility = 'always';

export function getDisplayMode(): BadgeDisplayMode {
  return displayMode;
}

export function getHintVisibility(): HintVisibility {
  return hintVisibility;
}

export interface ConfigHandlers {
  /** badgeDisplayMode changed — re-label currently visible badges. */
  onDisplayModeChange: () => void;
  /** hintVisibility changed — show or hide hints to match the new value. */
  onHintVisibilityChange: () => void;
}

/**
 * Read the persisted settings from chrome.storage.sync and register an
 * onChanged listener that keeps them live. Side effects (re-label, show/hide)
 * are delegated to the caller via `handlers` because they touch
 * content.ts-owned state.
 */
export function loadConfig(handlers: ConfigHandlers): void {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) return;

  chrome.storage.sync.get(['badgeDisplayMode', 'hintVisibility'], (result) => {
    if (result.badgeDisplayMode) {
      displayMode = migrateDisplayMode(result.badgeDisplayMode);
    }
    if (result.hintVisibility) {
      hintVisibility = result.hintVisibility;
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.badgeDisplayMode) {
      displayMode = migrateDisplayMode(changes.badgeDisplayMode.newValue);
      handlers.onDisplayModeChange();
    }
    if (changes.hintVisibility) {
      hintVisibility = changes.hintVisibility.newValue || 'always';
      handlers.onHintVisibilityChange();
    }
  });
}

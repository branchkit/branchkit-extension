/**
 * BranchKit Browser — storage-backed user settings.
 *
 * Owns the two persisted display preferences read throughout content.ts —
 * badge display mode and hint visibility — plus the aggressive-hints
 * scanner toggle. State lives here (private); content.ts reads it through
 * getDisplayMode / getHintVisibility and applies side effects via the
 * handlers passed to loadConfig.
 *
 * Deliberately NOT here: the per-machine `alphabet` adoption (storage.local
 * + its onChanged branch). That's vocab adoption coupled to the delta-sync
 * session state (sessionId, pendingPuts, sentCodewords), not a user setting,
 * so it stays in content.ts. `activeCategory` likewise stays — it's runtime
 * UI state, not storage-backed.
 *
 * Extracted from content.ts as part of the extension restructure (step 1,
 * carve leaf concerns). See notes/DESIGN_EXTENSION_RESTRUCTURE.md.
 */

import { BadgeDisplayMode, HintHideKey, HintVisibility } from './types';
import { setExtraHintsEnabled } from './scan/scanner';
import { DEFAULT_HIDE_KEY, isComboAllowed, parseCombo } from './activate/key-combo';

/** Accept a stored combo only if it still passes the guardrail; else default. */
function sanitizeHideKey(value: unknown): HintHideKey {
  if (typeof value !== 'string') return DEFAULT_HIDE_KEY;
  const c = parseCombo(value);
  return c && isComboAllowed(c) ? value : DEFAULT_HIDE_KEY;
}

let displayMode: BadgeDisplayMode = 'letter';
let hintVisibility: HintVisibility = 'always';
// F-driven sticky show/hide. The mode (always/manual) decides what a fresh
// page does on its own; this is the user's explicit "hints on/off" intent,
// which overrides always-mode auto-show. Default on.
let hintsShown = true;
// User-chosen chord that toggles hints. Captured from a real keypress and
// stored as a combo string (see activate/key-combo.ts). Must carry a
// Ctrl/Alt/Meta modifier — bare keys collide with codeword typing in
// always-visible mode. Default Ctrl+F.
let hintHideKey: HintHideKey = DEFAULT_HIDE_KEY;

export function getDisplayMode(): BadgeDisplayMode {
  return displayMode;
}

export function getHintVisibility(): HintVisibility {
  return hintVisibility;
}

export function getHintHideKey(): HintHideKey {
  return hintHideKey;
}

export function getHintsShown(): boolean {
  return hintsShown;
}

// Persist the F state to storage.local (per-machine UI state, not a synced
// preference) so a hide/show survives navigation and browser restart. Read
// on every page load; propagates to other open frames/tabs via onChanged.
export function setHintsShown(value: boolean): void {
  hintsShown = value;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    chrome.storage.local.set({ hintsShown: value });
  }
}

export interface ConfigHandlers {
  /** badgeDisplayMode changed — re-label currently visible badges. */
  onDisplayModeChange: () => void;
  /** hintVisibility changed — show or hide hints to match the new value. */
  onHintVisibilityChange: () => void;
  /** hintsShown loaded from storage — reconcile this page's initial visibility. */
  onHintsShownLoaded: () => void;
  /** aggressiveHints toggled — re-scan so the wider/narrower selector applies. */
  onAggressiveHintsChange: () => void;
}

/**
 * Read the persisted settings from chrome.storage.sync and register an
 * onChanged listener that keeps them live. Side effects (re-label, show/hide,
 * re-scan) are delegated to the caller via `handlers` because they touch
 * content.ts-owned state. The aggressiveHints scanner flag is applied here
 * directly since it's a scanner setting, then the rescan is delegated.
 */
export function loadConfig(handlers: ConfigHandlers): void {
  if (typeof chrome === 'undefined' || !chrome.storage?.sync) return;

  chrome.storage.sync.get(['badgeDisplayMode', 'hintVisibility', 'aggressiveHints', 'hintHideKey'], (result) => {
    if (result.badgeDisplayMode) {
      displayMode = result.badgeDisplayMode;
    }
    if (result.hintVisibility) {
      hintVisibility = result.hintVisibility;
    }
    if (result.hintHideKey) {
      hintHideKey = sanitizeHideKey(result.hintHideKey);
    }
    setExtraHintsEnabled(result.aggressiveHints === true);
  });

  if (chrome.storage?.local) {
    chrome.storage.local.get(['hintsShown'], (result) => {
      if (typeof result.hintsShown === 'boolean') hintsShown = result.hintsShown;
      handlers.onHintsShownLoaded();
    });
  }

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.badgeDisplayMode) {
      displayMode = changes.badgeDisplayMode.newValue || 'letter';
      handlers.onDisplayModeChange();
    }
    if (changes.hintVisibility) {
      hintVisibility = changes.hintVisibility.newValue || 'always';
      handlers.onHintVisibilityChange();
    }
    if (changes.hintHideKey) {
      // Read live by the keydown listener — no side effect to apply here.
      hintHideKey = sanitizeHideKey(changes.hintHideKey.newValue);
    }
    if (changes.hintsShown) {
      // Keep the value current for this frame's next decision (e.g. an SPA
      // nav), but DON'T live-reconcile visibility here: reacting to our own
      // storage echo can hide a just-shown toggle, and manual mode can't
      // re-show. The F handler applies show/hide locally; new page loads
      // read this value via onHintsShownLoaded.
      hintsShown = changes.hintsShown.newValue !== false;  // absent/removed → on
    }
    if (changes.aggressiveHints) {
      // Toggle changed → re-scan so the wider/narrower selector takes
      // effect immediately. Caller clears the store first so already-hinted
      // elements that no longer qualify get torn down.
      setExtraHintsEnabled(changes.aggressiveHints.newValue === true);
      handlers.onAggressiveHintsChange();
    }
  });
}

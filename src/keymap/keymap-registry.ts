/**
 * BranchKit Browser — the live keymap, and the registry built from it.
 *
 * The registry is the matcher; the keymap (command-catalog.ts DEFAULT_KEYMAP,
 * overridable per-user via keymap-storage) is the source of truth for what's
 * bound to what. Building the registry from data (rather than hardcoded
 * registry.add calls) is what lets the options-page editor rebuild bindings
 * live via registry.replaceAll — see notes/DESIGN_KEYMAP_CONFIG.md.
 *
 * The default set, for reference: one binding per command, preferring the
 * always-mode form (Shift/modifier chords route to commands even with hints
 * painted; bare letters are codeword input then, so they'd be eaten).
 * Shift+J/K/D/U/T/G scroll; Shift+H/L cycle tabs; Shift+F toggles hints, `f`
 * enters hint mode, and a capital letter in hint mode opens in a new tab — the
 * trio that replaced the discrete show/hide/show-new-tab commands. A few
 * inherently-bare, hidden-only binds (h/l horizontal scroll, `cs`, `/`, `n`).
 * Users add extra binds (e.g. plain j) via the options editor.
 *
 * ## Why this is not part of `keymap-storage.ts`
 *
 * Storage is the layer BELOW this one and has to stay that way: palette-page.ts
 * imports it, and this module reaches `core/singletons` for the registry, which
 * constructs the KeyHandler and pulls in media, toast and the mode chip. Folding
 * the two together would put that whole closure into the palette bundle to read
 * a keymap out of chrome.storage. Same argument section 6g.7 made for
 * `scroller.ts`, and the reason this is a third file rather than a second.
 *
 * Installed explicitly rather than at import scope. The storage read and the
 * change subscription are I/O, and running them at some module's import time is
 * a boot order nobody chose — the same rule `installSiteKeyPolicy` follows, and
 * that `core/singletons` states for its own hooks.
 */

import { registry } from '../core/singletons';
import { DEFAULT_KEYMAP, type KeymapEntry } from './command-catalog';
import { loadKeymap, onKeymapChanged } from './keymap-storage';

// The effective keymap, kept in sync with the registry so the help overlay can
// render the user's actual binds (not just the defaults).
let currentKeymap: readonly KeymapEntry[] = DEFAULT_KEYMAP;

/**
 * The binds in force right now.
 *
 * A function, not the array: the help overlay reads it at OPEN time, and an
 * exported binding captured at import time would pin the defaults forever —
 * the user's stored keymap arrives from an async read, so a snapshot taken
 * early is exactly the wrong one. The overlay would open, render every group,
 * and quietly show factory binds.
 */
export function activeKeymap(): readonly KeymapEntry[] {
  return currentKeymap;
}

function buildRegistryFromKeymap(entries: readonly KeymapEntry[]): void {
  currentKeymap = entries;
  registry.replaceAll(
    entries.map((e) => ({ keys: e.keys, action: e.command, params: e.params })),
  );
}

/** Defaults synchronously so keybinds work before the async storage read
 *  returns; then apply the stored keymap (if any) and rebuild live on edits. */
export function installKeymapRegistry(): void {
  buildRegistryFromKeymap(DEFAULT_KEYMAP);
  if (typeof chrome !== 'undefined' && chrome.storage?.sync) {
    void loadKeymap().then(buildRegistryFromKeymap);
    onKeymapChanged(buildRegistryFromKeymap);
  }
}

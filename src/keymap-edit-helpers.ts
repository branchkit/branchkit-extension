/**
 * BranchKit Browser — pure helpers for the keymap editor.
 *
 * Display + validation logic, split out from the DOM wiring in
 * keymap-options.ts so it can be unit-tested.
 */

import { comboDisplay, parseCombo } from './activate/key-combo';
import type { KeymapEntry } from './command-catalog';

/** Sequence-aware human label: "shift+KeyH" → "Shift+H", "KeyG KeyG" → "G G". */
export function displayKeys(keys: string): string {
  return keys
    .split(' ')
    .map((t) => comboDisplay(t))
    .join(' ');
}

/**
 * Whether a binding actually fires while hints are visible (always-mode). In
 * that mode the matcher only routes real-modifier chords (Ctrl/Alt/Cmd) and a
 * Shift+letter to commands; bare keys are codeword-filter input and multi-key
 * sequences lose their 2nd key to the filter. So: a single combo with a real
 * modifier, OR Shift+letter.
 */
export function worksInAlwaysMode(keys: string): boolean {
  const tokens = keys.split(' ');
  if (tokens.length !== 1) return false; // sequence: 2nd key eaten by codeword filter
  const c = parseCombo(tokens[0]);
  if (!c) return false;
  if (c.ctrl || c.alt || c.meta) return true;
  if (c.shift && /^Key[A-Z]$/.test(c.code)) return true;
  return false;
}

/** Informational note for binds that only work with hints hidden (null if fine
 *  in always-mode). Not an error — the shipping defaults use bare keys. */
export function alwaysModeNote(keys: string): string | null {
  if (worksInAlwaysMode(keys)) return null;
  return 'Active only when hints are hidden — bare keys and sequences type hint codewords while hints are visible. Use Shift+letter or a Ctrl/Alt/Cmd chord for always-mode.';
}

/** Keys bound by more than one entry (conflicts). */
export function duplicateKeys(entries: readonly KeymapEntry[]): Set<string> {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.keys, (counts.get(e.keys) ?? 0) + 1);
  const dupes = new Set<string>();
  for (const [k, n] of counts) if (n > 1) dupes.add(k);
  return dupes;
}

/**
 * BranchKit Browser — pure helpers for the keymap editor.
 *
 * Display + validation logic, split out from the DOM wiring in
 * keymap-options.ts so it can be unit-tested.
 */

import { comboDisplay } from './activate/key-combo';
import type { KeymapEntry } from './command-catalog';

/** Sequence-aware human label: "shift+KeyH" → "Shift+H", "KeyG KeyG" → "G G". */
export function displayKeys(keys: string): string {
  return keys
    .split(' ')
    .map((t) => comboDisplay(t))
    .join(' ');
}

/** Keys bound by more than one entry (conflicts). */
export function duplicateKeys(entries: readonly KeymapEntry[]): Set<string> {
  const counts = new Map<string, number>();
  for (const e of entries) counts.set(e.keys, (counts.get(e.keys) ?? 0) + 1);
  const dupes = new Set<string>();
  for (const [k, n] of counts) if (n > 1) dupes.add(k);
  return dupes;
}

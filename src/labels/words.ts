/**
 * BranchKit Browser — Codeword alphabet and label formatting.
 *
 * The 26 codewords are pushed by BranchKit over SSE on connect.
 * Codeword-to-element assignment is handled by the per-tab label pool
 * (label-pool.ts), not here.
 */

import { BadgeDisplayMode } from '../types';

/** Map from word to its letter (e.g. "arch" → "A") */
export const WORD_TO_LETTER: Record<string, string> = {};

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';
const alphabet: string[] = [];

function rebuildMaps(): void {
  for (const k of Object.keys(WORD_TO_LETTER)) delete WORD_TO_LETTER[k];
  for (let i = 0; i < alphabet.length; i++) {
    WORD_TO_LETTER[alphabet[i]] = LETTERS[i];
  }
}

/** True once BranchKit has pushed a valid 26-word alphabet. */
export function isAlphabetLoaded(): boolean {
  return alphabet.length === 26;
}

/**
 * Replace the active 26 codewords with one received from BranchKit.
 * No-op if the input is the wrong length or has any blank entries.
 */
export function setAlphabet(words: string[]): boolean {
  if (!Array.isArray(words) || words.length !== 26) return false;
  if (words.some(w => typeof w !== 'string' || w.length === 0)) return false;
  alphabet.length = 0;
  alphabet.push(...words);
  rebuildMaps();
  return true;
}

export interface LabelAssignment {
  words: string[];    // e.g. ["arch"] or ["zoo", "arch"]
  letter: string;     // e.g. "A" or "ZA"
  isSingle: boolean;  // true = single codeword, false = pair
}

/**
 * Rebuild a LabelAssignment from a stored codeword string (the spoken
 * word form, e.g. "charlie golf" or "arch"). Used by the codeword
 * resolver to recompute a wrapper's displayed form for any mode.
 * Returns null for unknown words or more than two words.
 */
export function codewordToAssignment(codeword: string): LabelAssignment | null {
  const words = codeword.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length < 1 || words.length > 2) return null;
  let letter = '';
  for (const w of words) {
    const l = WORD_TO_LETTER[w];
    if (!l) return null;
    letter += l;
  }
  return { words, letter, isSingle: words.length === 1 };
}

/**
 * Format label for display based on display mode.
 */
export function labelToDisplay(assignment: LabelAssignment, mode: BadgeDisplayMode): string {
  switch (mode) {
    case 'word':
      return assignment.words.join(' ');
    case 'letter':
      return assignment.letter;
    case 'both':
      if (assignment.words.length === 1) {
        return `${assignment.letter} ${assignment.words[0]}`;
      }
      return assignment.words.join(' ');
    case 'first-word':
      if (assignment.words.length === 1) {
        return assignment.words[0];
      }
      return `${assignment.words[0]} ${WORD_TO_LETTER[assignment.words[1]] || assignment.letter[1] || ''}`;
  }
}

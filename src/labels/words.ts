/**
 * BranchKit Browser — letter labels + optional voice codeword overlay.
 *
 * Letters are the primary, extension-owned hint identity. The per-tab pool
 * (label-pool.ts) builds its tokens from `LETTERS_26`, so hints render and are
 * pickable by typing with BranchKit entirely absent.
 *
 * When BranchKit is present it pushes its 26-word alphabet over SSE; each
 * letter then gains a spoken codeword — the *voice overlay*. The overlay is
 * used only for (a) spoken-form badge display and (b) the service worker's
 * letter<->word translation at the plugin boundary. It never changes the
 * identity a wrapper holds: that stays letters.
 */

import { BadgeDisplayMode } from '../types';

// The 26 letters the pool builds its tokens from, in TYPING-ergonomic order:
// home row first, then top, then bottom. The pool's square-fill ordering uses
// this array head-first, so the earliest hints land on the most reachable
// keys. Extension-owned and always available.
export const LETTERS_26 = [
  'a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l',
  'q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p',
  'z', 'x', 'c', 'v', 'b', 'n', 'm',
];

// Alphabetical index for the voice overlay. BranchKit pushes its 26 codewords
// in A–Z order (word[0] is the word for 'a'), so we map each letter to the
// word at its alphabetical position — independent of LETTERS_26's typing order.
const LETTER_INDEX = 'abcdefghijklmnopqrstuvwxyz';

// Voice overlay maps, populated by setAlphabet, empty until BranchKit connects.
const LETTER_TO_WORD: Record<string, string> = {}; // 'a' -> 'arch'
/** Spoken word -> letter (the overlay inverse). Used by the SW to translate an
 *  inbound spoken codeword back to its letter token, and by the partial-prefix
 *  voice path. Empty until the voice alphabet is loaded. */
export const WORD_TO_LETTER: Record<string, string> = {};

// Cached load state so isVoiceAlphabetLoaded() is O(1) on the badge-paint hot
// path (no Object.keys allocation per pending badge). The maps are mutated only
// by setAlphabet + clearAlphabet, which keep this in sync.
let voiceAlphabetLoaded = false;

/** True once BranchKit has pushed a valid 26-word alphabet (voice addressing is
 *  available). Hints do NOT depend on this — only the spoken overlay does. */
export function isVoiceAlphabetLoaded(): boolean {
  return voiceAlphabetLoaded;
}

/**
 * Install BranchKit's 26-word alphabet as the voice overlay. No-op (returns
 * false) if the input is the wrong length or has any blank entries. Does NOT
 * touch the pool — letter identities are stable across alphabet changes.
 */
export function setAlphabet(words: string[]): boolean {
  if (!Array.isArray(words) || words.length !== 26) return false;
  if (words.some(w => typeof w !== 'string' || w.length === 0)) return false;
  for (const k of Object.keys(LETTER_TO_WORD)) delete LETTER_TO_WORD[k];
  for (const k of Object.keys(WORD_TO_LETTER)) delete WORD_TO_LETTER[k];
  for (let i = 0; i < 26; i++) {
    LETTER_TO_WORD[LETTER_INDEX[i]] = words[i];
    WORD_TO_LETTER[words[i]] = LETTER_INDEX[i];
  }
  voiceAlphabetLoaded = true;
  return true;
}

/** Clear the voice overlay (BranchKit disconnected / alphabet invalidated). */
export function clearAlphabet(): void {
  for (const k of Object.keys(LETTER_TO_WORD)) delete LETTER_TO_WORD[k];
  for (const k of Object.keys(WORD_TO_LETTER)) delete WORD_TO_LETTER[k];
  voiceAlphabetLoaded = false;
}

/** The spoken word for a letter, or the letter itself when no overlay loaded. */
export function letterToSpokenWord(letter: string): string {
  return LETTER_TO_WORD[letter] ?? letter;
}

/** The letter for a spoken word, or the input unchanged if it isn't an overlay
 *  word (already a letter, or unknown). */
export function spokenWordToLetter(word: string): string {
  return WORD_TO_LETTER[word] ?? word;
}

/**
 * Translate a pool token ("c g") to its spoken codeword ("cape glad") for the
 * plugin's voice grammar. Falls back to the letters with no overlay loaded.
 * Used by the service worker at the outbound grammar-push boundary.
 */
export function tokenToSpokenCodeword(token: string): string {
  return token.trim().split(/\s+/).filter(Boolean).map(letterToSpokenWord).join(' ');
}

/**
 * Translate an inbound spoken codeword ("cape glad") back to its pool token
 * ("c g") so it routes against the letter-keyed label pool / store. Words not
 * in the overlay pass through unchanged, so an already-letter token (from the
 * extension's own keyboard dispatcher) is a safe no-op. Used by the service
 * worker at the inbound voice-routing boundary.
 */
export function spokenCodewordToToken(codeword: string): string {
  return codeword.trim().split(/\s+/).filter(Boolean).map(spokenWordToLetter).join(' ');
}

export interface LabelAssignment {
  words: string[];    // the letter tokens, e.g. ["a"] or ["a", "s"]
  letter: string;     // joined letter form, e.g. "a" or "as"
  isSingle: boolean;  // true = single letter, false = pair
}

/**
 * Rebuild a LabelAssignment from a pool token (the letter form, e.g. "a s" or
 * "a"). Returns null for tokens that aren't one or two single a–z letters.
 */
export function codewordToAssignment(token: string): LabelAssignment | null {
  const words = token.trim().split(/\s+/).filter(w => w.length > 0);
  if (words.length < 1 || words.length > 2) return null;
  for (const w of words) {
    if (w.length !== 1 || !LETTER_INDEX.includes(w)) return null;
  }
  return { words, letter: words.join(''), isSingle: words.length === 1 };
}

/**
 * Format a label for display. Letter mode (the default) shows the letters and
 * needs no overlay — that's the standalone path. The word/both/first-word
 * modes show the spoken codeword via the voice overlay; with no overlay loaded
 * they fall back to the letters.
 */
export function labelToDisplay(assignment: LabelAssignment, mode: BadgeDisplayMode): string {
  const spoken = assignment.words.map(letterToSpokenWord);
  switch (mode) {
    case 'letter':
      return assignment.letter;
    case 'word':
      return spoken.join(' ');
    case 'both':
      if (assignment.isSingle) {
        return `${assignment.letter} ${spoken[0]}`;
      }
      return spoken.join(' ');
    case 'first-word':
      if (assignment.isSingle) {
        return spoken[0];
      }
      return `${spoken[0]} ${assignment.letter[1] ?? ''}`;
  }
}

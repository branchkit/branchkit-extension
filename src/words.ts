/**
 * BranchKit Browser — Prefix-free codeword labeling.
 *
 * The 26 codewords are split into two pools based on element count:
 *   - Singles: words that are complete commands (immediate execution)
 *   - Pair prefixes: words that always require a second word
 *
 * No word appears in both pools, so there's zero ambiguity:
 *   "arch"        → always a single, execute immediately
 *   "zoo"         → always a pair prefix, wait for second word
 *   "zoo arch"    → pair command, execute
 *
 * The split adapts to minimize pairs:
 *   30 elements → 25 singles + 1 prefix (1×26 pairs) = 51 capacity
 *   80 elements → 23 singles + 3 prefixes (3×26 pairs) = 101 capacity
 *  150 elements → 21 singles + 5 prefixes (5×26 pairs) = 151 capacity
 */

/**
 * 26 codewords, one per letter A-Z. Populated only via `setAlphabet()` from
 * the alphabet BranchKit pushes over SSE on connect. Until then the array
 * is empty and `assignLabels()` returns no labels — hint mode bails so we
 * never render badges that voice can't recognize.
 */
export const HINT_WORDS: string[] = [];

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Map from word to its letter (e.g. "arch" → "A") */
export const WORD_TO_LETTER: Record<string, string> = {};

/** Map from letter to word (e.g. "A" → "arch") */
export const LETTER_TO_WORD: Record<string, string> = {};

function rebuildMaps(): void {
  for (const k of Object.keys(WORD_TO_LETTER)) delete WORD_TO_LETTER[k];
  for (const k of Object.keys(LETTER_TO_WORD)) delete LETTER_TO_WORD[k];
  for (let i = 0; i < HINT_WORDS.length; i++) {
    WORD_TO_LETTER[HINT_WORDS[i]] = LETTERS[i];
    LETTER_TO_WORD[LETTERS[i]] = HINT_WORDS[i];
  }
}

/** True once BranchKit has pushed a valid 26-word alphabet. */
export function isAlphabetLoaded(): boolean {
  return HINT_WORDS.length === 26;
}

/**
 * Replace the active 26 codewords with one received from BranchKit.
 * No-op if the input is the wrong length or has any blank entries.
 */
export function setAlphabet(words: string[]): boolean {
  if (!Array.isArray(words) || words.length !== 26) return false;
  if (words.some(w => typeof w !== 'string' || w.length === 0)) return false;
  HINT_WORDS.length = 0;
  HINT_WORDS.push(...words);
  rebuildMaps();
  return true;
}

export interface LabelAssignment {
  words: string[];    // e.g. ["arch"] or ["zoo", "arch"]
  letter: string;     // e.g. "A" or "ZA"
  isSingle: boolean;  // true = immediate execute, false = pair prefix
}

/**
 * Compute the prefix-free split for a given element count.
 * Returns { singles, pairPrefixes } — the number of words in each pool.
 */
export function computeSplit(count: number): { singles: number; pairPrefixes: number } {
  const W = HINT_WORDS.length; // 26
  if (count <= W) {
    return { singles: count, pairPrefixes: 0 };
  }
  // Need P pair-prefix words: (W - P) singles + P×W pairs ≥ count
  // P ≥ (count - W) / (W - 1)
  const pairPrefixes = Math.min(W, Math.ceil((count - W) / (W - 1)));
  const singles = W - pairPrefixes;
  return { singles, pairPrefixes };
}

/** Maximum addressable elements once the alphabet is loaded: 26×26 = 676. */
export function maxLabels(): number {
  return HINT_WORDS.length * HINT_WORDS.length;
}

/**
 * Assign prefix-free labels to elements. Returns `[]` if no alphabet has
 * been pushed yet — callers should treat that as "hints unavailable".
 *
 * First `singles` elements get single-word labels from the start of the word list.
 * Remaining elements get pair labels using words from the end of the list as prefixes.
 */
export function assignLabels(count: number): LabelAssignment[] {
  if (!isAlphabetLoaded()) return [];
  const labels: LabelAssignment[] = [];
  const capped = Math.min(count, maxLabels());
  const { singles, pairPrefixes } = computeSplit(capped);

  // Singles: first `singles` words
  for (let i = 0; i < singles; i++) {
    labels.push({
      words: [HINT_WORDS[i]],
      letter: LETTERS[i],
      isSingle: true,
    });
  }

  // Pairs: prefix words are the last `pairPrefixes` words in the list
  const pairStartIdx = HINT_WORDS.length - pairPrefixes;
  let pairCount = 0;
  const needed = capped - singles;

  for (let p = 0; p < pairPrefixes && pairCount < needed; p++) {
    const prefixIdx = pairStartIdx + p;
    for (let s = 0; s < HINT_WORDS.length && pairCount < needed; s++) {
      labels.push({
        words: [HINT_WORDS[prefixIdx], HINT_WORDS[s]],
        letter: LETTERS[prefixIdx] + LETTERS[s],
        isSingle: false,
      });
      pairCount++;
    }
  }

  return labels;
}

/**
 * Format label for display based on display mode.
 */
export function labelToDisplay(assignment: LabelAssignment, mode: 'word' | 'letter' | 'both'): string {
  switch (mode) {
    case 'word':
      return assignment.words.join(' ');
    case 'letter':
      return assignment.letter;
    case 'both':
      // Only show both for single-word hints (pairs are too wide)
      if (assignment.words.length === 1) {
        return `${assignment.letter} ${assignment.words[0]}`;
      }
      return assignment.words.join(' ');
  }
}

/**
 * BranchKit Browser — Prefix-free codeword labeling.
 *
 * The 26 codewords are split into two pools based on element count:
 *   - Singles: words that are complete commands (immediate execution)
 *   - Pair prefixes: words that always require a second word
 *
 * No word appears in both pools, so there's zero ambiguity:
 *   "ape"       → always a single, execute immediately
 *   "quartz"    → always a pair prefix, wait for second word
 *   "quartz ape"→ pair command, execute
 *
 * The split adapts to minimize pairs:
 *   30 elements → 25 singles + 1 prefix (1×26 pairs) = 51 capacity
 *   80 elements → 23 singles + 3 prefixes (3×26 pairs) = 101 capacity
 *  150 elements → 21 singles + 5 prefixes (5×26 pairs) = 151 capacity
 */

export const HINT_WORDS: string[] = [
  'ape', 'beam', 'chip', 'dash', 'elf', 'flux', 'glow', 'hex',
  'ink', 'jet', 'kit', 'loom', 'mesh', 'nex', 'oak', 'pod',
  'quartz', 'ritz', 'sox', 'tick', 'unit', 'volt', 'wick',
  'xen', 'yoke', 'zone',
];

export const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Map from word to its letter (e.g. "ape" → "A") */
export const WORD_TO_LETTER: Record<string, string> = {};
for (let i = 0; i < HINT_WORDS.length; i++) {
  WORD_TO_LETTER[HINT_WORDS[i]] = LETTERS[i];
}

/** Map from letter to word (e.g. "A" → "ape") */
export const LETTER_TO_WORD: Record<string, string> = {};
for (let i = 0; i < HINT_WORDS.length; i++) {
  LETTER_TO_WORD[LETTERS[i]] = HINT_WORDS[i];
}

export interface LabelAssignment {
  words: string[];    // e.g. ["ape"] or ["quartz", "ape"]
  letter: string;     // e.g. "A" or "QA"
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

/** Maximum addressable elements: 26 singles + 0 pairs, or 0 singles + 26×26 pairs */
export const MAX_LABELS = HINT_WORDS.length * HINT_WORDS.length; // 676

/**
 * Assign prefix-free labels to elements.
 *
 * First `singles` elements get single-word labels from the start of the word list.
 * Remaining elements get pair labels using words from the end of the list as prefixes.
 */
export function assignLabels(count: number): LabelAssignment[] {
  const labels: LabelAssignment[] = [];
  const capped = Math.min(count, MAX_LABELS);
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

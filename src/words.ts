/**
 * BranchKit Extension — 26 alphabet codewords for hint labels.
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
  words: string[];    // e.g. ["ape"] or ["ape", "chip"]
  letter: string;     // e.g. "A" or "AC"
}

/**
 * Assign labels to elements sorted by viewport position.
 * Returns labels indexed same as input array.
 */
export function assignLabels(count: number): LabelAssignment[] {
  const labels: LabelAssignment[] = [];
  const needsPair = count > HINT_WORDS.length;

  for (let i = 0; i < count; i++) {
    if (needsPair) {
      const first = Math.floor(i / HINT_WORDS.length);
      const second = i % HINT_WORDS.length;
      labels.push({
        words: [HINT_WORDS[first], HINT_WORDS[second]],
        letter: LETTERS[first] + LETTERS[second],
      });
    } else {
      labels.push({
        words: [HINT_WORDS[i]],
        letter: LETTERS[i],
      });
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

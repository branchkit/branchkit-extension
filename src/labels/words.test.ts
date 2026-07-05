import { describe, it, expect, beforeEach } from 'vitest';
import {
  setAlphabet,
  clearAlphabet,
  isVoiceAlphabetLoaded,
  letterToSpokenWord,
  labelToDisplay,
  migrateDisplayMode,
  codewordToAssignment,
  LabelAssignment,
  WORD_TO_LETTER,
} from './words';

// BranchKit's voice alphabet: word[i] is the spoken word for the i-th letter
// (a, b, c, ...). So letter 'c' -> 'cape', 'g' -> 'glad', 'd' -> 'dune'.
const ALPHABET = [
  'arch', 'bake', 'cape', 'dune', 'elm', 'frog', 'glad', 'half', 'iron', 'jake',
  'kind', 'lime', 'make', 'none', 'own', 'plan', 'quick', 'rain', 'song', 'take',
  'under', 'voice', 'work', 'xray', 'yoga', 'zoo',
];

describe('voice overlay (setAlphabet)', () => {
  beforeEach(() => clearAlphabet());

  it('maps each letter to the word at its alphabetical index', () => {
    expect(setAlphabet(ALPHABET)).toBe(true);
    expect(isVoiceAlphabetLoaded()).toBe(true);
    expect(letterToSpokenWord('a')).toBe('arch');
    expect(letterToSpokenWord('c')).toBe('cape');
    expect(letterToSpokenWord('g')).toBe('glad');
    expect(WORD_TO_LETTER['dune']).toBe('d');
    expect(WORD_TO_LETTER['glad']).toBe('g');
  });

  it('rejects an alphabet of the wrong length or with blanks', () => {
    expect(setAlphabet(['too', 'short'])).toBe(false);
    const blank = [...ALPHABET];
    blank[4] = '';
    expect(setAlphabet(blank)).toBe(false);
    expect(isVoiceAlphabetLoaded()).toBe(false);
  });

  it('falls back to the letter itself when no overlay is loaded', () => {
    expect(isVoiceAlphabetLoaded()).toBe(false);
    expect(letterToSpokenWord('c')).toBe('c');
  });
});

describe('codewordToAssignment — letter tokens', () => {
  it('rebuilds a pair assignment from its letters', () => {
    expect(codewordToAssignment('c g')).toEqual({
      words: ['c', 'g'],
      letter: 'cg',
      isSingle: false,
    });
  });

  it('rebuilds a single assignment', () => {
    expect(codewordToAssignment('a')).toEqual({
      words: ['a'],
      letter: 'a',
      isSingle: true,
    });
  });

  it('tolerates extra whitespace', () => {
    expect(codewordToAssignment('  c   g ')).toEqual({
      words: ['c', 'g'],
      letter: 'cg',
      isSingle: false,
    });
  });

  it('returns null for non-letter tokens', () => {
    expect(codewordToAssignment('cape glad')).toBeNull(); // multi-char tokens
    expect(codewordToAssignment('1 2')).toBeNull();
  });

  it('returns null for empty or more than two tokens', () => {
    expect(codewordToAssignment('')).toBeNull();
    expect(codewordToAssignment('a s d')).toBeNull();
  });
});

describe('labelToDisplay', () => {
  beforeEach(() => setAlphabet(ALPHABET));

  it('letter mode shows the letters (no overlay needed)', () => {
    const label = codewordToAssignment('c g')!;
    expect(labelToDisplay(label, 'letter')).toBe('cg');
  });

  it('word mode shows the spoken codeword via the overlay', () => {
    const label = codewordToAssignment('c g')!;
    expect(labelToDisplay(label, 'word')).toBe('cape glad');
  });

  it('word mode for a single letter shows just the spoken word', () => {
    const label = codewordToAssignment('a')!;
    expect(labelToDisplay(label, 'word')).toBe('arch');
  });

  it('expand mode shows the first spoken word + the second letter', () => {
    const label = codewordToAssignment('c g')!;
    expect(labelToDisplay(label, 'expand')).toBe('cape g');
  });

  it('round-trips a token through every mode', () => {
    const a = codewordToAssignment('c g')!;
    expect(labelToDisplay(a, 'letter')).toBe('cg');
    expect(labelToDisplay(a, 'word')).toBe('cape glad');
    expect(labelToDisplay(a, 'expand')).toBe('cape g');
  });

  it('migrates legacy display-mode values onto the current set', () => {
    expect(migrateDisplayMode('first-word')).toBe('expand');
    expect(migrateDisplayMode('both')).toBe('word');
    expect(migrateDisplayMode('word')).toBe('word');
    expect(migrateDisplayMode('bogus')).toBe('letter');
  });
});

describe('labelToDisplay — standalone (no overlay)', () => {
  beforeEach(() => clearAlphabet());

  it('word/expand modes fall back to the letters', () => {
    const pair: LabelAssignment = { words: ['c', 'g'], letter: 'cg', isSingle: false };
    expect(labelToDisplay(pair, 'word')).toBe('c g');
    expect(labelToDisplay(pair, 'letter')).toBe('cg');
    expect(labelToDisplay(pair, 'expand')).toBe('c g');
    const single: LabelAssignment = { words: ['a'], letter: 'a', isSingle: true };
    expect(labelToDisplay(single, 'expand')).toBe('a');
  });
});

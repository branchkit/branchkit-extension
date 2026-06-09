import { describe, it, expect, beforeEach } from 'vitest';
import {
  setAlphabet,
  labelToDisplay,
  codewordToAssignment,
  LabelAssignment,
  WORD_TO_LETTER,
} from './words';

const ALPHABET = [
  'arch', 'bake', 'cape', 'dune', 'elm', 'frog', 'glad', 'half', 'iron', 'jake',
  'kind', 'lime', 'make', 'none', 'own', 'plan', 'quick', 'rain', 'song', 'take',
  'under', 'voice', 'work', 'xray', 'yoga', 'zoo',
];

beforeEach(() => {
  setAlphabet(ALPHABET);
});

describe('labelToDisplay — first-word mode', () => {
  it('two-word label shows first word + second letter', () => {
    const label: LabelAssignment = { words: ['arch', 'lime'], letter: 'al', isSingle: false };
    expect(labelToDisplay(label, 'first-word')).toBe('arch l');
  });

  it('uses WORD_TO_LETTER for the second position', () => {
    const label: LabelAssignment = { words: ['bake', 'dune'], letter: 'bd', isSingle: false };
    expect(WORD_TO_LETTER['dune']).toBe('d');
    expect(labelToDisplay(label, 'first-word')).toBe('bake d');
  });

  it('single-word label shows just the word', () => {
    const label: LabelAssignment = { words: ['arch'], letter: 'a', isSingle: true };
    expect(labelToDisplay(label, 'first-word')).toBe('arch');
  });

  it('falls back to letter[1] if second word not in WORD_TO_LETTER', () => {
    const label: LabelAssignment = { words: ['arch', 'unknown'], letter: 'au', isSingle: false };
    expect(labelToDisplay(label, 'first-word')).toBe('arch u');
  });
});

describe('labelToDisplay — existing modes unchanged', () => {
  it('letter mode returns letter string', () => {
    const label: LabelAssignment = { words: ['arch', 'lime'], letter: 'al', isSingle: false };
    expect(labelToDisplay(label, 'letter')).toBe('al');
  });

  it('word mode returns space-joined words', () => {
    const label: LabelAssignment = { words: ['arch', 'lime'], letter: 'al', isSingle: false };
    expect(labelToDisplay(label, 'word')).toBe('arch lime');
  });

  it('both mode for single word shows letter + word', () => {
    const label: LabelAssignment = { words: ['arch'], letter: 'a', isSingle: true };
    expect(labelToDisplay(label, 'both')).toBe('a arch');
  });
});

describe('codewordToAssignment', () => {
  it('rebuilds a pair assignment with its letter form', () => {
    expect(codewordToAssignment('cape glad')).toEqual({
      words: ['cape', 'glad'],
      letter: 'cg',
      isSingle: false,
    });
  });

  it('rebuilds a single assignment', () => {
    expect(codewordToAssignment('arch')).toEqual({
      words: ['arch'],
      letter: 'a',
      isSingle: true,
    });
  });

  it('tolerates extra whitespace', () => {
    expect(codewordToAssignment('  cape   glad ')).toEqual({
      words: ['cape', 'glad'],
      letter: 'cg',
      isSingle: false,
    });
  });

  it('round-trips through labelToDisplay for every mode', () => {
    const a = codewordToAssignment('cape glad')!;
    expect(labelToDisplay(a, 'letter')).toBe('cg');
    expect(labelToDisplay(a, 'word')).toBe('cape glad');
    expect(labelToDisplay(a, 'first-word')).toBe('cape g');
  });

  it('returns null for an unknown word', () => {
    expect(codewordToAssignment('cape zzz')).toBeNull();
    expect(codewordToAssignment('nope')).toBeNull();
  });

  it('returns null for empty or more than two words', () => {
    expect(codewordToAssignment('')).toBeNull();
    expect(codewordToAssignment('cape glad arch')).toBeNull();
  });
});

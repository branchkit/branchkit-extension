import { describe, it, expect } from 'vitest';
import { assignCodewords, codewordDisplay, classifyMarkInput, maxVoiceRows } from './codewords';

// A–Z order, as BranchKit pushes it.
const ALPHABET = [
  'arch', 'bolt', 'crane', 'drum', 'echo', 'flame', 'grove', 'harp', 'iris',
  'jade', 'kite', 'lamp', 'moss', 'nest', 'ocean', 'pearl', 'quill', 'reef',
  'stone', 'tide', 'urn', 'vine', 'wave', 'xray', 'yarn', 'zone',
];

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `row:${i}`);

describe('assignCodewords', () => {
  it('badges every row with a two-word pair (uniform length = chop safety)', () => {
    const m = assignCodewords(ids(40), ALPHABET);
    expect(m.size).toBe(40);
    for (const cw of m.values()) {
      const words = cw.split(' ');
      expect(words.length).toBe(2);
      expect(ALPHABET).toContain(words[0]);
      expect(ALPHABET).toContain(words[1]);
      expect(words[0]).not.toBe(words[1]); // no doubled pairs
    }
    expect(m.get('row:0')).toBe('arch bolt');
  });

  it('no key is a prefix of another (a chopped pair matches nothing)', () => {
    const m = assignCodewords(ids(maxVoiceRows()), ALPHABET);
    const keys = new Set(m.values());
    for (const cw of keys) {
      const [first] = cw.split(' ');
      expect(keys.has(first), `bare "${first}" must not be a key`).toBe(false);
    }
  });

  it('caps at 650 pairs (26×25) — no triples ever needed', () => {
    expect(maxVoiceRows()).toBe(650);
    const m = assignCodewords(ids(maxVoiceRows() + 10), ALPHABET);
    expect(m.size).toBe(maxVoiceRows());
    expect(new Set(m.values()).size).toBe(m.size); // all unique
  });

  it('is deterministic for a given row order', () => {
    const a = assignCodewords(ids(50), ALPHABET);
    const b = assignCodewords(ids(50), ALPHABET);
    expect([...a.entries()]).toEqual([...b.entries()]);
  });

  it('returns an empty map without a valid 26-word alphabet', () => {
    expect(assignCodewords(ids(5), []).size).toBe(0);
    expect(assignCodewords(ids(5), ALPHABET.slice(0, 25)).size).toBe(0);
    expect(assignCodewords(ids(5), [...ALPHABET.slice(0, 25), '']).size).toBe(0);
  });
});

describe('classifyMarkInput (tab palette letter-jump)', () => {
  // Prefix-free marks: singles from the head, pairs from a disjoint tail.
  const marks = ['a', 'b', 'c', 'iz', 'io', 'zx'];

  it('exact single-letter mark → jump on one keystroke', () => {
    expect(classifyMarkInput(marks, 'a')).toBe('exact');
  });

  it('first letter of a pair → prefix (narrow, wait for the second)', () => {
    expect(classifyMarkInput(marks, 'i')).toBe('prefix');
  });

  it('completed pair → exact', () => {
    expect(classifyMarkInput(marks, 'iz')).toBe('exact');
  });

  it('a letter no mark uses → none (keystroke ignored)', () => {
    expect(classifyMarkInput(marks, 'q')).toBe('none');
    expect(classifyMarkInput(marks, 'ix')).toBe('none'); // no "ix" pair
  });
});

describe('codewordDisplay', () => {
  // Mirrors labels/words.ts labelToDisplay so palette badges and page hints
  // read the same under every badgeDisplayMode value.
  it('letter mode shows the letter(s)', () => {
    expect(codewordDisplay('arch', ALPHABET, 'letter')).toBe('a');
    expect(codewordDisplay('ocean pearl', ALPHABET, 'letter')).toBe('op');
  });

  it('word mode shows the spoken form', () => {
    expect(codewordDisplay('arch', ALPHABET, 'word')).toBe('arch');
    expect(codewordDisplay('ocean pearl', ALPHABET, 'word')).toBe('ocean pearl');
  });

  it('expand mode shows word for singles, word+letter for pairs', () => {
    expect(codewordDisplay('arch', ALPHABET, 'expand')).toBe('arch');
    expect(codewordDisplay('ocean pearl', ALPHABET, 'expand')).toBe('ocean p');
  });
});

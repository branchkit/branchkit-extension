import { describe, it, expect } from 'vitest';
import { assignCodewords, codewordDisplay, maxVoiceRows } from './codewords';

// A–Z order, as BranchKit pushes it.
const ALPHABET = [
  'arch', 'bolt', 'crane', 'drum', 'echo', 'flame', 'grove', 'harp', 'iris',
  'jade', 'kite', 'lamp', 'moss', 'nest', 'ocean', 'pearl', 'quill', 'reef',
  'stone', 'tide', 'urn', 'vine', 'wave', 'xray', 'yarn', 'zone',
];

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `row:${i}`);

describe('assignCodewords', () => {
  it('gives the first 14 rows single-word badges from the alphabet head', () => {
    const m = assignCodewords(ids(14), ALPHABET);
    expect(m.get('row:0')).toBe('arch');
    expect(m.get('row:13')).toBe('nest');
  });

  it('gives later rows pairs drawn only from the alphabet tail', () => {
    const m = assignCodewords(ids(20), ALPHABET);
    const tail = new Set(ALPHABET.slice(14));
    for (let i = 14; i < 20; i++) {
      const cw = m.get(`row:${i}`)!;
      const [a, b] = cw.split(' ');
      expect(tail.has(a)).toBe(true);
      expect(tail.has(b)).toBe(true);
      expect(a).not.toBe(b); // no doubled pairs
    }
    expect(m.get('row:14')).toBe('ocean pearl');
  });

  it('never uses a single badge word as a pair word (chop safety)', () => {
    const m = assignCodewords(ids(maxVoiceRows()), ALPHABET);
    const singles = new Set(ALPHABET.slice(0, 14));
    for (const [id, cw] of m) {
      const words = cw.split(' ');
      if (words.length === 2) {
        expect(singles.has(words[0]), `${id}: ${cw}`).toBe(false);
        expect(singles.has(words[1]), `${id}: ${cw}`).toBe(false);
      }
    }
  });

  it('assigns unique codewords up to maxVoiceRows and stops after', () => {
    const m = assignCodewords(ids(maxVoiceRows() + 10), ALPHABET);
    expect(m.size).toBe(maxVoiceRows());
    expect(new Set(m.values()).size).toBe(m.size);
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

  it('both mode pairs letter+word for singles, words for pairs', () => {
    expect(codewordDisplay('arch', ALPHABET, 'both')).toBe('a arch');
    expect(codewordDisplay('ocean pearl', ALPHABET, 'both')).toBe('ocean pearl');
  });

  it('first-word mode shows word for singles, word+letter for pairs', () => {
    expect(codewordDisplay('arch', ALPHABET, 'first-word')).toBe('arch');
    expect(codewordDisplay('ocean pearl', ALPHABET, 'first-word')).toBe('ocean p');
  });
});

import { describe, it, expect } from 'vitest';
import {
  assignCodewords, codewordDisplay, codewordLength, classifyMarkInput, maxVoiceRows,
  splitSpokenBadge,
} from './codewords';

// A–Z order, as BranchKit pushes it.
const ALPHABET = [
  'arch', 'bolt', 'crane', 'drum', 'echo', 'flame', 'grove', 'harp', 'iris',
  'jade', 'kite', 'lamp', 'moss', 'nest', 'ocean', 'pearl', 'quill', 'reef',
  'stone', 'tide', 'urn', 'vine', 'wave', 'xray', 'yarn', 'zone',
];

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `row:${i}`);

/** Every badge in the map is `len` distinct alphabet words; all unique. */
function expectUniform(m: Map<string, string>, len: number): void {
  expect(new Set(m.values()).size).toBe(m.size);
  for (const cw of m.values()) {
    const words = cw.split(' ');
    expect(words.length).toBe(len);
    for (const w of words) expect(ALPHABET).toContain(w);
    expect(new Set(words).size).toBe(words.length); // no repeated word in a key
  }
}

describe('codewordLength (tier per row count)', () => {
  it('picks the smallest tier that covers the whole list', () => {
    expect(codewordLength(1)).toBe(1);
    expect(codewordLength(26)).toBe(1);
    expect(codewordLength(27)).toBe(2);
    expect(codewordLength(650)).toBe(2);
    expect(codewordLength(651)).toBe(3);
    expect(codewordLength(20000)).toBe(3);
  });
});

describe('assignCodewords', () => {
  it('26 rows or fewer → uniform singles (no multi-word keys, chop impossible)', () => {
    const m = assignCodewords(ids(26), ALPHABET);
    expect(m.size).toBe(26);
    expectUniform(m, 1);
    expect(m.get('row:0')).toBe('arch');
    expect(m.get('row:25')).toBe('zone');
  });

  it('27–650 rows → uniform pairs', () => {
    const m = assignCodewords(ids(40), ALPHABET);
    expect(m.size).toBe(40);
    expectUniform(m, 2);
    expect(m.get('row:0')).toBe('arch bolt');
  });

  it('above 650 rows → uniform triples', () => {
    const m = assignCodewords(ids(700), ALPHABET);
    expect(m.size).toBe(700);
    expectUniform(m, 3);
    expect(m.get('row:0')).toBe('arch bolt crane');
  });

  it('no key is a prefix of another (uniform length in every tier = chop safety)', () => {
    for (const n of [26, 650, 800]) {
      const keys = [...assignCodewords(ids(n), ALPHABET).values()];
      const keySet = new Set(keys);
      for (const cw of keys) {
        const words = cw.split(' ');
        for (let cut = 1; cut < words.length; cut++) {
          const chopped = words.slice(0, cut).join(' ');
          expect(keySet.has(chopped), `chopped "${chopped}" of "${cw}" must not be a key`).toBe(false);
        }
      }
    }
  });

  it('caps at 15600 triples (26×25×24) — the rest go unbadged', () => {
    expect(maxVoiceRows()).toBe(15600);
    const m = assignCodewords(ids(maxVoiceRows() + 10), ALPHABET);
    expect(m.size).toBe(maxVoiceRows());
    expect(new Set(m.values()).size).toBe(m.size); // all unique
    expect(m.has(`row:${maxVoiceRows()}`)).toBe(false);
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
    expect(codewordDisplay('ocean pearl quill', ALPHABET, 'letter')).toBe('opq');
  });

  it('word mode shows the spoken form', () => {
    expect(codewordDisplay('arch', ALPHABET, 'word')).toBe('arch');
    expect(codewordDisplay('ocean pearl', ALPHABET, 'word')).toBe('ocean pearl');
  });

  it('expand mode shows word for singles, word + tail letters otherwise', () => {
    expect(codewordDisplay('arch', ALPHABET, 'expand')).toBe('arch');
    expect(codewordDisplay('ocean pearl', ALPHABET, 'expand')).toBe('ocean p');
    expect(codewordDisplay('ocean pearl quill', ALPHABET, 'expand')).toBe('ocean pq');
  });
});

describe('splitSpokenBadge (already-spoken half of a badge)', () => {
  // The regression this exists for. A tabs-scope badge is a bare mark ("op"),
  // and the old whitespace-only split saw ONE segment — so speaking the first
  // word faded the whole badge, reading as "this row is out" instead of "the o
  // is spent, say the p". Page hints branch per display mode in
  // setMatchedChars; this states the same rule once, over the rendered string.
  it('consumes one CHARACTER per word in letter form', () => {
    expect(splitSpokenBadge('op', 1)).toEqual({ done: 'o', rest: 'p' });
    expect(splitSpokenBadge('opq', 2)).toEqual({ done: 'op', rest: 'q' });
  });

  it('consumes one WORD per word in spaced form', () => {
    expect(splitSpokenBadge('ocean pearl', 1)).toEqual({ done: 'ocean', rest: ' pearl' });
    // expand form: first word spelled out, tail as letters.
    expect(splitSpokenBadge('ocean p', 1)).toEqual({ done: 'ocean', rest: ' p' });
  });

  it('nothing consumed leaves the badge whole', () => {
    expect(splitSpokenBadge('ocean pearl', 0)).toEqual({ done: '', rest: 'ocean pearl' });
    expect(splitSpokenBadge('op', -1)).toEqual({ done: '', rest: 'op' });
  });

  // The holder and the badge can disagree for a frame during teardown; an
  // over-long prefix consumes everything rather than throwing or dropping text.
  it('clamps a prefix longer than the badge', () => {
    expect(splitSpokenBadge('op', 5)).toEqual({ done: 'op', rest: '' });
    expect(splitSpokenBadge('ocean pearl', 9)).toEqual({ done: 'ocean pearl', rest: '' });
  });

  // The property the caller depends on: the two halves reassemble the badge,
  // so no rendering path can silently lose or duplicate a character.
  it('done + rest always reconstructs the badge', () => {
    for (const badge of ['o', 'op', 'opq', 'ocean pearl', 'ocean p', 'ocean pearl quill']) {
      for (let n = -1; n <= 5; n++) {
        const { done, rest } = splitSpokenBadge(badge, n);
        expect(done + rest).toBe(badge);
      }
    }
  });
});

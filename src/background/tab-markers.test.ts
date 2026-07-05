import { describe, it, expect } from 'vitest';
import {
  buildMarkerSequence, assignMarker, releaseMarker, markToSpokenWords,
  parseMarker, MARKER_SINGLES, type MarkerMap,
} from './tab-markers';
import { stripTabMarker, decorateTitle, hasTabMarker } from '../tab-marker-format';
import { LETTERS_26 } from '../labels/words';

const ALPHABET = [
  'arch', 'bolt', 'crane', 'drum', 'echo', 'flame', 'grove', 'harp', 'iris',
  'jade', 'kite', 'lamp', 'moss', 'nest', 'ocean', 'pearl', 'quill', 'reef',
  'stone', 'tide', 'urn', 'vine', 'wave', 'xray', 'yarn', 'zone',
];

describe('buildMarkerSequence (letter-first)', () => {
  it('is single letters (ergonomic head) then pairs, no voice dependency', () => {
    const seq = buildMarkerSequence(16);
    expect(seq.slice(0, 16)).toEqual(LETTERS_26.slice(0, 16));
    expect(seq[16]).toHaveLength(2); // first pair, two letters concatenated
  });

  it('draws pair letters only from the tail — prefix-free', () => {
    const seq = buildMarkerSequence(16);
    const heads = new Set(LETTERS_26.slice(0, 16));
    for (const m of seq.filter((s) => s.length === 2)) {
      for (const ch of m) expect(heads.has(ch)).toBe(false);
    }
  });

  it('no single-letter mark is a prefix of any pair (one-keystroke jump)', () => {
    const seq = buildMarkerSequence(16);
    const singles = seq.filter((m) => m.length === 1);
    for (const s of singles) {
      expect(seq.some((m) => m.length === 2 && m[0] === s)).toBe(false);
    }
  });

  it('capacity is S + P·(P−1)', () => {
    expect(buildMarkerSequence(16)).toHaveLength(16 + 10 * 9); // 106
    expect(buildMarkerSequence(20)).toHaveLength(20 + 6 * 5);  // 50
  });
});

describe('markToSpokenWords (voice overlay)', () => {
  it('maps each letter to its alphabet word by alphabetical position', () => {
    expect(markToSpokenWords('a', ALPHABET)).toBe('arch');
    // i = index 8 → iris, z = index 25 → zone
    expect(markToSpokenWords('iz', ALPHABET)).toBe('iris zone');
  });

  it('is empty without a valid alphabet (voice absent; letter still works)', () => {
    expect(markToSpokenWords('a', [])).toBe('');
  });
});

describe('assignMarker / releaseMarker', () => {
  const seq = buildMarkerSequence(16);

  it('hands out single letters first, in order', () => {
    let map: MarkerMap = {};
    map = { ...map, 1: assignMarker(map, 1, seq)! };
    map = { ...map, 2: assignMarker(map, 2, seq)! };
    expect(map[1]).toBe(LETTERS_26[0]);
    expect(map[2]).toBe(LETTERS_26[1]);
  });

  it('keeps a tab’s existing marker (stability)', () => {
    const map: MarkerMap = { 1: 'g' };
    expect(assignMarker(map, 1, seq)).toBe('g');
  });

  it('never hands the same marker to two live tabs', () => {
    const first = LETTERS_26[0];
    const map: MarkerMap = { 1: first };
    expect(assignMarker(map, 2, seq)).toBe(LETTERS_26[1]);
  });

  it('re-grants a preferred marker when free (reconciliation)', () => {
    const map: MarkerMap = { 1: LETTERS_26[0] };
    expect(assignMarker(map, 2, seq, LETTERS_26[3])).toBe(LETTERS_26[3]);
  });

  it('returns null when the pool is exhausted', () => {
    const map: MarkerMap = {};
    seq.forEach((m, i) => { map[i] = m; });
    expect(assignMarker(map, 9999, seq)).toBeNull();
  });

  it('release returns the marker to the free pool', () => {
    const map: MarkerMap = { 1: LETTERS_26[0], 2: LETTERS_26[1] };
    const after = releaseMarker(map, 1);
    expect(after).toEqual({ 2: LETTERS_26[1] });
    expect(assignMarker(after, 3, seq)).toBe(LETTERS_26[0]); // freed single reused first
  });
});

describe('title decoration round-trip', () => {
  it('decorate then strip recovers the bare title', () => {
    const decorated = decorateTitle('a', 'GitHub — pulls');
    expect(decorated).toBe('[a] GitHub — pulls');
    expect(hasTabMarker(decorated)).toBe(true);
    expect(stripTabMarker(decorated)).toBe('GitHub — pulls');
  });

  it('parseMarker recovers the letter token for reconciliation', () => {
    expect(parseMarker(decorateTitle('iz', 'Docs'))).toBe('iz');
    expect(parseMarker('Undecorated')).toBeNull();
  });
});

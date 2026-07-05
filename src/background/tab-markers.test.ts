import { describe, it, expect } from 'vitest';
import {
  buildMarkerSequence, assignMarker, releaseMarker, markerLetters,
  parseMarkerLetters, MARKER_SINGLES, type MarkerMap,
} from './tab-markers';
import { stripTabMarker, decorateTitle, hasTabMarker } from '../tab-marker-format';

const ALPHABET = [
  'arch', 'bolt', 'crane', 'drum', 'echo', 'flame', 'grove', 'harp', 'iris',
  'jade', 'kite', 'lamp', 'moss', 'nest', 'ocean', 'pearl', 'quill', 'reef',
  'stone', 'tide', 'urn', 'vine', 'wave', 'xray', 'yarn', 'zone',
];

describe('buildMarkerSequence', () => {
  it('puts single-word markers (alphabet head) before pairs', () => {
    const seq = buildMarkerSequence(ALPHABET, 16);
    expect(seq.slice(0, 16)).toEqual(ALPHABET.slice(0, 16));
    expect(seq[16]).toContain(' '); // first pair
  });

  it('draws pair words only from the tail — prefix-free by construction', () => {
    const seq = buildMarkerSequence(ALPHABET, 16);
    const heads = new Set(ALPHABET.slice(0, 16));
    for (const m of seq.filter((s) => s.includes(' '))) {
      for (const w of m.split(' ')) expect(heads.has(w)).toBe(false);
    }
  });

  it('capacity is S + P·(P−1)', () => {
    expect(buildMarkerSequence(ALPHABET, 16)).toHaveLength(16 + 10 * 9); // 106
    expect(buildMarkerSequence(ALPHABET, 20)).toHaveLength(20 + 6 * 5);  // 50
  });

  it('is empty without a valid 26-word alphabet', () => {
    expect(buildMarkerSequence([], 16)).toEqual([]);
    expect(buildMarkerSequence(ALPHABET.slice(0, 25), 16)).toEqual([]);
  });
});

describe('assignMarker / releaseMarker', () => {
  const seq = buildMarkerSequence(ALPHABET, 16);

  it('hands out singles first, in order', () => {
    let map: MarkerMap = {};
    map = { ...map, 1: assignMarker(map, 1, seq)! };
    map = { ...map, 2: assignMarker(map, 2, seq)! };
    expect(map[1]).toBe('arch');
    expect(map[2]).toBe('bolt');
  });

  it('keeps a tab’s existing marker (stability)', () => {
    const map: MarkerMap = { 1: 'crane' };
    expect(assignMarker(map, 1, seq)).toBe('crane');
  });

  it('never hands the same marker to two live tabs', () => {
    const map: MarkerMap = { 1: 'arch' };
    expect(assignMarker(map, 2, seq)).toBe('bolt'); // skips the used 'arch'
  });

  it('re-grants a preferred marker when free (reconciliation)', () => {
    const map: MarkerMap = { 1: 'arch' };
    expect(assignMarker(map, 2, seq, 'echo')).toBe('echo');
  });

  it('ignores a preferred marker that is taken', () => {
    const map: MarkerMap = { 1: 'echo' };
    expect(assignMarker(map, 2, seq, 'echo')).toBe('arch'); // falls to first free
  });

  it('returns null when the pool is exhausted', () => {
    const map: MarkerMap = {};
    seq.forEach((m, i) => { map[i] = m; });
    expect(assignMarker(map, 9999, seq)).toBeNull();
  });

  it('release returns the marker to the free pool', () => {
    const map: MarkerMap = { 1: 'arch', 2: 'bolt' };
    const after = releaseMarker(map, 1);
    expect(after).toEqual({ 2: 'bolt' });
    expect(assignMarker(after, 3, seq)).toBe('arch'); // freed single reused first
  });
});

describe('markerLetters', () => {
  it('renders single and pair markers as 1–2 letters', () => {
    expect(markerLetters('arch', ALPHABET)).toBe('a');
    expect(markerLetters('quill reef', ALPHABET)).toBe('qr');
  });
});

describe('title decoration round-trip', () => {
  it('decorate then strip recovers the bare title', () => {
    const decorated = decorateTitle('a', 'GitHub — pulls');
    expect(decorated).toBe('a| GitHub — pulls');
    expect(hasTabMarker(decorated)).toBe(true);
    expect(stripTabMarker(decorated)).toBe('GitHub — pulls');
  });

  it('strip is idempotent on an undecorated title', () => {
    expect(stripTabMarker('Plain Title')).toBe('Plain Title');
    expect(hasTabMarker('Plain Title')).toBe(false);
  });

  it('parseMarkerLetters recovers the letter token for reconciliation', () => {
    expect(parseMarkerLetters(decorateTitle('qr', 'Docs'))).toBe('qr');
    expect(parseMarkerLetters('Undecorated')).toBeNull();
  });
});

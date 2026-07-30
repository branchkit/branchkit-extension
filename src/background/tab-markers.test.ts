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

// notes/DESIGN_PALETTE_KEYBOARD_NAV.md — letters the palette needs for list
// navigation are withheld from the pool, so a bare `j` can move the selection
// instead of jumping to mark "j".
describe('buildMarkerSequence — reserved nav letters', () => {
  const SHIPPING = new Set(['d', 'g', 'j', 'k', 'u']);

  it('drops reserved letters from the singles head', () => {
    const seq = buildMarkerSequence(16, SHIPPING);
    const singles = seq.filter((m) => m.length === 1);
    expect(singles).toHaveLength(11);
    for (const r of SHIPPING) expect(singles).not.toContain(r);
  });

  it('costs no pairs — all five shipping letters sit in the head', () => {
    expect(buildMarkerSequence(16, SHIPPING)).toHaveLength(11 + 10 * 9); // 101
  });

  it('filters AFTER the head/tail split, so no tail letter is promoted', () => {
    // Reserving a head letter must not pull `i` (the first tail letter) up into
    // the singles: a letter's role stays fixed, which is what keeps the pair
    // pool at full size.
    const seq = buildMarkerSequence(16, new Set(['a']));
    expect(seq.filter((m) => m.length === 1)).not.toContain('i');
    expect(seq.filter((m) => m.length === 2)).toHaveLength(10 * 9);
  });

  it('never emits a reserved letter anywhere, singles or pairs', () => {
    const reserved = new Set(['a', 'i', 'z']); // one head letter, two tail
    for (const m of buildMarkerSequence(16, reserved)) {
      for (const ch of m) expect(reserved.has(ch)).toBe(false);
    }
  });

  it('stays prefix-free under reservation', () => {
    const seq = buildMarkerSequence(16, SHIPPING);
    for (const s of seq.filter((m) => m.length === 1)) {
      expect(seq.some((m) => m.length === 2 && m[0] === s)).toBe(false);
    }
  });

  it('is unchanged when nothing is reserved (arrow-key user)', () => {
    expect(buildMarkerSequence(16, new Set())).toEqual(buildMarkerSequence(16));
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

  it('strips word- and expand-mode decorations', () => {
    // The display follows badgeDisplayMode, so the strip must clear every form
    // or the shown words leak into the voice tab-word grammar.
    expect(stripTabMarker('[arch] Docs')).toBe('Docs');      // word, single
    expect(stripTabMarker('[iris zone] Docs')).toBe('Docs'); // word, pair
    expect(stripTabMarker('[iris z] Docs')).toBe('Docs');    // expand, pair
    const d = decorateTitle('iris zone', 'GitHub');
    expect(d).toBe('[iris zone] GitHub');
    expect(stripTabMarker(d)).toBe('GitHub');
  });

  it("does not eat a page's own capitalized bracket prefix", () => {
    // Our emissions are lowercase; a capitalized "[Draft] " is the page's, and
    // the lowercase-only strip regex must leave it intact.
    expect(stripTabMarker('[Draft] Report')).toBe('[Draft] Report');
    expect(stripTabMarker('[TODO] Fix')).toBe('[TODO] Fix');
    expect(hasTabMarker('[Draft] Report')).toBe(false);
  });

  it('parseMarker takes the letter form only (word-mode titles reassign)', () => {
    expect(parseMarker('[arch] Docs')).toBeNull();
    expect(parseMarker('[iris zone] Docs')).toBeNull();
    expect(parseMarker('[a] Docs')).toBe('a');
  });
});

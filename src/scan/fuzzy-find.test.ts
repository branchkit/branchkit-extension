import { describe, it, expect } from 'vitest';
import {
  normalizeFuzzy,
  phoneticKey,
  fuzzyScore,
  bestPageMatch,
  fold1to1,
  flexiblePattern,
} from './fuzzy-find';

describe('normalizeFuzzy', () => {
  it('lowercases, strips punctuation, collapses whitespace', () => {
    expect(normalizeFuzzy('  Check-Out! ')).toBe('check out');
    expect(normalizeFuzzy('Quarterly   Revenue.')).toBe('quarterly revenue');
  });
});

describe('phoneticKey', () => {
  it('collapses ch/sh confusions to the same key', () => {
    expect(phoneticKey('checkout')).toBe(phoneticKey('shekout'));
  });
  it('maps ph->f', () => {
    expect(phoneticKey('phone')).toBe(phoneticKey('fone'));
  });
  it('is stable under vowel noise', () => {
    // vowels (except leading) are dropped, so vowel swaps don't change the key
    expect(phoneticKey('submit')).toBe(phoneticKey('submet'));
  });
  it('keeps genuinely different words distinct', () => {
    expect(phoneticKey('cat')).not.toBe(phoneticKey('dog'));
  });
});

describe('fuzzyScore', () => {
  it('scores exact (normalized) match as 1', () => {
    expect(fuzzyScore('Checkout', 'checkout')).toBe(1);
  });
  it('scores a plausible ASR garble high across a word-split', () => {
    expect(fuzzyScore('shek out', 'checkout')).toBeGreaterThan(0.7);
  });
  it('scores unrelated words low', () => {
    expect(fuzzyScore('checkout', 'giraffe')).toBeLessThan(0.4);
  });
});

describe('fold1to1', () => {
  it('folds accents to base letters, preserving length for index mapping', () => {
    expect(fold1to1('Martín')).toBe('martin');
    expect(fold1to1('Martín').length).toBe('Martín'.length);
    expect(fold1to1('Café')).toBe('cafe');
  });
});

describe('flexiblePattern', () => {
  it('joins words with a tolerant non-alphanumeric separator', () => {
    expect(flexiblePattern('lope martin marooned')).toBe('lope[^a-z0-9]+martin[^a-z0-9]+marooned');
  });
  it('matches the page phrase across an accent and parenthesis', () => {
    const pattern = flexiblePattern('Lope Martin Marooned 21 July 1566')!;
    const folded = fold1to1('Lope Martín (Marooned 21 July 1566) was');
    expect(new RegExp(pattern).test(folded)).toBe(true);
  });
  it('returns null for empty input', () => {
    expect(flexiblePattern('  ')).toBeNull();
  });
});

describe('bestPageMatch', () => {
  const page =
    'Home About Products Checkout Contact Us. Add to cart or proceed to Checkout now.';

  it('corrects a garbled single word to the page term', () => {
    const m = bestPageMatch('shek out', page);
    expect(m).not.toBeNull();
    expect(m!.term.toLowerCase()).toBe('checkout');
  });

  it('returns null when nothing on the page is close', () => {
    expect(bestPageMatch('xylophone', page)).toBeNull();
  });

  it('matches a page term the recognizer split in two', () => {
    const m = bestPageMatch('add to cart', page);
    expect(m).not.toBeNull();
    expect(normalizeFuzzy(m!.term)).toBe('add to cart');
  });

  it('prefers an exact (normalized) page term', () => {
    const m = bestPageMatch('checkout', page);
    expect(m).not.toBeNull();
    expect(m!.score).toBe(1);
    expect(m!.term.toLowerCase()).toBe('checkout');
  });

  it('handles empty inputs', () => {
    expect(bestPageMatch('', page)).toBeNull();
    expect(bestPageMatch('checkout', '')).toBeNull();
  });
});

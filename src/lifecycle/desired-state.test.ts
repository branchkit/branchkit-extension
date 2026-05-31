/**
 * BranchKit Browser — desired-state predicate unit tests.
 *
 * Pins the pure level-triggered predicates that both the legacy edge
 * handlers and the future reconcile() consume. See desired-state.ts and
 * notes/DESIGN_HINT_LIFECYCLE_RECONCILER.md.
 *
 * Run: npm test
 */

import { describe, it, expect } from 'vitest';
import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement, Category } from '../types';
import { categoryMatches, wantsCodeword, wantsHint } from './desired-state';

function fakeElement(): Element {
  return { tagName: 'A' } as unknown as Element;
}

function makeWrapper(opts: {
  inViewport: boolean;
  codeword: string;
  category?: Category;
}): ElementWrapper {
  const scanned: ScannedElement = {
    label: 'a link',
    id: 0,
    category: opts.category ?? 'link',
    type: 'link',
    adapter: null,
    codeword: opts.codeword,
  };
  const w = new ElementWrapper(fakeElement(), scanned);
  w.isInViewport = opts.inViewport;
  return w;
}

describe('categoryMatches', () => {
  it('matches everything when no category is active', () => {
    const w = makeWrapper({ inViewport: true, codeword: 'ape', category: 'button' });
    expect(categoryMatches(w, null)).toBe(true);
  });

  it('matches when categories are equal', () => {
    const w = makeWrapper({ inViewport: true, codeword: 'ape', category: 'link' });
    expect(categoryMatches(w, 'link')).toBe(true);
  });

  it('rejects when categories differ', () => {
    const w = makeWrapper({ inViewport: true, codeword: 'ape', category: 'link' });
    expect(categoryMatches(w, 'button')).toBe(false);
  });
});

describe('wantsCodeword', () => {
  it('wants a codeword when in the viewport band', () => {
    expect(wantsCodeword(makeWrapper({ inViewport: true, codeword: '' }))).toBe(true);
  });

  it('does not want a codeword when off-band', () => {
    expect(wantsCodeword(makeWrapper({ inViewport: false, codeword: 'ape' }))).toBe(false);
  });
});

describe('wantsHint', () => {
  it('wants a hint when in-viewport, codeworded, and category matches', () => {
    const w = makeWrapper({ inViewport: true, codeword: 'ape', category: 'link' });
    expect(wantsHint(w, null)).toBe(true);
    expect(wantsHint(w, 'link')).toBe(true);
  });

  it('does not want a hint without a codeword', () => {
    const w = makeWrapper({ inViewport: true, codeword: '' });
    expect(wantsHint(w, null)).toBe(false);
  });

  it('does not want a hint when off-band', () => {
    const w = makeWrapper({ inViewport: false, codeword: 'ape' });
    expect(wantsHint(w, null)).toBe(false);
  });

  it('does not want a hint when the category filter excludes it', () => {
    const w = makeWrapper({ inViewport: true, codeword: 'ape', category: 'link' });
    expect(wantsHint(w, 'button')).toBe(false);
  });
});

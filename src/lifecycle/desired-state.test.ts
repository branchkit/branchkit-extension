/**
 * BranchKit Browser — desired-state predicate unit tests.
 *
 * Pins the pure level-triggered predicates that both the legacy edge
 * handlers and the future reconcile() consume. See desired-state.ts and
 * notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md.
 *
 * Run: npm test
 */

import { describe, it, expect } from 'vitest';
import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement, Category } from '../types';
import { HintBadge } from '../render/hints';
import { categoryMatches, wantsCodeword, wantsHint, wantsShown, wantsStrict } from './desired-state';

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

// Real connected elements: wantsShown reads element.isConnected.
function makeShownWrapper(opts: {
  codeword?: string;
  hint?: boolean;
  connected?: boolean;
  disconnected?: boolean;
  occluded?: boolean;
  cssHidden?: boolean;
}): ElementWrapper {
  const el = document.createElement('a');
  if (opts.connected ?? true) document.body.appendChild(el);
  const scanned: ScannedElement = {
    label: 'a link', id: 0, category: 'link', type: 'link', adapter: null,
    codeword: opts.codeword ?? 'ape',
  };
  const w = new ElementWrapper(el, scanned);
  if (opts.hint ?? true) w.hint = {} as HintBadge;
  if (opts.disconnected) w.disconnectedAt = 1;
  if (opts.occluded) w.occluded = true;
  if (opts.cssHidden) w.cssHidden = true;
  return w;
}

const SHOWN_OK = { flagInBand: true, cssVisible: true, onScreen: true };

describe('wantsShown', () => {
  it('wants shown when in-band, CSS-visible, and on-screen', () => {
    expect(wantsShown(makeShownWrapper({}), SHOWN_OK)).toBe(true);
  });

  it('encodes dormant-badge reuse: an out-of-band badge is desired-hidden, not drift', () => {
    expect(wantsShown(makeShownWrapper({}), { ...SHOWN_OK, flagInBand: false })).toBe(false);
  });

  it('never wants a limbo wrapper shown (held by design)', () => {
    expect(wantsShown(makeShownWrapper({ disconnected: true }), SHOWN_OK)).toBe(false);
  });

  it('never wants shown without a badge object (that is the build class)', () => {
    expect(wantsShown(makeShownWrapper({ hint: false }), SHOWN_OK)).toBe(false);
  });

  it('does not want a CSS-invisible or off-screen badge shown', () => {
    expect(wantsShown(makeShownWrapper({}), { ...SHOWN_OK, cssVisible: false })).toBe(false);
    expect(wantsShown(makeShownWrapper({}), { ...SHOWN_OK, onScreen: false })).toBe(false);
  });

  it('does not want a disconnected element shown', () => {
    expect(wantsShown(makeShownWrapper({ connected: false }), SHOWN_OK)).toBe(false);
  });
});

const STRICT_OK = { ancestorChainVisible: true, onScreen: true };

describe('wantsStrict', () => {
  it('wants strict for a codeworded on-screen wrapper in visible frames', () => {
    expect(wantsStrict(makeShownWrapper({}), STRICT_OK)).toBe(true);
  });

  it('never wants strict without a codeword', () => {
    expect(wantsStrict(makeShownWrapper({ codeword: '' }), STRICT_OK)).toBe(false);
  });

  it('never wants a limbo wrapper strict (held by design)', () => {
    expect(wantsStrict(makeShownWrapper({ disconnected: true }), STRICT_OK)).toBe(false);
  });

  it('drops occluded and CSS-hidden targets (badge hidden → voice must not match)', () => {
    expect(wantsStrict(makeShownWrapper({ occluded: true }), STRICT_OK)).toBe(false);
    expect(wantsStrict(makeShownWrapper({ cssHidden: true }), STRICT_OK)).toBe(false);
  });

  it('drops off-screen targets and invisible ancestor frames', () => {
    expect(wantsStrict(makeShownWrapper({}), { ...STRICT_OK, onScreen: false })).toBe(false);
    expect(wantsStrict(makeShownWrapper({}), { ...STRICT_OK, ancestorChainVisible: false })).toBe(false);
  });
});

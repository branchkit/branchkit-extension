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
import { wantsCodeword, wantsHint, wantsShown, wantsStrict } from './desired-state';

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

describe('wantsCodeword', () => {
  it('wants a codeword when in the viewport band', () => {
    expect(wantsCodeword(makeWrapper({ inViewport: true, codeword: '' }))).toBe(true);
  });

  it('does not want a codeword when off-band', () => {
    expect(wantsCodeword(makeWrapper({ inViewport: false, codeword: 'ape' }))).toBe(false);
  });
});

describe('wantsHint', () => {
  it('wants a hint when in-viewport and codeworded', () => {
    const w = makeWrapper({ inViewport: true, codeword: 'ape', category: 'link' });
    expect(wantsHint(w)).toBe(true);
  });

  it('does not want a hint without a codeword', () => {
    const w = makeWrapper({ inViewport: true, codeword: '' });
    expect(wantsHint(w)).toBe(false);
  });

  it('does not want a hint when off-band', () => {
    const w = makeWrapper({ inViewport: false, codeword: 'ape' });
    expect(wantsHint(w)).toBe(false);
  });
});

// Real connected elements: wantsShown reads element.isConnected.
function makeShownWrapper(opts: {
  codeword?: string;
  hint?: boolean;
  connected?: boolean;
  disconnected?: boolean;
  occluded?: boolean;
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
  return w;
}

const SHOWN_OK = { flagInBand: true, cssVisible: true, overVideo: false };

describe('wantsShown', () => {
  it('wants shown when in-band and CSS-visible', () => {
    expect(wantsShown(makeShownWrapper({}), SHOWN_OK)).toBe(true);
  });

  it('does not want a badge shown over an actively-playing video (WR freeze amplifier)', () => {
    expect(wantsShown(makeShownWrapper({}), { ...SHOWN_OK, overVideo: true })).toBe(false);
  });

  it('is IO-band scoped, NOT strict-viewport scoped (paint the band): in-band is sufficient', () => {
    // notes/DESIGN_PAINT_THE_BAND.md: there is deliberately no onScreen
    // input — an in-band, off-viewport badge paints and rides into view.
    // This pins the predicate's input shape so a strict-viewport term can't
    // silently return. `overVideo` (2026-07-18) is NOT a viewport term: it
    // suppresses painting over actively-playing videos (Firefox WR
    // compositor-surface race, bugzilla 1989948) regardless of band state.
    const inputKeys = Object.keys(SHOWN_OK).sort();
    expect(inputKeys).toEqual(['cssVisible', 'flagInBand', 'overVideo']);
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

  it('does not want a CSS-invisible badge shown (hover-reveal targets never paint)', () => {
    expect(wantsShown(makeShownWrapper({}), { ...SHOWN_OK, cssVisible: false })).toBe(false);
  });

  it('does not want a disconnected element shown', () => {
    expect(wantsShown(makeShownWrapper({ connected: false }), SHOWN_OK)).toBe(false);
  });
});

const STRICT_OK = { ancestorChainVisible: true, onScreen: true, occluded: false, cssHidden: false };

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
    // Flags arrive as inputs: the plan derives them as the appliers will
    // leave them, so the predicate is order-independent.
    expect(wantsStrict(makeShownWrapper({}), { ...STRICT_OK, occluded: true })).toBe(false);
    expect(wantsStrict(makeShownWrapper({}), { ...STRICT_OK, cssHidden: true })).toBe(false);
  });

  it('drops off-screen targets and invisible ancestor frames', () => {
    expect(wantsStrict(makeShownWrapper({}), { ...STRICT_OK, onScreen: false })).toBe(false);
    expect(wantsStrict(makeShownWrapper({}), { ...STRICT_OK, ancestorChainVisible: false })).toBe(false);
  });
});

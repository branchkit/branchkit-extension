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
import { wantsShown, wantsStrict } from './desired-state';

// (wantsCodeword / wantsHint are gone — DESIGN_OBSERVED_STATE_READ_TIME
// phase 3: band membership is derived from fresh rects at the consumers,
// so the flag-reading predicates collapsed into the plan's lifecycle walk
// and the build step's enumeration. Their specs live in reconcile.test.ts.)

// Real connected elements: wantsShown reads element.isConnected.
function makeShownWrapper(opts: {
  codeword?: string;
  hint?: boolean;
  connected?: boolean;
  disconnected?: boolean;
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

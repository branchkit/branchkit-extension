/**
 * The palette holder — the cross-realm participant.
 * Design: notes/DESIGN_CROSS_REALM_CODEWORD_HOLDERS.md.
 *
 * The conformance run is the point: the palette's badges were a parallel
 * implementation precisely because registration wasn't reachable from an
 * iframe, and "implement these methods" is what registration is supposed to
 * cost. The suite proves the cost was paid.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  __resetHolderRegistry, holdersByPriority, resolveCodeword, narrowByPrefix,
  registerHolder, AMBIENT_PRIORITY, type CodewordHolder,
} from '../labels/holder-registry';
import {
  describeCodewordHolderConformance, type HolderHarness,
} from '../testing/holder-conformance';
import { PaletteHolder, type PaletteFrameLegs } from './palette-holder';
import { codewordToken } from './codewords';

function stubLegs(): PaletteFrameLegs & { narrow: ReturnType<typeof vi.fn> } {
  return { narrow: vi.fn(), activate: vi.fn(), relabel: vi.fn() } as never;
}

/** Armed liveness: constructed unregistered, registers on the frame's
 *  publish, unregisters when it empties or disposes. */
function makePaletteHarness(): HolderHarness {
  __resetHolderRegistry();
  const holder = new PaletteHolder(stubLegs());
  const granted: string[] = [];
  return {
    holder,
    grant: (cws) => {
      granted.push(...cws);
      holder.adopt(granted.map((token, i) => ({ token, rowId: `row:${i}` })));
    },
  };
}

describeCodewordHolderConformance('PaletteHolder (mirror + stub frame legs)',
  makePaletteHarness, { liveness: 'armed' });

describe('PaletteHolder', () => {
  it('registers on adopt and unregisters when the palette badges nothing', () => {
    __resetHolderRegistry();
    const h = new PaletteHolder(stubLegs());
    expect(holdersByPriority()).toHaveLength(0);

    h.adopt([{ token: 'o', rowId: 'tab:1' }]);
    expect(holdersByPriority()).toContain(h);

    // An empty assignment must LEAVE the list, not sit in it swallowing
    // codewords for a palette that badged nothing — the holder is exclusive.
    h.adopt([]);
    expect(holdersByPriority()).not.toContain(h);
  });

  it('drops unmappable rows rather than binding them to the wrong row', () => {
    __resetHolderRegistry();
    const h = new PaletteHolder(stubLegs());
    h.adopt([
      { token: 'o', rowId: 'tab:1' },
      { token: '', rowId: 'tab:2' },   // word outside the alphabet
      { token: 'r', rowId: '' },       // no row to dispatch to
    ]);
    expect([...h.held()]).toEqual(['o']);
  });

  it('resolve activates the mirrored row and declines anything else', () => {
    __resetHolderRegistry();
    const legs = stubLegs();
    const h = new PaletteHolder(legs);
    h.adopt([{ token: 'o r', rowId: 'cmd:pin_tab' }]);

    expect(h.resolve('o r')).toBe('acted');
    expect(legs.activate).toHaveBeenCalledWith('cmd:pin_tab');

    expect(h.resolve('z z')).toBe('not_mine');
    expect(legs.activate).toHaveBeenCalledTimes(1);
  });

  it('narrow crosses into the frame and never touches the mirror', () => {
    __resetHolderRegistry();
    const legs = stubLegs();
    const h = new PaletteHolder(legs);
    h.adopt([{ token: 'o r', rowId: 'a' }, { token: 'o s', rowId: 'b' }]);

    h.narrow('o');
    expect(legs.narrow).toHaveBeenCalledWith('o');
    expect([...h.held()]).toEqual(['o r', 'o s']);
  });

  // The gap that started this: a spoken prefix reaches the palette at all.
  // narrowByPrefix stops at the first exclusive holder, so the palette must
  // BE that holder for the frame to ever hear about mid-utterance progress.
  it('receives narrowByPrefix as the exclusive holder, swallowing the ambient one', () => {
    __resetHolderRegistry();
    const legs = stubLegs();
    const palette = new PaletteHolder(legs);
    const ambientNarrow = vi.fn();
    const ambient = {
      id: 'store', priority: AMBIENT_PRIORITY, claim: 'additive',
      held: () => [], republish() {}, onCodewordRejected() {},
      matchesPrefix: () => false, narrow: ambientNarrow,
      resolve: () => 'not_mine', soleMatch: () => null,
      relabel() {}, reconcile() {}, dispose() {},
    } as unknown as CodewordHolder;
    registerHolder(ambient);
    palette.adopt([{ token: 'o', rowId: 'tab:1' }]);

    narrowByPrefix('o');
    expect(legs.narrow).toHaveBeenCalledWith('o');
    expect(ambientNarrow).not.toHaveBeenCalled();
  });

  it('swallows a codeword it does not hold, so page hints cannot act under it', () => {
    __resetHolderRegistry();
    const palette = new PaletteHolder(stubLegs());
    const pageActed = vi.fn(() => 'acted' as const);
    registerHolder({
      id: 'store', priority: AMBIENT_PRIORITY, claim: 'additive',
      held: () => ['z z'], republish() {}, onCodewordRejected() {},
      matchesPrefix: () => true, narrow() {},
      resolve: pageActed, soleMatch: () => null,
      relabel() {}, reconcile() {}, dispose() {},
    } as unknown as CodewordHolder);
    palette.adopt([{ token: 'o', rowId: 'tab:1' }]);

    const out = resolveCodeword('z z');
    expect(out).toEqual({ kind: 'swallowed', holder: 'palette' });
    expect(pageActed).not.toHaveBeenCalled();
  });

  it('soleMatch fires only when one row survives the prefix', () => {
    __resetHolderRegistry();
    const h = new PaletteHolder(stubLegs());
    h.adopt([{ token: 'o r', rowId: 'a' }, { token: 'o s', rowId: 'b' }]);

    expect(h.soleMatch('o')).toBe(null);   // two live
    expect(h.soleMatch('or')).toBe('o r'); // letter form, spaces stripped
    expect(h.soleMatch('')).toBe(null);    // a reset is not a selection
    expect(h.soleMatch('z')).toBe(null);
  });
});

describe('codewordToken', () => {
  // A–Z indexed, matching markToSpokenWords' `charCodeAt(0) - 97` inverse.
  // NOT LETTERS_26, whose order is typing-ergonomic — using it would bind
  // every badge to the wrong letter.
  const alphabet = [
    'arch', 'bond', 'cape', 'dust', 'echo', 'flag', 'glad', 'hive', 'iris',
    'jade', 'kite', 'lark', 'mint', 'north', 'ocean', 'pearl', 'quartz',
    'river', 'stone', 'tide', 'umber', 'vine', 'wharf', 'xenon', 'yield', 'zinc',
  ];

  it('maps spoken words to their alphabetical letters', () => {
    expect(codewordToken('arch', alphabet)).toBe('a');
    expect(codewordToken('ocean', alphabet)).toBe('o');
    expect(codewordToken('zinc', alphabet)).toBe('z');
    expect(codewordToken('ocean river', alphabet)).toBe('o r');
  });

  it('separates a tabs-scope strip mark, which is already letters', () => {
    expect(codewordToken('a', alphabet)).toBe('a');
    expect(codewordToken('ab', alphabet)).toBe('a b');
  });

  it('yields empty for a word outside the alphabet — unspeakable, not mis-bound', () => {
    expect(codewordToken('ocean nonsense', alphabet)).toBe('');
    expect(codewordToken('', alphabet)).toBe('');
  });
});

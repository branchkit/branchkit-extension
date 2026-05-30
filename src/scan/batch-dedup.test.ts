/**
 * BranchKit Browser — rescan dedup tests.
 *
 * Pins Problem 2 from notes/DESIGN_OPTION_B_REATTEMPT.md: refs whose
 * wrappers already exist in the store must NOT be re-claimed against
 * the label pool. Re-claiming on rescan was the bug that depleted the
 * pool after ~10 rescans on QuickBase.
 */

import { describe, it, expect } from 'vitest';
import { ScannedElement } from '../types';
import { filterNewBatchRefs } from './batch-dedup';

function fakeElement(id: number): Element {
  return { tagName: 'BUTTON', __id: id } as unknown as Element;
}

function fakeScanned(label: string): ScannedElement {
  return {
    label, id: 0, category: 'button', type: 'button', adapter: null, codeword: '',
  };
}

describe('filterNewBatchRefs', () => {
  it('returns every ref when none are already attached', () => {
    const refs = [fakeElement(1), fakeElement(2), fakeElement(3)];
    const elements = [fakeScanned('a'), fakeScanned('b'), fakeScanned('c')];
    const { newRefs, newElements } = filterNewBatchRefs(refs, elements, () => false);
    expect(newRefs).toEqual(refs);
    expect(newElements).toEqual(elements);
  });

  it('drops refs whose wrappers already exist in the store', () => {
    const el1 = fakeElement(1);
    const el2 = fakeElement(2);
    const el3 = fakeElement(3);
    const refs = [el1, el2, el3];
    const elements = [fakeScanned('a'), fakeScanned('b'), fakeScanned('c')];
    // el2 already attached — its codeword is in plugin's session.Codewords
    // from a prior batch and will be re-pushed by buildTabPrefixState.
    const isAttached = (el: Element) => el === el2;
    const { newRefs, newElements } = filterNewBatchRefs(refs, elements, isAttached);
    expect(newRefs).toEqual([el1, el3]);
    expect(newElements.map(e => e.label)).toEqual(['a', 'c']);
  });

  it('returns empty arrays when every ref is already attached', () => {
    const refs = [fakeElement(1), fakeElement(2)];
    const elements = [fakeScanned('a'), fakeScanned('b')];
    const { newRefs, newElements } = filterNewBatchRefs(refs, elements, () => true);
    expect(newRefs).toEqual([]);
    expect(newElements).toEqual([]);
  });

  it('preserves ref/element index alignment after filtering', () => {
    const refs = [fakeElement(1), fakeElement(2), fakeElement(3), fakeElement(4)];
    const elements = [fakeScanned('a'), fakeScanned('b'), fakeScanned('c'), fakeScanned('d')];
    // Drop alternating refs.
    const dropSet = new Set([refs[0], refs[2]]);
    const { newRefs, newElements } = filterNewBatchRefs(refs, elements, (el) => dropSet.has(el));
    expect(newRefs).toEqual([refs[1], refs[3]]);
    expect(newElements.map(e => e.label)).toEqual(['b', 'd']);
  });
});

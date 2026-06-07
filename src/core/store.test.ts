/**
 * BranchKit Browser — store delta-emitter tests (Tier 2, the delta cut).
 *
 * Pins the contract reactions will depend on: one delta per *real* mutation
 * (attach / detach / rebind), and no delta for the no-op cases (duplicate add,
 * remove of an untracked element). Emission must be exactly-once so a subscribed
 * grammar-sync / render doesn't over- or under-fire.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { ObservableWrapperStore, type WrapperDelta } from './store';

function wrapper(): ElementWrapper {
  const scanned: ScannedElement = { label: 'x', id: 1, category: 'button', type: 'button', adapter: null, codeword: '' };
  return new ElementWrapper(document.createElement('div'), scanned);
}

let store: ObservableWrapperStore;
let deltas: WrapperDelta[];

beforeEach(() => {
  store = new ObservableWrapperStore();
  deltas = [];
  store.subscribe((d) => deltas.push(d));
});

describe('attach', () => {
  it('emits one attached delta when a wrapper is added', () => {
    const w = wrapper();
    store.addWrapper(w);
    expect(deltas).toEqual([{ kind: 'attached', wrapper: w }]);
  });

  it('does not emit a second delta for a duplicate add', () => {
    const w = wrapper();
    store.addWrapper(w);
    store.addWrapper(w); // same element → no-op
    expect(deltas.filter(d => d.kind === 'attached')).toHaveLength(1);
  });
});

describe('detach', () => {
  it('emits one detached delta when a tracked wrapper is removed', () => {
    const w = wrapper();
    store.addWrapper(w);
    deltas.length = 0;
    store.removeWrapperByElement(w.element);
    expect(deltas).toEqual([{ kind: 'detached', wrapper: w }]);
  });

  it('emits nothing when removing an untracked element', () => {
    store.removeWrapperByElement(document.createElement('div'));
    expect(deltas).toEqual([]);
  });
});

describe('rebind', () => {
  it('emits a rebound delta carrying the old element', () => {
    const w = wrapper();
    store.addWrapper(w);
    deltas.length = 0;
    const oldEl = w.element;
    const newEl = document.createElement('span');
    store.rebindElement(oldEl, newEl, w);
    expect(deltas).toEqual([{ kind: 'rebound', wrapper: w, from: oldEl }]);
  });
});

describe('no subscribers', () => {
  it('mutating a store with no listeners does not throw', () => {
    const bare = new ObservableWrapperStore();
    expect(() => {
      const w = wrapper();
      bare.addWrapper(w);
      bare.removeWrapperByElement(w.element);
    }).not.toThrow();
  });
});

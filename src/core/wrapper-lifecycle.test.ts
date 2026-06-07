/**
 * BranchKit Browser — wrapper-lifecycle unit tests.
 *
 * Pins the attach/detach wiring and the attachDiscovered batch dedup that were
 * previously only reachable through the content-script monolith: attach adds to
 * the store and starts the observers; detach removes and unobserves all three;
 * attachDiscovered skips already-known refs and attaches the rest. The
 * codeword-less path is used so detach's delta-sync bookkeeping stays out of the
 * picture (covered by label-sync's own tests).
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { store } from './store';
import * as idRegistry from '../scan/registry';
import {
  initWrapperLifecycle,
  attachWrapper,
  detachWrapper,
  attachDiscovered,
} from './wrapper-lifecycle';

function scanned(label: string): ScannedElement {
  return { label, id: 0, category: 'button', type: 'button', adapter: null, codeword: '' };
}

/** A real element with a distinct accessible name so fingerprints don't collide. */
function el(name: string): HTMLElement {
  const node = document.createElement('button');
  node.setAttribute('aria-label', name);
  document.body.appendChild(node);
  return node;
}

let trackerObserve: ReturnType<typeof vi.fn>;
let trackerUnobserve: ReturnType<typeof vi.fn>;
let resizeObserve: ReturnType<typeof vi.fn>;
let resizeUnobserve: ReturnType<typeof vi.fn>;
let attentionUnobserve: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.clear();
  idRegistry.clear();
  trackerObserve = vi.fn();
  trackerUnobserve = vi.fn();
  resizeObserve = vi.fn();
  resizeUnobserve = vi.fn();
  attentionUnobserve = vi.fn();
  initWrapperLifecycle({
    tracker: { observe: trackerObserve, unobserve: trackerUnobserve } as unknown as Parameters<typeof initWrapperLifecycle>[0]['tracker'],
    resizeObserver: { observe: resizeObserve, unobserve: resizeUnobserve, disconnect: vi.fn() } as unknown as ResizeObserver,
    attentionObserver: { unobserve: attentionUnobserve } as unknown as Parameters<typeof initWrapperLifecycle>[0]['attentionObserver'],
  });
});

describe('attachWrapper', () => {
  it('adds the wrapper to the store and observes its element', () => {
    const node = el('one');
    const w = new ElementWrapper(node, scanned('one'));

    attachWrapper(w);

    expect(store.findWrapperFor(node)).toBe(w);
    expect(trackerObserve).toHaveBeenCalledWith(node);
    expect(resizeObserve).toHaveBeenCalledWith(node);
  });
});

describe('detachWrapper', () => {
  it('removes the wrapper from the store and unobserves all three observers', () => {
    const node = el('two');
    attachWrapper(new ElementWrapper(node, scanned('two')));
    expect(store.findWrapperFor(node)).toBeDefined();

    detachWrapper(node);

    expect(store.findWrapperFor(node)).toBeUndefined();
    expect(trackerUnobserve).toHaveBeenCalledWith(node);
    expect(resizeUnobserve).toHaveBeenCalledWith(node);
    expect(attentionUnobserve).toHaveBeenCalledWith(node);
  });
});

describe('attachDiscovered', () => {
  it('attaches fresh refs and reports the count', () => {
    const a = el('a');
    const b = el('b');

    const added = attachDiscovered([a, b], [scanned('a'), scanned('b')], [], new Map<string, ElementWrapper | null>());

    expect(added).toBe(2);
    expect(store.findWrapperFor(a)).toBeDefined();
    expect(store.findWrapperFor(b)).toBeDefined();
  });

  it('skips refs the store already knows', () => {
    const known = el('known');
    store.addWrapper(new ElementWrapper(known, scanned('known')));
    const fresh = el('fresh');

    const added = attachDiscovered([known, fresh], [scanned('known'), scanned('fresh')], [], new Map<string, ElementWrapper | null>());

    expect(added).toBe(1); // only `fresh` is new
    expect(store.findWrapperFor(fresh)).toBeDefined();
  });
});

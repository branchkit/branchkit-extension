/**
 * BranchKit Browser — debug-overlay.ts unit tests.
 *
 * Covers the pure pieces: wrapper classification (the green/yellow/orange
 * tiering) and the page-coord math. Toggle-on/toggle-off DOM behavior is
 * exercised via the happy-dom environment configured for the suite.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ElementWrapper, WrapperStore } from './element-wrapper';
import { ScannedElement, Category } from './types';
import {
  classifyWrapper,
  pageRect,
  toggleOverlay,
  isOverlayActive,
  _resetOverlayForTesting,
} from './debug-overlay';

function makeScanned(id: number, codeword = ''): ScannedElement {
  return {
    label: `el-${id}`,
    id,
    category: 'click' as Category,
    type: 'button',
    adapter: null,
    codeword,
  };
}

function makeWrapper(id: number, codeword = '', inViewport = true): ElementWrapper {
  const el = document.createElement('button');
  el.textContent = `btn-${id}`;
  // Attach to body so getBoundingClientRect returns non-zero — the
  // overlay's "skip detached/collapsed" filter would otherwise drop
  // every test wrapper.
  document.body.appendChild(el);
  // happy-dom doesn't run layout; stub the rect explicitly so the
  // filter passes deterministically.
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 10, bottom: 10, width: 10, height: 10, toJSON: () => ({}) }) as DOMRect;
  const w = new ElementWrapper(el, makeScanned(id, codeword));
  w.isInViewport = inViewport;
  return w;
}

describe('classifyWrapper', () => {
  it('returns orange when off-screen, regardless of codeword', () => {
    const w = makeWrapper(1, 'arch', /* inViewport */ false);
    expect(classifyWrapper(w)).toBe('orange');
  });

  it('returns yellow when in viewport but no codeword (pool exhausted)', () => {
    const w = makeWrapper(2, '', /* inViewport */ true);
    expect(classifyWrapper(w)).toBe('yellow');
  });

  it('returns green when in viewport with a codeword', () => {
    const w = makeWrapper(3, 'arch check', /* inViewport */ true);
    expect(classifyWrapper(w)).toBe('green');
  });

  it('orange wins over the codeword check (off-screen with codeword)', () => {
    // Intersection tracker may release codewords on viewport exit, but
    // we're not asserting that here — just the predicate ordering.
    const w = makeWrapper(4, 'bake', /* inViewport */ false);
    expect(classifyWrapper(w)).toBe('orange');
  });
});

describe('pageRect', () => {
  it('offsets viewport rect by scroll to produce page coords', () => {
    const r = pageRect(
      { top: 100, left: 50, width: 80, height: 30 },
      /* scrollX */ 0,
      /* scrollY */ 200,
    );
    expect(r).toEqual({ top: 300, left: 50, width: 80, height: 30 });
  });

  it('handles non-zero scrollX (horizontal scroll)', () => {
    const r = pageRect(
      { top: 10, left: 20, width: 5, height: 5 },
      /* scrollX */ 100,
      /* scrollY */ 50,
    );
    expect(r).toEqual({ top: 60, left: 120, width: 5, height: 5 });
  });

  it('passes through zero scroll', () => {
    const r = pageRect({ top: 1, left: 2, width: 3, height: 4 }, 0, 0);
    expect(r).toEqual({ top: 1, left: 2, width: 3, height: 4 });
  });
});

describe('toggleOverlay', () => {
  beforeEach(() => {
    _resetOverlayForTesting();
    // Clear any leftover DOM from previous tests (happy-dom doesn't
    // recycle the document between describes).
    document.body.innerHTML = '';
  });

  it('starts inactive', () => {
    expect(isOverlayActive()).toBe(false);
    expect(document.querySelector('[data-branchkit-debug-overlay]')).toBeNull();
  });

  it('toggles on: appends a root with [data-branchkit-debug-overlay]', () => {
    const store = new WrapperStore();
    toggleOverlay(store);
    expect(isOverlayActive()).toBe(true);
    const root = document.querySelector('[data-branchkit-debug-overlay]');
    expect(root).not.toBeNull();
  });

  it('toggles off: removes the root and resets state', () => {
    const store = new WrapperStore();
    toggleOverlay(store);
    toggleOverlay(store);
    expect(isOverlayActive()).toBe(false);
    expect(document.querySelector('[data-branchkit-debug-overlay]')).toBeNull();
  });

  it('toggle-on renders one box per live wrapper', () => {
    const store = new WrapperStore();
    store.addWrapper(makeWrapper(1, 'arch'));
    store.addWrapper(makeWrapper(2, 'bake'));
    toggleOverlay(store);
    const root = document.querySelector('[data-branchkit-debug-overlay]')!;
    // 2 boxes for the 2 wrappers; almost-hintable/registry-rejected
    // walks return nothing on an empty document.
    expect(root.children.length).toBe(2);
  });

  it('survives repeated toggle cycles without state leak', () => {
    const store = new WrapperStore();
    for (let i = 0; i < 3; i++) {
      toggleOverlay(store);
      expect(isOverlayActive()).toBe(true);
      toggleOverlay(store);
      expect(isOverlayActive()).toBe(false);
      expect(document.querySelector('[data-branchkit-debug-overlay]')).toBeNull();
    }
  });
});

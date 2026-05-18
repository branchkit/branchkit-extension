/**
 * BranchKit Browser — WrapperStore + ElementWrapper unit tests.
 *
 * Pins the per-element store API that Sprint B's MutationObserver
 * (incremental discovery) and IntersectionObserver (claim/release) both
 * rely on. Element references are fakes — the Map in WrapperStore only
 * needs reference equality, not real DOM behavior.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementWrapper, WrapperStore, scoreTextMatch } from './element-wrapper';
import { ScannedElement } from './types';

// Reference-equality stand-in for Element. WrapperStore's Map uses object
// identity; ElementWrapper.destroy is a no-op when hint is null.
function fakeElement(label = 'el'): Element {
  return { tagName: 'BUTTON', __debug: label } as unknown as Element;
}

function fakeScanned(overrides: Partial<ScannedElement> = {}): ScannedElement {
  return {
    label: 'click me',
    selector: 'button',
    category: 'button',
    type: 'button',
    adapter: null,
    codeword: '',
    ...overrides,
  };
}

// Mock chrome.runtime.sendMessage. Cast through unknown — the @types/chrome
// runtime surface is huge, and these tests only use `sendMessage`.
let sendMessageMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendMessageMock = vi.fn().mockResolvedValue(undefined);
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: sendMessageMock },
  };
});

describe('WrapperStore', () => {
  it('addWrapper indexes by element and exposes via findWrapperFor', () => {
    const store = new WrapperStore();
    const el = fakeElement();
    const w = new ElementWrapper(el, fakeScanned());
    store.addWrapper(w);

    expect(store.findWrapperFor(el)).toBe(w);
    expect(store.all).toEqual([w]);
    expect(store.count).toBe(1);
  });

  it('addWrapper is idempotent for the same element', () => {
    const store = new WrapperStore();
    const el = fakeElement();
    const w1 = new ElementWrapper(el, fakeScanned({ label: 'first' }));
    const w2 = new ElementWrapper(el, fakeScanned({ label: 'second' }));
    store.addWrapper(w1);
    store.addWrapper(w2);

    expect(store.count).toBe(1);
    expect(store.findWrapperFor(el)).toBe(w1);
  });

  it('removeWrapperByElement drops from both list and index, returns the wrapper', () => {
    const store = new WrapperStore();
    const el = fakeElement();
    const w = new ElementWrapper(el, fakeScanned());
    store.addWrapper(w);

    const removed = store.removeWrapperByElement(el);
    expect(removed).toBe(w);
    expect(store.findWrapperFor(el)).toBeUndefined();
    expect(store.all).toEqual([]);
  });

  it('removeWrapperByElement is a no-op for unknown elements', () => {
    const store = new WrapperStore();
    expect(store.removeWrapperByElement(fakeElement())).toBeUndefined();
    expect(store.count).toBe(0);
  });

  it('removeWrapperByElement releases the wrapper’s pool codeword', () => {
    const store = new WrapperStore();
    const el = fakeElement();
    const w = new ElementWrapper(el, fakeScanned({ codeword: 'arch' }));
    store.addWrapper(w);

    store.removeWrapperByElement(el);
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'RELEASE_LABELS',
      labels: ['arch'],
    });
  });

  it('set replaces both list and index', () => {
    const store = new WrapperStore();
    const e1 = fakeElement('one');
    const e2 = fakeElement('two');
    const e3 = fakeElement('three');
    store.addWrapper(new ElementWrapper(e1, fakeScanned()));

    const w2 = new ElementWrapper(e2, fakeScanned());
    const w3 = new ElementWrapper(e3, fakeScanned());
    store.set([w2, w3]);

    expect(store.findWrapperFor(e1)).toBeUndefined();
    expect(store.findWrapperFor(e2)).toBe(w2);
    expect(store.findWrapperFor(e3)).toBe(w3);
    expect(store.count).toBe(2);
  });

  it('clear empties both list and index', () => {
    const store = new WrapperStore();
    const el = fakeElement();
    store.addWrapper(new ElementWrapper(el, fakeScanned()));
    store.clear();
    expect(store.findWrapperFor(el)).toBeUndefined();
    expect(store.count).toBe(0);
  });

  it('clear releases each wrapper’s pool codeword', () => {
    // Without this, codewords held by cleared wrappers stay "assigned"
    // server-side until tab close — destroy() tears down the badge but
    // doesn't talk to the pool.
    const store = new WrapperStore();
    const w1 = new ElementWrapper(fakeElement('a'), fakeScanned({ codeword: 'arch' }));
    const w2 = new ElementWrapper(fakeElement('b'), fakeScanned({ codeword: 'rain bake' }));
    const w3 = new ElementWrapper(fakeElement('c'), fakeScanned({ codeword: '' }));
    store.addWrapper(w1);
    store.addWrapper(w2);
    store.addWrapper(w3);

    store.clear();

    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'RELEASE_LABELS', labels: ['arch'] });
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'RELEASE_LABELS', labels: ['rain bake'] });
    // w3 had no codeword; releaseLabel is a no-op, no extra call.
    const releaseCalls = sendMessageMock.mock.calls.filter(([m]) => m.type === 'RELEASE_LABELS');
    expect(releaseCalls).toHaveLength(2);
  });
});

describe('ElementWrapper.releaseLabel', () => {
  it('sends RELEASE_LABELS for the held codeword and clears it locally', () => {
    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'rain bake' }));
    w.releaseLabel();

    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'RELEASE_LABELS',
      labels: ['rain bake'],
    });
    expect(w.scanned.codeword).toBe('');
    expect(w.label).toBeNull();
  });

  it('is a no-op when no codeword is held', () => {
    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: '' }));
    w.releaseLabel();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('is idempotent — the second call has nothing to release', () => {
    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));
    w.releaseLabel();
    w.releaseLabel();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
  });
});

describe('scoreTextMatch', () => {
  it('returns 0 for empty label', () => {
    expect(scoreTextMatch('', 'foo')).toBe(0);
  });

  it('returns 0 when query not found', () => {
    expect(scoreTextMatch('Hello World', 'xyz')).toBe(0);
  });

  it('scores 8 for exact first-token match', () => {
    expect(scoreTextMatch('Get started', 'get')).toBe(8);
  });

  it('scores 4 for exact later-token match', () => {
    expect(scoreTextMatch('Get started now', 'now')).toBe(4);
  });

  it('scores 6 for prefix of first token', () => {
    expect(scoreTextMatch('Settings page', 'set')).toBe(6);
  });

  it('scores 2 for prefix of later token', () => {
    expect(scoreTextMatch('Go to settings', 'set')).toBe(2);
  });

  it('scores 1 for substring-only match', () => {
    expect(scoreTextMatch('Unresettable', 'set')).toBe(1);
  });

  it('is case-insensitive', () => {
    expect(scoreTextMatch('GitHub', 'github')).toBe(8);
  });

  it('tokenizes on non-word characters', () => {
    expect(scoreTextMatch('Sign-in / Register', 'register')).toBe(4);
  });

  it('picks the best score across all tokens', () => {
    expect(scoreTextMatch('Settings and setup', 'set')).toBe(6);
  });
});

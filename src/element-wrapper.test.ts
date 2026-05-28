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
import {
  ElementWrapper,
  WrapperStore,
  enterLimbo,
  isLimboExpired,
  scoreTextMatch,
} from './element-wrapper';
import { ScannedElement } from './types';

// Reference-equality stand-in for Element. WrapperStore's Map uses object
// identity; ElementWrapper.destroy is a no-op when hint is null.
function fakeElement(label = 'el'): Element {
  return { tagName: 'BUTTON', __debug: label } as unknown as Element;
}

function fakeScanned(overrides: Partial<ScannedElement> = {}): ScannedElement {
  return {
    label: 'click me',
    id: 0,
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

describe('rescan stability under lazy load', () => {
  // Locks the invariant Option B's per-batch refactor relies on: element
  // identity → codeword binding survives any rescan, regardless of scan
  // order. doScan walks refs in viewport/DOM order; for each ref it skips
  // creation if findWrapperFor(ref) already returns a wrapper. So an
  // element that gets codeword "arch arch" on scan 1 and reappears at a
  // different position on scan 2 keeps "arch arch" — the wrapper (and its
  // .scanned.codeword) is reused, the codeword isn't re-derived from
  // position. The "claim" in these tests assigns directly to
  // wrapper.scanned.codeword; the real flow goes through the intersection
  // tracker + label pool, but pool ordering is already covered by
  // label-pool.test.ts. See notes/DESIGN_HINT_PIPELINE_RESYNC.md item 6.

  // Simulate doScan's walk: for each ref in scan order, reuse an existing
  // wrapper or attach a new one. Returns the wrappers in the same order as
  // refs so callers can assert positional behavior.
  function doScanLike(store: WrapperStore, refs: Element[]): ElementWrapper[] {
    const out: ElementWrapper[] = [];
    for (const ref of refs) {
      let w = store.findWrapperFor(ref);
      if (!w) {
        w = new ElementWrapper(ref, fakeScanned());
        store.addWrapper(w);
      }
      out.push(w);
    }
    return out;
  }

  it('insertion at position 0 preserves codewords on all prior wrappers', () => {
    const store = new WrapperStore();
    const e1 = fakeElement('one');
    const e2 = fakeElement('two');
    const e3 = fakeElement('three');

    // Scan 1: three elements get wrappers; tracker claims codewords.
    doScanLike(store, [e1, e2, e3]);
    store.findWrapperFor(e1)!.scanned.codeword = 'arch arch';
    store.findWrapperFor(e2)!.scanned.codeword = 'arch bake';
    store.findWrapperFor(e3)!.scanned.codeword = 'arch check';

    // Scan 2: a lazy-loaded element e0 appears at position 0. doScan's
    // findWrapperFor short-circuit means e1/e2/e3 reuse their wrappers.
    const e0 = fakeElement('zero');
    doScanLike(store, [e0, e1, e2, e3]);

    expect(store.findWrapperFor(e1)!.scanned.codeword).toBe('arch arch');
    expect(store.findWrapperFor(e2)!.scanned.codeword).toBe('arch bake');
    expect(store.findWrapperFor(e3)!.scanned.codeword).toBe('arch check');
    // e0 has a wrapper but no codeword yet — tracker hasn't claimed.
    expect(store.findWrapperFor(e0)!.scanned.codeword).toBe('');
  });

  it('rescan returning refs in a different order preserves codewords', () => {
    const store = new WrapperStore();
    const e1 = fakeElement('one');
    const e2 = fakeElement('two');
    const e3 = fakeElement('three');

    doScanLike(store, [e1, e2, e3]);
    store.findWrapperFor(e1)!.scanned.codeword = 'arch arch';
    store.findWrapperFor(e2)!.scanned.codeword = 'arch bake';
    store.findWrapperFor(e3)!.scanned.codeword = 'arch check';

    // Refs come back reordered (e.g. a sort key changed). Bindings are by
    // element identity, not list position, so codewords are unchanged.
    doScanLike(store, [e3, e1, e2]);

    expect(store.findWrapperFor(e1)!.scanned.codeword).toBe('arch arch');
    expect(store.findWrapperFor(e2)!.scanned.codeword).toBe('arch bake');
    expect(store.findWrapperFor(e3)!.scanned.codeword).toBe('arch check');
  });

  it('repeated lazy loads at position 0 accumulate fresh wrappers without disturbing earlier ones', () => {
    const store = new WrapperStore();
    const e1 = fakeElement('one');
    const e2 = fakeElement('two');

    doScanLike(store, [e1, e2]);
    store.findWrapperFor(e1)!.scanned.codeword = 'arch arch';
    store.findWrapperFor(e2)!.scanned.codeword = 'arch bake';

    // Lazy load #1: insert eA before everything, then tracker claims its codeword.
    const eA = fakeElement('A');
    doScanLike(store, [eA, e1, e2]);
    store.findWrapperFor(eA)!.scanned.codeword = 'arch check';

    // Lazy load #2: insert eB at the new front.
    const eB = fakeElement('B');
    doScanLike(store, [eB, eA, e1, e2]);
    store.findWrapperFor(eB)!.scanned.codeword = 'arch deck';

    expect(store.findWrapperFor(e1)!.scanned.codeword).toBe('arch arch');
    expect(store.findWrapperFor(e2)!.scanned.codeword).toBe('arch bake');
    expect(store.findWrapperFor(eA)!.scanned.codeword).toBe('arch check');
    expect(store.findWrapperFor(eB)!.scanned.codeword).toBe('arch deck');
    expect(store.count).toBe(4);
  });

  it('lazy-loaded element disappearing on a later scan releases only its own codeword', () => {
    const store = new WrapperStore();
    const e1 = fakeElement('one');
    const e2 = fakeElement('two');
    const e0 = fakeElement('zero');

    doScanLike(store, [e0, e1, e2]);
    store.findWrapperFor(e0)!.scanned.codeword = 'arch arch';
    store.findWrapperFor(e1)!.scanned.codeword = 'arch bake';
    store.findWrapperFor(e2)!.scanned.codeword = 'arch check';

    // Scan 2: e0 is gone. Drop wrappers whose elements are no longer in
    // the scan result (doScan's dropDisconnectedWrappers analogue).
    const refs2 = [e1, e2];
    const survivors = new Set(refs2);
    for (const w of [...store.all]) {
      if (!survivors.has(w.element)) store.removeWrapperByElement(w.element);
    }

    expect(store.findWrapperFor(e0)).toBeUndefined();
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'RELEASE_LABELS',
      labels: ['arch arch'],
    });
    // Other wrappers' codewords are untouched (no release for them).
    expect(store.findWrapperFor(e1)!.scanned.codeword).toBe('arch bake');
    expect(store.findWrapperFor(e2)!.scanned.codeword).toBe('arch check');
    const releaseCalls = sendMessageMock.mock.calls.filter(([m]) => m.type === 'RELEASE_LABELS');
    expect(releaseCalls).toHaveLength(1);
  });
});

describe('limbo lifecycle', () => {
  // Step 1–2 of DESIGN_WRAPPER_IDENTITY_STABILITY: a wrapper that loses
  // its DOM element enters limbo (keeps its codeword + badge), and the
  // finalize sweeper detaches only those whose limbo deadline elapsed.
  // The rebind logic (step 3+) isn't tested here.

  const fakeRect = (x: number, y: number, w = 10, h = 10): DOMRect => ({
    x, y, width: w, height: h,
    top: y, left: x, right: x + w, bottom: y + h,
    toJSON: () => ({}),
  } as DOMRect);

  it('enterLimbo records timestamp and rect on a connected wrapper', () => {
    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));
    const rect = fakeRect(40, 60);

    enterLimbo(w, 1_000, rect);

    expect(w.disconnectedAt).toBe(1_000);
    expect(w.lastRect).toBe(rect);
    // Codeword stays — limbo holds the pool allocation until finalize.
    expect(w.scanned.codeword).toBe('arch');
  });

  it('enterLimbo is idempotent — repeated calls do not reset the timer', () => {
    const w = new ElementWrapper(fakeElement(), fakeScanned());
    const firstRect = fakeRect(0, 0);
    enterLimbo(w, 1_000, firstRect);
    enterLimbo(w, 5_000, fakeRect(99, 99));

    expect(w.disconnectedAt).toBe(1_000);
    expect(w.lastRect).toBe(firstRect);
  });

  it('enterLimbo accepts a null rect (uncached element)', () => {
    const w = new ElementWrapper(fakeElement(), fakeScanned());
    enterLimbo(w, 1_000, null);

    expect(w.disconnectedAt).toBe(1_000);
    expect(w.lastRect).toBeNull();
  });

  it('isLimboExpired is false for connected wrappers', () => {
    const w = new ElementWrapper(fakeElement(), fakeScanned());
    expect(isLimboExpired(w, 999_999, 250)).toBe(false);
  });

  it('isLimboExpired is false within the deadline window', () => {
    const w = new ElementWrapper(fakeElement(), fakeScanned());
    enterLimbo(w, 1_000, null);
    expect(isLimboExpired(w, 1_100, 250)).toBe(false);
    expect(isLimboExpired(w, 1_249, 250)).toBe(false);
  });

  it('isLimboExpired is true at and past the deadline', () => {
    const w = new ElementWrapper(fakeElement(), fakeScanned());
    enterLimbo(w, 1_000, null);
    expect(isLimboExpired(w, 1_250, 250)).toBe(true);
    expect(isLimboExpired(w, 5_000, 250)).toBe(true);
  });

  it('store retains limbo wrappers — codeword is still claimed', () => {
    // Mirrors the content.ts contract: dropDisconnectedWrappers marks the
    // wrapper but leaves it in the store. Anything iterating store.all
    // (grammar push, etc.) still sees the codeword.
    const store = new WrapperStore();
    const el = fakeElement();
    const w = new ElementWrapper(el, fakeScanned({ codeword: 'arch' }));
    store.addWrapper(w);

    enterLimbo(w, 1_000, fakeRect(0, 0));

    expect(store.findWrapperFor(el)).toBe(w);
    expect(store.count).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('sweep applies the existing detach path to every expired wrapper', () => {
    // Models finalizeExpiredLimboWrappers without pulling in the
    // content.ts module: select expired wrappers, then call the existing
    // store.removeWrapperByElement (the detach path's pool release).
    const store = new WrapperStore();
    const elA = fakeElement('a');
    const elB = fakeElement('b');
    const elC = fakeElement('c');
    const wA = new ElementWrapper(elA, fakeScanned({ codeword: 'arch' }));
    const wB = new ElementWrapper(elB, fakeScanned({ codeword: 'bake' }));
    const wC = new ElementWrapper(elC, fakeScanned({ codeword: 'check' }));
    store.addWrapper(wA);
    store.addWrapper(wB);
    store.addWrapper(wC);

    // A and B enter limbo at different times; C stays connected.
    enterLimbo(wA, 1_000, fakeRect(0, 0));
    enterLimbo(wB, 1_200, fakeRect(10, 10));

    const deadline = 250;
    const now = 1_300;
    for (const w of [...store.all]) {
      if (isLimboExpired(w, now, deadline)) {
        store.removeWrapperByElement(w.element);
      }
    }

    // wA: 1_300 - 1_000 = 300 >= 250 → finalized.
    // wB: 1_300 - 1_200 = 100 < 250 → still in limbo.
    // wC: never entered limbo → untouched.
    expect(store.findWrapperFor(elA)).toBeUndefined();
    expect(store.findWrapperFor(elB)).toBe(wB);
    expect(store.findWrapperFor(elC)).toBe(wC);
    const released = sendMessageMock.mock.calls
      .filter(([m]) => m.type === 'RELEASE_LABELS')
      .map(([m]) => m.labels[0]);
    expect(released).toEqual(['arch']);
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

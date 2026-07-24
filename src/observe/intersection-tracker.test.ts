/**
 * BranchKit Browser — IntersectionTracker unit tests.
 *
 * IntersectionObserver is mocked as a no-op since its async behavior
 * is environment-driven; the testable logic is the claim/release queue,
 * the flush sequencing, and the two-strike exit ledger. Since
 * DESIGN_OBSERVED_STATE_READ_TIME phase 3 the tracker stores no band flag
 * and IO entries are wake-up signals only — claims arrive via queueClaims
 * from the engine's band-convergence pass, and the flush re-derives band
 * membership from a fresh rect at grant time.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { IntersectionTracker, TrackerEvents } from './intersection-tracker';
import { ScannedElement } from '../types';
import { labelReservoir } from '../labels/label-reservoir';

let sendMessageMock: ReturnType<typeof vi.fn>;

function fakeElement(
  label = 'el',
  rect: { left: number; top: number; width: number; height: number } =
    { left: 0, top: 0, width: 10, height: 10 },
): Element {
  // Match the DOMRect shape: include right/bottom/x/y derived fields so
  // any caller that reads them (now or later) gets consistent values.
  const fullRect = {
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  };
  return {
    tagName: 'BUTTON',
    __debug: label,
    isConnected: true,
    getBoundingClientRect: () => fullRect,
  } as unknown as Element;
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

function makeEvents() {
  return {
    onCodewordsChanged: vi.fn(),
    onBandActivity: vi.fn(),
  } satisfies TrackerEvents;
}

class FakeIntersectionObserver {
  callback: IntersectionObserverCallback;
  observed: Set<Element> = new Set();
  static lastInstance: FakeIntersectionObserver | null = null;

  constructor(cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {
    this.callback = cb;
    FakeIntersectionObserver.lastInstance = this;
  }
  observe(el: Element): void { this.observed.add(el); }
  unobserve(el: Element): void { this.observed.delete(el); }
  disconnect(): void { this.observed.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }

  /** Test helper: fire a synthetic intersection entry. */
  fire(target: Element, isIntersecting: boolean, boundingClientRect?: DOMRect): void {
    const rect = boundingClientRect ?? ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) } as DOMRect);
    this.callback(
      [{ target, isIntersecting, boundingClientRect: rect } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

beforeEach(() => {
  sendMessageMock = vi.fn();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: sendMessageMock },
  };
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver =
    FakeIntersectionObserver;
  // Reset the module-level reservoir between tests so each test starts
  // with a known label set instead of inheriting state from the prior one.
  labelReservoir._seedForTests([]);
});

/** Seed the per-frame reservoir with deterministic labels for this test.
 *  Replaces the old SW-mocked CLAIM_LABELS response now that claims are
 *  served from the local reservoir. */
function setupClaimResponse(labels: string[]): void {
  labelReservoir._seedForTests(labels);
  // RELEASE_LABELS is still IPC-bound (async SW notify). Stub it so
  // sendMessage calls during release don't hang.
  sendMessageMock.mockImplementation((msg: { type: string }) => {
    if (msg.type === 'RELEASE_LABELS') return Promise.resolve(undefined);
    if (msg.type === 'CLAIM_LABELS') return Promise.resolve({ labels: [] });
    return Promise.resolve(undefined);
  });
}

describe('IntersectionTracker.queueClaims (the single store-claim path)', () => {
  it('claims a codeword for every queued wrapper that lacks one', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const a = new ElementWrapper(fakeElement('a'), fakeScanned());
    const b = new ElementWrapper(fakeElement('b'), fakeScanned());
    store.addWrapper(a);
    store.addWrapper(b);

    setupClaimResponse(['arch', 'bake']);
    tracker.queueClaims([a, b]);
    await tracker.flushNow();

    expect(a.scanned.codeword).toBe('arch');
    expect(b.scanned.codeword).toBe('bake');
    expect(events.onCodewordsChanged).toHaveBeenCalled();
  });

  it('skips wrappers that already hold a codeword and stays quiet when all skip', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const held = new ElementWrapper(fakeElement('held'), fakeScanned({ codeword: 'rain' }));
    store.addWrapper(held);

    setupClaimResponse(['arch']);
    tracker.queueClaims([held]);
    await tracker.flushNow();

    expect(held.scanned.codeword).toBe('rain');
    expect(events.onCodewordsChanged).not.toHaveBeenCalled();
  });

  it('the fresh-rect guard returns the label for a wrapper that left the band before flush', async () => {
    // The caller derived in-band at pass time, but the wrapper moved (or the
    // page re-laid-out) before the flush microtask — the grant-time re-check
    // must return the label to the pool instead of granting a codeword the
    // release direction would have to chase.
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const left = new ElementWrapper(
      fakeElement('left', { left: 0, top: 5000, width: 10, height: 10 }),
      fakeScanned(),
    );
    store.addWrapper(left);

    setupClaimResponse(['arch']);
    tracker.queueClaims([left]);
    await tracker.flushNow();

    expect(left.scanned.codeword).toBe('');
    // The label went back to the reservoir, not into the void.
    expect(labelReservoir.claim(1)).toEqual(['arch']);
  });

  it('the fresh-rect guard drops a wrapper whose element detached before flush', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const gone = new ElementWrapper(fakeElement('gone'), fakeScanned());
    (gone.element as unknown as { isConnected: boolean }).isConnected = false;
    store.addWrapper(gone);

    setupClaimResponse(['arch']);
    tracker.queueClaims([gone]);
    await tracker.flushNow();

    expect(gone.scanned.codeword).toBe('');
    expect(labelReservoir.claim(1)).toEqual(['arch']);
  });

  it('assigns codewords in queue order for the whole batch', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const wrappers: ElementWrapper[] = [];
    for (let i = 0; i < 5; i++) {
      const w = new ElementWrapper(fakeElement(`w${i}`), fakeScanned());
      store.addWrapper(w);
      wrappers.push(w);
    }

    setupClaimResponse(['a', 'b', 'c', 'd', 'e']);
    tracker.queueClaims(wrappers);
    await tracker.flushNow();

    expect(wrappers.map(w => w.scanned.codeword)).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('handles pool exhaustion by leaving tail wrappers unlabeled', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const wrappers = [];
    for (let i = 0; i < 4; i++) {
      const w = new ElementWrapper(fakeElement(`w${i}`), fakeScanned());
      store.addWrapper(w);
      wrappers.push(w);
    }

    setupClaimResponse(['a', 'b']);
    tracker.queueClaims(wrappers);
    await tracker.flushNow();

    expect(wrappers[0].scanned.codeword).toBe('a');
    expect(wrappers[1].scanned.codeword).toBe('b');
    expect(wrappers[2].scanned.codeword).toBe('');
    expect(wrappers[3].scanned.codeword).toBe('');
  });

  it('replays a released codeword on the next claim (sticky reclaim)', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const w = new ElementWrapper(fakeElement('w0'), fakeScanned());
    store.addWrapper(w);
    tracker.observe(w.element);

    // Seed two labels so the reservoir has choice — sticky reclaim should
    // pull the preferred one out of order even when other free labels exist.
    setupClaimResponse(['arch bake', 'other']);
    tracker.queueClaims([w]);
    await tracker.flushNow();
    expect(w.scanned.codeword).toBe('arch bake');

    // Band exit (the release applier's path): the codeword clears but is
    // stashed, and the reservoir takes the label back (front of pool).
    tracker.queueRelease(w);
    await tracker.flushNow();
    expect(w.scanned.codeword).toBe('');
    expect(w.preferredCodeword).toBe('arch bake');

    // Scroll back in: the reservoir's sticky-reclaim pass should hand us
    // the same codeword the wrapper held before, NOT the other free label.
    tracker.queueClaims([w]);
    await tracker.flushNow();

    expect(w.scanned.codeword).toBe('arch bake');
  });

  it('does not call onCodewordsChanged when nothing was claimed or released', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    setupClaimResponse([]);
    await tracker.flushNow();

    expect(events.onCodewordsChanged).not.toHaveBeenCalled();
    const claimCalls = sendMessageMock.mock.calls.filter(([m]) => m.type === 'CLAIM_LABELS');
    expect(claimCalls).toHaveLength(0);
  });

  it('is idempotent — re-queueing a codeworded wrapper does not re-claim', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const w = new ElementWrapper(fakeElement('w'), fakeScanned());
    store.addWrapper(w);

    setupClaimResponse(['arch', 'bake']);
    tracker.queueClaims([w]);
    await tracker.flushNow();
    expect(w.scanned.codeword).toBe('arch');

    tracker.queueClaims([w]);
    await tracker.flushNow();

    expect(w.scanned.codeword).toBe('arch');
    expect(events.onCodewordsChanged).toHaveBeenCalledTimes(1);
  });
});

describe('IntersectionTracker entries are wake-up signals', () => {
  // DESIGN_OBSERVED_STATE_READ_TIME phase 3: entries write no lifecycle
  // state and queue no claims/releases — a dropped or discarded entry costs
  // one pass of latency, never a standing lie.

  function rect(x: number, y: number, w = 40, h = 20): DOMRect {
    return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect;
  }

  it('fires onBandActivity for a live wrapper entry and writes no codeword state', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);
    const io = FakeIntersectionObserver.lastInstance!;

    const w = new ElementWrapper(fakeElement(), fakeScanned());
    store.addWrapper(w);
    tracker.observe(w.element);

    setupClaimResponse(['arch']);
    io.fire(w.element, true, rect(0, 0));
    await tracker.flushNow();

    expect(events.onBandActivity).toHaveBeenCalledTimes(1);
    expect(w.scanned.codeword).toBe(''); // the PASS claims, not the entry
  });

  it('writes entry.boundingClientRect to wrapper.lastRect on every entry', () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);
    const io = FakeIntersectionObserver.lastInstance!;

    const w = new ElementWrapper(fakeElement(), fakeScanned());
    store.addWrapper(w);
    tracker.observe(w.element);

    expect(w.lastRect).toBeNull();
    const first = rect(100, 200);
    io.fire(w.element, true, first);
    // Reference equality: the tracker stores the IO-provided rect as-is,
    // it doesn't copy. That's intentional — DOMRect is cheap to retain
    // and an extra copy would be wasted work on every IO entry.
    expect(w.lastRect).toBe(first);

    // A subsequent entry (scroll, reflow) keeps it fresh.
    const second = rect(100, 150);
    io.fire(w.element, true, second);
    expect(w.lastRect).toBe(second);
  });

  it('does not overwrite lastRect or wake for a limbo wrapper', () => {
    // After disconnect, IO may emit one final not-intersecting entry —
    // preserve the pre-disconnect rect for the position tiebreaker, and
    // don't burn a settle on a wrapper limbo is deliberately holding.
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);
    const io = FakeIntersectionObserver.lastInstance!;

    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));
    store.addWrapper(w);
    tracker.observe(w.element);

    const preDisconnect = rect(100, 200);
    io.fire(w.element, true, preDisconnect);
    expect(w.lastRect).toBe(preDisconnect);
    events.onBandActivity.mockClear();

    w.disconnectedAt = 1_000;  // limbo
    io.fire(w.element, false, rect(0, 0));  // zero rect from disconnected el
    expect(w.lastRect).toBe(preDisconnect);  // unchanged
    expect(events.onBandActivity).not.toHaveBeenCalled();
  });

  it('never releases a limbo wrapper codeword from an entry', async () => {
    // DESIGN_WRAPPER_IDENTITY_STABILITY decision 3, now structural: entries
    // release nothing at all, so the limbo window cannot silently return
    // codewords to the pool.
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);
    const io = FakeIntersectionObserver.lastInstance!;

    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));
    w.disconnectedAt = 1_000;  // marked as limbo
    store.addWrapper(w);
    tracker.observe(w.element);

    io.fire(w.element, false);
    await tracker.flushNow();

    expect(w.scanned.codeword).toBe('arch');
    const releaseCalls = sendMessageMock.mock.calls.filter(([m]) => m.type === 'RELEASE_LABELS');
    expect(releaseCalls).toHaveLength(0);
  });
});

describe('IntersectionTracker.queueRelease', () => {
  it('clears the codeword, stashes it for sticky reclaim, and notifies', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));
    store.addWrapper(w);

    setupClaimResponse([]);
    tracker.queueRelease(w);
    await tracker.flushNow();

    expect(w.scanned.codeword).toBe('');
    expect(w.preferredCodeword).toBe('arch');
    const releaseCalls = sendMessageMock.mock.calls.filter(([m]) => m.type === 'RELEASE_LABELS');
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0][0]).toEqual({ type: 'RELEASE_LABELS', doc_id: expect.any(String), labels: ['arch'] });
  });
});

describe('IntersectionTracker exit-strike ledger', () => {
  // Temporal hysteresis for the destructive direction (drill round 6,
  // inherited from the deleted sweepBand): the first out-of-band sighting
  // records a strike; only a second sighting >= EXIT_STRIKE_MIN_MS (50ms)
  // later confirms. An in-band sighting clears.

  it('confirms an exit only on the second strike with real spacing', () => {
    const store = new WrapperStore();
    const tracker = new IntersectionTracker(store, makeEvents());
    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));

    expect(tracker.strikeOut(w, 1000)).toBe(false); // strike one
    expect(tracker.strikeOut(w, 1100)).toBe(true);  // >= 50ms later — confirmed
  });

  it('two near-instant sightings do not confirm (per-batch reconcile guard)', () => {
    const store = new WrapperStore();
    const tracker = new IntersectionTracker(store, makeEvents());
    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));

    expect(tracker.strikeOut(w, 1000)).toBe(false);
    expect(tracker.strikeOut(w, 1010)).toBe(false); // 10ms apart — still one strike
    expect(tracker.strikeOut(w, 1060)).toBe(true);  // spacing satisfied vs first strike
  });

  it('clearExitStrike resets the ledger (transient virtualizer park)', () => {
    const store = new WrapperStore();
    const tracker = new IntersectionTracker(store, makeEvents());
    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));

    expect(tracker.strikeOut(w, 1000)).toBe(false);
    tracker.clearExitStrike(w); // bounced back in-band between passes
    expect(tracker.strikeOut(w, 2000)).toBe(false); // strike one again
  });
});

describe('IntersectionTracker.unobserve', () => {
  it('removes the wrapper from pendingClaim so a detached wrapper does not leak a codeword', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const w = new ElementWrapper(fakeElement(), fakeScanned());
    store.addWrapper(w);
    tracker.observe(w.element);
    tracker.queueClaims([w]);

    // Wrapper is queued for claim, then detached before flush. The pool
    // would otherwise hand out a codeword for nobody.
    tracker.unobserve(w.element);
    store.removeWrapperByElement(w.element);

    setupClaimResponse(['arch']);
    await tracker.flushNow();

    const claimCalls = sendMessageMock.mock.calls.filter(([m]) => m.type === 'CLAIM_LABELS');
    expect(claimCalls).toHaveLength(0);
  });
});

describe('IntersectionTracker.flushNow', () => {
  it('drains pending work that arrives between flushes', async () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    setupClaimResponse(['first', 'second']);

    const w1 = new ElementWrapper(fakeElement('w1'), fakeScanned());
    store.addWrapper(w1);
    tracker.queueClaims([w1]);

    const w2 = new ElementWrapper(fakeElement('w2'), fakeScanned());
    store.addWrapper(w2);
    tracker.queueClaims([w2]);

    await tracker.flushNow();

    expect(w1.scanned.codeword).toBe('first');
    expect(w2.scanned.codeword).toBe('second');
  });
});

describe('IntersectionTracker.disconnectAll', () => {
  it('drops all observations and pending claims', () => {
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const w = new ElementWrapper(fakeElement(), fakeScanned());
    store.addWrapper(w);
    tracker.observe(w.element);
    tracker.queueClaims([w]);

    tracker.disconnectAll();

    // After disconnect+flush, no claim should have been issued because the
    // pending queue was cleared.
    setupClaimResponse([]);
    return tracker.flushNow().then(() => {
      const claimCalls = sendMessageMock.mock.calls.filter(([m]) => m.type === 'CLAIM_LABELS');
      expect(claimCalls).toHaveLength(0);
    });
  });
});

describe('IntersectionTracker claim ordering', () => {
  it('assigns codewords in discovery order, independent of rect distance', async () => {
    // No viewport-distance re-deal: codewords zip onto wrappers in the
    // order they were queued, regardless of where each element sits in the
    // viewport. Rects here are deliberately "out of distance order" to
    // prove they no longer influence assignment.
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const first = new ElementWrapper(
      fakeElement('first', { left: 900, top: 700, width: 10, height: 10 }),
      fakeScanned({ id: 1 }),
    );
    const second = new ElementWrapper(
      fakeElement('second', { left: 400, top: 300, width: 10, height: 10 }),
      fakeScanned({ id: 2 }),
    );
    const third = new ElementWrapper(
      fakeElement('third', { left: 0, top: 0, width: 10, height: 10 }),
      fakeScanned({ id: 3 }),
    );
    store.addWrapper(first);
    store.addWrapper(second);
    store.addWrapper(third);

    setupClaimResponse(['arch', 'bake', 'check']);
    tracker.queueClaims([first, second, third]);
    await tracker.flushNow();

    // Front-of-pool codeword goes to the first-queued wrapper.
    expect(first.scanned.codeword).toBe('arch');
    expect(second.scanned.codeword).toBe('bake');
    expect(third.scanned.codeword).toBe('check');
  });

  it('preserves codeword assignments across a no-op flush (stability regression)', async () => {
    // Once a wrapper holds a codeword, no further flush touches it unless
    // the release direction fires for it. This test pins that property.
    const store = new WrapperStore();
    const events = makeEvents();
    const tracker = new IntersectionTracker(store, events);

    const a = new ElementWrapper(
      fakeElement('a', { left: 0, top: 0, width: 10, height: 10 }),
      fakeScanned({ id: 1 }),
    );
    const b = new ElementWrapper(
      fakeElement('b', { left: 200, top: 200, width: 10, height: 10 }),
      fakeScanned({ id: 2 }),
    );
    store.addWrapper(a);
    store.addWrapper(b);

    setupClaimResponse(['arch', 'bake']);
    tracker.queueClaims([a, b]);
    await tracker.flushNow();
    const aFirst = a.scanned.codeword;
    const bFirst = b.scanned.codeword;
    expect(aFirst).toBeTruthy();
    expect(bFirst).toBeTruthy();

    // No-op flush — re-queueing sees codewords already on both wrappers
    // and skips them.
    tracker.queueClaims([a, b]);
    await tracker.flushNow();

    // Codewords unchanged.
    expect(a.scanned.codeword).toBe(aFirst);
    expect(b.scanned.codeword).toBe(bFirst);
  });
});

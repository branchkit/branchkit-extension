/**
 * BranchKit Browser — IntersectionTracker unit tests.
 *
 * IntersectionObserver is mocked as a no-op since its async behavior
 * is environment-driven; the testable logic is the claim/release queue
 * and the flush sequencing. Where a test needs to simulate IO firing,
 * it manipulates wrapper state and uses public surface
 * (refreshViewportClaims, flushNow) to drive the queue.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { IntersectionTracker } from './intersection-tracker';
import { ScannedElement } from '../types';

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
});

function setupClaimResponse(labels: string[]): void {
  // CLAIM_LABELS gets the first matching response; RELEASE_LABELS doesn't
  // need a response value but we resolve undefined so awaits don't hang.
  sendMessageMock.mockImplementation((msg: { type: string }) => {
    if (msg.type === 'CLAIM_LABELS') return Promise.resolve({ labels });
    return Promise.resolve(undefined);
  });
}

describe('IntersectionTracker.refreshViewportClaims', () => {
  it('claims a codeword for every viewport-visible wrapper that lacks one', async () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    const onScreen1 = new ElementWrapper(fakeElement('a'), fakeScanned());
    const onScreen2 = new ElementWrapper(fakeElement('b'), fakeScanned());
    const offScreen = new ElementWrapper(fakeElement('c'), fakeScanned());
    onScreen1.isInViewport = true;
    onScreen2.isInViewport = true;
    offScreen.isInViewport = false;
    store.addWrapper(onScreen1);
    store.addWrapper(onScreen2);
    store.addWrapper(offScreen);

    setupClaimResponse(['arch', 'bake']);
    tracker.refreshViewportClaims();
    await tracker.flushNow();

    expect(onScreen1.scanned.codeword).toBe('arch');
    expect(onScreen2.scanned.codeword).toBe('bake');
    expect(offScreen.scanned.codeword).toBe('');
    expect(events.onCodewordsChanged).toHaveBeenCalled();
  });

  it('skips wrappers that already hold a codeword', async () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    const held = new ElementWrapper(fakeElement('held'), fakeScanned({ codeword: 'rain' }));
    const empty = new ElementWrapper(fakeElement('empty'), fakeScanned());
    held.isInViewport = true;
    empty.isInViewport = true;
    store.addWrapper(held);
    store.addWrapper(empty);

    setupClaimResponse(['arch']);
    tracker.refreshViewportClaims();
    await tracker.flushNow();

    expect(held.scanned.codeword).toBe('rain');
    expect(empty.scanned.codeword).toBe('arch');
  });

  it('issues exactly one CLAIM_LABELS for the whole batch', async () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    for (let i = 0; i < 5; i++) {
      const w = new ElementWrapper(fakeElement(`w${i}`), fakeScanned());
      w.isInViewport = true;
      store.addWrapper(w);
    }

    setupClaimResponse(['a', 'b', 'c', 'd', 'e']);
    tracker.refreshViewportClaims();
    await tracker.flushNow();

    const claimCalls = sendMessageMock.mock.calls.filter(
      ([msg]) => msg.type === 'CLAIM_LABELS',
    );
    expect(claimCalls).toHaveLength(1);
    expect(claimCalls[0][0]).toEqual({
      type: 'CLAIM_LABELS',
      count: 5,
      // Fresh wrappers have no prior codeword, so preferred is all-empty.
      preferred: ['', '', '', '', ''],
    });
  });

  it('handles pool exhaustion by leaving tail wrappers unlabeled', async () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    const wrappers = [];
    for (let i = 0; i < 4; i++) {
      const w = new ElementWrapper(fakeElement(`w${i}`), fakeScanned());
      w.isInViewport = true;
      store.addWrapper(w);
      wrappers.push(w);
    }

    setupClaimResponse(['a', 'b']);
    tracker.refreshViewportClaims();
    await tracker.flushNow();

    expect(wrappers[0].scanned.codeword).toBe('a');
    expect(wrappers[1].scanned.codeword).toBe('b');
    expect(wrappers[2].scanned.codeword).toBe('');
    expect(wrappers[3].scanned.codeword).toBe('');
  });

  it('replays a released codeword as preferred on the next claim (sticky)', async () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    const w = new ElementWrapper(fakeElement('w0'), fakeScanned());
    w.isInViewport = true;
    store.addWrapper(w);
    tracker.observe(w.element);

    setupClaimResponse(['arch bake']);
    tracker.refreshViewportClaims();
    await tracker.flushNow();
    expect(w.scanned.codeword).toBe('arch bake');

    // Scroll out of the viewport: IO exit clears the codeword but stashes it.
    FakeIntersectionObserver.lastInstance!.fire(w.element, false);
    await tracker.flushNow();
    expect(w.scanned.codeword).toBe('');
    expect(w.preferredCodeword).toBe('arch bake');

    // Scroll back in: re-claim must request the same codeword as preferred.
    w.isInViewport = true;
    sendMessageMock.mockClear();
    tracker.refreshViewportClaims();
    await tracker.flushNow();

    const claimCall = sendMessageMock.mock.calls.find(
      ([msg]) => msg.type === 'CLAIM_LABELS',
    );
    expect(claimCall![0].preferred).toEqual(['arch bake']);
  });

  it('does not call onCodewordsChanged when nothing was claimed or released', async () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    setupClaimResponse([]);
    await tracker.flushNow();

    expect(events.onCodewordsChanged).not.toHaveBeenCalled();
    const claimCalls = sendMessageMock.mock.calls.filter(([m]) => m.type === 'CLAIM_LABELS');
    expect(claimCalls).toHaveLength(0);
  });
});

describe('IntersectionTracker lastRect snapshot', () => {
  // Without this, lastRect would almost always be null at limbo entry —
  // the layout cache is cleared after every reposition and the MO-driven
  // disconnect path runs with an empty cache. IO entries are the
  // continuous source of "where was this element just now."

  function rect(x: number, y: number, w = 40, h = 20): DOMRect {
    return { x, y, width: w, height: h, top: y, left: x, right: x + w, bottom: y + h, toJSON: () => ({}) } as DOMRect;
  }

  it('writes entry.boundingClientRect to wrapper.lastRect on every entry', () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
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

  it('does not overwrite lastRect while the wrapper is in limbo', () => {
    // After disconnect, IO may emit one final not-intersecting entry —
    // we want to preserve the pre-disconnect rect for the position
    // tiebreaker, not overwrite it with whatever bogus rect the
    // disconnected element reports.
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);
    const io = FakeIntersectionObserver.lastInstance!;

    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));
    store.addWrapper(w);
    tracker.observe(w.element);

    const preDisconnect = rect(100, 200);
    io.fire(w.element, true, preDisconnect);
    expect(w.lastRect).toBe(preDisconnect);

    w.disconnectedAt = 1_000;  // limbo
    io.fire(w.element, false, rect(0, 0));  // zero rect from disconnected el
    expect(w.lastRect).toBe(preDisconnect);  // unchanged
  });
});

describe('IntersectionTracker limbo gating', () => {
  // DESIGN_WRAPPER_IDENTITY_STABILITY decision 3: a disconnected
  // element's IO `isIntersecting: false` must not strip the wrapper's
  // codeword. Otherwise the limbo window would silently release
  // codewords back to the pool, defeating the rebind story.

  it('does not release codeword when a limbo wrapper fires not-intersecting', async () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);
    const io = FakeIntersectionObserver.lastInstance!;

    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));
    w.isInViewport = true;
    w.disconnectedAt = 1_000;  // marked as limbo
    store.addWrapper(w);
    tracker.observe(w.element);

    // Simulate the IO firing the disconnect entry that Chrome emits
    // after `el.remove()`.
    io.fire(w.element, false);

    await tracker.flushNow();

    // Codeword still on the wrapper, badge state untouched, no
    // RELEASE_LABELS request issued.
    expect(w.scanned.codeword).toBe('arch');
    const releaseCalls = sendMessageMock.mock.calls.filter(([m]) => m.type === 'RELEASE_LABELS');
    expect(releaseCalls).toHaveLength(0);
  });

  it('processes intersection entries normally once the wrapper de-limbos', async () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);
    const io = FakeIntersectionObserver.lastInstance!;

    const w = new ElementWrapper(fakeElement(), fakeScanned({ codeword: 'arch' }));
    w.isInViewport = true;
    w.disconnectedAt = 1_000;
    store.addWrapper(w);
    tracker.observe(w.element);

    // Rebind clears disconnectedAt — IT should resume normal handling
    // on the next entry. (We don't drive the full rebind path here;
    // that lives in content.ts. Just flip the flag.)
    w.disconnectedAt = null;
    io.fire(w.element, false);
    await tracker.flushNow();

    expect(w.scanned.codeword).toBe('');
    const releaseCalls = sendMessageMock.mock.calls.filter(([m]) => m.type === 'RELEASE_LABELS');
    expect(releaseCalls).toHaveLength(1);
    expect(releaseCalls[0][0]).toEqual({ type: 'RELEASE_LABELS', labels: ['arch'] });
  });
});

describe('IntersectionTracker.unobserve', () => {
  it('removes the wrapper from pendingClaim so a detached wrapper does not leak a codeword', async () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    const w = new ElementWrapper(fakeElement(), fakeScanned());
    w.isInViewport = true;
    store.addWrapper(w);
    tracker.observe(w.element);
    tracker.refreshViewportClaims();

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
  it('drains pending work that arrives during an in-flight flush', async () => {
    // Regression for the showHints race. Without flushNow's drain loop,
    // a doFlush mid-await on CLAIM_LABELS while a new IO entry queues a
    // second claim would let flushNow return after only the first
    // claim resolves — showHints would then render badges for wrappers
    // whose codewords haven't landed yet.
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);
    const io = FakeIntersectionObserver.lastInstance!;

    const w1 = new ElementWrapper(fakeElement('w1'), fakeScanned());
    store.addWrapper(w1);
    tracker.observe(w1.element);

    let resolveFirst: (v: { labels: string[] }) => void = () => {};
    let firstClaimSeen = false;
    sendMessageMock.mockImplementation((msg: { type: string }) => {
      if (msg.type === 'CLAIM_LABELS' && !firstClaimSeen) {
        firstClaimSeen = true;
        return new Promise<{ labels: string[] }>(r => { resolveFirst = r; });
      }
      if (msg.type === 'CLAIM_LABELS') {
        return Promise.resolve({ labels: ['second'] });
      }
      return Promise.resolve(undefined);
    });

    // Fire intersect for w1 → queues a claim → schedules a 50ms flush.
    io.fire(w1.element, true);

    // flushNow clears the timer and starts the first doFlush.
    const flushPromise = tracker.flushNow();

    // Yield until doFlush has issued sendMessage and is suspended on it.
    await Promise.resolve();
    await Promise.resolve();

    // Mid-flight: a new wrapper intersects. handleEntries skips wrappers
    // that already hold a codeword, so w1 won't be re-queued — only w2.
    const w2 = new ElementWrapper(fakeElement('w2'), fakeScanned());
    store.addWrapper(w2);
    tracker.observe(w2.element);
    io.fire(w2.element, true);

    // Resolve the first claim. flushNow's drain loop should then pick
    // up w2 in a second doFlush before resolving.
    resolveFirst({ labels: ['first'] });
    await flushPromise;

    expect(w1.scanned.codeword).toBe('first');
    expect(w2.scanned.codeword).toBe('second');
  });
});

describe('IntersectionTracker.disconnectAll', () => {
  it('drops all observations and pending claims', () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    const w = new ElementWrapper(fakeElement(), fakeScanned());
    w.isInViewport = true;
    store.addWrapper(w);
    tracker.observe(w.element);
    tracker.refreshViewportClaims();

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
    // order they were discovered (store insertion order), regardless of
    // where each element sits in the viewport. Rects here are deliberately
    // "out of distance order" to prove they no longer influence assignment.
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
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
    first.isInViewport = true;
    second.isInViewport = true;
    third.isInViewport = true;
    store.addWrapper(first);
    store.addWrapper(second);
    store.addWrapper(third);

    setupClaimResponse(['arch', 'bake', 'check']);
    tracker.refreshViewportClaims();
    await tracker.flushNow();

    // Front-of-pool codeword goes to the first-discovered wrapper.
    expect(first.scanned.codeword).toBe('arch');
    expect(second.scanned.codeword).toBe('bake');
    expect(third.scanned.codeword).toBe('check');
  });

  it('preserves codeword assignments across a no-op flush (stability regression)', async () => {
    // The Sprint C definition of done requires that "re-scan after a
    // no-op page mutation produces identical hint assignments." In our
    // pipeline that's enforced not by a stability metric (deferred in
    // path 1) but by the absence of re-allocation: once a wrapper
    // holds a codeword, no further flush touches it unless IO fires
    // for it. This test pins that property.
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    const a = new ElementWrapper(
      fakeElement('a', { left: 0, top: 0, width: 10, height: 10 }),
      fakeScanned({ id: 1 }),
    );
    const b = new ElementWrapper(
      fakeElement('b', { left: 200, top: 200, width: 10, height: 10 }),
      fakeScanned({ id: 2 }),
    );
    a.isInViewport = true;
    b.isInViewport = true;
    store.addWrapper(a);
    store.addWrapper(b);

    setupClaimResponse(['arch', 'bake']);
    tracker.refreshViewportClaims();
    await tracker.flushNow();
    const aFirst = a.scanned.codeword;
    const bFirst = b.scanned.codeword;
    expect(aFirst).toBeTruthy();
    expect(bFirst).toBeTruthy();

    // No-op flush — neither wrapper changed viewport state, no IO
    // entries fired, refreshViewportClaims sees codewords already on
    // both wrappers and skips them.
    tracker.refreshViewportClaims();
    await tracker.flushNow();

    // Codewords unchanged.
    expect(a.scanned.codeword).toBe(aFirst);
    expect(b.scanned.codeword).toBe(bFirst);
  });
});

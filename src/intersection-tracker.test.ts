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
import { ElementWrapper, WrapperStore } from './element-wrapper';
import { IntersectionTracker } from './intersection-tracker';
import { ScannedElement } from './types';

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
    selector: 'button',
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
  fire(target: Element, isIntersecting: boolean): void {
    this.callback(
      [{ target, isIntersecting } as IntersectionObserverEntry],
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
    expect(claimCalls[0][0]).toEqual({ type: 'CLAIM_LABELS', count: 5 });
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

describe('IntersectionTracker rank-aware allocation', () => {
  // In a node test env without a DOM, getFocusPoint falls through to
  // viewport center. With `typeof window === 'undefined'`, that center
  // is (0, 0). Wrapper rects are interpreted relative to that origin —
  // the closest-rect-center wrapper gets the cheapest codeword.

  it('pairs rank-sorted wrappers with codewords from the pool', async () => {
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    // Three wrappers at increasing distance from origin (0, 0).
    // Note that codeword assignment is INDEPENDENT of insertion order:
    // we deliberately add and queue them in reverse-distance order, then
    // verify the closest gets the cheapest codeword regardless.
    const far = new ElementWrapper(
      fakeElement('far', { left: 1000, top: 1000, width: 10, height: 10 }),
      fakeScanned({ selector: 'button.far' }),
    );
    const mid = new ElementWrapper(
      fakeElement('mid', { left: 100, top: 100, width: 10, height: 10 }),
      fakeScanned({ selector: 'button.mid' }),
    );
    const near = new ElementWrapper(
      fakeElement('near', { left: 0, top: 0, width: 10, height: 10 }),
      fakeScanned({ selector: 'button.near' }),
    );
    far.isInViewport = true;
    mid.isInViewport = true;
    near.isInViewport = true;
    store.addWrapper(far);
    store.addWrapper(mid);
    store.addWrapper(near);

    setupClaimResponse(['arch', 'bake', 'check']); // pool order: cheap → expensive
    tracker.refreshViewportClaims();
    await tracker.flushNow();

    // Closest-to-origin wrapper gets the front-of-pool codeword.
    expect(near.scanned.codeword).toBe('arch');
    expect(mid.scanned.codeword).toBe('bake');
    expect(far.scanned.codeword).toBe('check');
  });

  it('rank-sorts even when wrappers arrive in already-sorted insertion order', async () => {
    // Sanity check: the sort doesn't break the trivially-already-sorted
    // case. Closest first by insertion → still closest first by rank.
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    const a = new ElementWrapper(
      fakeElement('a', { left: 0, top: 0, width: 10, height: 10 }),
      fakeScanned({ selector: 'a' }),
    );
    const b = new ElementWrapper(
      fakeElement('b', { left: 200, top: 0, width: 10, height: 10 }),
      fakeScanned({ selector: 'b' }),
    );
    a.isInViewport = true;
    b.isInViewport = true;
    store.addWrapper(a);
    store.addWrapper(b);

    setupClaimResponse(['arch', 'bake']);
    tracker.refreshViewportClaims();
    await tracker.flushNow();

    expect(a.scanned.codeword).toBe('arch');
    expect(b.scanned.codeword).toBe('bake');
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
      fakeScanned({ selector: 'a' }),
    );
    const b = new ElementWrapper(
      fakeElement('b', { left: 200, top: 200, width: 10, height: 10 }),
      fakeScanned({ selector: 'b' }),
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

  it('falls back to insertion order when all wrappers tie on distance', async () => {
    // All wrappers at the same rect → identical distance → stable sort
    // preserves insertion order. This is what existing tests (which use
    // the default 0,0,10,10 rect on every fake element) rely on.
    const store = new WrapperStore();
    const events = { onCodewordsChanged: vi.fn() };
    const tracker = new IntersectionTracker(store, events);

    const w1 = new ElementWrapper(fakeElement('1'), fakeScanned({ selector: 'one' }));
    const w2 = new ElementWrapper(fakeElement('2'), fakeScanned({ selector: 'two' }));
    const w3 = new ElementWrapper(fakeElement('3'), fakeScanned({ selector: 'three' }));
    w1.isInViewport = true;
    w2.isInViewport = true;
    w3.isInViewport = true;
    store.addWrapper(w1);
    store.addWrapper(w2);
    store.addWrapper(w3);

    setupClaimResponse(['arch', 'bake', 'check']);
    tracker.refreshViewportClaims();
    await tracker.flushNow();

    expect(w1.scanned.codeword).toBe('arch');
    expect(w2.scanned.codeword).toBe('bake');
    expect(w3.scanned.codeword).toBe('check');
  });
});

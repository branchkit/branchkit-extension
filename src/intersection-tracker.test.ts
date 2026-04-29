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

class FakeIntersectionObserver {
  observed: Set<Element> = new Set();
  constructor(_cb: IntersectionObserverCallback, _opts?: IntersectionObserverInit) {}
  observe(el: Element): void { this.observed.add(el); }
  unobserve(el: Element): void { this.observed.delete(el); }
  disconnect(): void { this.observed.clear(); }
  takeRecords(): IntersectionObserverEntry[] { return []; }
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

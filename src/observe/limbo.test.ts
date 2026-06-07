/**
 * BranchKit Browser — limbo / rebind / finalize unit tests.
 *
 * Pins the store orchestration that was previously only reachable through the
 * content-script monolith: which wrappers are rebind-eligible, that disconnected
 * wrappers enter limbo, and that the finalize sweeper detaches the expired-dead
 * while graduating the reconnected-alive. The pure rebind-distance decision is
 * covered by labels/rebind.test.ts.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ElementWrapper, enterLimbo } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { store } from '../core/store';
import {
  initLimbo,
  collectLimboWrappers,
  dropDisconnectedWrappers,
  finalizeExpiredLimboWrappers,
  rebindCounters,
} from './limbo';

function scanned(id: number): ScannedElement {
  return { label: 'x', id, category: 'button', type: 'button', adapter: null, codeword: '' };
}

/** Make a wrapper backed by a real element. `connected` controls isConnected. */
function makeWrapper(connected: boolean, id = 1): ElementWrapper {
  const el = document.createElement('div');
  if (connected) document.body.appendChild(el);
  const w = new ElementWrapper(el, scanned(id));
  store.addWrapper(w);
  return w;
}

let detachWrapper: ReturnType<typeof vi.fn>;
let trackerObserve: ReturnType<typeof vi.fn>;
let resizeObserve: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.clear();
  detachWrapper = vi.fn();
  trackerObserve = vi.fn();
  resizeObserve = vi.fn();
  initLimbo({
    detachWrapper: detachWrapper as unknown as (element: Element) => void,
    tracker: { observe: trackerObserve, unobserve: vi.fn() } as unknown as Parameters<typeof initLimbo>[0]['tracker'],
    resizeObserver: { observe: resizeObserve, unobserve: vi.fn(), disconnect: vi.fn() } as unknown as ResizeObserver,
  });
  rebindCounters.refuse_no_match = 0;
});

afterEach(() => {
  store.clear();
  document.body.replaceChildren();
});

describe('collectLimboWrappers', () => {
  it('returns only disconnected limbo wrappers with a registry id', () => {
    const live = makeWrapper(true, 1);            // connected, not limbo
    const disconnectedFresh = makeWrapper(false, 2); // disconnected, not yet limbo
    const limboDead = makeWrapper(false, 3);      // disconnected limbo — eligible
    enterLimbo(limboDead, Date.now());
    const limboButConnected = makeWrapper(true, 4); // limbo flag set but still connected
    enterLimbo(limboButConnected, Date.now());
    const limboNoId = makeWrapper(false, 0);      // disconnected limbo but id<=0
    enterLimbo(limboNoId, Date.now());

    const eligible = collectLimboWrappers();
    expect(eligible).toEqual([limboDead]);
    // Sanity: the others are excluded for the stated reasons.
    expect(eligible).not.toContain(live);
    expect(eligible).not.toContain(disconnectedFresh);
    expect(eligible).not.toContain(limboButConnected);
    expect(eligible).not.toContain(limboNoId);
  });
});

describe('dropDisconnectedWrappers', () => {
  it('moves disconnected wrappers into limbo and leaves connected ones alone', () => {
    const live = makeWrapper(true, 1);
    const dead = makeWrapper(false, 2);
    expect(dead.disconnectedAt).toBeNull();

    const entered = dropDisconnectedWrappers();

    expect(entered).toBe(1);
    expect(dead.disconnectedAt).not.toBeNull();
    expect(live.disconnectedAt).toBeNull();
  });

  it('does not re-enter wrappers already in limbo', () => {
    const dead = makeWrapper(false, 1);
    enterLimbo(dead, 123);
    const entered = dropDisconnectedWrappers();
    expect(entered).toBe(0);
    expect(dead.disconnectedAt).toBe(123);
  });
});

describe('finalizeExpiredLimboWrappers', () => {
  it('detaches an expired wrapper whose element is gone', () => {
    const dead = makeWrapper(false, 1);
    enterLimbo(dead, 1); // long past the 250ms deadline relative to now

    const finalized = finalizeExpiredLimboWrappers();

    expect(finalized).toBe(1);
    expect(detachWrapper).toHaveBeenCalledWith(dead.element);
    expect(rebindCounters.refuse_no_match).toBe(1);
  });

  it('graduates a still-connected limbo wrapper back to live instead of detaching', () => {
    const reconnected = makeWrapper(true, 1);
    enterLimbo(reconnected, 1); // expired, but element is connected

    const finalized = finalizeExpiredLimboWrappers();

    expect(finalized).toBe(0);
    expect(detachWrapper).not.toHaveBeenCalled();
    expect(reconnected.disconnectedAt).toBeNull();
    expect(trackerObserve).toHaveBeenCalledWith(reconnected.element);
    expect(resizeObserve).toHaveBeenCalledWith(reconnected.element);
  });

  it('ignores limbo wrappers whose deadline has not elapsed', () => {
    const fresh = makeWrapper(false, 1);
    enterLimbo(fresh, Date.now()); // just entered — not expired

    const finalized = finalizeExpiredLimboWrappers();

    expect(finalized).toBe(0);
    expect(detachWrapper).not.toHaveBeenCalled();
  });
});

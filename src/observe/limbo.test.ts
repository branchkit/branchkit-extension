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
import { pageSession } from '../lifecycle/page-session';
import type { IntersectionTracker } from './intersection-tracker';
import {
  collectLimboWrappers,
  collectStrongKeyIndex,
  tryRebindByStrongKey,
  isRecentlyOrphaned,
  dropDisconnectedWrappers,
  finalizeExpiredLimboWrappers,
  rebindCounters,
} from './limbo';
import { detachWrapper } from '../core/wrapper-lifecycle';

// limbo imports detachWrapper directly from core/wrapper-lifecycle (Tier 3 —
// the initLimbo seam is gone); stub the module so the finalize/refuse paths
// don't run the real detach against the store. attachWrapper is stubbed too:
// page-session/visibility-tracker import it in this module graph.
vi.mock('../core/wrapper-lifecycle', () => ({ detachWrapper: vi.fn(), attachWrapper: vi.fn() }));

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

/** Wrapper backed by an anchor with a strong key (href). */
function makeAnchor(href: string, id: number): ElementWrapper {
  const el = document.createElement('a');
  el.setAttribute('href', href);
  document.body.appendChild(el);
  const w = new ElementWrapper(el, scanned(id));
  store.addWrapper(w);
  return w;
}

/** A connected anchor with no wrapper yet (a freshly re-mounted node). */
function freeAnchor(href: string): HTMLAnchorElement {
  const el = document.createElement('a');
  el.setAttribute('href', href);
  document.body.appendChild(el);
  return el;
}

let trackerObserve: ReturnType<typeof vi.fn>;
let resizeObserve: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.clear();
  vi.mocked(detachWrapper).mockClear();
  trackerObserve = vi.fn();
  resizeObserve = vi.fn();
  // limbo reaches the observers through the pageSession singleton (Tier 3) —
  // install fakes directly.
  pageSession.tracker = { observe: trackerObserve, unobserve: vi.fn() } as unknown as IntersectionTracker;
  pageSession.resizeObserver = { observe: resizeObserve, unobserve: vi.fn(), disconnect: vi.fn() } as unknown as ResizeObserver;
  rebindCounters.refuse_no_match = 0;
  rebindCounters.rebind_key = 0;
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

describe('collectStrongKeyIndex', () => {
  it('maps a single-holder key to its wrapper', () => {
    const w = makeAnchor('/users', 1);
    expect(collectStrongKeyIndex().get('h:/users')).toBe(w);
  });

  it('marks a key held by 2+ wrappers as ambiguous (null)', () => {
    makeAnchor('/home', 1);
    makeAnchor('/home', 2);
    expect(collectStrongKeyIndex().get('h:/home')).toBeNull();
  });

  it('omits wrappers with no strong key or no registry id', () => {
    makeWrapper(true, 1);        // div — no href
    makeAnchor('/x', 0);         // anchor but id <= 0
    expect([...collectStrongKeyIndex().keys()]).toEqual([]);
  });
});

describe('tryRebindByStrongKey', () => {
  it('transfers the wrapper (codeword + id) onto a re-mounted same-href node', () => {
    const w = makeAnchor('/users', 7);
    w.scanned.codeword = 'harp bat';
    const oldEl = w.element;
    const index = collectStrongKeyIndex();
    const newEl = freeAnchor('/users');

    const ok = tryRebindByStrongKey(newEl, index, []);

    expect(ok).toBe(true);
    expect(w.element).toBe(newEl);                  // re-anchored to the new node
    expect(w.scanned.codeword).toBe('harp bat');    // codeword preserved
    expect(w.scanned.id).toBe(7);                   // identity preserved
    expect(store.findWrapperFor(newEl)).toBe(w);
    expect(store.findWrapperFor(oldEl)).toBeUndefined();
    expect(rebindCounters.rebind_key).toBe(1);
    expect(isRecentlyOrphaned(oldEl)).toBe(true);   // ping-pong guard armed
  });

  it('refuses when the key is ambiguous (2+ holders)', () => {
    makeAnchor('/home', 1);
    makeAnchor('/home', 2);
    const index = collectStrongKeyIndex();
    expect(tryRebindByStrongKey(freeAnchor('/home'), index, [])).toBe(false);
  });

  it('refuses an element with no strong key', () => {
    makeAnchor('/users', 1);
    const index = collectStrongKeyIndex();
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(tryRebindByStrongKey(div, index, [])).toBe(false);
  });

  it('consumes the entry so a second same-key node falls through to fresh', () => {
    makeAnchor('/users', 1);
    const index = collectStrongKeyIndex();
    expect(tryRebindByStrongKey(freeAnchor('/users'), index, [])).toBe(true);
    expect(tryRebindByStrongKey(freeAnchor('/users'), index, [])).toBe(false);
  });

  it('also removes the rebound wrapper from the limbo pool', () => {
    const w = makeAnchor('/users', 1);
    const pool = [w];
    const ok = tryRebindByStrongKey(freeAnchor('/users'), collectStrongKeyIndex(), pool);
    expect(ok).toBe(true);
    expect(pool).toEqual([]); // consumed, so the fingerprint path can't double-bind it
  });
});

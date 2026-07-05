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
  tryRebindBySlot,
  recordSlotAncestors,
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
  rebindCounters.rebind_slot = 0;
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
    expect(collectStrongKeyIndex().get('h:/users')).toEqual([w]);
  });

  it('queues 2+ same-key wrappers in attach order (round 34)', () => {
    const w1 = makeAnchor('/home', 1);
    const w2 = makeAnchor('/home', 2);
    expect(collectStrongKeyIndex().get('h:/home')).toEqual([w1, w2]);
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

    expect(ok).toBeTruthy();
    expect(w.element).toBe(newEl);                  // re-anchored to the new node
    expect(w.scanned.codeword).toBe('harp bat');    // codeword preserved
    expect(w.scanned.id).toBe(7);                   // identity preserved
    expect(store.findWrapperFor(newEl)).toBe(w);
    expect(store.findWrapperFor(oldEl)).toBeUndefined();
    expect(rebindCounters.rebind_key).toBe(1);
    expect(isRecentlyOrphaned(oldEl)).toBe(true);   // ping-pong guard armed
  });

  it('pops multi-holder keys in attach order (round 34: repeated-value columns)', () => {
    const w1 = makeAnchor('/home', 1);
    const w2 = makeAnchor('/home', 2);
    const index = collectStrongKeyIndex();
    const n1 = freeAnchor('/home');
    const n2 = freeAnchor('/home');
    expect(tryRebindByStrongKey(n1, index, [])).toBeTruthy();
    expect(w1.element).toBe(n1); // document-order pairing: first predecessor first
    expect(tryRebindByStrongKey(n2, index, [])).toBeTruthy();
    expect(w2.element).toBe(n2);
    // Queue exhausted — a third same-key node claims fresh.
    expect(tryRebindByStrongKey(freeAnchor('/home'), index, [])).toBeNull();
  });

  it('refuses an element with no strong key', () => {
    makeAnchor('/users', 1);
    const index = collectStrongKeyIndex();
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(tryRebindByStrongKey(div, index, [])).toBeNull();
  });

  it('consumes the entry so a second same-key node falls through to fresh', () => {
    makeAnchor('/users', 1);
    const index = collectStrongKeyIndex();
    expect(tryRebindByStrongKey(freeAnchor('/users'), index, [])).toBeTruthy();
    expect(tryRebindByStrongKey(freeAnchor('/users'), index, [])).toBeNull();
  });

  it('pops a DISCONNECTED holder before a connected one (round 34e: never steal from a healthy row when a dead holder exists)', () => {
    const alive = makeAnchor('/home', 1);
    const dead = makeAnchor('/home', 2);
    dead.element.remove();
    const index = collectStrongKeyIndex();
    const n = freeAnchor('/home');
    const res = tryRebindByStrongKey(n, index, []);
    expect(res).toBeTruthy();
    expect(dead.element).toBe(n);          // the dead holder rode
    expect(res!.orphaned).toBeNull();      // nothing connected was orphaned
    expect(alive.element).not.toBe(n);     // the healthy row kept its wrapper
  });

  it('reports a connected steal via `orphaned` so the caller can re-attach it fresh (round 34e)', () => {
    const alive = makeAnchor('/home', 1);
    const oldEl = alive.element;
    const res = tryRebindByStrongKey(freeAnchor('/home'), collectStrongKeyIndex(), []);
    expect(res).toBeTruthy();
    expect(res!.orphaned).toBe(oldEl);
  });

  it('also removes the rebound wrapper from the limbo pool', () => {
    const w = makeAnchor('/users', 1);
    const pool = [w];
    const ok = tryRebindByStrongKey(freeAnchor('/users'), collectStrongKeyIndex(), pool);
    expect(ok).toBeTruthy();
    expect(pool).toEqual([]); // consumed, so the fingerprint path can't double-bind it
  });

  it('never rebinds a wrapper the store no longer holds (finalize-sweeper race)', () => {
    // The key index is a pass-start snapshot; the finalize sweeper can detach
    // a queued wrapper during a batched-walk yield. The stale entry must be
    // skipped — rebinding it would put a wrapper in byElement that store.all
    // lacks, leaving the new element permanently undiscoverable.
    const w = makeAnchor('/users', 1);
    w.element.remove(); // disconnected — exactly what the dead-first pop prefers
    const index = collectStrongKeyIndex();
    store.removeWrapperByElement(w.element); // what the sweeper's detach does

    const newEl = freeAnchor('/users');
    expect(tryRebindByStrongKey(newEl, index, [])).toBeNull();
    expect(store.findWrapperFor(newEl)).toBeUndefined();
    expect(store.all).not.toContain(w);
  });

  it('skips a swept corpse and pops the next live holder instead', () => {
    const corpse = makeAnchor('/home', 1);
    corpse.element.remove();
    const survivor = makeAnchor('/home', 2);
    survivor.element.remove(); // disconnected but still store-held (in limbo)
    const index = collectStrongKeyIndex();
    store.removeWrapperByElement(corpse.element); // sweeper reaps the first

    const n = freeAnchor('/home');
    const res = tryRebindByStrongKey(n, index, []);
    expect(res).toBeTruthy();
    expect(survivor.element).toBe(n);
    expect(store.all).not.toContain(corpse);
  });
});

describe('tryRebindBySlot (DESIGN_FLING_WAVE Part 2)', () => {
  // A virtualized grid swaps a cell's content: new fingerprint, new href,
  // same surviving cell shell. The slot tier re-anchors the limbo wrapper
  // onto the replacement so badge/letter/grammar survive the swap.

  /** td cell holding one link; returns [cell, link, limbo wrapper]. */
  function cellWithLimboLink(id: number, text = 'old'): [HTMLElement, ElementWrapper] {
    const cell = document.createElement('td');
    document.body.appendChild(cell);
    const link = document.createElement('a');
    link.textContent = text;
    cell.appendChild(link);
    const w = new ElementWrapper(link, scanned(id));
    w.scanned.codeword = 'arch bake';
    store.addWrapper(w);
    recordSlotAncestors(w); // normally attachWrapper's job (mocked here)
    link.remove();
    enterLimbo(w, Date.now());
    return [cell, w];
  }

  function newLinkIn(cell: HTMLElement, text = 'new'): HTMLAnchorElement {
    const el = document.createElement('a');
    el.textContent = text;
    cell.appendChild(el);
    return el;
  }

  it('re-anchors a limbo wrapper onto same-slot replacement content', () => {
    const [cell, w] = cellWithLimboLink(1);
    const replacement = newLinkIn(cell);

    const pool = [w];
    const rebound = tryRebindBySlot(replacement, pool);

    expect(rebound).toBe(w);
    expect(w.element).toBe(replacement);
    expect(w.disconnectedAt).toBeNull();
    expect(w.scanned.codeword).toBe('arch bake'); // identity survives
    expect(pool).toEqual([]); // consumed
    expect(rebindCounters.rebind_slot).toBe(1);
    // Slot re-recorded from the NEW element for the next recycle.
    expect(w.slotAncestors.some(r => r.deref() === cell)).toBe(true);
  });

  it('refuses on tag mismatch (not a slot swap)', () => {
    const [cell, w] = cellWithLimboLink(1);
    const button = document.createElement('button');
    cell.appendChild(button);

    expect(tryRebindBySlot(button, [w])).toBeNull();
    expect(rebindCounters.rebind_slot).toBe(0);
  });

  it('refuses when two limbo wrappers claim the same new element', () => {
    const cell = document.createElement('td');
    document.body.appendChild(cell);
    const mk = (id: number) => {
      const link = document.createElement('a');
      cell.appendChild(link);
      const w = new ElementWrapper(link, scanned(id));
      store.addWrapper(w);
      recordSlotAncestors(w);
      link.remove();
      enterLimbo(w, Date.now());
      return w;
    };
    const w1 = mk(1);
    const w2 = mk(2);
    const replacement = newLinkIn(cell);

    expect(tryRebindBySlot(replacement, [w1, w2])).toBeNull();
    expect(rebindCounters.rebind_slot).toBe(0);
  });

  it('refuses when the surviving anchor holds two same-kind candidates', () => {
    const [cell, w] = cellWithLimboLink(1);
    newLinkIn(cell, 'first');
    const second = newLinkIn(cell, 'second');

    expect(tryRebindBySlot(second, [w])).toBeNull();
    expect(rebindCounters.rebind_slot).toBe(0);
  });

  it('falls through when no recorded ancestor survives (whole-row replacement)', () => {
    const [cell, w] = cellWithLimboLink(1);
    cell.remove(); // the shell died with the row
    const otherCell = document.createElement('td');
    document.body.appendChild(otherCell);
    const replacement = newLinkIn(otherCell);

    expect(tryRebindBySlot(replacement, [w])).toBeNull();
    expect(rebindCounters.rebind_slot).toBe(0);
  });

  it('never rebinds a wrapper the store no longer holds (finalize-sweeper race)', () => {
    // Same race as the strong-key tier: the pool is a pass-start snapshot,
    // the sweeper detached the wrapper mid-pass. Must fall through to fresh.
    const [cell, w] = cellWithLimboLink(1);
    const pool = [w];
    store.removeWrapperByElement(w.element); // sweeper reaped it

    const replacement = newLinkIn(cell);
    expect(tryRebindBySlot(replacement, pool)).toBeNull();
    expect(store.findWrapperFor(replacement)).toBeUndefined();
    expect(store.all).not.toContain(w);
    expect(rebindCounters.rebind_slot).toBe(0);
  });

  it('matches via a deeper recorded ancestor when the immediate parent died', () => {
    // link inside div inside td; the div is removed with the link, the new
    // link mounts directly in the td — the depth-2 record still matches.
    const cell = document.createElement('td');
    document.body.appendChild(cell);
    const inner = document.createElement('div');
    cell.appendChild(inner);
    const link = document.createElement('a');
    inner.appendChild(link);
    const w = new ElementWrapper(link, scanned(1));
    store.addWrapper(w);
    recordSlotAncestors(w);
    inner.remove();
    enterLimbo(w, Date.now());

    const replacement = newLinkIn(cell);
    expect(tryRebindBySlot(replacement, [w])).toBe(w);
    expect(w.element).toBe(replacement);
    expect(rebindCounters.rebind_slot).toBe(1);
  });
});

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

// --- Round 23: connected-predecessor takeover by fingerprint + position ---

import * as idRegistry from '../scan/registry';
import { computeFingerprint } from '../scan/registry';
import { collectFingerprintIndex, tryTakeoverByFingerprint } from './limbo';

describe('tryTakeoverByFingerprint (round 23)', () => {
  const domRect = (x: number, y: number, w = 40, h = 20): DOMRect =>
    ({ left: x, top: y, width: w, height: h, right: x + w, bottom: y + h, x, y, toJSON: () => ({}) }) as DOMRect;

  /** Connected wrapper, registered (the index reads registry fingerprints),
   * with a lever-2-fresh lastRect. */
  function makePredecessor(label: string, x: number, y: number, tag = 'button'): ElementWrapper {
    const el = document.createElement(tag);
    if (label) el.setAttribute('aria-label', label);
    if (tag === 'input') el.setAttribute('type', 'checkbox');
    document.body.appendChild(el);
    const w = new ElementWrapper(el, scanned(0));
    idRegistry.register(w);
    store.addWrapper(w);
    w.lastRect = domRect(x, y);
    return w;
  }

  /** A freshly-discovered lookalike with a real box (attachDiscovered refs
   * passed isVisible, so they always have geometry). */
  function makeReplacement(label: string, x: number, y: number, tag = 'button'): Element {
    const el = document.createElement(tag);
    if (label) el.setAttribute('aria-label', label);
    if (tag === 'input') el.setAttribute('type', 'checkbox');
    el.getBoundingClientRect = () => domRect(x, y);
    document.body.appendChild(el);
    return el;
  }

  const takeover = (el: Element, index = collectFingerprintIndex()) =>
    tryTakeoverByFingerprint(el, computeFingerprint(el), index);

  beforeEach(() => {
    idRegistry.clear();
    rebindCounters.takeover_fp = 0;
    rebindCounters.takeover_fp_position = 0;
    rebindCounters.refuse_fp_ambiguous = 0;
  });

  it('unique fingerprint: the wrapper (codeword + id) rides onto the co-located lookalike', () => {
    const w = makePredecessor('Edit purchase order 10897', 100, 100);
    w.scanned.codeword = 'harp bat';
    w.grammarReady = true;
    const oldEl = w.element;
    const newEl = makeReplacement('Edit purchase order 10897', 104, 102);

    expect(takeover(newEl)).toBe(true);
    expect(w.element).toBe(newEl);
    expect(w.scanned.codeword).toBe('harp bat');
    expect(w.grammarReady).toBe(true);
    expect(store.findWrapperFor(newEl)).toBe(w);
    expect(store.findWrapperFor(oldEl)).toBeUndefined();
    expect(rebindCounters.takeover_fp).toBe(1);
    expect(isRecentlyOrphaned(oldEl)).toBe(true); // ping-pong guard armed
  });

  it('unique fingerprint takes over regardless of position (round 24: during an insert-before-remove overlap the replacement is appended far from the doomed row)', () => {
    const w = makePredecessor('Edit purchase order 10897', 100, 100);
    const newEl = makeReplacement('Edit purchase order 10897', 100, 3400);
    expect(takeover(newEl)).toBe(true);
    expect(w.element).toBe(newEl);
    expect(rebindCounters.takeover_fp).toBe(1);
  });

  it('ambiguous fingerprints (identical checkboxes) resolve by tight+margin position', () => {
    const near = makePredecessor('', 50, 100, 'input');
    makePredecessor('', 50, 300, 'input');
    const newEl = makeReplacement('', 50, 102, 'input');

    expect(takeover(newEl)).toBe(true);
    expect(near.element).toBe(newEl);
    expect(rebindCounters.takeover_fp_position).toBe(1);
  });

  it('ambiguous without a uniquely-nearest candidate refuses (adjacent-row twins)', () => {
    // 30px apart — inside the tight gate but the margin over second-best
    // fails, exactly the same-column neighbor-row hazard.
    makePredecessor('', 50, 100, 'input');
    makePredecessor('', 50, 130, 'input');
    const newEl = makeReplacement('', 50, 115, 'input');

    expect(takeover(newEl)).toBe(false);
    expect(rebindCounters.refuse_fp_ambiguous).toBe(1);
  });

  it('consumes the winner: a second lookalike cannot steal the same predecessor', () => {
    makePredecessor('Edit purchase order 10897', 100, 100);
    const index = collectFingerprintIndex();
    expect(takeover(makeReplacement('Edit purchase order 10897', 100, 104), index)).toBe(true);
    expect(takeover(makeReplacement('Edit purchase order 10897', 100, 108), index)).toBe(false);
  });

  it('a unique candidate without a lastRect still takes over (no position term); an ambiguous group with one refuses', () => {
    const w = makePredecessor('Edit purchase order 10897', 0, 0);
    w.lastRect = null;
    expect(takeover(makeReplacement('Edit purchase order 10897', 4, 2))).toBe(true);
    expect(w.element instanceof HTMLElement).toBe(true);

    // Ambiguous group where one member can't be position-ranked → refuse.
    const a = makePredecessor('', 50, 100, 'input');
    makePredecessor('', 50, 300, 'input');
    a.lastRect = null;
    expect(takeover(makeReplacement('', 50, 102, 'input'))).toBe(false);
    expect(rebindCounters.refuse_fp_ambiguous).toBe(1);
  });

  it('limbo wrappers stay out of the index — the disconnected path owns them', () => {
    const w = makePredecessor('Edit purchase order 10897', 100, 100);
    w.element.remove();
    enterLimbo(w, performance.now());
    expect(collectFingerprintIndex().size).toBe(0);
  });
});

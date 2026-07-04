/**
 * BranchKit Browser — wrapper-lifecycle unit tests.
 *
 * Pins the attach/detach wiring and the attachDiscovered batch dedup that were
 * previously only reachable through the content-script monolith: attach adds to
 * the store and starts the observers; detach removes and unobserves all three;
 * attachDiscovered skips already-known refs and attaches the rest. The
 * codeword-less path is used so detach's delta-sync bookkeeping stays out of the
 * picture (covered by label-sync's own tests).
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { store } from './store';
import * as idRegistry from '../scan/registry';
import {
  attachWrapper,
  detachWrapper,
  attachDiscovered,
} from './wrapper-lifecycle';
import { collectLimboWrappers, collectStrongKeyIndex } from '../observe/limbo';
import { pageSession } from '../lifecycle/page-session';
import type { IntersectionTracker } from '../observe/intersection-tracker';
import type { AttentionObserver } from '../observe/attention-observer';

function scanned(label: string): ScannedElement {
  return { label, id: 0, category: 'button', type: 'button', adapter: null, codeword: '' };
}

/** A real element with a distinct accessible name so fingerprints don't collide. */
function el(name: string): HTMLElement {
  const node = document.createElement('button');
  node.setAttribute('aria-label', name);
  document.body.appendChild(node);
  return node;
}

/** A link with a strong key (href). */
function anchorEl(href: string): HTMLAnchorElement {
  const node = document.createElement('a');
  node.setAttribute('href', href);
  node.setAttribute('aria-label', href);
  document.body.appendChild(node);
  return node;
}

let trackerObserve: ReturnType<typeof vi.fn>;
let trackerUnobserve: ReturnType<typeof vi.fn>;
let resizeObserve: ReturnType<typeof vi.fn>;
let resizeUnobserve: ReturnType<typeof vi.fn>;
let attentionUnobserve: ReturnType<typeof vi.fn>;

beforeEach(() => {
  store.clear();
  idRegistry.clear();
  trackerObserve = vi.fn();
  trackerUnobserve = vi.fn();
  resizeObserve = vi.fn();
  resizeUnobserve = vi.fn();
  attentionUnobserve = vi.fn();
  // Both wrapper-lifecycle and limbo's rebindWrapper reach the observers
  // through the pageSession singleton (Tier 3) — install fakes directly.
  pageSession.tracker = { observe: trackerObserve, unobserve: trackerUnobserve } as unknown as IntersectionTracker;
  pageSession.resizeObserver = { observe: resizeObserve, unobserve: resizeUnobserve, disconnect: vi.fn() } as unknown as ResizeObserver;
  pageSession.attentionObserver = { unobserve: attentionUnobserve } as unknown as AttentionObserver;
});

describe('attachWrapper', () => {
  it('adds the wrapper to the store and observes its element', () => {
    const node = el('one');
    const w = new ElementWrapper(node, scanned('one'));

    attachWrapper(w, 'scan');

    expect(store.findWrapperFor(node)).toBe(w);
    expect(trackerObserve).toHaveBeenCalledWith(node);
    expect(resizeObserve).toHaveBeenCalledWith(node);
  });

  it('tags the discovery source and falls back tDomSeen to tAttached without an MO stamp', () => {
    // No markDomSeen ran for this element (jsdom, no MO) — every wrapper
    // must still enter the latency percentiles (round-15 survivorship fix).
    const node = el('stamped');
    const w = new ElementWrapper(node, scanned('stamped'));

    attachWrapper(w, 'band_sweep');

    expect(w.discoverySource).toBe('band_sweep');
    expect(w.domSeenByMo).toBe(false);
    expect(w.tDomSeen).toBe(w.tAttached);
  });

  it('keeps the MO stamp authoritative when one resolves on the ancestor chain', async () => {
    const { markDomSeen } = await import('../observe/dom-seen');
    const parent = document.createElement('div');
    document.body.appendChild(parent);
    markDomSeen(parent); // the added-subtree root the MO reported
    const node = document.createElement('button');
    node.setAttribute('aria-label', 'mo-stamped');
    parent.appendChild(node);
    const w = new ElementWrapper(node, scanned('mo-stamped'));

    attachWrapper(w, 'settle_sweep');

    // A sweep found it, but the MO had sighted its root — tDomSeen keeps the
    // earlier stamp so tAttached - tDomSeen measures the MO path's miss window.
    expect(w.domSeenByMo).toBe(true);
    expect(w.tDomSeen).not.toBeNull();
    expect(w.tDomSeen!).toBeLessThanOrEqual(w.tAttached);
  });

  it('stamps in_viewport_at_attach from the strict-viewport rect (round 21)', () => {
    // jsdom rects are 0×0 at the origin — off-screen by the strict predicate
    // (bottom > 0 fails). An element reporting a real in-viewport rect
    // stamps true; the default stamps false. Discriminates held-ineligible-
    // in-view stragglers from scroll-ahead attaches in the snapshot.
    const offscreen = el('vp-off');
    const wOff = new ElementWrapper(offscreen, scanned('vp-off'));
    attachWrapper(wOff, 'settle_sweep');
    expect(wOff.inViewportAtAttach).toBe(false);

    const onscreen = el('vp-on');
    onscreen.getBoundingClientRect = () =>
      ({ top: 10, left: 10, bottom: 30, right: 50, width: 40, height: 20, x: 10, y: 10, toJSON: () => ({}) }) as DOMRect;
    const wOn = new ElementWrapper(onscreen, scanned('vp-on'));
    attachWrapper(wOn, 'settle_sweep');
    expect(wOn.inViewportAtAttach).toBe(true);
  });
});

describe('detachWrapper', () => {
  it('records shown wrappers in the churn log; never-shown detaches stay out (round 22)', async () => {
    const { churnStats, resetChurnLog } = await import('../debug/churn-log');
    resetChurnLog();

    const shownNode = el('churn-shown');
    const shown = new ElementWrapper(shownNode, scanned('churn-shown'));
    attachWrapper(shown, 'mo');
    shown.tFirstShown = performance.now() - 700; // painted 0.7s ago — a wipe
    shown.scanned.codeword = 'arch';
    detachWrapper(shownNode);

    const neverNode = el('churn-never');
    const never = new ElementWrapper(neverNode, scanned('churn-never'));
    attachWrapper(never, 'mo');
    detachWrapper(neverNode); // tFirstShown null — not perceptual churn

    const s = churnStats(60_000);
    expect(s.detached_shown_total).toBe(1);
    expect(s.wiped_within_2s_total).toBe(1);
    expect(s.recent[0].tag).toBe('button');
    expect(s.recent[0].had_codeword).toBe(true);
    expect(s.recent[0].shown_for_ms).toBeGreaterThanOrEqual(700);
  });

  it('removes the wrapper from the store and unobserves all three observers', () => {
    const node = el('two');
    attachWrapper(new ElementWrapper(node, scanned('two')), 'scan');
    expect(store.findWrapperFor(node)).toBeDefined();

    detachWrapper(node);

    expect(store.findWrapperFor(node)).toBeUndefined();
    expect(trackerUnobserve).toHaveBeenCalledWith(node);
    expect(resizeUnobserve).toHaveBeenCalledWith(node);
    expect(attentionUnobserve).toHaveBeenCalledWith(node);
  });
});

describe('attachDiscovered', () => {
  it('attaches fresh refs and reports the count', () => {
    const a = el('a');
    const b = el('b');

    const added = attachDiscovered([a, b], [scanned('a'), scanned('b')], [], new Map<string, ElementWrapper[]>(), 'mo');

    expect(added).toBe(2);
    expect(store.findWrapperFor(a)).toBeDefined();
    expect(store.findWrapperFor(b)).toBeDefined();
  });

  it('skips refs the store already knows', () => {
    const known = el('known');
    store.addWrapper(new ElementWrapper(known, scanned('known')));
    const fresh = el('fresh');

    const added = attachDiscovered([known, fresh], [scanned('known'), scanned('fresh')], [], new Map<string, ElementWrapper[]>(), 'mo');

    expect(added).toBe(1); // only `fresh` is new
    expect(store.findWrapperFor(fresh)).toBeDefined();
  });
});

describe('attachDiscovered — key-ownership transfer on a same-document re-mount', () => {
  it('a re-mounted same-href node inherits the predecessor wrapper (id + codeword)', () => {
    // Predecessor: a link with a codeword + registry id, the steady state.
    const oldNode = anchorEl('/users');
    attachWrapper(new ElementWrapper(oldNode, scanned('users')), 'scan');
    const w = store.findWrapperFor(oldNode)!;
    w.scanned.codeword = 'harp bat';
    const id = w.scanned.id;
    expect(id).toBeGreaterThan(0);

    // Same-document re-mount: the page replaces the node with a fresh one that
    // has the SAME href (no reload — the store + registry persist). This is the
    // QuickBase-sidebar shape that churned before key-ownership.
    oldNode.remove();
    const newNode = anchorEl('/users');

    const added = attachDiscovered(
      [newNode], [scanned('users')], collectLimboWrappers(), collectStrongKeyIndex(), 'mo',
    );

    expect(added).toBe(0);                          // transferred, not freshly attached
    expect(store.findWrapperFor(newNode)).toBe(w);  // same wrapper, now on the new node
    expect(w.scanned.id).toBe(id);                  // identity preserved
    expect(w.scanned.codeword).toBe('harp bat');    // codeword preserved — the whole point
    expect(store.findWrapperFor(oldNode)).toBeUndefined();
  });

  it('a genuinely new link (no predecessor) attaches fresh', () => {
    const node = anchorEl('/brand-new');
    const added = attachDiscovered(
      [node], [scanned('new')], collectLimboWrappers(), collectStrongKeyIndex(), 'mo',
    );
    expect(added).toBe(1);
  });

  it('transfers from a multi-holder key queue in order (round 34)', () => {
    // Repeated-value column: two live wrappers share the href. The old
    // ambiguous-null forced the replacement to attach fresh (badge flash +
    // letter reshuffle); the queue pops the first predecessor — an
    // action-equivalent transfer (same href, same activation result).
    const wa = new ElementWrapper(anchorEl('/home'), scanned('home-a'));
    attachWrapper(wa, 'scan');
    attachWrapper(new ElementWrapper(anchorEl('/home'), scanned('home-b')), 'scan');
    const newNode = anchorEl('/home');

    const added = attachDiscovered(
      [newNode], [scanned('home-c')], collectLimboWrappers(), collectStrongKeyIndex(), 'mo',
    );

    expect(added).toBe(0); // rode the key queue, no fresh attach
    expect(wa.element).toBe(newNode);
  });
});

import { markSent, hasPendingDeletes } from '../labels/label-sync';

describe('detachWrapper delta-sync ordering', () => {
  it('queues the plugin-side Delete for a sent codeword (regression: release blanks it first)', () => {
    // removeWrapperByElement calls releaseLabel(), which blanks
    // scanned.codeword — reading the codeword after removal always saw ''
    // and never queued the Delete, leaking a stale grammar entry per detach.
    const node = el('detach-delete');
    const s = scanned('detach-delete');
    s.codeword = 'arch bake';
    const w = new ElementWrapper(node, s);
    attachWrapper(w, 'scan');
    markSent('arch bake');

    expect(hasPendingDeletes()).toBe(false);
    detachWrapper(node);
    expect(hasPendingDeletes()).toBe(true);
  });
});

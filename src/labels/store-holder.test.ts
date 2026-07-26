/**
 * StoreHolder: the wrapper store answering the CodewordHolder interface at
 * CLAIM level, with its behaviors as recorded fake delegates.
 *
 * Two halves. The shared conformance suite runs over the adapter with a real
 * ObservableWrapperStore, holding it to the same invariants as every other
 * holder. The adapter-specific half pins what makes THIS holder correct:
 * that every ownership answer reads `w.scanned.codeword` (claim time) and
 * never `store.byCodeword` (paint time) — the leak-sweep regression the
 * design doc corrects, proven here on a claimed-but-never-painted wrapper —
 * plus the delegate seams: which content.ts behavior each hook routes to,
 * that the reveal decision gets the registry's claimed-elsewhere answer, and
 * that dispose latches.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { StoreHolder, StoreHolderDelegates } from './store-holder';
import {
  __resetHolderRegistry, registerHolder, SETTLE_KINDS,
} from './holder-registry';
import {
  describeCodewordHolderConformance, makeSyntheticHolder, HolderHarness,
} from '../testing/holder-conformance';
import { ObservableWrapperStore } from '../core/store';
import { ElementWrapper } from '../scan/element-wrapper';
import type { ScannedElement } from '../types';

// Reference-equality stand-in for Element, as in element-wrapper.test.ts —
// the store's Map only needs identity, and destroy() is a no-op when hint
// is null.
function fakeElement(): Element {
  return { tagName: 'A' } as unknown as Element;
}

function fakeScanned(codeword: string, id: number): ScannedElement {
  return { label: 'click me', id, category: 'button', type: 'button', adapter: null, codeword };
}

let nextId = 1;

/** A wrapper that has CLAIMED a codeword but never painted: label stays null,
 *  exactly the state prepareBadge would later fill in. */
function claimedWrapper(codeword: string): ElementWrapper {
  return new ElementWrapper(fakeElement(), fakeScanned(codeword, nextId++));
}

interface Recorded {
  calls: string[];
  narrows: Array<{ prefix: string; claimedElsewhere: boolean }>;
  activated: ElementWrapper[];
}

function makeDelegates(store: ObservableWrapperStore): { delegates: StoreHolderDelegates; rec: Recorded } {
  const rec: Recorded = { calls: [], narrows: [], activated: [] };
  const delegates: StoreHolderDelegates = {
    narrow: (prefix, claimedElsewhere) => {
      rec.calls.push(`narrow:${prefix}`);
      rec.narrows.push({ prefix, claimedElsewhere });
    },
    activate: (w) => { rec.calls.push('activate'); rec.activated.push(w); },
    republish: () => { rec.calls.push('republish'); },
    onCodewordRejected: (cw) => {
      rec.calls.push(`reject:${cw}`);
      // The real delegate (content's onConfirmRejected) strips the loser back
      // to unhinted; the fake upholds the held()-removal contract.
      const w = store.all.find((lw) => lw.scanned.codeword === cw);
      if (w) { w.scanned.codeword = ''; w.label = null; }
    },
    reposition: () => { rec.calls.push('reposition'); },
    relabel: () => { rec.calls.push('relabel'); },
    reconcile: (settle) => { rec.calls.push(`reconcile:${settle}`); },
    dispose: (reason) => { rec.calls.push(`dispose:${reason}`); },
  };
  return { delegates, rec };
}

function makeHarness(): HolderHarness & { store: ObservableWrapperStore; rec: Recorded } {
  __resetHolderRegistry();
  const store = new ObservableWrapperStore();
  const { delegates, rec } = makeDelegates(store);
  const holder = new StoreHolder(store, delegates);
  registerHolder(holder);
  return {
    holder,
    store,
    rec,
    grant: (cws) => { for (const cw of cws) store.addWrapper(claimedWrapper(cw)); },
  };
}

describeCodewordHolderConformance('StoreHolder (real store, fake delegates)', makeHarness);

describe('StoreHolder answers at CLAIM time, never through paint', () => {
  beforeEach(() => { __resetHolderRegistry(); });

  it('a claimed-but-never-painted wrapper is held, matchable, and resolvable', () => {
    const h = makeHarness();
    const w = claimedWrapper('arch');
    h.store.addWrapper(w);

    // The regression's shape (scan/element-wrapper.test.ts,
    // "claimed-vs-painted"): the claim is real, paint never happened, and the
    // paint-level lookup denies the codeword exists.
    expect(w.label).toBeNull();
    expect(h.store.byCodeword('arch')).toBeUndefined();

    expect([...h.holder.held()]).toContain('arch');
    expect(h.holder.matchesPrefix('arch')).toBe(true);
    expect(h.holder.soleMatch('arch')).toBe('arch');
    expect(h.holder.resolve('arch')).toBe('acted');
    expect(h.rec.activated).toEqual([w]);
  });

  it('a two-word codeword matches by its letter form', () => {
    const h = makeHarness();
    h.store.addWrapper(claimedWrapper('a s'));
    expect([...h.holder.held()]).toEqual(['a s']);
    expect(h.holder.matchesPrefix('a')).toBe(true);
    expect(h.holder.matchesPrefix('as')).toBe(true);
    expect(h.holder.matchesPrefix('s')).toBe(false);
    expect(h.holder.soleMatch('as')).toBe('a s');
    expect(h.holder.resolve('a s')).toBe('acted');
  });

  it('wrappers without a codeword are invisible to every query', () => {
    const h = makeHarness();
    h.store.addWrapper(claimedWrapper(''));     // pool never assigned one
    expect([...h.holder.held()]).toEqual([]);
    expect(h.holder.matchesPrefix('')).toBe(false);
    expect(h.holder.resolve('')).toBe('not_mine');
  });

  it('the empty prefix asks "anything held?", and never has a sole match', () => {
    const h = makeHarness();
    expect(h.holder.matchesPrefix('')).toBe(false);
    h.grant(['ab']);
    expect(h.holder.matchesPrefix('')).toBe(true);
    // A lone hint is NOT completed by a reset — '' means "pair cancelled",
    // not "type the only hint for me".
    expect(h.holder.soleMatch('')).toBe(null);
  });
});

describe('StoreHolder delegate seams', () => {
  beforeEach(() => { __resetHolderRegistry(); });

  it('narrow passes the registry\'s claimed-elsewhere answer for the reveal decision', () => {
    const h = makeHarness();
    h.grant(['ab']);
    // Alone in the registry: nothing else can finish 'a'.
    h.holder.narrow('a');
    expect(h.rec.narrows).toEqual([{ prefix: 'a', claimedElsewhere: false }]);

    // A search-shaped holder that can finish 'a' — now revealing the page's
    // hidden hints for this prefix would be the 2026-07-26 live failure.
    const other = makeSyntheticHolder({ id: 'search', priority: 100, claim: 'additive' });
    other.grant(['ax']);
    registerHolder(other.holder);
    h.holder.narrow('a');
    expect(h.rec.narrows[1]).toEqual({ prefix: 'a', claimedElsewhere: true });

    // A reset is never a reveal question.
    h.holder.narrow('');
    expect(h.rec.narrows[2]).toEqual({ prefix: '', claimedElsewhere: false });
  });

  it('pool, geometry, and lifecycle hooks route to their delegates', () => {
    const h = makeHarness();
    h.grant(['ab']);
    h.holder.republish();
    h.holder.reposition();
    h.holder.relabel();
    for (const kind of SETTLE_KINDS) h.holder.reconcile(kind);
    h.holder.onCodewordRejected('ab');
    expect(h.rec.calls).toEqual([
      'republish', 'reposition', 'relabel',
      ...SETTLE_KINDS.map((k) => `reconcile:${k}`),
      'reject:ab',
    ]);
    expect([...h.holder.held()]).toEqual([]);
  });

  it('dispose latches: one delegate call, then every hook goes quiet', () => {
    const h = makeHarness();
    h.grant(['ab']);
    h.holder.dispose('teardown');
    h.holder.dispose('again');
    expect(h.rec.calls).toEqual(['dispose:teardown']);

    h.holder.republish();
    h.holder.narrow('a');
    h.holder.reposition();
    h.holder.relabel();
    for (const kind of SETTLE_KINDS) h.holder.reconcile(kind);
    h.holder.onCodewordRejected('ab');
    expect(h.rec.calls).toEqual(['dispose:teardown']);

    expect([...h.holder.held()]).toEqual([]);
    expect(h.holder.matchesPrefix('a')).toBe(false);
    expect(h.holder.soleMatch('a')).toBe(null);
    expect(h.holder.resolve('ab')).toBe('not_mine');
  });
});

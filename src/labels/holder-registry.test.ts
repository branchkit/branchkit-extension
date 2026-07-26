/**
 * Holder registry: the ownership rule as a SORT over registered participants.
 *
 * What's pinned is what the v1 routing seam (activate/codeword-routing.ts)
 * pinned with mocked modules, restated over synthetic REGISTRATIONS: which
 * holder gets a codeword first, what exclusivity swallows, what additive
 * claims fall through to, and that every fan-out reaches every holder. The
 * participants are synthetic holders driven through the real registry —
 * not vi.mock (design doc, "Synthetic participants instead of vi.mock").
 *
 * The tail of the file is the registration meta-test: every participant the
 * Wave-2 factories register runs the shared conformance suite
 * (src/testing/holder-conformance.ts), and any registered id without a
 * participant entry fails. That is the enforcement half of "a fourth holder
 * cannot skip the suite by not writing a test file".
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  __resetHolderRegistry, registerHolder, unregisterHolder, holdersByPriority,
  resolveCodeword, anyHolderMatchesPrefix, narrowByPrefix, soleHolderMatch,
  republishAll, rejectAll, reconcileAll, heldAnywhere, allHeld,
  prefixClaimedByOther, SETTLE_KINDS,
} from './holder-registry';
import {
  describeCodewordHolderConformance, makeSyntheticHolder,
  HolderFactory, HolderHarness, SyntheticHolder,
} from '../testing/holder-conformance';
import { StoreHolder } from './store-holder';
import { ObservableWrapperStore } from '../core/store';
import { ElementWrapper } from '../scan/element-wrapper';
import type { ScannedElement } from '../types';

// --- The three-holder synthetic registry ----------------------------------
// The shape the design doc names: an exclusive pick above an additive search
// above the ambient store. Priorities are deliberately spread so the sort,
// not registration order, is visibly the contract.

let pick: SyntheticHolder;
let search: SyntheticHolder;
let ambient: SyntheticHolder;

function registerAllThree(): void {
  registerHolder(pick.holder);
  registerHolder(search.holder);
  registerHolder(ambient.holder);
}

beforeEach(() => {
  __resetHolderRegistry();
  pick = makeSyntheticHolder({ id: 'pick', priority: 200, claim: 'exclusive' });
  search = makeSyntheticHolder({ id: 'search', priority: 100, claim: 'additive' });
  ambient = makeSyntheticHolder({ id: 'ambient', priority: 0, claim: 'additive' });
});

describe('registration and ordering', () => {
  it('holdersByPriority sorts by priority regardless of registration order', () => {
    registerHolder(ambient.holder);
    registerHolder(pick.holder);
    registerHolder(search.holder);
    expect(holdersByPriority().map((h) => h.id)).toEqual(['pick', 'search', 'ambient']);
  });

  it('equal priorities keep registration order', () => {
    const a = makeSyntheticHolder({ id: 'tie_a', priority: 100, claim: 'additive' });
    const b = makeSyntheticHolder({ id: 'tie_b', priority: 100, claim: 'additive' });
    registerHolder(b.holder);
    registerHolder(a.holder);
    expect(holdersByPriority().map((h) => h.id)).toEqual(['tie_b', 'tie_a']);
  });

  it('register returns a working unregister; double unregister is safe', () => {
    const un = registerHolder(search.holder);
    expect(holdersByPriority()).toContain(search.holder);
    un();
    expect(holdersByPriority()).not.toContain(search.holder);
    un();
    unregisterHolder(search.holder);
    expect(holdersByPriority()).toHaveLength(0);
  });

  it('__resetHolderRegistry empties the registry', () => {
    registerAllThree();
    __resetHolderRegistry();
    expect(holdersByPriority()).toHaveLength(0);
  });
});

describe('resolveCodeword (the priority loop)', () => {
  it('the highest-priority holder that owns the codeword acts', () => {
    registerAllThree();
    pick.grant(['ab']);
    expect(resolveCodeword('ab')).toEqual({ kind: 'acted', holder: 'pick' });
  });

  it('a live exclusive holder swallows a codeword an additive one holds', () => {
    registerAllThree();
    search.grant(['cd']);
    expect(resolveCodeword('cd')).toEqual({ kind: 'swallowed', holder: 'pick' });
    expect(search.log).not.toContain('acted:cd');
    expect(ambient.log).not.toContain('acted:cd');
  });

  it('additive holders fall through in priority order', () => {
    registerHolder(search.holder);
    registerHolder(ambient.holder);
    search.grant(['cd']);
    ambient.grant(['ef']);
    expect(resolveCodeword('cd')).toEqual({ kind: 'acted', holder: 'search' });
    expect(resolveCodeword('ef')).toEqual({ kind: 'acted', holder: 'ambient' });
  });

  it('an off-screen refusal names the refusing holder and stops the loop', () => {
    registerHolder(search.holder);
    registerHolder(ambient.holder);
    search.grant(['cd']);
    search.markOffScreen('cd');
    ambient.grant(['cd']);           // would act, must never be reached
    expect(resolveCodeword('cd')).toEqual({ kind: 'off_screen', holder: 'search' });
    expect(ambient.log).not.toContain('acted:cd');
  });

  it('answers none when nobody owns the codeword and nothing is exclusive', () => {
    registerHolder(search.holder);
    registerHolder(ambient.holder);
    expect(resolveCodeword('zz')).toEqual({ kind: 'none' });
  });
});

describe('anyHolderMatchesPrefix (the keyboard accept gate)', () => {
  it('a live exclusive holder answers alone — a letter no chip can finish is refused', () => {
    registerAllThree();
    search.grant(['ab']);
    ambient.grant(['ad']);
    expect(anyHolderMatchesPrefix('a')).toBe(false);
    pick.grant(['ax']);
    expect(anyHolderMatchesPrefix('a')).toBe(true);
  });

  it('with no exclusive holder, any additive match is enough', () => {
    registerHolder(search.holder);
    registerHolder(ambient.holder);
    ambient.grant(['zx']);
    expect(anyHolderMatchesPrefix('z')).toBe(true);
    expect(anyHolderMatchesPrefix('q')).toBe(false);
  });
});

describe('narrowByPrefix (mid-codeword progress)', () => {
  it('a live exclusive holder takes progress and nothing else hears it', () => {
    registerAllThree();
    narrowByPrefix('a');
    expect(pick.log).toContain('narrow:a');
    expect(search.log).not.toContain('narrow:a');
    expect(ambient.log).not.toContain('narrow:a');
  });

  it('additive holders all narrow in the same breath', () => {
    registerHolder(search.holder);
    registerHolder(ambient.holder);
    narrowByPrefix('a');
    narrowByPrefix('');
    expect(search.log).toEqual(['narrow:a', 'narrow:']);
    expect(ambient.log).toEqual(['narrow:a', 'narrow:']);
  });
});

describe('soleHolderMatch', () => {
  it('answers null for the empty prefix', () => {
    registerAllThree();
    pick.grant(['ab']);
    expect(soleHolderMatch('')).toBe(null);
  });

  it('the highest-priority sole match wins', () => {
    registerHolder(search.holder);
    registerHolder(ambient.holder);
    search.grant(['ab']);
    ambient.grant(['ax']);
    expect(soleHolderMatch('ab')).toBe('ab');
    expect(soleHolderMatch('ax')).toBe('ax');
  });

  it('a live exclusive holder swallows a sole match below it', () => {
    registerAllThree();
    search.grant(['cd']);
    expect(soleHolderMatch('c')).toBe(null);
    pick.grant(['cx']);
    expect(soleHolderMatch('c')).toBe('cx');
  });
});

describe('pool queries and fan-outs', () => {
  it('heldAnywhere and allHeld aggregate over every holder', () => {
    registerAllThree();
    pick.grant(['ab']);
    search.grant(['cd']);
    ambient.grant(['ef']);
    expect(heldAnywhere('cd')).toBe(true);
    expect(heldAnywhere('zz')).toBe(false);
    expect(allHeld().sort()).toEqual(['ab', 'cd', 'ef']);
  });

  it('republishAll and rejectAll reach every holder, exclusivity notwithstanding', () => {
    registerAllThree();
    pick.grant(['ab']);
    search.grant(['ab']);   // pool refusals fan out — losing is per-holder
    republishAll();
    rejectAll('ab');
    for (const s of [pick, search, ambient]) {
      expect(s.log).toContain('republish');
      expect(s.log).toContain('reject:ab');
    }
    expect(heldAnywhere('ab')).toBe(false);
  });

  it('reconcileAll delivers every settle kind to every holder', () => {
    registerAllThree();
    for (const kind of SETTLE_KINDS) reconcileAll(kind);
    for (const s of [pick, search, ambient]) {
      for (const kind of SETTLE_KINDS) expect(s.log).toContain(`reconcile:${kind}`);
    }
  });

  it('prefixClaimedByOther excludes the asking holder', () => {
    registerHolder(search.holder);
    registerHolder(ambient.holder);
    ambient.grant(['ab']);
    expect(prefixClaimedByOther(ambient.holder, 'a')).toBe(false);
    expect(prefixClaimedByOther(search.holder, 'a')).toBe(true);
  });
});

// --- Registration meta-test + conformance over every participant ----------
//
// Every factory resets the registry, constructs a fresh holder, and registers
// it (the contract in holder-conformance.ts). The meta-test walks the
// participants, observes what each leaves registered, and fails on any
// registered id the list does not cover — so when Wave 3's wiring starts
// registering real holders, adding one HERE (which runs the suite over it)
// is the only way to keep this green. At Wave 2 the participants are the
// synthetics above plus a StoreHolder over a real ObservableWrapperStore
// with fake delegates; store-holder.test.ts exercises the adapter's own
// delegate seams beyond the shared invariants.

function fakeElement(): Element {
  return { tagName: 'BUTTON' } as unknown as Element;
}

function fakeScanned(codeword: string, id: number): ScannedElement {
  return { label: 'click me', id, category: 'button', type: 'button', adapter: null, codeword };
}

function makeStoreHarness(): HolderHarness {
  __resetHolderRegistry();
  const store = new ObservableWrapperStore();
  const holder = new StoreHolder(store, {
    narrow: () => {},
    activate: () => {},
    republish: () => {},
    // The real delegate strips the losing wrapper back to unhinted; the fake
    // upholds the same contract the conformance suite checks.
    onCodewordRejected: (cw) => {
      const w = store.all.find((lw) => lw.scanned.codeword === cw);
      if (w) { w.scanned.codeword = ''; w.label = null; }
    },
    reposition: () => {},
    relabel: () => {},
    reconcile: () => {},
    dispose: () => {},
  });
  registerHolder(holder);
  let nextId = 1;
  return {
    holder,
    grant: (cws) => {
      for (const cw of cws) {
        store.addWrapper(new ElementWrapper(fakeElement(), fakeScanned(cw, nextId++)));
      }
    },
  };
}

const participants: Array<{ name: string; make: HolderFactory }> = [
  {
    name: 'synthetic exclusive (pick-shaped)',
    make: () => {
      __resetHolderRegistry();
      const s = makeSyntheticHolder({ id: 'pick', priority: 200, claim: 'exclusive' });
      registerHolder(s.holder);
      return s;
    },
  },
  {
    name: 'synthetic additive (search-shaped)',
    make: () => {
      __resetHolderRegistry();
      const s = makeSyntheticHolder({ id: 'search', priority: 100, claim: 'additive' });
      registerHolder(s.holder);
      return s;
    },
  },
  { name: 'StoreHolder over ObservableWrapperStore (fake delegates)', make: makeStoreHarness },
];

for (const p of participants) describeCodewordHolderConformance(p.name, p.make);

describe('registration meta-test', () => {
  it('every id the factories register is covered by a conformance participant', () => {
    const covered = new Set<string>();
    const registered = new Set<string>();
    for (const p of participants) {
      const h = p.make();
      covered.add(h.holder.id);
      for (const r of holdersByPriority()) registered.add(r.id);
    }
    for (const id of registered) {
      expect(covered, `registered holder '${id}' has no conformance participant`).toContain(id);
    }
  });
});

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

import { describe, it, expect, beforeEach, vi } from 'vitest';

// The armed participants below construct real RangeBadgeSets, whose transport
// and paint collaborators are faked the same way render/range-badge-set.test.ts
// fakes them — the REGISTRY and the sets' holder mechanism stay real.
const pool: string[] = [];
vi.mock('./label-reservoir', () => ({
  labelReservoir: {
    claim: (n: number) => {
      const grant = pool.splice(0, n);
      while (grant.length < n) grant.push('');
      return grant;
    },
    release: () => {},
  },
}));
vi.mock('./label-sync', () => ({
  publishRecords: async (r: Array<{ codeword: string }>) => new Set(r.map((x) => x.codeword)),
  retireRecords: () => {},
  cancelPendingDelete: () => {},
}));
vi.mock('../render/hints', () => ({
  HintBadge: class {
    badgeSize = { w: 20, h: 14 };
    show(): void {}
    remove(): void {}
    setFiltered(): void {}
    setMatchedChars(): void {}
    updatePosition(): void {}
    updateLabel(): void {}
  },
}));
vi.mock('../config', () => ({ getDisplayMode: () => 'letter' }));
vi.mock('../debug/bk-log', () => ({ bkLog: () => {} }));

import {
  __resetHolderRegistry, registerHolder, unregisterHolder, holdersByPriority,
  resolveCodeword, resolveCodewordAboveAmbient, anyHolderMatchesPrefix,
  narrowByPrefix, soleHolderMatch,
  republishAll, rejectAll, reconcileAll, heldAnywhere, allHeld, overlayCodewordsLive,
  disposeAllHolders, prefixClaimedByOther, SETTLE_KINDS,
  EXCLUSIVE_OVERLAY_PRIORITY, ADDITIVE_OVERLAY_PRIORITY,
} from './holder-registry';
import {
  describeCodewordHolderConformance, makeSyntheticHolder,
  HolderFactory, HolderHarness, SyntheticHolder,
} from '../testing/holder-conformance';
import { StoreHolder } from './store-holder';
import { RangeBadgeSet } from '../render/range-badge-set';
import { RANGE_PICK_VARIANT, SEARCH_VARIANT } from '../render/badge-variant';
import type { BadgeVariant } from '../render/badge-variant';
import { ObservableWrapperStore } from '../core/store';
import { ElementWrapper } from '../scan/element-wrapper';
import type { ScannedElement } from '../types';

// happy-dom reports all-zero rects, which the band planner reads as
// "collapsed" — give every Range a real on-screen box so armed sets can claim.
beforeEach(() => {
  const original = Range.prototype.getBoundingClientRect;
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 10, bottom: 30, left: 10, right: 60, width: 50, height: 20 }) as DOMRect;
  return () => { Range.prototype.getBoundingClientRect = original; };
});

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

  // The gate on `f`'s ambient sweep: an overlay that is UP owns the screen, so
  // hint mode must not repaint the page's link hints over it (field 2026-07-26,
  // `/ query Enter f` buried the search badges). Registered-but-empty is not
  // "up" — a set that has released its codewords holds nothing to protect.
  it('overlayCodewordsLive sees any non-empty holder above the ambient rank', () => {
    registerAllThree();
    expect(overlayCodewordsLive()).toBe(false);

    ambient.grant(['ef']);
    expect(overlayCodewordsLive()).toBe(false);   // the store alone is not an overlay

    search.grant(['cd']);
    expect(overlayCodewordsLive()).toBe(true);

    pick.grant(['ab']);
    search.holder.dispose('find_deactivated');
    expect(overlayCodewordsLive()).toBe(true);    // exclusive counts too

    pick.holder.dispose('picked');
    expect(overlayCodewordsLive()).toBe(false);   // ambient's 'ef' still does not count
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

  it('disposeAllHolders reaches every holder, surviving mid-sweep unregistration', () => {
    registerAllThree();
    pick.grant(['ab']);
    search.grant(['cd']);
    // An armed holder unregisters inside its own dispose (the RangeBadgeSet
    // shape); the sweep must still reach everyone after it.
    const origDispose = pick.holder.dispose;
    (pick.holder as { dispose(reason: string): void }).dispose = (reason) => {
      origDispose(reason);
      unregisterHolder(pick.holder);
    };
    disposeAllHolders('teardown_orphan');
    for (const s of [pick, search, ambient]) {
      expect(s.log).toContain('dispose:teardown_orphan');
    }
    expect(allHeld()).toEqual([]);
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
    reveal: () => {},
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

/**
 * An ARMED participant: a real RangeBadgeSet registered under the production
 * id/priority/claim, with the owner's resolve policy in its real shape
 * (membership then on-screen gate then act). Registration is liveness — the
 * set registers when grant() arms it and unregisters on dispose — which is
 * the model the conformance suite's 'armed' branch checks.
 */
function makeRangeSetHarness(spec: {
  id: string; priority: number; claim: 'exclusive' | 'additive'; variant: BadgeVariant;
}): HolderHarness {
  __resetHolderRegistry();
  let set: RangeBadgeSet | null = null;
  return {
    get holder() { return set!.holder; },
    grant: (cws) => {
      pool.length = 0;
      pool.push(...cws);
      set = RangeBadgeSet.create({
        ranges: cws.map((cw) => {
          const p = document.createElement('p');
          p.textContent = cw;
          document.body.appendChild(p);
          const r = document.createRange();
          r.selectNodeContents(p.firstChild!);
          return r;
        }),
        variant: spec.variant,
        budget: cws.length,
        holder: {
          id: spec.id,
          priority: spec.priority,
          claim: spec.claim,
          resolve: (cw) => {
            if (!set || !set.has(cw)) return 'not_mine';
            if (!set.isOnScreen(cw)) return 'off_screen';
            return 'acted';
          },
        },
      });
    },
  };
}

const participants: Array<{ name: string; make: HolderFactory; liveness?: 'armed' }> = [
  {
    name: 'synthetic exclusive (pick-shaped)',
    make: () => {
      __resetHolderRegistry();
      const s = makeSyntheticHolder({
        id: 'pick', priority: EXCLUSIVE_OVERLAY_PRIORITY, claim: 'exclusive',
      });
      registerHolder(s.holder);
      return s;
    },
  },
  {
    name: 'synthetic additive (search-shaped)',
    make: () => {
      __resetHolderRegistry();
      const s = makeSyntheticHolder({
        id: 'search', priority: ADDITIVE_OVERLAY_PRIORITY, claim: 'additive',
      });
      registerHolder(s.holder);
      return s;
    },
  },
  { name: 'StoreHolder over ObservableWrapperStore (fake delegates)', make: makeStoreHarness },
  // The real registrations (Wave 3 C1): the pick's exclusive RangeBadgeSet
  // and search's additive one, as their owners construct them.
  {
    name: 'range pick chips (RangeBadgeSet, exclusive)',
    liveness: 'armed',
    make: () => makeRangeSetHarness({
      id: 'pick', priority: EXCLUSIVE_OVERLAY_PRIORITY, claim: 'exclusive',
      variant: RANGE_PICK_VARIANT,
    }),
  },
  {
    name: 'search badges (RangeBadgeSet, additive)',
    liveness: 'armed',
    make: () => makeRangeSetHarness({
      id: 'search', priority: ADDITIVE_OVERLAY_PRIORITY, claim: 'additive',
      variant: SEARCH_VARIANT,
    }),
  },
];

for (const p of participants) {
  describeCodewordHolderConformance(p.name, p.make, { liveness: p.liveness });
}

describe('registration meta-test', () => {
  it('every id the factories register is covered by a conformance participant', () => {
    const covered = new Set<string>();
    const registered = new Set<string>();
    for (const p of participants) {
      const h = p.make();
      h.grant(['zq']); // arms the liveness-registered participants
      covered.add(h.holder.id);
      for (const r of holdersByPriority()) registered.add(r.id);
    }
    for (const id of registered) {
      expect(covered, `registered holder '${id}' has no conformance participant`).toContain(id);
    }
  });
});

describe('the spoken path\'s above-ambient consult', () => {
  it('overlays act, exclusivity swallows, and the ambient tier is never consulted', () => {
    __resetHolderRegistry();
    const search = makeSyntheticHolder({
      id: 'search', priority: ADDITIVE_OVERLAY_PRIORITY, claim: 'additive',
    });
    const ambient = makeSyntheticHolder({ id: 'store', priority: 0, claim: 'additive' });
    registerHolder(search.holder);
    registerHolder(ambient.holder);
    search.grant(['ab']);
    ambient.grant(['cd']);

    expect(resolveCodewordAboveAmbient('ab')).toEqual({ kind: 'acted', holder: 'search' });
    // The ambient holder OWNS 'cd', but this consult must not act on it — the
    // spoken path's element leg (snapshot-first, sealed gate, dispatch
    // reporting) is the ambient answer for that input.
    expect(resolveCodewordAboveAmbient('cd')).toEqual({ kind: 'none' });
    expect(ambient.log).not.toContain('acted:cd');

    const pick = makeSyntheticHolder({
      id: 'pick', priority: EXCLUSIVE_OVERLAY_PRIORITY, claim: 'exclusive',
    });
    registerHolder(pick.holder);
    expect(resolveCodewordAboveAmbient('cd')).toEqual({ kind: 'swallowed', holder: 'pick' });
  });
});

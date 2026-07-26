import { describe, it, expect, afterEach } from 'vitest';
import {
  registerCodewordHolder,
  heldOutsideStore,
  allHeldOutsideStore,
  republishHeldOutsideStore,
  rejectHeldOutsideStore,
  __resetCodewordHolders,
} from './codeword-holders';

afterEach(() => __resetCodewordHolders());

describe('codeword holders outside the store', () => {
  it('answers heldOutsideStore for a live holder', () => {
    registerCodewordHolder({ held: () => ['wave is', 'king is'], republish: () => {}, onCodewordRejected: () => {} });
    expect(heldOutsideStore('wave is')).toBe(true);
    expect(heldOutsideStore('king is')).toBe(true);
    expect(heldOutsideStore('gap is')).toBe(false);
  });

  it('reads the holder LIVE, so a torn-down holder stops claiming its codewords', () => {
    // The reservoir sweep must reclaim a codeword the moment the pick ends —
    // holding a snapshot here would turn the leak-sweep fix into a leak.
    let live: string[] = ['wave is'];
    registerCodewordHolder({ held: () => live, republish: () => {}, onCodewordRejected: () => {} });
    expect(heldOutsideStore('wave is')).toBe(true);
    live = [];
    expect(heldOutsideStore('wave is')).toBe(false);
  });

  it('unions every holder — search badges will be the second', () => {
    registerCodewordHolder({ held: () => ['chip one'], republish: () => {}, onCodewordRejected: () => {} });
    registerCodewordHolder({ held: () => ['search one'], republish: () => {}, onCodewordRejected: () => {} });
    expect(allHeldOutsideStore().sort()).toEqual(['chip one', 'search one']);
    expect(heldOutsideStore('search one')).toBe(true);
  });

  it('unregister removes the holder', () => {
    const off = registerCodewordHolder({ held: () => ['wave is'], republish: () => {}, onCodewordRejected: () => {} });
    off();
    expect(heldOutsideStore('wave is')).toBe(false);
    expect(allHeldOutsideStore()).toEqual([]);
  });

  it('republish fans out to every holder', () => {
    const calls: string[] = [];
    registerCodewordHolder({
      held: () => [], republish: () => { calls.push('a'); }, onCodewordRejected: () => {},
    });
    registerCodewordHolder({
      held: () => [], republish: () => { calls.push('b'); }, onCodewordRejected: () => {},
    });
    republishHeldOutsideStore();
    expect(calls.sort()).toEqual(['a', 'b']);
  });

  it('fans a pool rejection out to every holder', () => {
    const seen: string[] = [];
    registerCodewordHolder({
      held: () => [], republish: () => {}, onCodewordRejected: (cw) => { seen.push(`a:${cw}`); },
    });
    registerCodewordHolder({
      held: () => [], republish: () => {}, onCodewordRejected: (cw) => { seen.push(`b:${cw}`); },
    });
    rejectHeldOutsideStore('wave is');
    expect(seen.sort()).toEqual(['a:wave is', 'b:wave is']);
  });

  it('is empty by default, so the sweeps behave exactly as before', () => {
    expect(allHeldOutsideStore()).toEqual([]);
    expect(heldOutsideStore('anything')).toBe(false);
  });
});

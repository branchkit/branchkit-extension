/**
 * BranchKit Browser — Activate-resolution tier tests.
 *
 * Pins the three-tier algorithm and its side effects: invalidate-on-
 * unknown-id (the "stale_grammar" protocol), lazy-delete on dead WeakRef
 * with no fingerprint match, registry rebind on successful fingerprint
 * fallback, frame-mismatch skip, and the tier-3 snapshot/live-store
 * fallthrough.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { resolveTarget, type ResolutionDeps } from './activate-resolution';
import type { ElementWrapper } from './element-wrapper';
import type { Fingerprint, RegistryEntry } from './registry';

function fp(overrides: Partial<Fingerprint> = {}): Fingerprint {
  return { role: 'button', name: 'Save', tag: 'button', text: '', ...overrides };
}

function entry(el: Element, fingerprint = fp()): RegistryEntry {
  return {
    ref: new WeakRef(el),
    fingerprint,
    createdAt: 0,
    category: 'button',
  };
}

function fakeElement(connected = true): HTMLElement {
  const e = document.createElement('button');
  if (connected) document.body.appendChild(e);
  return e;
}

function fakeWrapper(el: Element): ElementWrapper {
  return { element: el } as unknown as ElementWrapper;
}

interface MockState {
  registryEntries: Map<number, RegistryEntry>;
  rebindCalls: Array<[number, Element]>;
  unregisterCalls: number[];
  staleIdCalls: string[];
}

function makeDeps(overrides: Partial<ResolutionDeps> & { state?: MockState } = {}): {
  deps: ResolutionDeps;
  state: MockState;
} {
  const state: MockState = overrides.state ?? {
    registryEntries: new Map(),
    rebindCalls: [],
    unregisterCalls: [],
    staleIdCalls: [],
  };
  const deps: ResolutionDeps = {
    myFrameId: null,
    registry: {
      get: (id) => state.registryEntries.get(id),
      rebindRef: (id, el) => { state.rebindCalls.push([id, el]); },
      unregister: (id) => { state.unregisterCalls.push(id); state.registryEntries.delete(id); },
      fingerprintFallback: () => null,
      fingerprintToString: (f) => `role=${f.role} name=${f.name} tag=${f.tag}`,
    },
    candidates: () => [],
    resolveFromSnapshot: () => undefined,
    resolveFromStore: () => undefined,
    onStaleId: (reason) => { state.staleIdCalls.push(reason); },
    ...overrides,
  };
  return { deps, state };
}

beforeEach(() => {
  document.body.innerHTML = '';
});

describe('resolveTarget — tier 1 (registry hit)', () => {
  it('returns the live element when WeakRef is alive and connected', () => {
    const el = fakeElement();
    const { deps, state } = makeDeps();
    state.registryEntries.set(42, entry(el));

    const r = resolveTarget(42, 0, 'arch', deps);

    expect(r.target).toBe(el);
    expect(r.resolution).toBe('registry');
    expect(r.detail).toBe('');
    expect(r.fp).toMatch(/role=button/);
    expect(state.rebindCalls).toEqual([]);
    expect(state.unregisterCalls).toEqual([]);
    expect(state.staleIdCalls).toEqual([]);
  });
});

describe('resolveTarget — tier 2 (fingerprint fallback)', () => {
  it('rebinds and resolves via fingerprint when WeakRef is dead', () => {
    const dead = fakeElement(false);  // not in DOM → not connected
    const replacement = fakeElement();
    const { deps, state } = makeDeps({
      registry: {
        get: (id) => state.registryEntries.get(id),
        rebindRef: (id, el) => { state.rebindCalls.push([id, el]); },
        unregister: (id) => { state.unregisterCalls.push(id); },
        fingerprintFallback: () => replacement,
        fingerprintToString: (f) => `role=${f.role}`,
      },
    });
    state.registryEntries.set(42, entry(dead));

    const r = resolveTarget(42, 0, 'arch', deps);

    expect(r.target).toBe(replacement);
    expect(r.resolution).toBe('fingerprint');
    expect(state.rebindCalls).toEqual([[42, replacement]]);
    expect(state.unregisterCalls).toEqual([]);
  });

  it('lazy-deletes the entry when both tier 1 (dead ref) and tier 2 (no match) fail', () => {
    const dead = fakeElement(false);
    const { deps, state } = makeDeps();
    state.registryEntries.set(42, entry(dead));

    const r = resolveTarget(42, 0, '', deps);

    expect(r.target).toBeNull();
    expect(r.resolution).toBe('none');
    expect(r.detail).toContain('id=42 dead, fingerprint not found');
    expect(state.unregisterCalls).toEqual([42]);
  });
});

describe('resolveTarget — stale id (Q2 protocol)', () => {
  it('fires onStaleId when the registry has no entry for a non-zero id', () => {
    const { deps, state } = makeDeps();
    // No entry for id=99.

    const r = resolveTarget(99, 0, '', deps);

    expect(r.target).toBeNull();
    expect(r.resolution).toBe('none');
    expect(r.detail).toContain('id=99 not in registry');
    expect(state.staleIdCalls).toEqual(['stale_id']);
  });

  it('does not fire onStaleId when id is 0 (codeword-only dispatch)', () => {
    const { deps, state } = makeDeps();
    const r = resolveTarget(0, 0, '', deps);
    expect(r.target).toBeNull();
    expect(state.staleIdCalls).toEqual([]);
  });
});

describe('resolveTarget — frame mismatch', () => {
  it('skips tier 1 when params.frame_id disagrees with own frameId', () => {
    const el = fakeElement();
    const { deps, state } = makeDeps({ myFrameId: 0 });
    state.registryEntries.set(42, entry(el));

    const r = resolveTarget(42, 7, '', deps);

    expect(r.target).toBeNull();
    expect(r.resolution).toBe('none');
    expect(r.detail).toContain('frame 7');
    expect(r.detail).toContain('this is frame 0');
    // Did NOT touch registry side effects.
    expect(state.rebindCalls).toEqual([]);
    expect(state.unregisterCalls).toEqual([]);
    expect(state.staleIdCalls).toEqual([]);
  });

  it('honors tier 1 when myFrameId is unknown (pre-handshake)', () => {
    const el = fakeElement();
    const { deps, state } = makeDeps({ myFrameId: null });
    state.registryEntries.set(42, entry(el));

    const r = resolveTarget(42, 7, '', deps);

    expect(r.target).toBe(el);
    expect(r.resolution).toBe('registry');
  });

  it('honors tier 1 when params.frame_id is 0 (default / unspecified)', () => {
    const el = fakeElement();
    const { deps, state } = makeDeps({ myFrameId: 3 });
    state.registryEntries.set(42, entry(el));

    const r = resolveTarget(42, 0, '', deps);

    expect(r.target).toBe(el);
    expect(r.resolution).toBe('registry');
  });
});

describe('resolveTarget — tier 3 (codeword fallthrough)', () => {
  it('resolves via snapshot when id is missing', () => {
    const el = fakeElement();
    const { deps } = makeDeps({
      resolveFromSnapshot: (cw) => cw === 'arch' ? fakeWrapper(el) : undefined,
    });

    const r = resolveTarget(0, 0, 'arch', deps);

    expect(r.target).toBe(el);
    expect(r.resolution).toBe('snapshot');
  });

  it('falls through to live store when snapshot misses', () => {
    const el = fakeElement();
    const { deps } = makeDeps({
      resolveFromSnapshot: () => undefined,
      resolveFromStore: (cw) => cw === 'arch' ? fakeWrapper(el) : undefined,
    });

    const r = resolveTarget(0, 0, 'arch', deps);

    expect(r.target).toBe(el);
    expect(r.resolution).toBe('live_store');
  });

  it('still hits tier 3 when tier 1 missed AND a codeword is present', () => {
    const el = fakeElement();
    const { deps, state } = makeDeps({
      resolveFromStore: () => fakeWrapper(el),
    });
    // id=99 not in registry → onStaleId fires AND tier 3 catches it.
    const r = resolveTarget(99, 0, 'arch', deps);

    expect(r.target).toBe(el);
    expect(r.resolution).toBe('live_store');
    expect(state.staleIdCalls).toEqual(['stale_id']);
  });
});

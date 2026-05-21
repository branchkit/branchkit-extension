/**
 * BranchKit Browser — Stable-id registry unit tests.
 *
 * Pins the contract that voice activation depends on: monotonic ids,
 * idempotent re-registration, WeakRef-dead fingerprint fallback, and
 * the clear-on-bfcache reset.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementWrapper } from './element-wrapper';
import { ScannedElement } from './types';
import * as registry from './registry';

function scanned(overrides: Partial<ScannedElement> = {}): ScannedElement {
  return {
    label: '',
    id: 0,
    category: 'button',
    type: 'button',
    adapter: null,
    codeword: '',
    ...overrides,
  };
}

function makeButton(label: string, parent: Element = document.body): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  parent.appendChild(b);
  return b;
}

function wrapper(el: Element): ElementWrapper {
  return new ElementWrapper(el, scanned());
}

beforeEach(() => {
  document.body.innerHTML = '';
  registry.clear();
  // chrome.runtime.sendMessage isn't called in any of these paths but
  // ElementWrapper's releaseLabel guard reads it.
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn().mockResolvedValue(undefined) },
  };
});

describe('registry.register', () => {
  it('mints monotonic ids starting at 1', () => {
    const a = registry.register(wrapper(makeButton('A')));
    const b = registry.register(wrapper(makeButton('B')));
    const c = registry.register(wrapper(makeButton('C')));
    expect(a).toBe(1);
    expect(b).toBe(2);
    expect(c).toBe(3);
  });

  it('stamps the minted id onto wrapper.scanned.id', () => {
    const w = wrapper(makeButton('A'));
    const id = registry.register(w);
    expect(w.scanned.id).toBe(id);
    expect(id).toBeGreaterThan(0);
  });

  it('is idempotent: re-registering the same element returns the existing id', () => {
    const el = makeButton('A');
    const id1 = registry.register(wrapper(el));
    const id2 = registry.register(wrapper(el));
    expect(id2).toBe(id1);
  });

  it('registers elements with identical fingerprints (each gets its own id)', () => {
    const wrap1 = document.createElement('div');
    const wrap2 = document.createElement('div');
    document.body.appendChild(wrap1);
    document.body.appendChild(wrap2);
    const a = makeButton('Save', wrap1);
    const b = makeButton('Save', wrap2);
    const id1 = registry.register(wrapper(a));
    const id2 = registry.register(wrapper(b));
    expect(id1).toBeGreaterThan(0);
    expect(id2).toBeGreaterThan(0);
    expect(id1).not.toBe(id2);
  });
});

describe('registry.unregister', () => {
  it('removes the entry; get returns undefined afterwards', () => {
    const w = wrapper(makeButton('A'));
    const id = registry.register(w);
    expect(registry.get(id)).toBeTruthy();
    registry.unregister(id);
    expect(registry.get(id)).toBeUndefined();
  });

  it('is a no-op for unknown ids', () => {
    expect(() => registry.unregister(9999)).not.toThrow();
  });
});

describe('registry.clear', () => {
  it('drops all entries and resets the id counter to 1', () => {
    registry.register(wrapper(makeButton('A')));
    registry.register(wrapper(makeButton('B')));
    registry.clear();
    expect(registry._size()).toBe(0);

    const id = registry.register(wrapper(makeButton('C')));
    expect(id).toBe(1);
  });
});

describe('registry.fingerprintFallback', () => {
  it('finds an element matching a registered fingerprint among candidates', () => {
    const el = makeButton('Save');
    const id = registry.register(wrapper(el));
    const entry = registry.get(id)!;

    const candidates = Array.from(document.querySelectorAll('*'));
    const found = registry.fingerprintFallback(entry.fingerprint, candidates);
    expect(found).toBe(el);
  });

  it('returns null when no candidate matches', () => {
    const original = makeButton('Save');
    const id = registry.register(wrapper(original));
    const entry = registry.get(id)!;

    original.remove();
    const candidates = Array.from(document.querySelectorAll('*'));
    const found = registry.fingerprintFallback(entry.fingerprint, candidates);
    expect(found).toBeNull();
  });

  it('finds the replacement element after a React-style swap', () => {
    // Mount A, register, unmount A, mount B with identical name+role.
    const a = makeButton('Save');
    const id = registry.register(wrapper(a));
    const entry = registry.get(id)!;
    a.remove();

    const b = makeButton('Save');
    const found = registry.fingerprintFallback(entry.fingerprint, Array.from(document.querySelectorAll('*')));
    expect(found).toBe(b);
  });
});

describe('registry.refreshFingerprint', () => {
  it('updates the fingerprint when aria-label mutates', () => {
    const el = document.createElement('button');
    el.setAttribute('aria-label', 'Save');
    document.body.appendChild(el);

    const id = registry.register(wrapper(el));
    const before = registry.get(id)!.fingerprint;
    expect(before.name).toBe('Save');

    el.setAttribute('aria-label', 'Save changes');
    registry.refreshFingerprint(id, el);
    const after = registry.get(id)!.fingerprint;
    expect(after.name).toBe('Save changes');
  });

  it('updates the fingerprint even when it collides with another entry', () => {
    const wrap1 = document.createElement('div');
    const wrap2 = document.createElement('div');
    document.body.appendChild(wrap1);
    document.body.appendChild(wrap2);
    const a = makeButton('Save', wrap1);
    const b = document.createElement('button');
    b.setAttribute('aria-label', 'Submit');
    b.textContent = 'Submit';
    wrap2.appendChild(b);

    const idA = registry.register(wrapper(a));
    const idB = registry.register(wrapper(b));
    expect(idA).toBeGreaterThan(0);
    expect(idB).toBeGreaterThan(0);

    b.setAttribute('aria-label', 'Save');
    b.textContent = 'Save';
    registry.refreshFingerprint(idB, b);
    expect(registry.get(idB)).toBeTruthy();
    expect(registry.get(idB)!.fingerprint.name).toBe('Save');
  });
});

describe('WeakRef-dead path (dead-ref fingerprint fallback)', () => {
  it('rebinds an entry to a fresh element', () => {
    const a = makeButton('Save');
    const id = registry.register(wrapper(a));
    const entry = registry.get(id)!;

    a.remove();
    const b = makeButton('Save');

    const found = registry.fingerprintFallback(entry.fingerprint, Array.from(document.querySelectorAll('*')));
    expect(found).toBe(b);
    registry.rebindRef(id, found!);
    expect(registry.get(id)!.ref.deref()).toBe(b);
  });
});

describe('reverseIndex behavior across clear', () => {
  it('re-registers the same element after clear; counter restarts at 1', () => {
    // After clear, nextId resets to 1, so the same element does get the
    // same id again — but the entry was minted fresh, not recovered from
    // a stale reverseIndex hit (which would skip the fingerprint check).
    const el = makeButton('A');
    const id1 = registry.register(wrapper(el));
    expect(id1).toBe(1);
    registry.clear();
    const id2 = registry.register(wrapper(el));
    expect(id2).toBe(1);
    expect(registry.get(id2)).toBeTruthy();
  });
});

describe('bfcache re-registration (regression for stale wrapper ids)', () => {
  // The pageshow handler clears the registry then walks the surviving
  // wrappers and re-registers each. Without that walk, wrappers keep
  // their pre-clear scanned.id values pointing at entries that no
  // longer exist — every subsequent activate falls through tier 1.
  // This test pins the contract that re-registration restores the
  // wrapper → registry-entry pairing.
  it('walking the store after clear re-mints ids and re-syncs wrapper.scanned.id', () => {
    const a = makeButton('A');
    const b = makeButton('B');
    const c = makeButton('C');
    const wa = wrapper(a);
    const wb = wrapper(b);
    const wc = wrapper(c);

    expect(registry.register(wa)).toBe(1);
    expect(registry.register(wb)).toBe(2);
    expect(registry.register(wc)).toBe(3);

    // bfcache: V8 context survived; wrappers still hold their old ids;
    // registry got cleared because rectangles + plugin grammar are gone.
    registry.clear();
    expect(registry.get(wa.scanned.id)).toBeUndefined();

    // Re-register loop — same shape as content.ts:pageshow.
    for (const w of [wa, wb, wc]) {
      registry.register(w);
    }

    // Counter restarted at 1; entries point at the same elements; the
    // wrapper.scanned.id values now match the new registry slots.
    expect(wa.scanned.id).toBe(1);
    expect(wb.scanned.id).toBe(2);
    expect(wc.scanned.id).toBe(3);
    expect(registry.get(1)?.ref.deref()).toBe(a);
    expect(registry.get(2)?.ref.deref()).toBe(b);
    expect(registry.get(3)?.ref.deref()).toBe(c);
  });

  it('re-registers colliding fingerprints after bfcache restore', () => {
    const wrap1 = document.createElement('div');
    const wrap2 = document.createElement('div');
    document.body.appendChild(wrap1);
    document.body.appendChild(wrap2);
    const a = makeButton('Save', wrap1);
    const b = makeButton('Save', wrap2);
    const wa = wrapper(a);
    const wb = wrapper(b);

    expect(registry.register(wa)).toBeGreaterThan(0);

    registry.clear();

    const idA = registry.register(wa);
    const idB = registry.register(wb);
    expect(idA).toBeGreaterThan(0);
    expect(idB).toBeGreaterThan(0);
    expect(idA).not.toBe(idB);
  });
});

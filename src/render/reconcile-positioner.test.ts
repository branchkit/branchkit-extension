import { describe, it, expect, beforeEach } from 'vitest';
import {
  register,
  unregister,
  reconcileRegistrySize,
  reconcilePass,
  drain,
  type ReconcileBadge,
  type ReconcileWrite,
} from './reconcile-positioner';

// Shared transcript of read/write events across a pass, so we can assert the
// batched read-all-then-write-all ordering without relying on real layout.
let log: string[] = [];

// A fake badge. reconcilePass only ever reads `reconcileRead()` and writes
// `host.style.transform`, so a host with a logging transform accessor is a
// faithful stand-in for an HTMLElement and sidesteps happy-dom's zero-rect
// getBoundingClientRect. `coords` null => the badge declines placement this
// pass (hidden / disconnected / not yet baked), mirroring HintBadge.
function makeBadge(id: string, coords: { x: number; y: number } | null) {
  let transform = '';
  const host = {
    style: {
      get transform() {
        return transform;
      },
      set transform(v: string) {
        log.push(`write:${id}`);
        transform = v;
      },
    },
  } as unknown as HTMLElement;
  let reads = 0;
  const badge: ReconcileBadge = {
    reconcileRead(): ReconcileWrite | null {
      reads++;
      log.push(`read:${id}`);
      return coords
        ? { host, x: coords.x, y: coords.y, targetRect: new DOMRect(coords.x, coords.y, 10, 10) }
        : null;
    },
  };
  return {
    badge,
    get reads() {
      return reads;
    },
    get transform() {
      return host.style.transform;
    },
  };
}

beforeEach(() => {
  drain();
  log = [];
});

describe('reconcilePass', () => {
  it('reads ALL targets before writing ANY transform (batched)', () => {
    const a = makeBadge('a', { x: 1, y: 2 });
    const b = makeBadge('b', { x: 3, y: 4 });
    register(a.badge);
    register(b.badge);

    reconcilePass();

    // Both reads must precede both writes — interleaving would re-dirty layout
    // between gBCR calls and defeat the whole point of the model.
    expect(log).toEqual(['read:a', 'read:b', 'write:a', 'write:b']);
  });

  it('writes the composited transform from the returned coords', () => {
    const a = makeBadge('a', { x: 12, y: 34 });
    register(a.badge);

    reconcilePass();

    expect(a.transform).toBe('translate(12px,34px)');
  });

  it('re-reads live coords each pass (so per-frame scroll tracking follows the target)', () => {
    let coords = { x: 1, y: 1 };
    let transform = '';
    const host = {
      style: {
        get transform() {
          return transform;
        },
        set transform(v: string) {
          transform = v;
        },
      },
    } as unknown as HTMLElement;
    const badge: ReconcileBadge = {
      reconcileRead: () => ({ host, x: coords.x, y: coords.y, targetRect: new DOMRect(coords.x, coords.y, 10, 10) }),
    };
    register(badge);

    reconcilePass();
    expect(host.style.transform).toBe('translate(1px,1px)');

    // Target "moved" (scrolled): the next pass must reflect the new rect.
    coords = { x: 5, y: 9 };
    reconcilePass();
    expect(host.style.transform).toBe('translate(5px,9px)');
  });

  it('skips a badge whose reconcileRead returns null (hidden/disconnected/unbaked) — no write', () => {
    const hidden = makeBadge('hidden', null);
    const shown = makeBadge('shown', { x: 7, y: 8 });
    register(hidden.badge);
    register(shown.badge);

    reconcilePass();

    expect(log).toEqual(['read:hidden', 'read:shown', 'write:shown']);
    expect(hidden.transform).toBe('');
    expect(shown.transform).toBe('translate(7px,8px)');
  });

  it('is a no-op when the registry is empty', () => {
    expect(reconcileRegistrySize()).toBe(0);
    expect(reconcilePass().size).toBe(0);
    expect(log).toEqual([]);
  });

  it('returns the target rect for each placed badge (and omits declined badges)', () => {
    const placed = makeBadge('placed', { x: 7, y: 8 });
    const hidden = makeBadge('hidden', null);
    register(placed.badge);
    register(hidden.badge);

    const rects = reconcilePass();

    expect(rects.size).toBe(1);
    const r = rects.get(placed.badge);
    expect(r).toBeInstanceOf(DOMRect);
    expect({ x: r!.x, y: r!.y }).toEqual({ x: 7, y: 8 });
    expect(rects.has(hidden.badge)).toBe(false);
  });

  it('does no work after the last badge unregisters', () => {
    const a = makeBadge('a', { x: 1, y: 1 });
    register(a.badge);
    expect(reconcileRegistrySize()).toBe(1);

    unregister(a.badge);
    expect(reconcileRegistrySize()).toBe(0);

    reconcilePass();
    expect(a.reads).toBe(0);
    expect(log).toEqual([]);
  });
});

describe('drain', () => {
  it('drops every registered badge so a later pass touches nothing (orphan teardown)', () => {
    const a = makeBadge('a', { x: 1, y: 1 });
    const b = makeBadge('b', { x: 2, y: 2 });
    register(a.badge);
    register(b.badge);
    expect(reconcileRegistrySize()).toBe(2);

    drain();

    expect(reconcileRegistrySize()).toBe(0);
    reconcilePass();
    expect(a.reads).toBe(0);
    expect(b.reads).toBe(0);
    expect(log).toEqual([]);
  });

  it('is idempotent and safe on an empty registry', () => {
    expect(() => {
      drain();
      drain();
    }).not.toThrow();
    expect(reconcileRegistrySize()).toBe(0);
  });
});

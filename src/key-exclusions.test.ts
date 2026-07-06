import { describe, it, expect, beforeEach, vi } from 'vitest';
import { loadKeyExclusions, isHostExcluded, setHostExcluded } from './key-exclusions';

// Minimal in-memory chrome.storage.sync mock (promise API, MV3).
function mockChrome(initial: Record<string, unknown> = {}): Record<string, unknown> {
  const store = { ...initial };
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: {
      sync: {
        get: (key: string) => Promise.resolve({ [key]: store[key] }),
        set: (obj: Record<string, unknown>) => { Object.assign(store, obj); return Promise.resolve(); },
      },
      onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
    },
  };
  return store;
}

describe('key-exclusions', () => {
  beforeEach(() => { delete (globalThis as unknown as { chrome?: unknown }).chrome; });

  it('adds and removes a host', async () => {
    const store = mockChrome();
    expect(await isHostExcluded('example.com')).toBe(false);
    await setHostExcluded('example.com', true);
    expect(store.keyExclusions).toEqual(['example.com']);
    expect(await isHostExcluded('example.com')).toBe(true);
    await setHostExcluded('example.com', false);
    expect(store.keyExclusions).toEqual([]);
  });

  it('is idempotent — no duplicates, no error removing an absent host', async () => {
    mockChrome({ keyExclusions: ['a.com'] });
    await setHostExcluded('a.com', true); // already present
    expect(await loadKeyExclusions()).toEqual(['a.com']);
    await setHostExcluded('b.com', false); // not present
    expect(await loadKeyExclusions()).toEqual(['a.com']);
  });

  it('no-ops safely without chrome.storage', async () => {
    expect(await loadKeyExclusions()).toEqual([]);
    expect(await isHostExcluded('x')).toBe(false);
    await expect(setHostExcluded('x', true)).resolves.toBeUndefined();
  });
});

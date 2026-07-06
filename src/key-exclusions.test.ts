import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  loadKeyExclusions, isHostExcluded, setHostExcluded,
  getHostPassKeys, setHostPassKeys, getSiteKeyState,
} from './key-exclusions';

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

describe('granular passthrough', () => {
  beforeEach(() => { delete (globalThis as unknown as { chrome?: unknown }).chrome; });

  it('sets and reads per-host pass keys (deduped)', async () => {
    const store = mockChrome();
    expect(await getHostPassKeys('mail.google.com')).toEqual([]);
    await setHostPassKeys('mail.google.com', ['j', 'k', 'j', 'e']);
    expect(store.keyPassthrough).toEqual({ 'mail.google.com': ['j', 'k', 'e'] });
    expect(await getHostPassKeys('mail.google.com')).toEqual(['j', 'k', 'e']);
  });

  it('clearing removes the host entry', async () => {
    const store = mockChrome({ keyPassthrough: { 'a.com': ['j'] } });
    await setHostPassKeys('a.com', []);
    expect(store.keyPassthrough).toEqual({});
  });

  it('getSiteKeyState combines exclusion + pass keys', async () => {
    mockChrome({ keyExclusions: ['x.com'], keyPassthrough: { 'y.com': ['j'] } });
    expect(await getSiteKeyState('x.com')).toEqual({ excluded: true, passKeys: [] });
    expect(await getSiteKeyState('y.com')).toEqual({ excluded: false, passKeys: ['j'] });
    expect(await getSiteKeyState('z.com')).toEqual({ excluded: false, passKeys: [] });
  });
});

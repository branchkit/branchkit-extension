/**
 * BranchKit Browser — reference-sync unit tests.
 *
 * Pins the storage-shape logic: name aggregation across hosts (deduped),
 * connection gating on the push/save paths, and hydrate's merge policy —
 * plugin-side references fill gaps but NEVER clobber a local entry with the
 * same name.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Refs = typeof import('./references');

const postToPlugin = vi.fn();
const ensureConnected = vi.fn();
const storageData: Record<string, unknown> = {};

async function loadRefs(): Promise<Refs> {
  vi.resetModules();
  vi.doMock('../plugin/actuator-client', () => ({
    postToPlugin, ensureConnected,
    getPluginPort: () => 21551,
    getPluginToken: () => 'tok',
  }));
  return await import('./references');
}

beforeEach(() => {
  vi.clearAllMocks();
  ensureConnected.mockResolvedValue(true);
  postToPlugin.mockResolvedValue({ ok: true });
  for (const k of Object.keys(storageData)) delete storageData[k];
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storageData[key] })),
        set: vi.fn(async (obj: Record<string, unknown>) => { Object.assign(storageData, obj); }),
      },
    },
    tabs: {
      query: vi.fn(async () => [{ url: 'https://example.com/page' }]),
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('../plugin/actuator-client');
});

describe('loadAllReferenceNames', () => {
  it('aggregates names across hosts, deduped', async () => {
    const refs = await loadRefs();
    storageData[refs.REFERENCES_STORAGE_KEY] = {
      'a.com': { references: { login: {}, search: {} } },
      'b.com': { references: { login: {}, cart: {} } },
    };
    const names = await refs.loadAllReferenceNames();
    expect([...names].sort()).toEqual(['cart', 'login', 'search']);
  });

  it('returns empty for an empty store', async () => {
    const refs = await loadRefs();
    expect(await refs.loadAllReferenceNames()).toEqual([]);
  });
});

describe('push/save gating', () => {
  it('pushReferenceNames posts the aggregated name list', async () => {
    const refs = await loadRefs();
    storageData[refs.REFERENCES_STORAGE_KEY] = { 'a.com': { references: { login: {} } } };
    await refs.pushReferenceNames();
    expect(postToPlugin).toHaveBeenCalledWith('/references', { names: ['login'] });
  });

  it('bails without posting when the plugin is unreachable', async () => {
    ensureConnected.mockResolvedValue(false);
    const refs = await loadRefs();
    await refs.pushReferenceNames();
    await refs.saveReferenceToCollection('a.com', 'login', {});
    expect(postToPlugin).not.toHaveBeenCalled();
  });
});

describe('hydrateReferencesFromCollection', () => {
  it('merges plugin references for the active host without clobbering local ones', async () => {
    const refs = await loadRefs();
    storageData[refs.REFERENCES_STORAGE_KEY] = {
      'example.com': { references: { login: { local: true } }, marks: {} },
    };
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ references: { login: { remote: true }, search: { remote: true } } }),
    })));
    await refs.hydrateReferencesFromCollection();
    const store = storageData[refs.REFERENCES_STORAGE_KEY] as Record<string, { references: Record<string, unknown> }>;
    expect(store['example.com'].references.login).toEqual({ local: true }); // kept
    expect(store['example.com'].references.search).toEqual({ remote: true }); // filled
  });

  it('writes nothing when the plugin returns no references', async () => {
    const refs = await loadRefs();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ references: {} }) })));
    await refs.hydrateReferencesFromCollection();
    expect(storageData[refs.REFERENCES_STORAGE_KEY]).toBeUndefined();
  });
});

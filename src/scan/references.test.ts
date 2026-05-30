import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  saveReference,
  resolveReference,
  deleteReference,
  listReferences,
} from './references';

let storage: Record<string, unknown>;

beforeEach(() => {
  document.body.innerHTML = '';
  storage = {};

  (globalThis as any).chrome = {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (data: Record<string, unknown>) => {
          Object.assign(storage, data);
        }),
      },
    },
  };

  Object.defineProperty(window, 'location', {
    value: { hostname: 'example.com' },
    writable: true,
  });
});

describe('saveReference', () => {
  it('saves a reference with selector and visible text', async () => {
    document.body.innerHTML = `<button aria-label="Compose">New</button>`;
    const btn = document.querySelector('button')!;

    await saveReference('compose', btn);

    const store = storage['branchkit_references'] as any;
    expect(store['example.com'].references['compose']).toBeDefined();
    expect(store['example.com'].references['compose'].selector).toBeTruthy();
    expect(store['example.com'].references['compose'].visibleText).toBe('Compose');
    expect(store['example.com'].references['compose'].createdAt).toBeGreaterThan(0);
  });

  it('overwrites existing reference with same name', async () => {
    document.body.innerHTML = `
      <button id="a">First</button>
      <button id="b">Second</button>
    `;

    await saveReference('target', document.querySelector('#a')!);
    await saveReference('target', document.querySelector('#b')!);

    const store = storage['branchkit_references'] as any;
    expect(store['example.com'].references['target'].selector).toContain('b');
  });
});

describe('resolveReference', () => {
  it('resolves by exact selector match', async () => {
    document.body.innerHTML = `<button id="save-btn">Save</button>`;
    const btn = document.querySelector('#save-btn')!;

    await saveReference('save', btn);
    const resolved = await resolveReference('save');
    expect(resolved).toBe(btn);
  });

  it('falls back to tag + visible-text match when selector breaks', async () => {
    document.body.innerHTML = `<button id="old-id">Submit</button>`;
    const btn = document.querySelector('button')!;

    await saveReference('submit', btn);

    // Simulate selector breaking by changing the ID
    btn.id = 'new-id';

    const resolved = await resolveReference('submit');
    expect(resolved).toBe(btn);
  });

  it('returns null for unknown reference name', async () => {
    const result = await resolveReference('nonexistent');
    expect(result).toBeNull();
  });

  it('returns null for unknown host', async () => {
    document.body.innerHTML = `<button id="btn">Go</button>`;
    await saveReference('go', document.querySelector('button')!);

    (window as any).location = { hostname: 'other.com' };
    const result = await resolveReference('go');
    expect(result).toBeNull();
  });

  it('updates lastUsedAt on successful resolve', async () => {
    document.body.innerHTML = `<button id="btn">Go</button>`;
    await saveReference('go', document.querySelector('button')!);

    const before = (storage['branchkit_references'] as any)['example.com'].references['go'].lastUsedAt;
    await new Promise(r => setTimeout(r, 10));
    await resolveReference('go');
    const after = (storage['branchkit_references'] as any)['example.com'].references['go'].lastUsedAt;

    expect(after).toBeGreaterThanOrEqual(before);
  });
});

describe('deleteReference', () => {
  it('removes a saved reference', async () => {
    document.body.innerHTML = `<button id="btn">Go</button>`;
    await saveReference('go', document.querySelector('button')!);

    const deleted = await deleteReference('go');
    expect(deleted).toBe(true);

    const refs = await listReferences();
    expect(refs['go']).toBeUndefined();
  });

  it('returns false for nonexistent reference', async () => {
    const result = await deleteReference('nope');
    expect(result).toBe(false);
  });
});

describe('listReferences', () => {
  it('returns empty object when no references saved', async () => {
    const refs = await listReferences();
    expect(refs).toEqual({});
  });

  it('returns all references for current host', async () => {
    document.body.innerHTML = `
      <button id="a">A</button>
      <button id="b">B</button>
    `;
    await saveReference('first', document.querySelector('#a')!);
    await saveReference('second', document.querySelector('#b')!);

    const refs = await listReferences();
    expect(Object.keys(refs)).toEqual(['first', 'second']);
  });
});

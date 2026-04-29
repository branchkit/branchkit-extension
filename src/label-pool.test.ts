/**
 * BranchKit Browser — Label pool unit tests.
 *
 * Pure-function tests for the per-tab pool. Mocks chrome.storage with an
 * in-memory implementation so we can exercise the locking + race semantics
 * without a real extension context.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildPool,
  claimLabels,
  releaseLabels,
  releaseFrame,
  getFrameForLabel,
  regenerateAllStacks,
} from './label-pool';

const ALPHABET = [
  'arch', 'bake', 'check', 'deck', 'egg', 'food', 'glad', 'half', 'iron', 'jake',
  'kind', 'land', 'make', 'none', 'own', 'plan', 'quick', 'rain', 'song', 'take',
  'under', 'voice', 'work', 'xray', 'yoga', 'zoo',
];

const ALT_ALPHABET = [
  'apple', 'berry', 'cherry', 'date', 'elder', 'fig', 'grape', 'honey', 'item', 'jelly',
  'kiwi', 'lemon', 'mango', 'nectar', 'olive', 'pear', 'quince', 'rose', 'sage', 'thyme',
  'umber', 'vine', 'wheat', 'xenon', 'yarrow', 'zest',
];

// Minimal chrome.storage mock — in-memory backing for session and local
// areas, supporting the access patterns label-pool actually uses. Each
// call goes through structuredClone so callers can't accidentally mutate
// stored state by holding a reference (matches real chrome.storage).
function installMockChrome(initialAlphabet: string[] | null = ALPHABET): void {
  const session = new Map<string, unknown>();
  const local = new Map<string, unknown>();
  if (initialAlphabet) local.set('alphabet', initialAlphabet);

  const makeArea = (store: Map<string, unknown>) => ({
    async get(keys?: string | string[] | null): Promise<Record<string, unknown>> {
      if (keys === undefined || keys === null) {
        return Object.fromEntries([...store].map(([k, v]) => [k, structuredClone(v)]));
      }
      if (typeof keys === 'string') {
        return store.has(keys) ? { [keys]: structuredClone(store.get(keys)) } : {};
      }
      const out: Record<string, unknown> = {};
      for (const k of keys) {
        if (store.has(k)) out[k] = structuredClone(store.get(k));
      }
      return out;
    },
    async set(items: Record<string, unknown>): Promise<void> {
      for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
    },
    async remove(key: string): Promise<void> {
      store.delete(key);
    },
  });

  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: { session: makeArea(session), local: makeArea(local) },
  };
}

let tabIdCounter = 1000;
const nextTabId = () => tabIdCounter++;

describe('label-pool', () => {
  beforeEach(() => {
    installMockChrome();
  });

  describe('buildPool', () => {
    it('returns 176 codewords (20 singles + 6×26 pairs) for a valid alphabet', () => {
      const pool = buildPool(ALPHABET);
      expect(pool).not.toBeNull();
      expect(pool!.length).toBe(176);
      expect(pool![0]).toBe('arch');         // first single
      expect(pool![19]).toBe('take');         // last single (alphabet[19])
      expect(pool![20]).toBe('under arch');   // first pair (prefix=alphabet[20], suffix=alphabet[0])
      expect(pool![175]).toBe('zoo zoo');     // last pair
    });

    it('returns null for an alphabet of the wrong length', () => {
      expect(buildPool(['only', 'three', 'words'])).toBeNull();
      expect(buildPool([])).toBeNull();
    });

    it('returns null when any alphabet entry is empty', () => {
      const broken = [...ALPHABET];
      broken[5] = '';
      expect(buildPool(broken)).toBeNull();
    });
  });

  describe('claim → release → claim', () => {
    it('returns the same labels on re-claim of the same count', async () => {
      const tabId = nextTabId();
      const first = await claimLabels(tabId, 0, 4);
      expect(first).toEqual(['arch', 'bake', 'check', 'deck']);

      await releaseLabels(tabId, first);

      const second = await claimLabels(tabId, 0, 4);
      expect(second).toEqual(['arch', 'bake', 'check', 'deck']);
    });

    it('release of partial set preserves order for unreleased labels', async () => {
      const tabId = nextTabId();
      const first = await claimLabels(tabId, 0, 5);
      expect(first).toEqual(['arch', 'bake', 'check', 'deck', 'egg']);

      // Release only the middle three; arch and egg stay claimed.
      await releaseLabels(tabId, ['bake', 'check', 'deck']);

      const next = await claimLabels(tabId, 0, 3);
      // Pool's free list was [bake, check, deck, ...rest] after release;
      // claim returns from the front in order.
      expect(next).toEqual(['bake', 'check', 'deck']);
    });
  });

  describe('concurrent claims serialize via withTabLock', () => {
    it('two frames claiming the same tab in parallel get disjoint labels', async () => {
      const tabId = nextTabId();
      const [a, b] = await Promise.all([
        claimLabels(tabId, 0, 5),
        claimLabels(tabId, 1, 5),
      ]);

      expect(a.length).toBe(5);
      expect(b.length).toBe(5);
      const combined = new Set([...a, ...b]);
      expect(combined.size).toBe(10); // no overlap

      // The first 10 alphabet codewords are split between the two frames.
      const expected = new Set(['arch', 'bake', 'check', 'deck', 'egg', 'food', 'glad', 'half', 'iron', 'jake']);
      expect(combined).toEqual(expected);
    });

    it('routing map reflects which frame owns each codeword', async () => {
      const tabId = nextTabId();
      const a = await claimLabels(tabId, 0, 3);
      const b = await claimLabels(tabId, 1, 3);

      for (const label of a) {
        expect(await getFrameForLabel(tabId, label)).toBe(0);
      }
      for (const label of b) {
        expect(await getFrameForLabel(tabId, label)).toBe(1);
      }
    });
  });

  describe('releaseFrame', () => {
    it('releases every label held by one frame and leaves others intact', async () => {
      const tabId = nextTabId();
      const frameAClaim = await claimLabels(tabId, 0, 3);
      const frameBClaim = await claimLabels(tabId, 1, 3);

      await releaseFrame(tabId, 0);

      // Frame 0's labels are gone from the assigned map.
      for (const label of frameAClaim) {
        expect(await getFrameForLabel(tabId, label)).toBeNull();
      }
      // Frame 1's labels are still owned by frame 1.
      for (const label of frameBClaim) {
        expect(await getFrameForLabel(tabId, label)).toBe(1);
      }

      // Released labels are at the front of the pool — re-claim should
      // return them in their original order before reaching new ones.
      const reclaimed = await claimLabels(tabId, 99, 3);
      expect(reclaimed).toEqual(frameAClaim);
    });
  });

  describe('pool overflow', () => {
    it('returns at most pool capacity when more is requested', async () => {
      const tabId = nextTabId();
      const claimed = await claimLabels(tabId, 0, 300);
      expect(claimed.length).toBe(176); // 20 singles + 6*26 pairs
    });

    it('returns empty when alphabet is missing', async () => {
      installMockChrome(null); // no alphabet
      const tabId = nextTabId();
      const claimed = await claimLabels(tabId, 0, 5);
      expect(claimed).toEqual([]);
    });
  });

  describe('regenerateAllStacks', () => {
    it('clears assigned across all tabs and seeds the new alphabet', async () => {
      const tabA = nextTabId();
      const tabB = nextTabId();
      const aClaim = await claimLabels(tabA, 0, 5);
      const bClaim = await claimLabels(tabB, 0, 3);
      expect(aClaim.length).toBe(5);
      expect(bClaim.length).toBe(3);

      // Swap the alphabet and regenerate.
      await (globalThis as unknown as { chrome: { storage: { local: { set(o: object): Promise<void> } } } })
        .chrome.storage.local.set({ alphabet: ALT_ALPHABET });
      await regenerateAllStacks();

      // Old codewords should no longer resolve to any frame.
      for (const label of aClaim) {
        expect(await getFrameForLabel(tabA, label)).toBeNull();
      }
      for (const label of bClaim) {
        expect(await getFrameForLabel(tabB, label)).toBeNull();
      }

      // New claims pull from the alt alphabet.
      const fresh = await claimLabels(tabA, 0, 3);
      expect(fresh).toEqual(['apple', 'berry', 'cherry']);
    });
  });
});

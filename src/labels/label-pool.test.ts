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
  confirmLabels,
  releaseLabels,
  releaseFrame,
  getFrameForLabel,
  regenerateAllStacks,
  alphabetsEqual,
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
    it('returns 676 unique codewords in balanced square-fill order', () => {
      const pool = buildPool(ALPHABET);
      expect(pool).not.toBeNull();
      expect(pool!.length).toBe(676);
      expect(new Set(pool!).size).toBe(676);   // all unique

      // First 4 form a balanced 2×2 grid (prefixes × suffixes = arch,bake).
      expect(pool!.slice(0, 4)).toEqual([
        'arch arch', 'arch bake', 'bake bake', 'bake arch',
      ]);

      // Invariant: the first N codewords use ceil(sqrt(N)) distinct
      // prefixes AND the same count of distinct suffixes. Checked at N=9
      // (a full 3×3 shell).
      const first9 = pool!.slice(0, 9);
      const prefixes = new Set(first9.map(c => c.split(' ')[0]));
      const suffixes = new Set(first9.map(c => c.split(' ')[1]));
      expect(prefixes).toEqual(new Set(['arch', 'bake', 'check']));
      expect(suffixes).toEqual(new Set(['arch', 'bake', 'check']));

      expect(pool!).toContain('zoo zoo');
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
      expect(first).toEqual(['arch arch', 'arch bake', 'bake bake', 'bake arch']);

      await releaseLabels(tabId, first);

      const second = await claimLabels(tabId, 0, 4);
      expect(second).toEqual(['arch arch', 'arch bake', 'bake bake', 'bake arch']);
    });

    it('release of partial set preserves order for unreleased labels', async () => {
      const tabId = nextTabId();
      const first = await claimLabels(tabId, 0, 5);
      expect(first).toEqual(['arch arch', 'arch bake', 'bake bake', 'bake arch', 'arch check']);

      // Release only the middle three; first and last stay claimed.
      await releaseLabels(tabId, ['arch bake', 'bake bake', 'bake arch']);

      const next = await claimLabels(tabId, 0, 3);
      expect(next).toEqual(['arch bake', 'bake bake', 'bake arch']);
    });
  });

  describe('sticky reclaim (preferred)', () => {
    it('re-grants a preferred codeword that is still free', async () => {
      const tabId = nextTabId();
      const first = await claimLabels(tabId, 0, 3);
      expect(first).toEqual(['arch arch', 'arch bake', 'bake bake']);

      // Element holding 'bake bake' scrolls out, releasing it.
      await releaseLabels(tabId, ['bake bake']);

      // Two slots re-claim: one prefers the freed 'bake bake', one is new.
      const next = await claimLabels(tabId, 0, 2, ['bake bake', '']);
      // Slot 0 gets its preferred back regardless of pool order; slot 1 gets
      // the next fresh front-of-pool codeword (not 'bake bake').
      expect(next[0]).toBe('bake bake');
      expect(next[1]).not.toBe('bake bake');
      expect(next[1].length).toBeGreaterThan(0);
    });

    it('falls back to fresh when the preferred codeword is taken', async () => {
      const tabId = nextTabId();
      const a = await claimLabels(tabId, 0, 2); // ['arch arch', 'arch bake']
      // Frame 1 prefers a codeword frame 0 still holds — not free, so fresh.
      const b = await claimLabels(tabId, 1, 1, [a[0]]);
      expect(b[0]).not.toBe(a[0]);
      expect(b[0].length).toBeGreaterThan(0);
    });

    it('index-aligns grants when a preferred slot precedes fresh ones', async () => {
      const tabId = nextTabId();
      const first = await claimLabels(tabId, 0, 4);
      await releaseLabels(tabId, first); // all four back, front-of-pool

      // Slot 1 prefers a specific freed codeword; the rest are fresh and must
      // fill the OTHER slots without clobbering slot 1's grant.
      const next = await claimLabels(tabId, 0, 4, ['', 'bake arch', '', '']);
      expect(next[1]).toBe('bake arch');
      expect(new Set(next).size).toBe(4); // all distinct, none empty
      expect(next.every(l => l.length > 0)).toBe(true);
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

      // The first 10 pairs are split between the two frames. Square-fill
      // ordering fills expanding shells: the 2×2 and 3×3 grids, then the
      // first cell of the 4×4 shell.
      const expected = new Set([
        'arch arch', 'arch bake', 'bake bake', 'bake arch', 'arch check',
        'bake check', 'check check', 'check bake', 'check arch', 'arch deck',
      ]);
      expect(combined).toEqual(expected);
    });

    it('routing map reflects which frame owns each codeword (after confirm)', async () => {
      const tabId = nextTabId();
      const a = await claimLabels(tabId, 0, 3);
      const b = await claimLabels(tabId, 1, 3);

      // Pre-confirm: routing returns null — labels are reserved, not
      // yet wrapper-confirmed. This is the PR-6 invariant: unused
      // reservoir-pre-allocations can't capture voice routing meant
      // for a sibling frame.
      for (const label of a) {
        expect(await getFrameForLabel(tabId, label)).toBeNull();
      }

      // Confirm promotes reserved → assigned and routing locks to the
      // confirming frame.
      await confirmLabels(tabId, 0, a);
      await confirmLabels(tabId, 1, b);

      for (const label of a) {
        expect(await getFrameForLabel(tabId, label)).toBe(0);
      }
      for (const label of b) {
        expect(await getFrameForLabel(tabId, label)).toBe(1);
      }
    });

    it('confirmLabels rejects labels reserved to a different frame', async () => {
      // Defensive: an out-of-order or stale CONFIRM_LABELS from frame B
      // for labels that are reserved to frame A must not steal ownership —
      // and (Phase 4) must REPORT the rejection so frame B drops them.
      const tabId = nextTabId();
      const a = await claimLabels(tabId, 0, 3);

      // Frame 1 tries to confirm frame 0's reserved labels.
      const { rejected } = await confirmLabels(tabId, 1, a);
      expect(rejected).toEqual(a);

      // Still nobody owns them — frame 0 hasn't confirmed.
      for (const label of a) {
        expect(await getFrameForLabel(tabId, label)).toBeNull();
      }

      // Frame 0's own confirm still works.
      const ownConfirm = await confirmLabels(tabId, 0, a);
      expect(ownConfirm.rejected).toEqual([]);
      for (const label of a) {
        expect(await getFrameForLabel(tabId, label)).toBe(0);
      }
    });
  });

  describe('confirm exchange (epoch-handshake Phase 4 / review bug #5)', () => {
    it('acquires a released-then-reclaimed codeword directly from free', async () => {
      // The cross-frame duplicate setup: frame 0 releases (codeword → free),
      // then its reservoir re-grants the codeword locally. Pre-fix the late
      // confirm was a silent no-op, leaving the codeword in free for another
      // frame to claim while frame 0's wrapper still held it.
      const tabId = nextTabId();
      const [cw] = await claimLabels(tabId, 0, 1);
      await confirmLabels(tabId, 0, [cw]);
      await releaseLabels(tabId, [cw]);

      const { rejected } = await confirmLabels(tabId, 0, [cw]);
      expect(rejected).toEqual([]);
      expect(await getFrameForLabel(tabId, cw)).toBe(0);

      // The pool can no longer hand it to another frame.
      const b = await claimLabels(tabId, 1, 5);
      expect(b).not.toContain(cw);
    });

    it('rejects a codeword another frame won in the release-vs-confirm window', async () => {
      const tabId = nextTabId();
      const [cw] = await claimLabels(tabId, 0, 1);
      await confirmLabels(tabId, 0, [cw]);
      await releaseLabels(tabId, [cw]);

      // Frame 1's refill grabs it before frame 0's confirm lands (released
      // labels unshift to the front, so a 1-slot claim returns the same one).
      const b = await claimLabels(tabId, 1, 1);
      expect(b[0]).toBe(cw);

      // Frame 0's late confirm loses the arbitration.
      const { rejected } = await confirmLabels(tabId, 0, [cw]);
      expect(rejected).toEqual([cw]);

      // Frame 1 confirms and owns routing — exactly one owner.
      await confirmLabels(tabId, 1, [cw]);
      expect(await getFrameForLabel(tabId, cw)).toBe(1);
    });

    it('rejects codewords unknown to the pool', async () => {
      const tabId = nextTabId();
      await claimLabels(tabId, 0, 1); // materialize the stack
      const { rejected } = await confirmLabels(tabId, 0, ['bogus pair']);
      expect(rejected).toEqual(['bogus pair']);
    });

    it('re-confirm of an already-assigned codeword is an accepted no-op', async () => {
      const tabId = nextTabId();
      const [cw] = await claimLabels(tabId, 0, 1);
      await confirmLabels(tabId, 0, [cw]);
      const { rejected } = await confirmLabels(tabId, 0, [cw]);
      expect(rejected).toEqual([]);
      expect(await getFrameForLabel(tabId, cw)).toBe(0);
    });
  });

  describe('releaseFrame', () => {
    it('releases every label held by one frame and leaves others intact', async () => {
      const tabId = nextTabId();
      const frameAClaim = await claimLabels(tabId, 0, 3);
      const frameBClaim = await claimLabels(tabId, 1, 3);
      // Confirm so getFrameForLabel routes (the assertion below depends
      // on frame 1's labels being routable post-release of frame 0).
      await confirmLabels(tabId, 0, frameAClaim);
      await confirmLabels(tabId, 1, frameBClaim);

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

    it('releases reservoir-reserved labels on frame disconnect', async () => {
      // Reserved-but-not-confirmed labels must come back on releaseFrame
      // too — they were pre-allocated to the dying frame's reservoir and
      // no wrapper ever committed.
      const tabId = nextTabId();
      const reserved = await claimLabels(tabId, 0, 3);
      // No confirm — labels stay in `reserved` state.

      await releaseFrame(tabId, 0);

      // After release, re-claim from a different frame should return
      // the same labels (they're back at the front of free).
      const reclaimed = await claimLabels(tabId, 1, 3);
      expect(reclaimed).toEqual(reserved);
    });
  });

  describe('pool overflow', () => {
    it('grants at most pool capacity when more is requested', async () => {
      const tabId = nextTabId();
      const claimed = await claimLabels(tabId, 0, 800);
      // Result is index-aligned to the request (length 800); slots past the
      // pool's 676 capacity come back empty.
      expect(claimed.length).toBe(800);
      const granted = claimed.filter(l => l.length > 0);
      expect(granted.length).toBe(676); // 26×26 pairs
      expect(new Set(granted).size).toBe(676); // all distinct
      expect(claimed.slice(676).every(l => l === '')).toBe(true);
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

      // New claims pull from the alt alphabet (pairs now).
      const fresh = await claimLabels(tabA, 0, 3);
      expect(fresh).toEqual(['apple apple', 'apple berry', 'berry berry']);
    });
  });

  describe('alphabetsEqual', () => {
    it('returns true for same words in same order', () => {
      expect(alphabetsEqual(ALPHABET, [...ALPHABET])).toBe(true);
    });

    it('returns false when any word differs', () => {
      const swapped = [...ALPHABET];
      swapped[5] = 'different';
      expect(alphabetsEqual(ALPHABET, swapped)).toBe(false);
    });

    it('returns false when order differs', () => {
      const reordered = [...ALPHABET];
      [reordered[0], reordered[1]] = [reordered[1], reordered[0]];
      expect(alphabetsEqual(ALPHABET, reordered)).toBe(false);
    });

    it('returns false on different lengths', () => {
      expect(alphabetsEqual(ALPHABET, ALPHABET.slice(0, 25))).toBe(false);
    });

    it('returns true for two empty arrays', () => {
      expect(alphabetsEqual([], [])).toBe(true);
    });
  });
});

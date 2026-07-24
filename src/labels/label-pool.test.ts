/**
 * BranchKit Browser — Label pool unit tests.
 *
 * Pure-function tests for the per-tab pool. Mocks chrome.storage with an
 * in-memory implementation so we can exercise the locking + race semantics
 * without a real extension context.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  buildPool,
  claimLabels,
  confirmLabels,
  releaseLabels,
  releaseDocument,
  getFrameForLabel,
  sweepDeadStacks,
  alphabetsEqual,
  senderMayMutatePool,
  POOL_SIZE,
} from './label-pool';
import { vi } from 'vitest';
import { LETTERS_26 } from './words';

// The pool builds from the fixed extension-owned letter alphabet, so claim/
// release tokens are letter pairs. Derive the expected square-fill order from
// buildPool so these tests don't hard-code the letter ordering.
const LP = buildPool(LETTERS_26)!;

const ALPHABET = [
  'arch', 'bake', 'check', 'deck', 'egg', 'food', 'glad', 'half', 'iron', 'jake',
  'kind', 'land', 'make', 'none', 'own', 'plan', 'quick', 'rain', 'song', 'take',
  'under', 'voice', 'work', 'xray', 'yoga', 'zoo',
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
      const first = await claimLabels(tabId, 'd0', 0, 4);
      expect(first).toEqual(LP.slice(0, 4));

      await releaseLabels(tabId, 'd0', first);

      const second = await claimLabels(tabId, 'd0', 0, 4);
      expect(second).toEqual(LP.slice(0, 4));
    });

    it('release of partial set preserves order for unreleased labels', async () => {
      const tabId = nextTabId();
      const first = await claimLabels(tabId, 'd0', 0, 5);
      expect(first).toEqual(LP.slice(0, 5));

      // Release only the middle three; first and last stay claimed.
      await releaseLabels(tabId, 'd0', [LP[1], LP[2], LP[3]]);

      const next = await claimLabels(tabId, 'd0', 0, 3);
      expect(next).toEqual([LP[1], LP[2], LP[3]]);
    });
  });

  describe('sticky reclaim (preferred)', () => {
    it('re-grants a preferred codeword that is still free', async () => {
      const tabId = nextTabId();
      const first = await claimLabels(tabId, 'd0', 0, 3);
      expect(first).toEqual(LP.slice(0, 3));

      // Element holding LP[2] scrolls out, releasing it.
      await releaseLabels(tabId, 'd0', [LP[2]]);

      // Two slots re-claim: one prefers the freed LP[2], one is new.
      const next = await claimLabels(tabId, 'd0', 0, 2, [LP[2], '']);
      // Slot 0 gets its preferred back regardless of pool order; slot 1 gets
      // the next fresh front-of-pool token (not LP[2]).
      expect(next[0]).toBe(LP[2]);
      expect(next[1]).not.toBe(LP[2]);
      expect(next[1].length).toBeGreaterThan(0);
    });

    it('falls back to fresh when the preferred codeword is taken', async () => {
      const tabId = nextTabId();
      const a = await claimLabels(tabId, 'd0', 0, 2); // ['arch arch', 'arch bake']
      // Frame 1 prefers a codeword frame 0 still holds — not free, so fresh.
      const b = await claimLabels(tabId, 'd1', 1, 1, [a[0]]);
      expect(b[0]).not.toBe(a[0]);
      expect(b[0].length).toBeGreaterThan(0);
    });

    it('index-aligns grants when a preferred slot precedes fresh ones', async () => {
      const tabId = nextTabId();
      const first = await claimLabels(tabId, 'd0', 0, 4);
      await releaseLabels(tabId, 'd0', first); // all four back, front-of-pool

      // Slot 1 prefers a specific freed token; the rest are fresh and must
      // fill the OTHER slots without clobbering slot 1's grant.
      const next = await claimLabels(tabId, 'd0', 0, 4, ['', LP[3], '', '']);
      expect(next[1]).toBe(LP[3]);
      expect(new Set(next).size).toBe(4); // all distinct, none empty
      expect(next.every(l => l.length > 0)).toBe(true);
    });
  });

  describe('concurrent claims serialize via withTabLock', () => {
    it('two frames claiming the same tab in parallel get disjoint labels', async () => {
      const tabId = nextTabId();
      const [a, b] = await Promise.all([
        claimLabels(tabId, 'd0', 0, 5),
        claimLabels(tabId, 'd1', 1, 5),
      ]);

      expect(a.length).toBe(5);
      expect(b.length).toBe(5);
      const combined = new Set([...a, ...b]);
      expect(combined.size).toBe(10); // no overlap

      // The first 10 pairs are split between the two frames. Square-fill
      // ordering fills expanding shells: the 2×2 and 3×3 grids, then the
      // first cell of the 4×4 shell.
      expect(combined).toEqual(new Set(LP.slice(0, 10)));
    });

    it('routing map reflects which frame owns each codeword (after confirm)', async () => {
      const tabId = nextTabId();
      const a = await claimLabels(tabId, 'd0', 0, 3);
      const b = await claimLabels(tabId, 'd1', 1, 3);

      // Pre-confirm: routing returns null — labels are reserved, not
      // yet wrapper-confirmed. This is the PR-6 invariant: unused
      // reservoir-pre-allocations can't capture voice routing meant
      // for a sibling frame.
      for (const label of a) {
        expect(await getFrameForLabel(tabId, label)).toBeNull();
      }

      // Confirm promotes reserved → assigned and routing locks to the
      // confirming frame.
      await confirmLabels(tabId, 'd0', 0, a);
      await confirmLabels(tabId, 'd1', 1, b);

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
      const a = await claimLabels(tabId, 'd0', 0, 3);

      // Frame 1 tries to confirm frame 0's reserved labels.
      const { rejected } = await confirmLabels(tabId, 'd1', 1, a);
      expect(rejected).toEqual(a);

      // Still nobody owns them — frame 0 hasn't confirmed.
      for (const label of a) {
        expect(await getFrameForLabel(tabId, label)).toBeNull();
      }

      // Frame 0's own confirm still works.
      const ownConfirm = await confirmLabels(tabId, 'd0', 0, a);
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
      const [cw] = await claimLabels(tabId, 'd0', 0, 1);
      await confirmLabels(tabId, 'd0', 0, [cw]);
      await releaseLabels(tabId, 'd0', [cw]);

      const { rejected } = await confirmLabels(tabId, 'd0', 0, [cw]);
      expect(rejected).toEqual([]);
      expect(await getFrameForLabel(tabId, cw)).toBe(0);

      // The pool can no longer hand it to another frame.
      const b = await claimLabels(tabId, 'd1', 1, 5);
      expect(b).not.toContain(cw);
    });

    it('rejects a codeword another frame won in the release-vs-confirm window', async () => {
      const tabId = nextTabId();
      const [cw] = await claimLabels(tabId, 'd0', 0, 1);
      await confirmLabels(tabId, 'd0', 0, [cw]);
      await releaseLabels(tabId, 'd0', [cw]);

      // Frame 1's refill grabs it before frame 0's confirm lands (released
      // labels unshift to the front, so a 1-slot claim returns the same one).
      const b = await claimLabels(tabId, 'd1', 1, 1);
      expect(b[0]).toBe(cw);

      // Frame 0's late confirm loses the arbitration.
      const { rejected } = await confirmLabels(tabId, 'd0', 0, [cw]);
      expect(rejected).toEqual([cw]);

      // Frame 1 confirms and owns routing — exactly one owner.
      await confirmLabels(tabId, 'd1', 1, [cw]);
      expect(await getFrameForLabel(tabId, cw)).toBe(1);
    });

    it('rejects codewords unknown to the pool', async () => {
      const tabId = nextTabId();
      await claimLabels(tabId, 'd0', 0, 1); // materialize the stack
      const { rejected } = await confirmLabels(tabId, 'd0', 0, ['bogus pair']);
      expect(rejected).toEqual(['bogus pair']);
    });

    it('re-confirm of an already-assigned codeword is an accepted no-op', async () => {
      const tabId = nextTabId();
      const [cw] = await claimLabels(tabId, 'd0', 0, 1);
      await confirmLabels(tabId, 'd0', 0, [cw]);
      const { rejected } = await confirmLabels(tabId, 'd0', 0, [cw]);
      expect(rejected).toEqual([]);
      expect(await getFrameForLabel(tabId, cw)).toBe(0);
    });
  });

  describe('frame-scoped release (owner-blind release fix)', () => {
    it('ignores a release from a frame that does not own the assigned label', async () => {
      // The stale-local-copy scenario: frame 0 released a codeword, frame 1
      // claimed + confirmed it, and frame 0's reservoir (still holding the
      // string locally) releases it AGAIN. That second release must not free
      // frame 1's live assignment.
      const tabId = nextTabId();
      const [cw] = await claimLabels(tabId, 'd0', 0, 1);
      await releaseLabels(tabId, 'd0', [cw]);          // owner release — freed

      const b = await claimLabels(tabId, 'd1', 1, 1);     // frame 1 wins it
      expect(b[0]).toBe(cw);
      await confirmLabels(tabId, 'd1', 1, [cw]);

      await releaseLabels(tabId, 'd0', [cw]);          // stale re-release — ignored

      // Frame 1 still owns routing, and the pool can't re-issue the
      // codeword to a third frame.
      expect(await getFrameForLabel(tabId, cw)).toBe(1);
      const c = await claimLabels(tabId, 'd2', 2, 5);
      expect(c).not.toContain(cw);
    });

    it('ignores a non-owner release of a reserved (unconfirmed) label', async () => {
      const tabId = nextTabId();
      const [cw] = await claimLabels(tabId, 'd0', 0, 1);  // reserved to frame 0

      await releaseLabels(tabId, 'd1', [cw]);          // frame 1 never owned it

      // Frame 0's confirm still promotes its reservation.
      const { rejected } = await confirmLabels(tabId, 'd0', 0, [cw]);
      expect(rejected).toEqual([]);
      expect(await getFrameForLabel(tabId, cw)).toBe(0);
    });

    it('releases a reserved label when its owning frame releases it', async () => {
      // Pre-confirm owner release (wrapper left viewport before the confirm
      // round-trip): the reservation must come back to the pool.
      const tabId = nextTabId();
      const [cw] = await claimLabels(tabId, 'd0', 0, 1);  // reserved to frame 0
      await releaseLabels(tabId, 'd0', [cw]);

      const b = await claimLabels(tabId, 'd1', 1, 1);     // front-of-pool again
      expect(b[0]).toBe(cw);
    });
  });

  describe('releaseFrame', () => {
    it('releases every label held by one frame and leaves others intact', async () => {
      const tabId = nextTabId();
      const frameAClaim = await claimLabels(tabId, 'd0', 0, 3);
      const frameBClaim = await claimLabels(tabId, 'd1', 1, 3);
      // Confirm so getFrameForLabel routes (the assertion below depends
      // on frame 1's labels being routable post-release of frame 0).
      await confirmLabels(tabId, 'd0', 0, frameAClaim);
      await confirmLabels(tabId, 'd1', 1, frameBClaim);

      await releaseDocument(tabId, 'd0');

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
      const reclaimed = await claimLabels(tabId, 'd99', 99, 3);
      expect(reclaimed).toEqual(frameAClaim);
    });

    it('releases reservoir-reserved labels on frame disconnect', async () => {
      // Reserved-but-not-confirmed labels must come back on releaseFrame
      // too — they were pre-allocated to the dying frame's reservoir and
      // no wrapper ever committed.
      const tabId = nextTabId();
      const reserved = await claimLabels(tabId, 'd0', 0, 3);
      // No confirm — labels stay in `reserved` state.

      await releaseDocument(tabId, 'd0');

      // After release, re-claim from a different frame should return
      // the same labels (they're back at the front of free).
      const reclaimed = await claimLabels(tabId, 'd1', 1, 3);
      expect(reclaimed).toEqual(reserved);
    });
  });

  describe('pool overflow', () => {
    it('grants at most pool capacity when more is requested', async () => {
      const tabId = nextTabId();
      const claimed = await claimLabels(tabId, 'd0', 0, 800);
      // Result is index-aligned to the request (length 800); slots past the
      // pool's 676 capacity come back empty.
      expect(claimed.length).toBe(800);
      const granted = claimed.filter(l => l.length > 0);
      expect(granted.length).toBe(676); // 26×26 pairs
      expect(new Set(granted).size).toBe(676); // all distinct
      expect(claimed.slice(676).every(l => l === '')).toBe(true);
    });

    it('builds from the fixed letter alphabet even with no stored alphabet', async () => {
      // The pool is extension-owned now — it does NOT depend on BranchKit
      // having pushed an alphabet. Claims succeed with nothing in storage.
      installMockChrome(null);
      const tabId = nextTabId();
      const claimed = await claimLabels(tabId, 'd0', 0, 5);
      expect(claimed).toEqual(LP.slice(0, 5));
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

  describe('sweepDeadStacks (long-session audit finding 6)', () => {
    it('clears stacks for dead tabs, leaves live tabs untouched', async () => {
      const liveTab = nextTabId();
      const deadTab = nextTabId();
      const liveClaims = await claimLabels(liveTab, 'd0', 0, 3);
      await confirmLabels(liveTab, 'd0', 0, liveClaims);
      await claimLabels(deadTab, 'd0', 0, 3);

      const swept = await sweepDeadStacks(async () => new Set([liveTab]));

      // The module-level stack cache carries prior tests' tabs (each test
      // claims under a fresh id), so assert membership, not equality.
      expect(swept).toContain(deadTab);
      expect(swept).not.toContain(liveTab);
      // Live tab's assignments survive.
      for (const label of liveClaims) {
        expect(await getFrameForLabel(liveTab, label)).toBe(0);
      }
      // Dead tab's stack is gone — a hypothetical re-claim starts from the
      // head of a fresh pool (nothing held by the swept assignments).
      const reClaim = await claimLabels(deadTab, 'd0', 0, 3);
      expect(reClaim).toEqual(LP.slice(0, 3));
    });

    it('snapshots tracked stacks before querying live tabs (mid-sweep tab creation is safe)', async () => {
      const oldDead = nextTabId();
      await claimLabels(oldDead, 'd0', 0, 2);
      let newTab = -1;

      const swept = await sweepDeadStacks(async () => {
        // A tab born (and claiming) between the snapshot and the query —
        // its stack must not be reaped even though it's absent from the
        // alive set built below.
        newTab = nextTabId();
        await claimLabels(newTab, 'd0', 0, 2);
        return new Set<number>();
      });

      expect(swept).toContain(oldDead);
      expect(swept).not.toContain(newTab);
      const next = await claimLabels(newTab, 'd0', 0, 1);
      expect(next).toEqual([LP[2]]); // pool continued — stack survived
    });

    it('does not sweep a tracked tab reported alive', async () => {
      const tab = nextTabId();
      await claimLabels(tab, 'd0', 0, 2);
      expect(await sweepDeadStacks(async () => new Set([tab]))).not.toContain(tab);
    });
  });
  // --- DESIGN_PRERENDER_POOL_POISONING.md ---

  describe('senderMayMutatePool (L1)', () => {
    it('denies prerender-lifecycle senders and allows everything else', () => {
      expect(senderMayMutatePool({ documentLifecycle: 'prerender' })).toBe(false);
      expect(senderMayMutatePool({ documentLifecycle: 'active' })).toBe(true);
      // Older Chrome / Firefox senders without the field stay allowed.
      expect(senderMayMutatePool({})).toBe(true);
    });
  });

  describe('reservation TTL steal (L2)', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('a claim does NOT steal fresh reservations', async () => {
      const tab = nextTabId();
      // Phantom frame reserves the whole pool.
      await claimLabels(tab, 'd4241', 4241, POOL_SIZE);
      // A fresh claim from frame 0 finds free exhausted and nothing stale.
      const got = await claimLabels(tab, 'd0', 0, 3);
      expect(got).toEqual(['', '', '']);
    });

    it('a claim steals reservations older than the TTL, and the stolen labels confirm to the thief', async () => {
      vi.useFakeTimers({ now: 1_000_000 });
      const tab = nextTabId();
      await claimLabels(tab, 'd4241', 4241, POOL_SIZE); // phantom holds everything
      vi.setSystemTime(1_000_000 + 6 * 60_000); // past RESERVATION_STALE_MS
      const got = await claimLabels(tab, 'd0', 0, 3);
      expect(got.filter(Boolean)).toHaveLength(3);
      // The thief's confirm promotes normally.
      const { rejected } = await confirmLabels(tab, 'd0', 0, got);
      expect(rejected).toEqual([]);
      expect(await getFrameForLabel(tab, got[0])).toBe(0);
      // The original holder's late confirm for a stolen label is rejected —
      // its strip-and-reclaim recovery owns the aftermath.
      const late = await confirmLabels(tab, 'd4241', 4241, [got[0]]);
      expect(late.rejected).toEqual([got[0]]);
    });

    it('never steals the claiming document\'s own reservations via pass 2', async () => {
      vi.useFakeTimers({ now: 2_000_000 });
      const tab = nextTabId();
      await claimLabels(tab, 'd0', 0, POOL_SIZE); // frame 0's own reservoir cache
      vi.setSystemTime(2_000_000 + 6 * 60_000);
      // Same frame claiming again: pass 2 must not cannibalize its own
      // reservations (that is pass 1's sticky-preferred domain).
      const got = await claimLabels(tab, 'd0', 0, 2);
      expect(got).toEqual(['', '']);
    });

    it('grandfathers stamp-less persisted stacks: stealable only after a TTL from load', async () => {
      vi.useFakeTimers({ now: 3_000_000 });
      const tab = nextTabId();
      // Simulate a pre-migration persisted stack: reserved without reservedAt.
      const key = `labelStack:${tab}`;
      await chrome.storage.session.set({ [key]: {
        free: LP.slice(2),
        reserved: { [LP[0]]: { d: 'd4241', f: 4241 }, [LP[1]]: { d: 'd4241', f: 4241 } },
        assigned: {},
      } });
      // Exhaust free as frame 7 so pass 2 reaches the steal path.
      await claimLabels(tab, 'd7', 7, POOL_SIZE - 2);
      // Immediately after load: grandfathered stamps = now, not stealable.
      expect((await claimLabels(tab, 'd0', 0, 1))[0]).toBe('');
      vi.setSystemTime(3_000_000 + 6 * 60_000);
      const got = await claimLabels(tab, 'd0', 0, 2);
      expect(got.filter(Boolean).length).toBeGreaterThan(0);
    });
  });
  describe('document-scoped ownership (DESIGN_DOCUMENT_SCOPED_POOL_OWNERSHIP.md)', () => {
    it('prerender transition: a document confirming under a new frameId keeps its labels and re-routes', async () => {
      const tab = nextTabId();
      // Claimed while the document sat in the prerendered frame slot (4241)…
      const got = await claimLabels(tab, 'docA', 4241, 2);
      expect(got.filter(Boolean)).toHaveLength(2);
      // …then activated into frame 0. Same document, same docId: the confirm
      // is accepted (not rejected as another-owner) and routing follows the
      // CURRENT frame — the exact transition that used to strand the block.
      const { rejected } = await confirmLabels(tab, 'docA', 0, got);
      expect(rejected).toEqual([]);
      expect(await getFrameForLabel(tab, got[0])).toBe(0);
    });

    it('a confirm from the owning document refreshes routing on frame change', async () => {
      const tab = nextTabId();
      const [cw] = await claimLabels(tab, 'docA', 4241, 1);
      await confirmLabels(tab, 'docA', 4241, [cw]);
      expect(await getFrameForLabel(tab, cw)).toBe(4241);
      await confirmLabels(tab, 'docA', 0, [cw]); // idempotent re-confirm, new frame
      expect(await getFrameForLabel(tab, cw)).toBe(0);
    });

    it('bfcache shape: a dying document releases only ITS labels, never a same-frame sibling document', async () => {
      const tab = nextTabId();
      // Document A (restored page) holds labels in frame 0.
      const a = await claimLabels(tab, 'docA', 0, 2);
      await confirmLabels(tab, 'docA', 0, a);
      // Document B (the outgoing page) also lived in frame 0.
      const b = await claimLabels(tab, 'docB', 0, 2);
      await confirmLabels(tab, 'docB', 0, b);
      // B enters bfcache — its port disconnect releases ITS labels only.
      await releaseDocument(tab, 'docB');
      expect(await getFrameForLabel(tab, a[0])).toBe(0);  // A untouched
      expect(await getFrameForLabel(tab, b[0])).toBeNull(); // B freed
      // The freed labels are claimable again.
      const again = await claimLabels(tab, 'docC', 0, 1);
      expect(again[0]).not.toBe('');
    });

    it('discards a persisted stack with the pre-re-key numeric owner shape', async () => {
      const tab = nextTabId();
      await chrome.storage.session.set({ [`labelStack:${tab}`]: {
        free: LP.slice(2),
        reserved: { [LP[0]]: 4241 },
        assigned: { [LP[1]]: 0 },
      } });
      // The old-shape stack is dropped wholesale; a fresh pool serves claims.
      const got = await claimLabels(tab, 'docA', 0, 1);
      expect(got[0]).toBe(LP[0]); // front-of-pool of a REBUILT stack
      expect(await getFrameForLabel(tab, LP[1])).toBeNull();
    });
  });
});

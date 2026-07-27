/**
 * BranchKit Browser — label-reservoir tests.
 *
 * The reservoir is the local per-frame cache that replaces the
 * CLAIM_LABELS round-trip on the hot path. Tests pin the synchronous
 * claim/release contract, sticky reclaim, refill triggering, and clear
 * behavior.
 *
 * `chrome.runtime.sendMessage` is mocked — the reservoir treats its
 * response (`{ labels }`) as the source of fresh codewords, and a
 * rejection as "SW unreachable, stay at current depth."
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// The reservoir's DEFAULTED hooks call into the holder registry, so the
// registry is mocked to assert them without standing up real holders. Every
// other test here installs its own handler, so nothing else observes this.
// (vi.mock is hoisted above the static import below.)
//
// `heldAnywhere` joined the defaults when the leak sweep's isHeld stopped being
// injected from content.ts. It is backed by a Set the tests drive: WHICH
// holders answer is holder-registry's own test's question, and what matters
// here is that the reservoir asks the registry at all rather than waiting to be
// handed a predicate.
const registryHeld = new Set<string>();
vi.mock('./holder-registry', () => ({
  rejectAll: vi.fn(),
  heldAnywhere: (cw: string) => registryHeld.has(cw),
}));

import { labelReservoir } from './label-reservoir';
import { rejectAll } from './holder-registry';
import { setSettleEngine, _clearSettleEngineForTesting } from '../lifecycle/settle-engine-ref';

let sendMessageMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  sendMessageMock = vi.fn();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: sendMessageMock },
  };
  // Reset reservoir to a known empty state between tests.
  labelReservoir._seedForTests([]);
});

describe('LabelReservoir.claim', () => {
  it('returns codewords in queue order when seeded', () => {
    labelReservoir._seedForTests(['a', 'b', 'c', 'd']);
    expect(labelReservoir.claim(3)).toEqual(['a', 'b', 'c']);
  });

  it('returns empty strings for slots beyond available codewords', () => {
    labelReservoir._seedForTests(['only-one']);
    expect(labelReservoir.claim(3)).toEqual(['only-one', '', '']);
  });

  it('sticky reclaim: returns preferred codeword in its requested slot', () => {
    labelReservoir._seedForTests(['a', 'b', 'c', 'd']);
    // Slot 1 prefers 'c'. Sticky pass pulls 'c' into slot 1; remaining
    // slots fill front-of-pool in request order (excluding the granted
    // 'c'). So slot 0 gets 'a' (front), slot 1 gets 'c' (sticky), slot 2
    // gets 'b' (next non-granted front-of-pool).
    expect(labelReservoir.claim(3, ['', 'c', ''])).toEqual(['a', 'c', 'b']);
  });

  it('sticky reclaim falls through to fresh when preferred is not free', () => {
    labelReservoir._seedForTests(['a', 'b', 'c']);
    // 'z' isn't in the reservoir — sticky pass doesn't find it, slot
    // gets a fresh front-of-pool codeword instead.
    expect(labelReservoir.claim(1, ['z'])).toEqual(['a']);
  });

  it('returns empty array for count=0 without touching the reservoir', () => {
    labelReservoir._seedForTests(['a', 'b']);
    expect(labelReservoir.claim(0)).toEqual([]);
    // Reservoir untouched.
    expect(labelReservoir.stats().free).toBe(2);
  });

  it('depletes the reservoir as labels are claimed', () => {
    labelReservoir._seedForTests(['a', 'b', 'c']);
    labelReservoir.claim(2);
    expect(labelReservoir.stats().free).toBe(1);
  });

  it('does NOT redeal the same codeword in a single claim batch', () => {
    labelReservoir._seedForTests(['a', 'b', 'c']);
    const r = labelReservoir.claim(3, ['a', 'b', 'c']);
    expect(new Set(r).size).toBe(3); // all distinct
    // No duplicate from sticky-reclaim accidentally taking same codeword
    // for two slots.
  });
});

describe('LabelReservoir confirm exchange (Phase 4 / review bug #5)', () => {
  it('sends CONFIRM_LABELS for granted codewords as an exchange', async () => {
    labelReservoir._seedForTests(['arch bake', 'cave dove']);
    labelReservoir.onConfirmRejected(vi.fn());
    sendMessageMock.mockResolvedValue({ rejected: [] });
    labelReservoir.claim(2);
    const confirmCall = sendMessageMock.mock.calls.find(([m]) => m.type === 'CONFIRM_LABELS');
    expect(confirmCall?.[0].labels).toEqual(['arch bake', 'cave dove']);
  });

  it('purges rejected codewords and hands them to the rejection handler', async () => {
    labelReservoir._seedForTests(['arch bake', 'cave dove']);
    const handler = vi.fn();
    labelReservoir.onConfirmRejected(handler);
    sendMessageMock.mockImplementation((m: { type: string }) =>
      Promise.resolve(m.type === 'CONFIRM_LABELS' ? { rejected: ['arch bake'] } : undefined));

    labelReservoir.claim(2);
    await vi.waitFor(() => expect(handler).toHaveBeenCalledWith(['arch bake']));

    // Outstanding purged: a later refill re-issuing the rejected codeword is
    // no longer dedup-blocked (it isn't ours anymore — if the SW grants it
    // again later, that's a legitimate fresh grant). Without the purge, the
    // refill-dedup against `outstanding` would drop it and free would stay 0.
    sendMessageMock.mockImplementation((m: { type: string }) =>
      Promise.resolve(m.type === 'CLAIM_LABELS' ? { labels: ['arch bake'] } : { rejected: [] }));
    labelReservoir.claim(1); // empty reservoir → grants nothing, arms a refill
    await vi.waitFor(() => expect(labelReservoir.stats().free).toBe(1));
  });

  it('with NO handler installed, the default drops the codeword at the registry', async () => {
    // The default is what production runs — content.ts stopped injecting this
    // (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md §6a). Without this test, losing the
    // default is silent: an arbitrated-away codeword keeps its holder and the
    // frame goes on answering for a codeword another frame won.
    //
    // A pristine module instance is required. The reservoir is a module-level
    // singleton and the tests above install their own handlers on it, which
    // beforeEach does not undo — it reseeds codewords, not hooks.
    vi.resetModules();
    vi.mocked(rejectAll).mockClear();
    const { labelReservoir: fresh } = await import('./label-reservoir');

    fresh._seedForTests(['arch bake', 'cave dove']);
    sendMessageMock.mockImplementation((m: { type: string }) =>
      Promise.resolve(m.type === 'CONFIRM_LABELS' ? { rejected: ['arch bake'] } : undefined));

    fresh.claim(2);

    await vi.waitFor(() => expect(rejectAll).toHaveBeenCalledWith('arch bake'));
    // Only the rejected one — the codeword this frame kept must not be dropped.
    expect(rejectAll).toHaveBeenCalledTimes(1);
  });

  it('a rejection with no registered handler does not throw', async () => {
    labelReservoir._seedForTests(['arch bake']);
    // Simulate no handler (fresh module state would have none).
    labelReservoir.onConfirmRejected(undefined as unknown as (l: string[]) => void);
    sendMessageMock.mockResolvedValue({ rejected: ['arch bake'] });
    labelReservoir.claim(1);
    await new Promise((r) => setTimeout(r, 0)); // let the .then settle
  });

  it('a malformed / absent confirm response is ignored', async () => {
    labelReservoir._seedForTests(['arch bake']);
    const handler = vi.fn();
    labelReservoir.onConfirmRejected(handler);
    sendMessageMock.mockResolvedValue(undefined);
    labelReservoir.claim(1);
    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('LabelReservoir.release', () => {
  it('returns labels to the front of the reservoir (sticky semantics)', () => {
    labelReservoir._seedForTests(['c', 'd']);
    sendMessageMock.mockResolvedValue(undefined);
    labelReservoir.release(['a', 'b']);
    // 'a' and 'b' unshifted to front; next claim picks them up first.
    expect(labelReservoir.claim(4)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('async-notifies SW with RELEASE_LABELS', () => {
    labelReservoir._seedForTests([]);
    sendMessageMock.mockResolvedValue(undefined);
    labelReservoir.release(['x', 'y']);
    const releaseCall = sendMessageMock.mock.calls.find(
      ([m]) => m.type === 'RELEASE_LABELS',
    );
    expect(releaseCall).toBeDefined();
    expect(releaseCall![0]).toEqual({ type: 'RELEASE_LABELS', doc_id: expect.any(String), labels: ['x', 'y'] });
  });

  it('filters out empty / falsy labels from the release set', () => {
    labelReservoir._seedForTests([]);
    sendMessageMock.mockResolvedValue(undefined);
    labelReservoir.release(['', 'real', '']);
    // Only 'real' lands in the reservoir; the SW notify also only carries 'real'.
    expect(labelReservoir.stats().free).toBe(1);
    const releaseCall = sendMessageMock.mock.calls.find(([m]) => m.type === 'RELEASE_LABELS');
    expect(releaseCall![0].labels).toEqual(['real']);
  });

  it('is a no-op for an empty release set', () => {
    labelReservoir._seedForTests(['a']);
    labelReservoir.release([]);
    expect(labelReservoir.stats().free).toBe(1);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('does not throw when chrome.runtime is unavailable (orphan content script)', () => {
    (globalThis as unknown as { chrome: unknown }).chrome = undefined;
    labelReservoir._seedForTests([]);
    expect(() => labelReservoir.release(['a'])).not.toThrow();
    // Local state still updated (codeword effectively held by this
    // frame's reservoir until real teardown via port-disconnect).
    expect(labelReservoir.stats().free).toBe(1);
  });
});

describe('LabelReservoir.ensureReady', () => {
  it('skips fetch when reservoir already has codewords', async () => {
    labelReservoir._seedForTests(['a']);
    await labelReservoir.ensureReady();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it('fetches initial reservation via CLAIM_LABELS when empty', async () => {
    sendMessageMock.mockResolvedValue({ labels: ['a', 'b'] });
    await labelReservoir.ensureReady();
    const claim = sendMessageMock.mock.calls.find(([m]) => m.type === 'CLAIM_LABELS');
    expect(claim).toBeDefined();
    expect(labelReservoir.stats().free).toBeGreaterThan(0);
  });

  it('concurrent callers share the same fetch (idempotent)', async () => {
    sendMessageMock.mockResolvedValue({ labels: ['a', 'b'] });
    await Promise.all([
      labelReservoir.ensureReady(),
      labelReservoir.ensureReady(),
      labelReservoir.ensureReady(),
    ]);
    const claims = sendMessageMock.mock.calls.filter(([m]) => m.type === 'CLAIM_LABELS');
    // Exactly one fetch despite three concurrent callers.
    expect(claims).toHaveLength(1);
  });

  it('absorbs SW rejection — reservoir stays empty, doesn\'t throw', async () => {
    sendMessageMock.mockRejectedValue(new Error('SW asleep'));
    await expect(labelReservoir.ensureReady()).resolves.toBeUndefined();
    expect(labelReservoir.stats().free).toBe(0);
  });
});

// `clear()` deleted 2026-07-26: no production caller, and its doc claimed one
// ("called when the alphabet changes") that never existed — the alphabet
// handler deliberately rotates the session and re-Puts instead. These tests
// exercised only the method itself, so they went with it.

describe('LabelReservoir refill threshold', () => {
  it('triggers an async refill when claim drains the reservoir below threshold', async () => {
    // Seed below the REFILL_THRESHOLD so any claim trips the refill.
    labelReservoir._seedForTests(['a']);
    sendMessageMock.mockResolvedValue({ labels: ['b', 'c', 'd'] });
    labelReservoir.claim(1);
    // Drain remaining microtasks so the async refill IPC completes.
    await new Promise(r => setTimeout(r, 0));
    const claims = sendMessageMock.mock.calls.filter(([m]) => m.type === 'CLAIM_LABELS');
    expect(claims.length).toBeGreaterThan(0);
    // After refill, reservoir has the new codewords.
    expect(labelReservoir.stats().free).toBeGreaterThan(0);
  });

  it('does NOT trigger a second refill while one is in-flight', async () => {
    labelReservoir._seedForTests([]);
    // The mock never resolves — the in-flight promise stays pending.
    sendMessageMock.mockReturnValue(new Promise(() => {}));
    labelReservoir.claim(1); // triggers refill #1
    labelReservoir.claim(1); // should NOT trigger refill #2 (already in flight)
    labelReservoir.claim(1);
    // Allow microtasks to flush.
    await new Promise(r => setTimeout(r, 0));
    const claims = sendMessageMock.mock.calls.filter(([m]) => m.type === 'CLAIM_LABELS');
    expect(claims).toHaveLength(1);
  });
});

// The refill-landed hook had ONE caller (content.ts) and zero tests, which is
// the same shape the confirm-rejection default landed in — uncovered, and only
// mutation-testing found it. Written before that hook gets a default so the
// coverage is known to bite first.
describe('LabelReservoir refill-landed hook', () => {
  afterEach(() => {
    // null, not `() => {}` — a truthy no-op leaks into every later describe in
    // this file and would silently eat the signal for a future
    // `expect(scheduleReconcile).not.toHaveBeenCalled()`.
    labelReservoir.onRefillLanded(null as unknown as () => void);
    _clearSettleEngineForTesting();
  });

  // The DEFAULT, with no handler installed. This is the arm that landed
  // uncovered last time a hook was defaulted here — every other test in this
  // file injects its own handler, so none of them can see it.
  it('drives the settle engine when nothing overrides it', async () => {
    labelReservoir.onRefillLanded(null as unknown as () => void);
    const scheduleReconcile = vi.fn();
    setSettleEngine({ scheduleReconcile } as unknown as Parameters<typeof setSettleEngine>[0]);
    labelReservoir._seedForTests([]);
    sendMessageMock.mockResolvedValue({ labels: ['b', 'c'] });

    labelReservoir.claim(1);
    await new Promise(r => setTimeout(r, 0));

    expect(scheduleReconcile).toHaveBeenCalledTimes(1);
  });

  it('an installed handler wins over the engine', async () => {
    const landed = vi.fn();
    const scheduleReconcile = vi.fn();
    labelReservoir.onRefillLanded(landed);
    setSettleEngine({ scheduleReconcile } as unknown as Parameters<typeof setSettleEngine>[0]);
    labelReservoir._seedForTests([]);
    sendMessageMock.mockResolvedValue({ labels: ['b', 'c'] });

    labelReservoir.claim(1);
    await new Promise(r => setTimeout(r, 0));

    expect(landed).toHaveBeenCalledTimes(1);
    expect(scheduleReconcile).not.toHaveBeenCalled();
  });

  // NOT TESTED HERE, deliberately: "no engine published yet -> no-op rather
  // than throw". `notifyRefillLanded` is the last statement inside `refill`'s
  // own try/catch, so swapping its `?.` for a `!` throws, gets swallowed, and
  // leaves NO observable difference — the codewords are already pushed by then.
  // A test written against this path passes either way, which is the exact
  // shape §6b warns about, so there is no honest test to write at this seam.
  // The label-sync twin IS testable because syncNow does not swallow.
  // Worth knowing on its own: that catch would hide a genuine engine error too.

  it('fires when a refill actually adds codewords', async () => {
    const landed = vi.fn();
    labelReservoir.onRefillLanded(landed);
    labelReservoir._seedForTests([]);
    sendMessageMock.mockResolvedValue({ labels: ['b', 'c', 'd'] });

    labelReservoir.claim(1);
    await new Promise(r => setTimeout(r, 0));

    expect(landed).toHaveBeenCalledTimes(1);
  });

  // The point of the hook: a claim that ran dry left wrappers unhinted, and the
  // reconciler's own triggers are all user-activity-driven. On a static page
  // nothing would ever request the pass. But a refill that added NOTHING has
  // not unblocked anything, so firing there would be a pass for no reason.
  it('does not fire when the refill added nothing new', async () => {
    const landed = vi.fn();
    labelReservoir.onRefillLanded(landed);
    labelReservoir._seedForTests(['a']);
    sendMessageMock.mockResolvedValue({ labels: ['a'] }); // all already held

    labelReservoir.claim(1);
    await new Promise(r => setTimeout(r, 0));

    expect(landed).not.toHaveBeenCalled();
  });

  it('does not fire when the SW is unreachable', async () => {
    const landed = vi.fn();
    labelReservoir.onRefillLanded(landed);
    labelReservoir._seedForTests([]);
    sendMessageMock.mockRejectedValue(new Error('sw unreachable'));

    labelReservoir.claim(1);
    await new Promise(r => setTimeout(r, 0));

    expect(landed).not.toHaveBeenCalled();
  });
});

describe('LabelReservoir duplicate-codeword defenses', () => {
  it('refill dedups SW-returned codewords already in the reservoir', async () => {
    // Reproduces the race: a release added the codeword back locally, the
    // SW released it server-side, and the refill returns the same codeword
    // that's already in the reservoir. Pre-fix, this.free ended up with
    // a duplicate; pass 2's shift() then handed it to two wrappers.
    labelReservoir._seedForTests(['kind gust', 'b']);
    sendMessageMock.mockResolvedValue({ labels: ['kind gust', 'c', 'd'] });
    // Force a refill by claiming enough to dip below threshold.
    labelReservoir.claim(1);
    await new Promise(r => setTimeout(r, 0));
    // 'kind gust' must appear exactly once in the reservoir.
    const seedCount = sendMessageMock.mock.calls
      .filter(([m]) => m.type === 'CLAIM_LABELS').length;
    expect(seedCount).toBeGreaterThan(0);
    // Drain everything; nothing should come out as a duplicate.
    const drained: string[] = [];
    let next: string[];
    do {
      next = labelReservoir.claim(10);
      for (const l of next) if (l !== '') drained.push(l);
    } while (next.some(l => l !== ''));
    const counts = drained.reduce<Record<string, number>>((acc, l) => {
      acc[l] = (acc[l] ?? 0) + 1;
      return acc;
    }, {});
    for (const [label, n] of Object.entries(counts)) {
      expect(n, `${label} should appear exactly once`).toBe(1);
    }
  });

  it('release dedups against codewords already in the reservoir', () => {
    labelReservoir._seedForTests(['a', 'kind gust']);
    // Some path released 'kind gust' even though it's already in free.
    // Pre-fix, this.free would gain a second copy via unshift.
    labelReservoir.release(['kind gust']);
    // Drain and count.
    const drained = labelReservoir.claim(5).filter(l => l !== '');
    expect(drained.filter(l => l === 'kind gust')).toHaveLength(1);
  });

  it('release dedups within its own argument set', () => {
    // Two wrappers somehow both held the same codeword (the pre-fix
    // state) and both pushed it to pendingRelease. doFlush hands the
    // duplicated list to reservoir.release in one call. Each codeword
    // should land in the reservoir exactly once regardless.
    labelReservoir._seedForTests([]);
    labelReservoir.release(['kind gust', 'kind gust', 'other']);
    const drained = labelReservoir.claim(10).filter(l => l !== '');
    expect(drained.filter(l => l === 'kind gust')).toHaveLength(1);
    expect(drained.filter(l => l === 'other')).toHaveLength(1);
  });

  it('claim pass 2 drains in-reservoir duplicates without returning them twice', () => {
    // Simulate an existing reservoir that already contains duplicates
    // (the pre-fix steady state on a churn-heavy page). pass 2 must walk
    // past the second copy rather than handing it to two slots.
    labelReservoir._seedForTests(['kind gust', 'b', 'kind gust', 'c']);
    const result = labelReservoir.claim(3);
    expect(result.filter(l => l === 'kind gust')).toHaveLength(1);
  });
});

describe('LabelReservoir.ensureReady (Regime B preferred initial fill)', () => {
  it('threads preferred codewords into the initial CLAIM_LABELS', async () => {
    sendMessageMock.mockResolvedValue({ labels: ['gust harp', 'air ink', 'p1'] });
    await labelReservoir.ensureReady(['gust harp', 'air ink']);
    const claimCall = sendMessageMock.mock.calls.find(c => c[0]?.type === 'CLAIM_LABELS');
    expect(claimCall).toBeTruthy();
    expect(claimCall![0].preferred).toEqual(['gust harp', 'air ink']);
  });

  it('makes a remembered codeword reclaimable by a subsequent preferred claim', async () => {
    // SW granted the remembered codewords into the initial fill.
    sendMessageMock.mockResolvedValue({ labels: ['gust harp', 'air ink', 'fresh1'] });
    await labelReservoir.ensureReady(['gust harp', 'air ink']);
    // A wrapper whose fingerprint resolved to "air ink" reclaims it (pass 1).
    expect(labelReservoir.claim(1, ['air ink'])).toEqual(['air ink']);
  });

  it('omits preferred on a generic (no-arg) warm-up', async () => {
    sendMessageMock.mockResolvedValue({ labels: ['a', 'b'] });
    await labelReservoir.ensureReady();
    const claimCall = sendMessageMock.mock.calls.find(c => c[0]?.type === 'CLAIM_LABELS');
    expect(claimCall![0].preferred).toBeUndefined();
  });

  it('sizes the initial fill to the recalled set when it exceeds the default (fix A2)', async () => {
    sendMessageMock.mockResolvedValue({ labels: [] });
    const preferred = Array.from({ length: 130 }, (_, i) => 'cw' + i);
    await labelReservoir.ensureReady(preferred);
    const claimCall = sendMessageMock.mock.calls.find(c => c[0]?.type === 'CLAIM_LABELS');
    expect(claimCall![0].count).toBe(130); // not the 100 default — covers all remembered
    expect(claimCall![0].preferred).toEqual(preferred);
  });

  it('keeps the default fill size when the recalled set is small', async () => {
    sendMessageMock.mockResolvedValue({ labels: [] });
    await labelReservoir.ensureReady(['gust harp', 'air ink']);
    const claimCall = sendMessageMock.mock.calls.find(c => c[0]?.type === 'CLAIM_LABELS');
    expect(claimCall![0].count).toBe(100);
  });

  it('caps the initial fill so a pathological recall can not request unbounded', async () => {
    sendMessageMock.mockResolvedValue({ labels: [] });
    const preferred = Array.from({ length: 500 }, (_, i) => 'cw' + i);
    await labelReservoir.ensureReady(preferred);
    const claimCall = sendMessageMock.mock.calls.find(c => c[0]?.type === 'CLAIM_LABELS');
    expect(claimCall![0].count).toBe(300); // MAX_INITIAL_RESERVATION
  });
});

describe('LabelReservoir.claim — recalled reservation (A3)', () => {
  it('a fresh claim skips reserved codewords and takes a generic one', () => {
    // res* are reserved for remembered owners; gen* are generic. A fresh claim
    // (no preferred) must not consume res1 even though it's front-of-pool.
    labelReservoir._seedForTests(['res1', 'gen1', 'res2', 'gen2'], ['res1', 'res2']);
    expect(labelReservoir.claim(1)).toEqual(['gen1']);
  });

  it('two fresh claims take the generics and leave the reserved for their owners', () => {
    labelReservoir._seedForTests(['res1', 'gen1', 'res2', 'gen2'], ['res1', 'res2']);
    expect(labelReservoir.claim(2)).toEqual(['gen1', 'gen2']);
    // The remembered owners can still reclaim their letters — not stolen.
    expect(labelReservoir.claim(2, ['res1', 'res2'])).toEqual(['res1', 'res2']);
  });

  it('a preferred claim reclaims its reserved codeword and clears the reservation', () => {
    labelReservoir._seedForTests(['res1', 'gen1'], ['res1']);
    expect(labelReservoir.claim(1, ['res1'])).toEqual(['res1']);
    // res1 is now claimed, no longer reserved — a later fresh claim could use
    // gen1 (still there) without contention.
    expect(labelReservoir.claim(1)).toEqual(['gen1']);
  });

  it('falls back to a reserved codeword when generic is exhausted (no starvation)', () => {
    labelReservoir._seedForTests(['res1', 'res2'], ['res1', 'res2']);
    expect(labelReservoir.claim(1)).toEqual(['res1']); // only reserved left → take one
  });
});

describe('LabelReservoir leak sweep (2026-06-29 review: outstanding never swept)', () => {
  /** Seed, then install the sweep handler — _seedForTests clears it. */
  function seed(labels: string[]): string[] {
    const swept: string[] = [];
    labelReservoir._seedForTests(labels);
    labelReservoir.onLeakSwept((cws) => swept.push(...cws));
    return swept;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['performance'] });
    registryHeld.clear();
  });
  afterEach(() => {
    // Module-level and shared with the mock factory: a codeword left in it
    // answers "still held" in every later test (sec 6c's leaked-cooldown class).
    registryHeld.clear();
    vi.useRealTimers();
  });

  it('releases an aged outstanding codeword that no live wrapper holds', () => {
    const swept = seed(['a', 'b', 'c']);

    const [leak] = labelReservoir.claim(1);
    expect(leak).toBe('a');
    // A release-skipping teardown strips the wrapper: no holder ever takes
    // 'a', and reservoir.release() is never called.

    vi.advanceTimersByTime(31_000);
    registryHeld.add('b');
    labelReservoir.claim(1); // grants 'b'; its maybeRefill runs the sweep

    expect(swept).toEqual(['a']);
    // Healed end-to-end: back in local free (re-claimable) + SW notified.
    expect(labelReservoir.claim(1)[0]).toBe('a');
    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'RELEASE_LABELS', doc_id: expect.any(String), labels: ['a'] });
  });

  it('never sweeps a codeword a live wrapper still holds', () => {
    const swept = seed(['a', 'b']);
    registryHeld.add('a');

    labelReservoir.claim(1); // 'a', held by a wrapper (e.g. dormant/limbo)
    vi.advanceTimersByTime(120_000);
    labelReservoir.claim(1);
    expect(swept).toEqual([]);
  });

  it('never sweeps inside the claim→attach grace window', () => {
    const swept = seed(['a', 'b']);

    labelReservoir.claim(1); // 'a' granted, wrapper not in store yet
    vi.advanceTimersByTime(5_000); // < 30s grace
    labelReservoir.claim(1);
    expect(swept).toEqual([]);
  });

  // The arm the injection hid. With isHeld unset the old sweep early-returned,
  // so "nobody wired a predicate" and "the registry says nobody holds it" were
  // indistinguishable — and every test that skipped installLeakSweep was
  // silently sweep-free. Sweeping with NOTHING installed is the one observation
  // that separates a defaulted predicate from the old null one; every other
  // test in this block passes either way.
  it('sweeps with no handler installed at all — the predicate is not optional', () => {
    labelReservoir._seedForTests(['a', 'b']); // deliberately no onLeakSwept

    labelReservoir.claim(1);
    vi.advanceTimersByTime(31_000);
    labelReservoir.claim(1);

    expect(sendMessageMock).toHaveBeenCalledWith({ type: 'RELEASE_LABELS', doc_id: expect.any(String), labels: ['a'] });
    expect(labelReservoir.claim(1)[0]).toBe('a'); // reclaimable again
  });
});

describe('LabelReservoir.reconfirm (SW-restart pool re-assertion)', () => {
  it('sends CONFIRM_LABELS for held codewords and registers them outstanding', async () => {
    labelReservoir._seedForTests(['x']);
    sendMessageMock.mockResolvedValue({ rejected: [] });

    labelReservoir.reconfirm(['arch bake', 'cave dove']);
    expect(sendMessageMock).toHaveBeenCalledWith({
      type: 'CONFIRM_LABELS',
      doc_id: expect.any(String),
      labels: ['arch bake', 'cave dove'],
    });
    expect(labelReservoir.stats().outstanding).toBe(2);
  });

  it('routes rejections through the rejection handler (another frame won)', async () => {
    labelReservoir._seedForTests(['x']);
    const rejected: string[] = [];
    labelReservoir.onConfirmRejected((cws) => rejected.push(...cws));
    sendMessageMock.mockResolvedValue({ rejected: ['cave dove'] });

    labelReservoir.reconfirm(['arch bake', 'cave dove']);
    await Promise.resolve(); await Promise.resolve(); // confirm .then chain

    expect(rejected).toEqual(['cave dove']);
    expect(labelReservoir.stats().outstanding).toBe(1); // loser purged
  });

  it('empty / blank input is a no-op', () => {
    labelReservoir._seedForTests(['x']);
    labelReservoir.reconfirm(['', '']);
    expect(sendMessageMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'CONFIRM_LABELS' }),
    );
  });
});

// --- L3: poisoned-cache flush on confirm rejection ---
// DESIGN_PRERENDER_POOL_POISONING.md: purging only the rejected strings left
// the rest of a poisoned cache block to be re-granted and re-rejected round
// after round. A rejection now flushes the WHOLE unconfirmed cache back to
// the SW (owner-scoped release) and refills fresh under the current identity.
describe('confirm rejection flush (L3)', () => {
  async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setTimeout(r, 0));
  }

  it('flushes the entire unconfirmed cache, releases it, and refills', async () => {
    labelReservoir._seedForTests(['a', 'b', 'c', 'd', 'e']);
    const rejectionHandler = vi.fn();
    labelReservoir.onConfirmRejected(rejectionHandler);
    sendMessageMock.mockImplementation(async (msg: { type: string }) => {
      if (msg.type === 'CONFIRM_LABELS') return { rejected: ['a'] };
      if (msg.type === 'CLAIM_LABELS') return { labels: [] };
      return {};
    });

    labelReservoir.claim(1); // grants 'a', sends the confirm
    await flushMicrotasks();

    // The whole remaining cache (b..e) was flushed, not just 'a' purged.
    expect(labelReservoir.stats().free).toBe(0);
    const released = sendMessageMock.mock.calls.find(([m]) => m.type === 'RELEASE_LABELS');
    expect(released).toBeDefined();
    expect(released![0].labels.sort()).toEqual(['b', 'c', 'd', 'e']);
    // The content layer still gets the rejected strings to strip wrappers.
    expect(rejectionHandler).toHaveBeenCalledWith(['a']);
    // And a fresh refill was requested under the current identity.
    expect(sendMessageMock.mock.calls.some(([m]) => m.type === 'CLAIM_LABELS')).toBe(true);
  });

  it('a clean confirm (no rejections) leaves the cache untouched', async () => {
    labelReservoir._seedForTests(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j']);
    sendMessageMock.mockImplementation(async (msg: { type: string }) => {
      if (msg.type === 'CONFIRM_LABELS') return { rejected: [] };
      return {};
    });
    labelReservoir.claim(1);
    await flushMicrotasks();
    expect(labelReservoir.stats().free).toBe(9);
    expect(sendMessageMock.mock.calls.some(([m]) => m.type === 'RELEASE_LABELS')).toBe(false);
  });
});

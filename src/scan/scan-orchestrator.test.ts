/**
 * BranchKit Browser — scan-orchestrator unit tests.
 *
 * Pins the scan lock (one scan at a time; triggers during flight fold into a
 * single pending re-run), the machinery gates, the 50ms trigger coalescer,
 * and processScanBatch's ack partitioning: acked codewords markSent, failed
 * ones stay painted and queue a re-Put, and a transport failure keeps
 * wrappers attached (the badge-flash regression) while queueing Puts.
 *
 * Run: npm test
 */

// @vitest-environment happy-dom

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

type Orchestrator = typeof import('./scan-orchestrator');

const scanInBatches = vi.fn();
const claimLabels = vi.fn();
const postBatch = vi.fn();
const queuePut = vi.fn();
const queueDelete = vi.fn();
const markSent = vi.fn();
const attachWrapper = vi.fn();
const detachWrapper = vi.fn();
const reconcile = vi.fn();
const timeouts: Array<{ fn: () => void; ms: number }> = [];

const fakeSession = {
  hintMachineryEnabled: true,
  suspended: false,
  badgesVisible: true,
  engine: { reconcile },
  resources: { timeout: (fn: () => void, ms: number) => { timeouts.push({ fn, ms }); return 1 as never; } },
};

const storeWrappers = new Map<Element, unknown>();

async function loadOrchestrator(): Promise<Orchestrator> {
  vi.resetModules();
  vi.doMock('./scanner', () => ({ scanInBatches, DEFAULT_SCAN_BATCH_SIZE: 15 }));
  vi.doMock('./batch-dedup', () => ({
    filterNewBatchRefs: (refs: Element[], elements: unknown[]) => ({ newRefs: refs, newElements: elements }),
  }));
  vi.doMock('./registry', () => ({ get: () => undefined, computeFingerprint: () => null }));
  vi.doMock('../core/store', () => ({
    store: {
      findWrapperFor: (el: Element) => storeWrappers.get(el),
      get all() { return [...storeWrappers.values()]; },
    },
  }));
  vi.doMock('../core/wrapper-lifecycle', () => ({
    attachWrapper: attachWrapper.mockImplementation((w: { element: Element }) => { storeWrappers.set(w.element, w); }),
    detachWrapper,
  }));
  vi.doMock('../observe/limbo', () => ({ dropDisconnectedWrappers: vi.fn() }));
  vi.doMock('../observe/visibility-tracker', () => ({ observeInvisibleCandidates: vi.fn() }));
  vi.doMock('../lifecycle/strict-viewport', () => ({ stampStrictViewport: vi.fn() }));
  vi.doMock('../lifecycle/page-session', () => ({ pageSession: fakeSession, yieldTask: async () => {} }));
  vi.doMock('../adapters', () => ({ getActiveAdapter: () => null }));
  vi.doMock('../rules/rule-apply', () => ({ getCompiledRule: () => null, applyUserRuleToScan: vi.fn() }));
  vi.doMock('../rules/domain-rules', () => ({ applyExclusions: vi.fn(), collectInclusions: vi.fn() }));
  vi.doMock('../labels/codeword-recall', () => ({
    isRecallLoaded: () => false, resolvePreferredCodeword: () => null, rememberClaimedCodewords: vi.fn(),
  }));
  vi.doMock('../labels/label-sync', () => ({
    queuePut, queueDelete, markSent,
    hasPendingDeletes: () => false, drainPendingDeletes: () => [],
    getSessionId: () => 's1', claimLabels, postBatch,
  }));
  vi.doMock('../debug/perf-counters', () => ({
    recordCpu: vi.fn(), claimCounters: { scanPathClaimed: 0, trackerPathClaimed: 0 },
  }));
  vi.doMock('../config', () => ({ getHintVisibility: () => 'always' }));
  return await import('./scan-orchestrator');
}

/**
 * The REAL holder registry (not a mock), resolved from the same module graph
 * the freshly-imported orchestrator got. Must be called after
 * loadOrchestrator: vi.resetModules() runs in there, so importing before it
 * would hand back a different registry instance than the one under test.
 */
async function loadHolderRegistry(): Promise<typeof import('../labels/holder-registry')> {
  return await import('../labels/holder-registry');
}

function batchOf(els: Element[], isLast = true) {
  return {
    refs: els,
    elements: els.map(() => ({ codeword: '', id: 0, in_strict_viewport: false })),
    isLast,
    invisibleCandidates: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  timeouts.length = 0;
  storeWrappers.clear();
  fakeSession.hintMachineryEnabled = true;
  fakeSession.suspended = false;
  fakeSession.badgesVisible = true;
  claimLabels.mockImplementation(async (n: number) => Array.from({ length: n }, (_, i) => 'abc'[i] ?? 'z'));
  postBatch.mockResolvedValue({ result: 'ok', succeeded: [], failed: [] });
  scanInBatches.mockImplementation(function* () {
    yield batchOf([document.createElement('a')]);
  });
});

afterEach(() => {
  vi.resetModules();
});

describe('doScan gating and the scan lock', () => {
  it('no-ops while the machinery is disabled or suspended', async () => {
    const o = await loadOrchestrator();
    fakeSession.hintMachineryEnabled = false;
    await o.doScan();
    fakeSession.hintMachineryEnabled = true;
    fakeSession.suspended = true;
    await o.doScan();
    expect(scanInBatches).not.toHaveBeenCalled();
  });

  it('folds triggers that arrive during a scan into one pending re-run', async () => {
    const o = await loadOrchestrator();
    let release!: (v: string[]) => void;
    claimLabels.mockImplementationOnce(() => new Promise((r) => { release = r; }));
    const first = o.doScan();
    await new Promise((r) => setTimeout(r, 0)); // let the first scan reach the claim
    void o.doScan(); // during flight → pending
    void o.doScan(); // folds into the same pending slot
    release(['a']);
    await first;
    await new Promise((r) => setTimeout(r, 10));
    expect(scanInBatches).toHaveBeenCalledTimes(2); // first run + ONE folded re-run
  });
});

describe('scheduleDoScan', () => {
  it('coalesces multiple triggers into one deferred doScan', async () => {
    const o = await loadOrchestrator();
    o.scheduleDoScan();
    o.scheduleDoScan();
    o.scheduleDoScan();
    expect(timeouts).toHaveLength(1);
    expect(timeouts[0].ms).toBe(50);
    timeouts[0].fn();
    await new Promise((r) => setTimeout(r, 10));
    expect(scanInBatches).toHaveBeenCalledTimes(1);
  });
});

describe('batch processing', () => {
  it('claims, attaches, paints, and POSTs the batch; acked codewords markSent', async () => {
    const o = await loadOrchestrator();
    postBatch.mockResolvedValue({ result: 'ok', succeeded: ['a'], failed: [] });
    const el = document.createElement('a');
    document.body.appendChild(el);
    scanInBatches.mockImplementation(function* () { yield batchOf([el]); });
    await o.doScan();
    expect(attachWrapper).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalled(); // paint fired pre-POST (badgesVisible)
    expect(postBatch).toHaveBeenCalledTimes(1);
    expect(postBatch.mock.calls[0][0]).toMatchObject({ is_final: true, kind: 'scan' });
    expect(markSent).toHaveBeenCalledWith('a');
    expect(queuePut).not.toHaveBeenCalled();
    expect(detachWrapper).not.toHaveBeenCalled();
  });

  it('an unacked codeword stays painted and queues a re-Put', async () => {
    const o = await loadOrchestrator();
    postBatch.mockResolvedValue({ result: 'ok', succeeded: [], failed: [{ codeword: 'a', reason: 'x' }] });
    const el = document.createElement('a');
    document.body.appendChild(el);
    scanInBatches.mockImplementation(function* () { yield batchOf([el]); });
    await o.doScan();
    expect(queuePut).toHaveBeenCalledTimes(1);
    expect(markSent).not.toHaveBeenCalled();
    expect(detachWrapper).not.toHaveBeenCalled(); // keep painted
  });

  it('a transport failure keeps wrappers attached and queues Puts (no badge flash)', async () => {
    const o = await loadOrchestrator();
    postBatch.mockResolvedValue({ result: 'error', succeeded: [], failed: [] });
    const el = document.createElement('a');
    document.body.appendChild(el);
    scanInBatches.mockImplementation(function* () { yield batchOf([el]); });
    await o.doScan();
    expect(detachWrapper).not.toHaveBeenCalled();
    expect(queuePut).toHaveBeenCalledTimes(1);
  });

  // The mid-flight branch: the wrapper left the store between the POST and its
  // ACK, so the plugin holds a codeword no wrapper does. Whether that codeword
  // is garbage depends on who picked it up in the meantime — and the store is
  // not the only thing that can (labels/holder-registry.ts).
  describe('a codeword whose wrapper detached mid-flight', () => {
    async function detachDuringPost(): Promise<Orchestrator> {
      const o = await loadOrchestrator();
      const el = document.createElement('a');
      document.body.appendChild(el);
      scanInBatches.mockImplementation(function* () { yield batchOf([el]); });
      postBatch.mockImplementation(async () => {
        // Detached mid-round-trip (MO removal / dedup by a later scan), which
        // released its label back to the reservoir.
        storeWrappers.clear();
        return { result: 'ok', succeeded: ['a'], failed: [] };
      });
      return o;
    }

    it('is queued for delete when nothing holds it', async () => {
      const o = await detachDuringPost();
      await o.doScan();
      expect(queueDelete).toHaveBeenCalledWith('a');
    });

    it('is NOT queued for delete when a non-store holder reclaimed it', async () => {
      const o = await detachDuringPost();
      const reg = await loadHolderRegistry();
      // Stand-in for a RangeBadgeSet (pick chips / search badges): the
      // reservoir's sticky reclaim hands a just-released codeword back from the
      // FRONT of the queue, so this is the codeword it lands on. Deleting it
      // here retires the grammar record of a live, painted chip — speakable
      // nowhere, and an empty Discovery HUD suffix menu.
      reg.__resetHolderRegistry();
      const unregister = reg.registerHolder({
        id: 'reclaimer', priority: 100, claim: 'additive',
        held: () => ['a'],
        republish: () => {},
        onCodewordRejected: () => {},
        matchesPrefix: () => false,
        narrow: () => {},
        resolve: () => 'not_mine',
        soleMatch: () => null,
        relabel: () => {},
        reconcile: () => {},
        dispose: () => {},
      });
      await o.doScan();
      expect(queueDelete).not.toHaveBeenCalled();
      unregister();
    });
  });

  it('skips painting when badges are hidden (manual mode pre-show)', async () => {
    const o = await loadOrchestrator();
    fakeSession.badgesVisible = false;
    await o.doScan();
    expect(reconcile).not.toHaveBeenCalled();
  });
});

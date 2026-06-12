/**
 * BranchKit Browser — delta-sync refusal handling.
 *
 * Pins the wholesale-refusal recovery in syncNow: when the plugin answers
 * `calibration_active` (received, applied nothing, no per-codeword verdicts),
 * the drained puts/deletes must be restored and retried — pre-fix they
 * silently vanished, leaving painted badges permanently unmatchable.
 *
 * Run: npm test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { setAlphabet } from './words';
import {
  initLabelSync,
  queuePut,
  queueDelete,
  markSent,
  hasSent,
  hasPendingDeletes,
  rotateSession,
  syncNow,
} from './label-sync';

const ALPHABET = [
  'arch', 'bake', 'cave', 'dove', 'echo', 'fern', 'gulf', 'harp', 'iris',
  'jade', 'kelp', 'lime', 'mint', 'nova', 'opal', 'pine', 'quay', 'rune',
  'sage', 'tarp', 'urn', 'vine', 'wisp', 'xray', 'yarn', 'zinc',
];

type Resp = {
  result: string;
  succeeded: string[];
  failed: { codeword: string; reason: string }[];
};
// Sentinel: the mock rejects this GRAMMAR_BATCH send (SW unreachable).
const REJECT = 'REJECT' as const;

const calibrationActive = (): Resp => ({ result: 'calibration_active', succeeded: [], failed: [] });
const ok = (succeeded: string[]): Resp => ({ result: 'ok', succeeded, failed: [] });

function makeWrapper(codeword: string, store: WrapperStore): ElementWrapper {
  const el = document.createElement('a');
  document.body.appendChild(el);
  const scanned: ScannedElement = {
    label: 'x', id: 1, category: 'link', type: 'link', adapter: null, codeword,
  };
  const w = new ElementWrapper(el, scanned);
  store.addWrapper(w);
  return w;
}

describe('syncNow wholesale refusal (calibration_active)', () => {
  let store: WrapperStore;
  let sendMessage: ReturnType<typeof vi.fn>;
  // Responses for GRAMMAR_BATCH messages only — bkLog and friends also route
  // through chrome.runtime.sendMessage and must not consume these.
  let batchResponses: (Resp | typeof REJECT)[];

  const batchCalls = () =>
    sendMessage.mock.calls.filter((c) => c[0]?.type === 'GRAMMAR_BATCH');

  beforeEach(() => {
    vi.useFakeTimers();
    setAlphabet(ALPHABET);
    store = new WrapperStore();
    batchResponses = [];
    sendMessage = vi.fn((msg: { type: string }) => {
      if (msg.type !== 'GRAMMAR_BATCH') return Promise.resolve(undefined);
      const r = batchResponses.length > 1 ? batchResponses.shift()! : batchResponses[0];
      if (r === REJECT) return Promise.reject(new Error('sw unreachable'));
      return Promise.resolve(r);
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    initLabelSync({
      store,
      detachWrapper: vi.fn(),
      reconcile: vi.fn(),
      isHintsVisible: () => false,
    });
    // Clear module-level delta-sync state from prior tests.
    rotateSession();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function runSync(): Promise<void> {
    const p = syncNow('test');
    // Flush the chunk loop's setTimeout(0) yields under fake timers.
    await vi.advanceTimersByTimeAsync(10);
    await p;
  }

  it('re-queues drained puts and retries once calibration releases', async () => {
    const w = makeWrapper('arch', store);
    queuePut(w);
    batchResponses = [calibrationActive(), ok(['arch'])];

    await runSync();
    expect(batchCalls()).toHaveLength(1);
    expect(w.grammarReady).toBe(false);

    // Refusal retry (2s) → scheduleSync debounce (80ms) → second POST succeeds.
    await vi.advanceTimersByTimeAsync(2200);
    expect(batchCalls()).toHaveLength(2);
    const second = batchCalls()[1][0].request;
    expect(second.elements.map((e: ScannedElement) => e.codeword)).toContain('arch');
    expect(w.grammarReady).toBe(true);
  });

  it('restores pending deletes refused by the pure-delete path', async () => {
    markSent('zinc');
    queueDelete('zinc');
    batchResponses = [calibrationActive(), ok([])];

    await runSync();
    // Refused: the delete must be back in the queue, still marked sent.
    expect(hasPendingDeletes()).toBe(true);
    expect(hasSent('zinc')).toBe(true);

    await vi.advanceTimersByTimeAsync(2200);
    expect(batchCalls()).toHaveLength(2);
    expect(hasPendingDeletes()).toBe(false);
    expect(hasSent('zinc')).toBe(false);
  });

  it('does not double-restore deletes on a transport failure', async () => {
    // SW unreachable on a pure-delete sync: postBatch restores the drained
    // deletes itself and synthesizes result:'error' with empty failed (no
    // elements). The refusal path must NOT fire — pre-fix it restored the
    // deletes a second time and armed the 2s retry, doubling the queue on
    // every attempt while the SW was down.
    markSent('zinc');
    queueDelete('zinc');
    batchResponses = [REJECT, ok([])];

    await runSync();
    expect(hasPendingDeletes()).toBe(true);
    // No refusal retry armed for a transport failure.
    await vi.advanceTimersByTimeAsync(5000);
    expect(batchCalls()).toHaveLength(1);

    // The next natural sync carries the delete exactly once.
    await runSync();
    expect(batchCalls()).toHaveLength(2);
    const second = batchCalls()[1][0].request;
    expect(second.delete_codewords).toEqual(['zinc']);
    expect(hasPendingDeletes()).toBe(false);
  });

  it('does not schedule a retry on a successful push', async () => {
    const w = makeWrapper('bake', store);
    queuePut(w);
    batchResponses = [ok(['bake'])];

    await runSync();
    expect(batchCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(batchCalls()).toHaveLength(1);
  });
});

// --- Grammar epoch tripwire (Phase 2a of DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md) ---

import { grammarEpochStats } from './label-sync';
import { epochHashOf } from './grammar-epoch';

describe('grammar epoch tripwire (detect-only)', () => {
  let store: WrapperStore;
  let sendMessage: ReturnType<typeof vi.fn>;
  let nextResp: Resp & { epoch?: { count: number; hash: string } };

  beforeEach(() => {
    // Real timers: the success path's chunk loop awaits a setTimeout(0)
    // yield, which never fires under fake timers (the refusal suite above
    // returns before reaching it).
    setAlphabet(ALPHABET);
    store = new WrapperStore();
    sendMessage = vi.fn((msg: { type: string }) => {
      if (msg.type !== 'GRAMMAR_BATCH') return Promise.resolve(undefined);
      return Promise.resolve(nextResp);
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    initLabelSync({
      store,
      detachWrapper: vi.fn(),
      reconcile: vi.fn(),
      isHintsVisible: () => false,
    });
    rotateSession(); // clear sentCodewords between tests
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('matching epoch on the final chunk passes silently', async () => {
    const w = makeWrapper('arch', store);
    queuePut(w);
    nextResp = { ...ok(['arch']), epoch: { count: 1, hash: epochHashOf(['arch']) } };
    const before = grammarEpochStats();
    await syncNow('test');
    const after = grammarEpochStats();
    expect(after.checks).toBe(before.checks + 1);
    expect(after.mismatches).toBe(before.mismatches);
  });

  it('diverged epoch records a mismatch with both views, and does NOT republish', async () => {
    const w = makeWrapper('bake', store);
    queuePut(w);
    // Plugin claims a different membership than the shadow will hold.
    nextResp = { ...ok(['bake']), epoch: { count: 3, hash: 'deadbeefdeadbeef' } };
    const before = grammarEpochStats();
    await syncNow('test');
    const after = grammarEpochStats();
    expect(after.mismatches).toBe(before.mismatches + 1);
    expect(after.lastMismatch?.pluginCount).toBe(3);
    expect(after.lastMismatch?.shadowCount).toBe(1);
    expect(after.lastMismatch?.shadowHash).toBe(epochHashOf(['bake']));
    // Detect-only: exactly the sync's own batch posts — no republish storm.
    const batchPosts = sendMessage.mock.calls.filter((c) => c[0]?.type === 'GRAMMAR_BATCH');
    expect(batchPosts.length).toBe(1);
  });

  it('absent epoch (old plugin build / refusal) skips the check entirely', async () => {
    const w = makeWrapper('cave', store);
    queuePut(w);
    nextResp = ok(['cave']);
    const before = grammarEpochStats();
    await syncNow('test');
    expect(grammarEpochStats().checks).toBe(before.checks);
  });
});

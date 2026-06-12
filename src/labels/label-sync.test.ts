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
      republishAll: vi.fn(),
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

// --- Grammar epoch handshake (Phases 2a+2b of DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md) ---

import { grammarEpochStats, resetGrammarEpochActForTest } from './label-sync';
import { epochHashOf } from './grammar-epoch';

describe('grammar epoch handshake', () => {
  let store: WrapperStore;
  let sendMessage: ReturnType<typeof vi.fn>;
  let republishAll: ReturnType<typeof vi.fn<(reason: string) => void>>;
  let nextResp: Resp & { epoch?: { count: number; hash: string } };

  beforeEach(() => {
    // Real timers: the success path's chunk loop awaits a setTimeout(0)
    // yield, which never fires under fake timers (the refusal suite above
    // returns before reaching it).
    setAlphabet(ALPHABET);
    store = new WrapperStore();
    republishAll = vi.fn<(reason: string) => void>();
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
      republishAll,
    });
    rotateSession(); // clear sentCodewords between tests
    resetGrammarEpochActForTest();
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
    expect(republishAll).not.toHaveBeenCalled();
  });

  it('diverged epoch records a mismatch with both views and fires the epoch_mismatch republish', async () => {
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
    // Phase 2b: the mismatch acts — exactly one republish, via the dep.
    expect(republishAll).toHaveBeenCalledTimes(1);
    expect(republishAll).toHaveBeenCalledWith('epoch_mismatch');
    expect(after.republishes).toBe(1);
  });

  it('a second mismatch inside the cooldown window does not republish again', async () => {
    const w = makeWrapper('dove', store);
    queuePut(w);
    nextResp = { ...ok(['dove']), epoch: { count: 9, hash: 'deadbeefdeadbeef' } };
    await syncNow('test');
    expect(republishAll).toHaveBeenCalledTimes(1);

    const w2 = makeWrapper('echo', store);
    queuePut(w2);
    nextResp = { ...ok(['echo']), epoch: { count: 9, hash: 'deadbeefdeadbeef' } };
    await syncNow('test');
    // Mismatch still recorded, but the act is cooldown-suppressed.
    expect(grammarEpochStats().mismatches).toBe(2);
    expect(republishAll).toHaveBeenCalledTimes(1);
  });

  it('absent epoch (old plugin build / refusal) skips the check entirely', async () => {
    const w = makeWrapper('cave', store);
    queuePut(w);
    nextResp = ok(['cave']);
    const before = grammarEpochStats();
    await syncNow('test');
    expect(grammarEpochStats().checks).toBe(before.checks);
    expect(republishAll).not.toHaveBeenCalled();
  });
});

describe('grammar epoch 2b loop guards (cap + reset)', () => {
  // Fake timers INCLUDING performance: the cooldown stamps performance.now(),
  // and the cap requires the cooldown to elapse between acts.
  let store: WrapperStore;
  let sendMessage: ReturnType<typeof vi.fn>;
  let republishAll: ReturnType<typeof vi.fn<(reason: string) => void>>;
  let nextResp: Resp & { epoch?: { count: number; hash: string } };
  const sent: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    setAlphabet(ALPHABET);
    store = new WrapperStore();
    sent.length = 0;
    republishAll = vi.fn<(reason: string) => void>();
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
      republishAll,
    });
    rotateSession();
    resetGrammarEpochActForTest();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  // One sync round: put a fresh codeword; the plugin answers ok + the given
  // epoch (lazy — evaluated AFTER this round's codeword joins `sent`, so a
  // clean epoch reflects the post-batch shadow). Advances past the chunk
  // loop's setTimeout(0) yield.
  async function syncRound(codeword: string, epoch: () => { count: number; hash: string }): Promise<void> {
    const w = makeWrapper(codeword, store);
    queuePut(w);
    sent.push(codeword);
    nextResp = { ...ok([codeword]), epoch: epoch() };
    const p = syncNow('test');
    await vi.advanceTimersByTimeAsync(10);
    await p;
  }

  const MISMATCH = () => ({ count: 999, hash: 'deadbeefdeadbeef' });
  const cleanEpoch = () => ({ count: sent.length, hash: epochHashOf(sent) });

  it('caps consecutive republishes, goes loud, and resets on a clean check', async () => {
    // Three mismatches, each past the 5s cooldown → three republishes.
    await syncRound('arch', MISMATCH);
    await vi.advanceTimersByTimeAsync(6000);
    await syncRound('bake', MISMATCH);
    await vi.advanceTimersByTimeAsync(6000);
    await syncRound('cave', MISMATCH);
    expect(republishAll).toHaveBeenCalledTimes(3);
    expect(grammarEpochStats().capExhausted).toBe(false);

    // Fourth consecutive mismatch: cap trips — no act, loud flag.
    await vi.advanceTimersByTimeAsync(6000);
    await syncRound('dove', MISMATCH);
    expect(republishAll).toHaveBeenCalledTimes(3);
    expect(grammarEpochStats().capExhausted).toBe(true);

    // Still detect-only while capped.
    await vi.advanceTimersByTimeAsync(6000);
    await syncRound('echo', MISMATCH);
    expect(republishAll).toHaveBeenCalledTimes(3);
    expect(grammarEpochStats().mismatches).toBe(5);

    // A clean check clears the cap...
    await vi.advanceTimersByTimeAsync(6000);
    await syncRound('fern', cleanEpoch);
    expect(grammarEpochStats().capExhausted).toBe(false);

    // ...and the next mismatch acts again.
    await vi.advanceTimersByTimeAsync(6000);
    await syncRound('gulf', MISMATCH);
    expect(republishAll).toHaveBeenCalledTimes(4);
  });
});

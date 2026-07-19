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
  scheduleSync,
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
      isBadgesVisible: () => false,
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

describe('pipelined delete accounting (audit 2026-07-04)', () => {
  // Deletes queued while a pipeline's chunks round-trip used to be drained
  // ambiently by whichever POST fired next — a parallel middle chunk with no
  // accounting. Applied deletes then stayed in sentCodewords (epoch mismatch
  // → spurious full republish); refused ones vanished with both sides
  // agreeing on the wrong state. Now deletes ride only the ordered posts
  // (chunk 0 / final chunk) and postBatch settles them uniformly.
  let store: WrapperStore;
  let sendMessage: ReturnType<typeof vi.fn>;
  let onBatch: ((req: { batch_index: number }) => void) | null;

  const batchCalls = () =>
    sendMessage.mock.calls.filter((c) => c[0]?.type === 'GRAMMAR_BATCH');

  beforeEach(() => {
    setAlphabet(ALPHABET);
    store = new WrapperStore();
    onBatch = null;
    sendMessage = vi.fn((msg: { type: string; request?: { batch_index: number; elements: ScannedElement[] } }) => {
      if (msg.type !== 'GRAMMAR_BATCH') return Promise.resolve(undefined);
      onBatch?.(msg.request!);
      return Promise.resolve(ok(msg.request!.elements.map((e) => e.codeword)));
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    initLabelSync({
      store,
      detachWrapper: vi.fn(),
      reconcile: vi.fn(),
      isBadgesVisible: () => false,
    });
    rotateSession();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('a delete queued mid-pipeline rides the FINAL chunk and settles the shadow', async () => {
    // 16 puts → two chunks (batch size 15): chunk 0 awaited, then the final.
    markSent('zinc');
    for (let i = 0; i < 16; i++) queuePut(makeWrapper(ALPHABET[i], store));
    onBatch = (req) => {
      // Fires at chunk 0's POST — the delete lands while it round-trips,
      // after postChunk(0) already drained the (empty) queue.
      if (req.batch_index === 0) queueDelete('zinc');
    };

    await syncNow('test');

    const calls = batchCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0][0].request.delete_codewords).toBeUndefined();
    expect(calls[1][0].request.is_final).toBe(true);
    expect(calls[1][0].request.delete_codewords).toEqual(['zinc']);
    expect(hasSent('zinc')).toBe(false); // settled, not stranded in the shadow
    expect(hasPendingDeletes()).toBe(false);
  });

  it('concurrent syncNow coalesces into the running flight plus one re-run', async () => {
    // Overlapping pipelines raced pipeline B's chunk-0 deletes against
    // pipeline A's in-flight Puts through independent fetches. Single-flight:
    // the second call returns the same promise and its delta ships in one
    // trailing re-run after the first pipeline fully settles.
    let releaseFirst!: () => void;
    const gate = new Promise<void>((r) => { releaseFirst = r; });
    let firstCall = true;
    sendMessage.mockImplementation(async (msg: { type: string; request?: { elements: ScannedElement[] } }) => {
      if (msg.type !== 'GRAMMAR_BATCH') return undefined;
      if (firstCall) { firstCall = false; await gate; }
      return ok(msg.request!.elements.map((e) => e.codeword));
    });

    queuePut(makeWrapper('arch', store));
    const p1 = syncNow('first');
    queuePut(makeWrapper('bake', store));
    const p2 = syncNow('second');
    expect(p2).toBe(p1); // coalesced, not a parallel pipeline
    expect(batchCalls()).toHaveLength(1); // second flight NOT dispatched yet

    releaseFirst();
    await p1;

    const calls = batchCalls();
    expect(calls).toHaveLength(2);
    expect(calls[0][0].request.elements.map((e: ScannedElement) => e.codeword)).toEqual(['arch']);
    expect(calls[1][0].request.elements.map((e: ScannedElement) => e.codeword)).toEqual(['bake']);
    expect(hasSent('arch')).toBe(true);
    expect(hasSent('bake')).toBe(true);
  });
});

describe('syncNow transport failure keeps wrappers (BranchKit down)', () => {
  // The flash-loop bug (2026-07-06): with a persisted voice alphabet and the
  // host down, every GRAMMAR_BATCH came back as the SW's synthetic
  // result:'error' with all elements in `failed` — and the per-codeword
  // failure path detached every freshly painted wrapper. The reconcile/MO
  // machinery then rediscovered the bare elements, repainted, failed again:
  // visible badge flashing whenever BranchKit was closed. Transport failure
  // now keeps the wrappers painted and re-queues their puts; only a genuine
  // plugin response may detach.
  let store: WrapperStore;
  let sendMessage: ReturnType<typeof vi.fn>;
  let detachWrapper: ReturnType<typeof vi.fn<(element: Element) => void>>;
  // Scripted per-batch behavior; the last entry repeats. 'echo' answers ok
  // with every requested codeword.
  let script: ('error' | 'reject' | 'echo')[];

  const batchCalls = () =>
    sendMessage.mock.calls.filter((c) => c[0]?.type === 'GRAMMAR_BATCH');

  beforeEach(() => {
    vi.useFakeTimers();
    setAlphabet(ALPHABET);
    store = new WrapperStore();
    script = [];
    detachWrapper = vi.fn<(element: Element) => void>();
    sendMessage = vi.fn((msg: { type: string; request?: { elements: ScannedElement[] } }) => {
      if (msg.type !== 'GRAMMAR_BATCH') return Promise.resolve(undefined);
      const step = script.length > 1 ? script.shift()! : script[0];
      if (step === 'reject') return Promise.reject(new Error('sw unreachable'));
      if (step === 'error') {
        // The SW's transportFailure shape: synthetic result:'error' with
        // every element in failed, reason 'transport'.
        return Promise.resolve({
          result: 'error',
          succeeded: [],
          failed: msg.request!.elements.map((e) => ({ codeword: e.codeword, reason: 'transport' })),
        });
      }
      return Promise.resolve(ok(msg.request!.elements.map((e) => e.codeword)));
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    initLabelSync({
      store,
      detachWrapper,
      reconcile: vi.fn(),
      isBadgesVisible: () => false,
    });
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

  it('does not detach on the SW transportFailure response; the put re-queues and ships on the next sync', async () => {
    const w = makeWrapper('arch', store);
    queuePut(w);
    script = ['error', 'echo'];

    await runSync();
    expect(batchCalls()).toHaveLength(1);
    expect(detachWrapper).not.toHaveBeenCalled();
    expect(w.grammarReady).toBe(false);
    expect(hasSent('arch')).toBe(false);

    // No retry timer for transport failures (it would hammer forever while
    // BranchKit stays closed) — the put waits for the next churn-driven sync
    // or the reconnect reactivate.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(batchCalls()).toHaveLength(1);

    await runSync();
    expect(batchCalls()).toHaveLength(2);
    const second = batchCalls()[1][0].request;
    expect(second.elements.map((e: ScannedElement) => e.codeword)).toContain('arch');
    expect(w.grammarReady).toBe(true);
    expect(hasSent('arch')).toBe(true);
  });

  it('a sendMessage rejection (SW restarting) behaves the same', async () => {
    const w = makeWrapper('bake', store);
    queuePut(w);
    script = ['reject', 'echo'];

    await runSync();
    expect(detachWrapper).not.toHaveBeenCalled();
    expect(w.grammarReady).toBe(false);

    await runSync();
    expect(w.grammarReady).toBe(true);
  });

  it('a chunk-0 transport failure halts the pipeline and re-queues the undispatched chunks too', async () => {
    // 16 puts → two chunks (batch size 15). Chunk 0 fails on transport, so
    // the final chunk never dispatches — its puts were drained at the top of
    // the sync and no handleResponse will re-queue them. Pre-fix they
    // silently vanished from the delta (painted badges unmatchable until an
    // unrelated rotation).
    const wrappers = ALPHABET.slice(0, 16).map((cw) => {
      const w = makeWrapper(cw, store);
      queuePut(w);
      return w;
    });
    script = ['error', 'echo'];

    await runSync();
    expect(batchCalls()).toHaveLength(1); // halted after chunk 0
    expect(detachWrapper).not.toHaveBeenCalled();

    await runSync();
    const resent = batchCalls().slice(1).flatMap(
      (c) => c[0].request.elements.map((e: ScannedElement) => e.codeword));
    expect(new Set(resent)).toEqual(new Set(ALPHABET.slice(0, 16)));
    for (const w of wrappers) expect(w.grammarReady).toBe(true);
  });
});

// --- Grammar epoch handshake (Phases 2a+2b of DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md) ---

describe('scheduleSync debounce + max-wait deadline (round 22c)', () => {
  // A pure trailing debounce starves under sustained churn: during a fling,
  // claims and strict deltas reset the 80ms timer continuously and the sync
  // never fired for the whole scroll+swap window (sync_trace: a 5.5s hole,
  // then a 355-delete monster delta, session rotation, full republish —
  // badges translucent 13s+). The deadline caps the stall at 400ms.
  let store: WrapperStore;
  let sendMessage: ReturnType<typeof vi.fn>;

  const batchCalls = () =>
    sendMessage.mock.calls.filter((c) => c[0]?.type === 'GRAMMAR_BATCH');

  beforeEach(() => {
    vi.useFakeTimers();
    setAlphabet(ALPHABET);
    store = new WrapperStore();
    sendMessage = vi.fn((msg: { type: string }) => {
      if (msg.type !== 'GRAMMAR_BATCH') return Promise.resolve(undefined);
      return Promise.resolve(ok(['arch']));
    });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    initLabelSync({
      store,
      detachWrapper: vi.fn(),
      reconcile: vi.fn(),
      isBadgesVisible: () => false,
    });
    rotateSession();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('a quiet burst fires once at the trailing debounce, and the deadline does not double-fire', async () => {
    const w = makeWrapper('arch', store);
    queuePut(w);
    scheduleSync('quiet');
    await vi.advanceTimersByTimeAsync(100); // trailing 80ms fires
    expect(batchCalls()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000); // past the deadline — cleared by the fire
    expect(batchCalls()).toHaveLength(1);
  });

  it('sustained sub-debounce churn ships via the deadline instead of starving', async () => {
    const w = makeWrapper('arch', store);
    queuePut(w);
    // Storm: a scheduleSync every 50ms for 2s — the trailing 80ms debounce
    // alone would never fire.
    for (let i = 0; i < 8; i++) {
      scheduleSync('storm');
      await vi.advanceTimersByTimeAsync(50);
    }
    // 400ms in: the non-extending deadline must have shipped the delta.
    expect(batchCalls().length).toBeGreaterThanOrEqual(1);
  });
});

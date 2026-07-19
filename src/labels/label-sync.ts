/**
 * BranchKit Browser — LabelStage: codeword claim/release batching + grammar sync.
 *
 * Owns the delta-sync state machine that keeps the plugin's per-frame
 * grammar in step with this content script's live wrappers. The CS owns
 * truth; the plugin is a derived cache. Three pieces of state let each
 * flush send only what changed since the last successful push:
 *
 *   sentCodewords: codewords currently live on the plugin side. Lets us
 *     distinguish "real delete" (was Put, now gone — send Delete) from
 *     "never sent" (claimed and released within one debounce window —
 *     don't send anything). Cleared on session_id rotation since the
 *     plugin clears its own session state on the same event.
 *
 *   pendingPuts: wrappers whose codeword exists locally but hasn't been
 *     Put to the plugin yet. Populated by IT.onCodewordsChanged
 *     (newly-claimed) and by the scan path (after attach + push). Drained
 *     each batchedStateSync.
 *
 *   pendingDeleteCodewords: codewords queued for plugin-side delete.
 *     Populated by IT viewport-leave releases, detachWrapper, and the
 *     post-batch isConnected sweep (item 5 RED).
 *
 * Two paths feed the per-batch grammar POST:
 *   - The scan path (content.ts doScanBatched/processScanBatch) claims
 *     codewords inline and POSTs each batch via claimLabels + postBatch.
 *   - batchedStateSync: IT- and MO-driven catchup. Collects pendingPuts
 *     and re-POSTs them through the same per-batch protocol so
 *     MO-discovered + IT-claimed elements reach the plugin.
 *
 * docs/completed/DESIGN_OPTION_B_REATTEMPT.md is the authoritative record.
 * Extracted from content.ts as the LabelStage of the extension restructure
 * (step 2). See notes/DESIGN_EXTENSION_RESTRUCTURE.md.
 */

import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { stampStrictViewport } from '../lifecycle/strict-viewport';
import { GrammarBatchRequest, GrammarBatchResponse, Message } from '../types';
import { isVoiceAlphabetLoaded, tokenToSpokenCodeword } from './words';
import { DEFAULT_SCAN_BATCH_SIZE } from '../scan/scanner';
import { sweepDisconnectedAfterBatch } from '../scan/batch-sweep';
import { getHintVisibility } from '../config';
import { labelReservoir } from './label-reservoir';
import { bkLog } from '../debug/bk-log';
import { firehoseStep } from '../debug/firehose';
import { recordSyncPost } from '../debug/sync-trace';

/**
 * Content.ts-owned collaborators the catchup sync needs. Injected once at
 * boot via initLabelSync because they touch state this module doesn't own
 * (the wrapper store, wrapper teardown, badge paint, visibility flag).
 */
export interface LabelSyncDeps {
  store: WrapperStore;
  detachWrapper: (element: Element) => void;
  /** Single level-triggered convergence pass (claim + build). */
  reconcile: () => void;
  isBadgesVisible: () => boolean;
  /**
   * Full grammar republish (content.ts republishAllGrammar): rotate the
   * session and re-queue every live wrapper. Phase 2b's epoch_mismatch
   * recovery — the same body the enumerated triggers call.
   */
  republishAll: (reason: string) => void;
}

let deps: LabelSyncDeps;

export function initLabelSync(d: LabelSyncDeps): void {
  deps = d;
}

// --- Delta-sync state ---
const sentCodewords: Set<string> = new Set();
const pendingPuts: Set<ElementWrapper> = new Set();
const pendingDeleteCodewords: string[] = [];


/** Enqueue a newly-codeworded wrapper for the next Put. */
export function queuePut(w: ElementWrapper): void {
  pendingPuts.add(w);
}

/** Drop a pending Put (the wrapper detached before it was flushed). */
export function dropPendingPut(w: ElementWrapper): void {
  pendingPuts.delete(w);
}

/** Queue a codeword for plugin-side delete on the next batch. */
export function queueDelete(codeword: string): void {
  pendingDeleteCodewords.push(codeword);
}

/** Mark a codeword as live on the plugin side (acknowledged in a POST). */
export function markSent(codeword: string): void {
  sentCodewords.add(codeword);
}

/** Whether the plugin currently holds this codeword. */
export function hasSent(codeword: string): boolean {
  return sentCodewords.has(codeword);
}

/** Whether any deletes are queued (drives the scan path's terminal flush). */
export function hasPendingDeletes(): boolean {
  return pendingDeleteCodewords.length > 0;
}

// --- Session id ---

function generateSessionId(): string {
  // Crypto-random UUID-shaped id; we just need uniqueness per scan,
  // not RFC 4122 conformance. crypto is available in extension content.
  const a = crypto.getRandomValues(new Uint8Array(16));
  let s = '';
  for (const b of a) s += b.toString(16).padStart(2, '0');
  return s.slice(0, 8) + '-' + s.slice(8, 12) + '-' + s.slice(12, 16) + '-' + s.slice(16, 20) + '-' + s.slice(20);
}

// Per-content-script session id. Generated once at module load and
// re-used across every batched POST for this content script's lifetime.
// notes/DESIGN_OPTION_B_REATTEMPT.md "Problem 1": rotating the session_id
// on every doScanBatched call made `ensureFrameSession` on the plugin
// side wipe entity_cache for the frame between MO rescans, opening a
// "badges painted but voice doesn't match" window. Same id across
// rescans keeps `session.Codewords` accumulating.
//
// Reset only on alphabet change (via rotateSession) — that's the one
// in-lifetime event where we WANT plugin-side cleanup of stale per-prefix
// entries.
let sessionId = generateSessionId();

export function getSessionId(): string {
  return sessionId;
}

/**
 * Rotate the session id and drop all delta-sync state. Called on alphabet
 * swap: the prior alphabet's codewords are invalid and the plugin still
 * holds them, so a fresh session_id makes the plugin's ensureFrameSession
 * clear stale per-prefix entries. The local mirror state is now stale too,
 * so reset it; the engine's band-convergence claims + onCodewordsChanged re-queue the
 * in-viewport wrappers as pending Puts.
 */
export function rotateSession(): void {
  const from = sessionId;
  sessionId = generateSessionId();
  const sentCount = sentCodewords.size;
  sentCodewords.clear();
  pendingPuts.clear();
  pendingDeleteCodewords.length = 0;
  bkLog('BK_SESSION_ROTATE', { from, to: sessionId, clearedSent: sentCount });
}

// --- Transport ---

export async function claimLabels(count: number, preferred: string[] = []): Promise<string[]> {
  if (count === 0) return [];
  // Synchronous local claim — no IPC. The reservoir warms via
  // ensureReady() at content-script bootstrap; when the reservoir runs
  // dry, claim() returns '' for the overflow slots and the caller leaves
  // those wrappers unhinted (level-triggered reconcile re-queues them on
  // the next pass after the async refill arrives). Function stays async
  // for backwards compat with the call site's existing await.
  //
  // `preferred[i]` is the codeword slot i wants back (Regime B reclaim across a
  // reload — the scan path resolves it per element from the SW-persisted recall).
  // Pass 1 of the reservoir grants it if still free, so the RIGHT element gets
  // its own letter rather than whatever sits front-of-pool. Without this the
  // scan path reused recalled codewords in pool order — i.e. mismatched.
  return labelReservoir.claim(count, preferred);
}

/** Drain the queued deletes for an outbound batch. Callers pass the drained
 * list to postBatch, which owns settling it (see below). Exported for the
 * scan path's terminal deletes-only flush (content.ts doScanBatched). */
export function drainPendingDeletes(): string[] {
  if (pendingDeleteCodewords.length === 0) return [];
  const drained = pendingDeleteCodewords.slice();
  pendingDeleteCodewords.length = 0;
  return drained;
}

export async function postBatch(
  request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'>,
  deletes: string[] = [],
): Promise<GrammarBatchResponse> {
  // Standalone (BranchKit absent): there is no plugin to receive the grammar.
  // Acknowledge every element locally so the scan path attaches all candidate
  // wrappers — the badge-implies-functional contract degenerates to "pickable
  // by typing", which holds without any voice round-trip. Discard the caller's
  // drained deletes AND anything still queued so they can't accumulate while
  // disconnected — no plugin holds these codewords.
  if (!isVoiceAlphabetLoaded()) {
    drainPendingDeletes();
    return { result: 'ok', succeeded: request.elements.map(e => e.codeword), failed: [] };
  }
  // Deletes ride explicitly — postBatch no longer drains the ambient queue.
  // The ambient drain let deletes queued mid-pipeline hitchhike on whichever
  // POST happened next (a parallel middle chunk, a scan batch) with no
  // accounting: applied deletes stayed in sentCodewords (epoch mismatch →
  // spurious full republish) and refused ones vanished from the queue with
  // both sides agreeing on the wrong state — a permanently matchable
  // painted-but-gone codeword the epoch tripwire can't see. Deletes are
  // drained only at ordered points (syncNow chunk 0 / final chunk, the
  // pure-delete push, the scan path's terminal flush) and settled HERE,
  // uniformly: applied (ok/stored — batch.go admits delete_codewords on any
  // batch) drops them from the shadow; anything else restores them for the
  // next attempt.
  const fullRequest: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'> =
    deletes.length > 0 ? { ...request, delete_codewords: deletes } : request;
  // Transport trace (round 22b): every outcome — including silently-caught
  // sendMessage failures and slow round-trips — lands in the snapshot's
  // sync_trace ring so a stalled post-swap sync names its mechanism.
  const __t0 = performance.now();
  const trace = (result: string, failedN: number): void => {
    recordSyncPost({
      t: __t0, elapsedMs: performance.now() - __t0, result,
      elements: request.elements.length, deletes: deletes.length,
      failedN, session: request.session_id.slice(0, 8),
      kind: request.kind, batchIndex: request.batch_index, isFinal: request.is_final,
    });
  };
  try {
    const resp: GrammarBatchResponse =
      await chrome.runtime.sendMessage({ type: 'GRAMMAR_BATCH', request: fullRequest } as Message);
    if (resp.result === 'ok' || resp.result === 'stored') {
      for (const cw of deletes) sentCodewords.delete(cw);
    } else if (deletes.length > 0) {
      // Refusal (calibration_active) or plugin-side error: nothing applied.
      pendingDeleteCodewords.push(...deletes);
    }
    trace(resp.result, resp.failed.length);
    return resp;
  } catch {
    // Restore drained deletes on transport failure so they're carried
    // on the next attempt — otherwise an SW restart mid-scan would
    // strand the deletes silently.
    pendingDeleteCodewords.push(...deletes);
    trace('error', request.elements.length);
    return {
      result: 'error',
      succeeded: [],
      failed: request.elements.map(e => ({ codeword: e.codeword, reason: 'sendMessage_failed' })),
    };
  } finally {
  }
}

// --- Catchup orchestration ---

let batchedSyncTimer: ReturnType<typeof setTimeout> | null = null;
let batchedSyncDeadline: ReturnType<typeof setTimeout> | null = null;
const BATCHED_SYNC_DEBOUNCE_MS = 80;
// Max-wait deadline for the sync debounce (round 22b/22c): a pure trailing
// debounce starves under sustained churn — during a fling, claims and strict
// deltas reset the 80ms timer continuously and the sync NEVER fired for the
// whole scroll+swap window (sync_trace: a 5.5s hole, then one monster delta
// with 355 deletes at settle, then epoch divergence → session rotation → a
// full ~25-batch republish; badges translucent 13s+). Same debounce+deadline
// shape as the huge-mutation refresh (mutation-source.ts) and whenDOMSettles:
// the deadline is armed by the FIRST schedule of a burst, NOT reset by later
// ones, and whichever timer fires first clears both — so a sustained storm
// ships coalesced deltas at least every BATCHED_SYNC_MAX_WAIT_MS.
const BATCHED_SYNC_MAX_WAIT_MS = 400;

// Retry pacing for a wholesale plugin refusal (`calibration_active`): the
// plugin received the batch but applied nothing, so the delta must be re-sent
// once calibration releases the grammar surface. 2s keeps the retry loop to
// one POST per 2s for the duration of a calibration session and self-
// terminates on the first accepted batch.
const REFUSAL_RETRY_MS = 2000;
let refusalRetryTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleRefusalRetry(): void {
  if (refusalRetryTimer) return;
  refusalRetryTimer = setTimeout(() => {
    refusalRetryTimer = null;
    scheduleSync('refusal_retry');
  }, REFUSAL_RETRY_MS);
}

/**
 * Wholesale refusal: the plugin answered but applied nothing — no per-codeword
 * verdicts (`calibration_active` is the only current case). The drained delta
 * must be restored or it silently vanishes: the wrappers keep their painted
 * (bk-pending) badges but their codewords never reach the grammar —
 * permanently unmatchable until an unrelated session rotation.
 *
 * 'error' is excluded explicitly: that's the synthetic transport-failure
 * response, where postBatch has ALREADY restored the drained deletes and
 * populated `failed` for any puts. On a pure-delete batch its `failed` is
 * empty (no elements), so without this exclusion the refusal path would
 * restore the deletes a second time — and the 2s retry loop would double the
 * queue on every attempt while the SW is unreachable.
 */
function isWholesaleRefusal(resp: GrammarBatchResponse): boolean {
  return resp.result !== 'ok' && resp.result !== 'stored' && resp.result !== 'error'
    && resp.failed.length === 0;
}

// (The grammar-epoch handshake — tripwire, mismatch republish ladder, and
// trigger-redundancy probe — was deleted 2026-07-19 in the pull-resolution
// payoff pass: match truth moved to dispatch-time resolution, so the mirror
// is display-grade and no longer needs correctness-grade convergence
// machinery. History: DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md.)

// Mass-claim fast path (round 34b): a swap repaint claims ~100+ letters in
// one burst, and every one of those badges renders bk-pending translucent
// until the plugin ACK — the "settled" moment the eye actually waits for.
// The 80ms debounce + 400ms deadline were tuned for cosmetic-mutation
// coalescing; on a mass claim they just delay solidification. When the
// pending-Put backlog crosses this threshold, fire on the next macrotask
// (still coalescing the synchronous burst that's mid-flight) instead of
// waiting out the debounce. Same threshold class as REVEAL_REPAIR_FAST_ARM.
const MASS_CLAIM_FAST_SYNC = 25;

/**
 * Debounced entry point for every grammar-relevant change (MO mutations,
 * IT codeword claims, finalize-sweep detaches, bfcache restore). Coalesces
 * dense bursts into one catchup flush.
 */
export function scheduleSync(reason: string): void {
  if (batchedSyncTimer) clearTimeout(batchedSyncTimer);
  if (pendingPuts.size >= MASS_CLAIM_FAST_SYNC) {
    // setTimeout(0), not the debounce: the current task's claim loop
    // finishes queueing first, then one flush ships the whole burst.
    batchedSyncTimer = setTimeout(() => fireBatchedSync(`${reason}:mass_claim`), 0);
    return;
  }
  batchedSyncTimer = setTimeout(() => fireBatchedSync(reason), BATCHED_SYNC_DEBOUNCE_MS);
  if (batchedSyncDeadline === null) {
    batchedSyncDeadline = setTimeout(() => fireBatchedSync(`${reason}:deadline`), BATCHED_SYNC_MAX_WAIT_MS);
  }
}

// Shared fire body for the trailing timer AND the max-wait deadline:
// whichever fires first clears both, so one burst produces exactly one
// syncNow per firing (the fireHugeMutationRefresh shape).
function fireBatchedSync(reason: string): void {
  if (batchedSyncTimer) {
    clearTimeout(batchedSyncTimer);
    batchedSyncTimer = null;
  }
  if (batchedSyncDeadline) {
    clearTimeout(batchedSyncDeadline);
    batchedSyncDeadline = null;
  }
  void syncNow(reason);
}

/**
 * Catchup sync: collect every pending Put, batch them up with the current
 * session_id, and POST through the per-batch protocol. The plugin's
 * session_id handling Deletes anything no longer present, so the "what
 * changed" diff is handled implicitly by the plugin.
 *
 * Pre-delta, this re-flushed every wrapper-with-codeword on every fire —
 * quadratic-ish in mutation rate × set size. With pendingPuts/sentCodewords,
 * flushing N wrappers' worth of state for one row insertion is O(rows
 * changed) not O(rows total). Empty deltas skip the round-trip entirely.
 *
 * Awaitable so the refocus-from-cache path can sync inline.
 *
 * SINGLE-FLIGHT: the pipelined chunks impose ordering only within one
 * invocation (chunk 0's deletes awaited before the middle Puts). The
 * mass-claim fast path and the debounce could overlap two invocations,
 * racing pipeline B's deletes against pipeline A's still-in-flight Puts
 * through independent fetches — a stale Put landing after its codeword's
 * Delete resurrects a dead grammar entry. One sync runs at a time; a
 * request arriving mid-flight coalesces into one trailing re-run (its
 * delta is ambient module state, so nothing is lost by coalescing).
 */
let syncInFlight: Promise<void> | null = null;
let syncRerunReason: string | null = null;

export function syncNow(reason: string): Promise<void> {
  if (syncInFlight) {
    syncRerunReason = reason;
    return syncInFlight;
  }
  syncInFlight = (async () => {
    try {
      await doSyncNow(reason);
      while (syncRerunReason !== null) {
        const r = syncRerunReason;
        syncRerunReason = null;
        await doSyncNow(r);
      }
    } finally {
      syncInFlight = null;
    }
  })();
  return syncInFlight;
}

async function doSyncNow(reason: string): Promise<void> {
  // Grammar is pushed to the plugin only when BranchKit is connected (voice
  // overlay loaded). Standalone there is no plugin to receive it; hints still
  // render and are typeable without this push.
  if (!isVoiceAlphabetLoaded()) return;

  // Drain pendingPuts. Snapshot + clear before any await so codewords
  // claimed during the post round-trip re-queue for the next push.
  // Filter out wrappers whose codeword went away or were replaced in
  // the store between schedule and drain (race with IT viewport-leave
  // or rebind).
  const drained = [...pendingPuts];
  pendingPuts.clear();
  const puts = drained.filter(w =>
    w.scanned.codeword && deps.store.findWrapperFor(w.element) === w,
  );

  // Pure-empty delta — nothing changed since last push. Skip the
  // round-trip entirely. This is the "hash-skip for free" case: in
  // the steady state the only way to land here is "MO fired but no
  // hintability change", which is the bulk of cosmetic-mutation
  // pages (style toggles, animation classes, hover state churn).
  if (puts.length === 0 && pendingDeleteCodewords.length === 0) {
    void reason;
    return;
  }

  const sessionMeta = {
    conn_id: '', // stamped by the background SW in postGrammarBatch
    hint_visibility: getHintVisibility(),
    app_id: '',
    table_id: '',
  };

  if (puts.length === 0) {
    // Pure-delete push: one empty batch carrying the queued deletes.
    // postBatch settles them (shadow drop on apply, queue restore on
    // refusal or transport failure) — this path only paces the retry.
    const drainedDeletes = drainPendingDeletes();
    const resp = await postBatch({
      session_id: sessionId,
      batch_index: 0,
      is_final: true,
      kind: 'incremental',
      ...sessionMeta,
      elements: [],
    }, drainedDeletes);
    if (resp.result === 'ok' || resp.result === 'stored') {
    } else if (isWholesaleRefusal(resp)) {
      bkLog('BK_SYNC_REFUSED', { result: resp.result, deletes: drainedDeletes.length });
      scheduleRefusalRetry();
    }
    void reason;
    return;
  }

  // One delta-push chunked at DEFAULT_SCAN_BATCH_SIZE so each POST stays
  // small. PIPELINED (round 29c): mid-storm a single round-trip runs
  // ~430ms p50 (SW contention + the response continuation queueing behind
  // the page's storm tasks), and with letters reshuffling per swap a fling
  // delta is ~40 chunks — sequential awaits summed to the 3-3.5s
  // translucent window the user read as "not loaded". The plugin imposes
  // exactly two ordering constraints (batch.go admitGrammarBatch):
  // delete_codewords ride batch 0 and must apply before any Put that
  // reuses a freed letter, and is_final drives epoch finalization. So:
  // batch 0 posts FIRST and is awaited; the middle chunks post fully in
  // parallel (independent Puts of distinct codewords — arrival order
  // irrelevant, total = max round-trip instead of the sum); the final
  // chunk posts after every middle response settles.
  const chunks: ElementWrapper[][] = [];
  for (let start = 0; start < puts.length; start += DEFAULT_SCAN_BATCH_SIZE) {
    chunks.push(puts.slice(start, Math.min(start + DEFAULT_SCAN_BATCH_SIZE, puts.length)));
  }
  let halted = false;

  const handleResponse = (chunk: ElementWrapper[], resp: GrammarBatchResponse, deletesRiding: string[], _isLast: boolean): void => {
    if (resp.result === 'error') {
      // Transport failure ('error' is synthetic — the SW's transportFailure
      // or a failed sendMessage; the plugin only answers ok/stored/
      // calibration_active). The plugin never saw this chunk, so its
      // per-codeword `failed` list describes nothing the plugin decided —
      // detaching on it is what turned "BranchKit closed" into a
      // paint→detach→rediscover→repaint flash loop on every live page.
      // Keep the wrappers painted (bk-pending carries voice-not-live;
      // typing works regardless), re-queue their Puts, and stop dispatching
      // further chunks (they'd fail the same way). postBatch already
      // restored any deletes that rode this chunk. No retry timer:
      // convergence comes from the next churn-triggered sync, the liveness
      // onResync after an SW restart, or the sse_connect reactivate
      // (rotate + full re-Put) once the host returns — a timer here would
      // hammer forever in the standalone-with-stale-alphabet steady state.
      halted = true;
      for (const w of chunk) pendingPuts.add(w);
      bkLog('BK_SYNC_TRANSPORT_FAILED', { requeued: chunk.length, deletes: deletesRiding.length });
      return;
    }
    if (isWholesaleRefusal(resp)) {
      // Applied nothing (calibration). Re-queue this chunk's puts, stop
      // dispatching further chunks, and retry once calibration releases
      // (postBatch already restored any deletes that rode it).
      // Already-in-flight siblings settle through this same handler and
      // re-queue themselves too.
      halted = true;
      for (const w of chunk) pendingPuts.add(w);
      bkLog('BK_SYNC_REFUSED', {
        result: resp.result, requeued: chunk.length, deletes: deletesRiding.length,
      });
      scheduleRefusalRetry();
      return;
    }
    if (resp.failed.length > 0) {
      const failedSet = new Set(resp.failed.map(f => f.codeword));
      for (const w of chunk) {
        // Guard the empty string (round 30): a wrapper released while its
        // chunk was in flight has codeword '' — an ''-keyed failure would
        // match EVERY such wrapper and mass-detach freshly painted badges
        // (the production flash-then-gone: 605 plugin drops, all
        // reason=empty_codeword, each one detaching a whole chunk's
        // released wrappers).
        if (w.scanned.codeword && failedSet.has(w.scanned.codeword)) {
          deps.detachWrapper(w.element);
        }
      }
    }
    const succeededSet = new Set(resp.succeeded);
    for (const cw of succeededSet) sentCodewords.add(cw);
    // (Deletes that rode this chunk were already settled by postBatch.)
    // Voice-layer ACK: codewords the plugin just confirmed are live in the
    // grammar. ElementWrapper.markGrammarReady flips the flag and, if the
    // badge is visible with bk-pending, clears the class to transition to
    // full opacity.
    for (const w of chunk) {
      if (succeededSet.has(w.scanned.codeword)) w.markGrammarReady();
    }
    const succeededWrappers = chunk.filter(w => succeededSet.has(w.scanned.codeword));
    sweepDisconnectedAfterBatch(succeededWrappers, (el) => el.isConnected, pendingDeleteCodewords, deps.detachWrapper);
    // Epoch tripwire on the final chunk only — intermediate responses
    // describe a half-applied sync by construction.
    if (deps.isBadgesVisible() && resp.succeeded.length > 0) {
      deps.reconcile();
    }
  };

  const postChunk = async (index: number, isLast: boolean): Promise<void> => {
    // Re-validate at POST time (round 30): the drain filter ran when the
    // sync was SCHEDULED, but a wrapper can be released (codeword blanked)
    // or detached while earlier chunks round-trip — the wider the 29c
    // parallel window, the more often. Posting them as codeword:"" made
    // the plugin fail them (605 × reason=empty_codeword in one session)
    // and the failure path detached innocent wrappers. A released
    // wrapper's Delete is already queued by its release path; just don't
    // Put it.
    const chunk = chunks[index].filter(
      (w) => w.scanned.codeword && deps.store.findWrapperFor(w.element) === w,
    );
    // Deletes ride only the ORDERED posts: chunk 0 (awaited before the
    // middle Puts — the freed-letter-reuse constraint) and the final chunk
    // (posted after every middle settles, so deletes queued mid-pipeline by
    // the post-batch sweeps ship this sync instead of hitchhiking on a
    // parallel middle chunk, where arrival order vs the in-flight Puts is
    // unconstrained). A letter freed mid-pipeline can't be re-Put within
    // this same pipeline (its reclaim lands in pendingPuts for the NEXT
    // sync), so a final-chunk delete never clobbers a fresh Put.
    const deletesRiding = index === 0 || isLast ? drainPendingDeletes() : [];
    if (chunk.length === 0 && deletesRiding.length === 0 && !isLast) return;
    stampStrictViewport(chunk);
    const resp = await postBatch({
      session_id: sessionId,
      batch_index: index,
      is_final: isLast,
      kind: 'incremental',
      ...sessionMeta,
      elements: chunk.map(w => w.scanned),
    }, deletesRiding);
    handleResponse(chunk, resp, deletesRiding, isLast);
  };

  // A halt (refusal or transport failure) leaves chunks that were never
  // dispatched: their puts were drained from pendingPuts at the top of this
  // sync but no handleResponse will ever re-queue them — without this they
  // silently vanish from the delta, stranding painted badges unmatchable
  // until an unrelated rotation. Dispatched chunks re-queue themselves in
  // handleResponse; this covers only the ones the halt short-circuited.
  const requeueUndispatched = (fromIndex: number): void => {
    for (const c of chunks.slice(fromIndex)) {
      for (const w of c) pendingPuts.add(w);
    }
  };

  // Batch 0 (carries the deletes) alone and awaited — a freed letter
  // reused by a later chunk's Put must see its Delete applied first.
  await postChunk(0, chunks.length === 1);
  if (halted || chunks.length === 1) {
    if (halted) requeueUndispatched(1);
    void reason;
    return;
  }

  // Middle chunks in parallel; the final chunk waits for all of them so
  // is_final genuinely arrives last (epoch finalization).
  if (chunks.length > 2) {
    await Promise.all(
      chunks.slice(1, -1).map((_, i) => halted ? Promise.resolve() : postChunk(i + 1, false)),
    );
  }
  if (!halted) await postChunk(chunks.length - 1, true);
  else requeueUndispatched(chunks.length - 1);

  void reason;
}

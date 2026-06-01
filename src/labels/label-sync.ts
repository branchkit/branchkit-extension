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
import { GrammarBatchRequest, GrammarBatchResponse, Message } from '../types';
import { isAlphabetLoaded } from './words';
import { DEFAULT_SCAN_BATCH_SIZE } from '../scan/scanner';
import { sweepDisconnectedAfterBatch } from '../scan/batch-sweep';
import { getHintVisibility } from '../config';

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
  isHintsVisible: () => boolean;
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
 * so reset it; IT.refreshViewportClaims + onCodewordsChanged re-queue the
 * in-viewport wrappers as pending Puts.
 */
export function rotateSession(): void {
  sessionId = generateSessionId();
  sentCodewords.clear();
  pendingPuts.clear();
  pendingDeleteCodewords.length = 0;
}

// --- Transport ---

export async function claimLabels(count: number): Promise<string[]> {
  if (count === 0) return [];
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'CLAIM_LABELS', count });
    return Array.isArray(resp?.labels) ? resp.labels : [];
  } catch {
    return [];
  }
}

function drainPendingDeletes(): string[] {
  if (pendingDeleteCodewords.length === 0) return [];
  const drained = pendingDeleteCodewords.slice();
  pendingDeleteCodewords.length = 0;
  return drained;
}

export async function postBatch(
  request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'>,
): Promise<GrammarBatchResponse> {
  // Piggyback any queued deletes from the prior batch's isConnected
  // sweep. Drain unconditionally — even an empty batch should carry
  // pending deletes through so disconnected elements don't leak past
  // a scan boundary.
  const drainedDeletes = drainPendingDeletes();
  const fullRequest: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'> =
    drainedDeletes.length > 0 ? { ...request, delete_codewords: drainedDeletes } : request;
  try {
    return await chrome.runtime.sendMessage({ type: 'GRAMMAR_BATCH', request: fullRequest } as Message);
  } catch {
    // Restore drained deletes on transport failure so they're carried
    // on the next attempt — otherwise an SW restart mid-scan would
    // strand the deletes silently.
    pendingDeleteCodewords.push(...drainedDeletes);
    return {
      result: 'error',
      succeeded: [],
      failed: request.elements.map(e => ({ codeword: e.codeword, reason: 'sendMessage_failed' })),
    };
  }
}

// --- Catchup orchestration ---

let batchedSyncTimer: ReturnType<typeof setTimeout> | null = null;
const BATCHED_SYNC_DEBOUNCE_MS = 80;

/**
 * Debounced entry point for every grammar-relevant change (MO mutations,
 * IT codeword claims, finalize-sweep detaches, bfcache restore). Coalesces
 * dense bursts into one catchup flush.
 */
export function scheduleSync(reason: string): void {
  if (batchedSyncTimer) clearTimeout(batchedSyncTimer);
  batchedSyncTimer = setTimeout(() => {
    batchedSyncTimer = null;
    void syncNow(reason);
  }, BATCHED_SYNC_DEBOUNCE_MS);
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
 */
export async function syncNow(reason: string): Promise<void> {
  if (!isAlphabetLoaded()) return;

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
    // Pure-delete push. postBatch drains pendingDeleteCodewords
    // and piggybacks them via delete_codewords on a single empty batch.
    const drainedDeletes = pendingDeleteCodewords.slice();
    const resp = await postBatch({
      session_id: sessionId,
      batch_index: 0,
      is_final: true,
      kind: 'incremental',
      ...sessionMeta,
      elements: [],
    });
    // Plugin doesn't report deletes in `succeeded`/`failed`, but it
    // honors them as long as the batch itself didn't error. On error,
    // postBatch restores pendingDeleteCodewords for us. 'stored' (non-focused
    // source) applied the deletes to the session just like 'ok' did.
    if (resp.result === 'ok' || resp.result === 'stored') {
      for (const cw of drainedDeletes) sentCodewords.delete(cw);
    }
    void reason;
    return;
  }

  // One delta-push chunked at DEFAULT_SCAN_BATCH_SIZE so each round-trip
  // stays small. Deletes ride on the first batch's drainPendingDeletes.
  for (let start = 0; start < puts.length; start += DEFAULT_SCAN_BATCH_SIZE) {
    const end = Math.min(start + DEFAULT_SCAN_BATCH_SIZE, puts.length);
    const chunk = puts.slice(start, end);
    const isLast = end === puts.length;
    // Capture which deletes ride this batch — postBatch's drain
    // empties pendingDeleteCodewords for us. We track the snapshot so
    // sentCodewords can be updated on a successful response.
    const deletesRidingHere = start === 0 ? pendingDeleteCodewords.slice() : [];
    const resp = await postBatch({
      session_id: sessionId,
      batch_index: Math.floor(start / DEFAULT_SCAN_BATCH_SIZE),
      is_final: isLast,
      kind: 'incremental',
      ...sessionMeta,
      elements: chunk.map(w => w.scanned),
    });
    if (resp.failed.length > 0) {
      const failedSet = new Set(resp.failed.map(f => f.codeword));
      for (const w of chunk) {
        if (failedSet.has(w.scanned.codeword)) deps.detachWrapper(w.element);
      }
    }
    const succeededSet = new Set(resp.succeeded);
    for (const cw of succeededSet) sentCodewords.add(cw);
    if (resp.result === 'ok' || resp.result === 'stored') {
      for (const cw of deletesRidingHere) sentCodewords.delete(cw);
    }
    // Detach badges this REPLACE evicted from the grammar (badge-visible-implies
    // -commandable). detachWrapper removes the badge + queues the Delete that
    // clears the sent-set entry on its ack.
    if (resp.evicted?.length) {
      for (const cw of resp.evicted) {
        const w = deps.store.byCodeword(cw);
        if (w) deps.detachWrapper(w.element);
      }
    }
    const succeededWrappers = chunk.filter(w => succeededSet.has(w.scanned.codeword));
    sweepDisconnectedAfterBatch(succeededWrappers, (el) => el.isConnected, pendingDeleteCodewords, deps.detachWrapper);
    if (deps.isHintsVisible() && resp.succeeded.length > 0) {
      deps.reconcile();
    }
    await new Promise(r => setTimeout(r, 0));
  }

  void reason;
}

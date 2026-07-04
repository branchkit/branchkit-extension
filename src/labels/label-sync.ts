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
import { epochHashOf } from './grammar-epoch';
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
  isHintsVisible: () => boolean;
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
 * so reset it; IT.refreshViewportClaims + onCodewordsChanged re-queue the
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

function drainPendingDeletes(): string[] {
  if (pendingDeleteCodewords.length === 0) return [];
  const drained = pendingDeleteCodewords.slice();
  pendingDeleteCodewords.length = 0;
  return drained;
}

export async function postBatch(
  request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'>,
): Promise<GrammarBatchResponse> {
  // Standalone (BranchKit absent): there is no plugin to receive the grammar.
  // Acknowledge every element locally so the scan path attaches all candidate
  // wrappers — the badge-implies-functional contract degenerates to "pickable
  // by typing", which holds without any voice round-trip. Drain and discard
  // any queued deletes so they can't accumulate while disconnected.
  if (!isVoiceAlphabetLoaded()) {
    drainPendingDeletes();
    return { result: 'ok', succeeded: request.elements.map(e => e.codeword), failed: [] };
  }
  // Piggyback any queued deletes from the prior batch's isConnected
  // sweep. Drain unconditionally — even an empty batch should carry
  // pending deletes through so disconnected elements don't leak past
  // a scan boundary.
  const drainedDeletes = drainPendingDeletes();
  const fullRequest: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'> =
    drainedDeletes.length > 0 ? { ...request, delete_codewords: drainedDeletes } : request;
  inFlightBatches++;
  // Transport trace (round 22b): every outcome — including silently-caught
  // sendMessage failures and slow round-trips — lands in the snapshot's
  // sync_trace ring so a stalled post-swap sync names its mechanism.
  const __t0 = performance.now();
  const trace = (result: string, failedN: number): void => {
    recordSyncPost({
      t: __t0, elapsedMs: performance.now() - __t0, result,
      elements: request.elements.length, deletes: drainedDeletes.length,
      failedN, session: request.session_id.slice(0, 8),
      kind: request.kind, batchIndex: request.batch_index, isFinal: request.is_final,
    });
  };
  try {
    const resp: GrammarBatchResponse =
      await chrome.runtime.sendMessage({ type: 'GRAMMAR_BATCH', request: fullRequest } as Message);
    trace(resp.result, resp.failed.length);
    return resp;
  } catch {
    // Restore drained deletes on transport failure so they're carried
    // on the next attempt — otherwise an SW restart mid-scan would
    // strand the deletes silently.
    pendingDeleteCodewords.push(...drainedDeletes);
    trace('error', request.elements.length);
    return {
      result: 'error',
      succeeded: [],
      failed: request.elements.map(e => ({ codeword: e.codeword, reason: 'sendMessage_failed' })),
    };
  } finally {
    inFlightBatches--;
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

// --- Grammar epoch tripwire (Phase 2a of DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md) ---
//
// Detect-only: compares the plugin's post-batch epoch against this frame's
// delta-sync shadow on final-chunk responses. A mismatch means the shadow
// has diverged from the plugin's grammar — the class healed today by the
// enumerated full-republish triggers (sw_restart_resync, bfcache_restore,
// the plugin's sse_connect reactivate). This tripwire measures whether the
// handshake would catch each of those firings (and any unknown desync) BEFORE
// Phase 2b lets a mismatch trigger the republish itself. Counters ride the
// perf snapshot; mismatch detail goes to browser.log. Known tolerable noise:
// a session rotation racing a mid-flight sync compares an old-session
// response against the cleared shadow — detect-only exists to measure
// exactly this kind of thing.
interface EpochStats {
  checks: number;
  mismatches: number;
  /** Comparisons skipped because other grammar traffic was in flight. */
  skippedBusy: number;
  /** Phase 2b: epoch_mismatch republishes fired by this instance. */
  republishes: number;
  /** Phase 2b: the consecutive-republish cap tripped (loud-bug state). */
  capExhausted: boolean;
  lastMismatch: {
    pluginCount: number; pluginHash: string;
    shadowCount: number; shadowHash: string;
    reason: string;
    /** Frame attribution — without it, every mismatch investigation needs
     * hand-correlation across logs (2026-06-12's chases). */
    url: string;
    frame: 'top' | 'iframe';
  } | null;
}

// Origin+path only (no query/fragment noise), capped — breadcrumb-sized.
function trimUrlForLog(href: string): string {
  try {
    const u = new URL(href);
    return `${u.origin}${u.pathname}`.slice(0, 120);
  } catch {
    return href.slice(0, 120);
  }
}
const epochStats: EpochStats = {
  checks: 0, mismatches: 0, skippedBusy: 0, republishes: 0, capExhausted: false, lastMismatch: null,
};

// --- Phase 2b: mismatch acts (DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md decisions 4+5) ---
//
// A confirmed quiescent mismatch fires the same recovery the enumerated
// triggers use — republishAllGrammar('epoch_mismatch') via deps.republishAll
// — making grammar convergence level-triggered: any desync, known or future,
// heals within one batch round-trip of the next quiescent sync instead of
// waiting for its class to be discovered, named, and wired to a trigger.
// The enumerated triggers stay (decision 4) until telemetry proves them
// redundant.
//
// Loop guards (decision 5): a republish is itself a full re-Put whose final
// chunk re-runs this comparison, so a persistent disagreement (plugin bug,
// the latent plugin↔actuator divergence the epoch can't see) would otherwise
// republish forever:
//   - cooldown: at most one epoch_mismatch republish per 5s;
//   - consecutive cap: after 3 republishes with no clean check in between,
//     stop the fast ladder and go LOUD (BK_GRAMMAR_EPOCH_CAP + firehose
//     breadcrumb). A mismatch that survives a full republish is a real bug we
//     want visible, not a silent republish storm. Any clean check resets the
//     cap, so a long-lived page whose occasional desyncs DO heal never
//     exhausts it; detect-only logging continues even when capped.
//   - post-cap trickle: while capped, retry ONE republish per
//     EPOCH_CAP_RETRY_MS instead of never. The loud log is dev-only, so a
//     hard stop left production users with a silently diverged grammar
//     (painted-but-unmatchable badges) until an unrelated rotation — a
//     terminal wedge on a tab that never changes focus (2026-06-29 review).
//     One rotate+republish per 5 minutes bounds staleness for transient
//     causes while staying far from storm territory.
const EPOCH_REPUBLISH_COOLDOWN_MS = 5000;
const EPOCH_REPUBLISH_MAX_CONSECUTIVE = 3;
const EPOCH_CAP_RETRY_MS = 5 * 60_000;
let lastEpochRepublishAt = -Infinity;
let consecutiveEpochRepublishes = 0;

/** Test seam: module state is per-page in production (one module instance
 * per content script) but shared across a vitest file. */
export function resetGrammarEpochActForTest(): void {
  lastEpochRepublishAt = -Infinity;
  consecutiveEpochRepublishes = 0;
  epochStats.checks = 0;
  epochStats.mismatches = 0;
  epochStats.skippedBusy = 0;
  epochStats.republishes = 0;
  epochStats.capExhausted = false;
  epochStats.lastMismatch = null;
}

/** GRAMMAR_BATCH posts currently awaiting a response (scan + sync paths
 * both route through postBatch). */
let inFlightBatches = 0;

/** Snapshot for the perf surface (content.ts buildPerfSnapshot). */
export function grammarEpochStats(): EpochStats {
  return { ...epochStats, lastMismatch: epochStats.lastMismatch ? { ...epochStats.lastMismatch } : null };
}

function checkGrammarEpoch(resp: GrammarBatchResponse, reason: string): void {
  const remote = resp.epoch;
  if (!remote) return; // refusal, or a plugin build predating the handshake
  if (resp.result !== 'ok' && resp.result !== 'stored') return;
  // Quiescence gate: the scan pipeline, incremental syncs, and strict
  // re-pushes interleave by design, so a response's epoch describes a state
  // other in-flight batches are still moving — comparing there measures the
  // interleave, not divergence (first live smoke: 10/10 false mismatches
  // within 500ms of concurrent traffic). Compare only when this was the
  // sole in-flight batch and nothing further is queued; a genuinely
  // diverged grammar is diverged at rest, which is exactly when this fires.
  if (inFlightBatches > 0 || pendingPuts.size > 0 || pendingDeleteCodewords.length > 0) {
    epochStats.skippedBusy++;
    return;
  }
  epochStats.checks++;
  const shadowCount = sentCodewords.size;
  // The plugin's epoch is computed over the SPOKEN codewords it stored, so the
  // shadow must hash the spoken translation of our letter tokens — not the
  // letters themselves — to stay byte-identical (the overlay is loaded whenever
  // a real epoch response arrives, since voice is connected).
  const shadowHash = epochHashOf([...sentCodewords].map(tokenToSpokenCodeword));
  // Count comparison is free; hash only when counts agree (and at mismatch
  // time for the breadcrumb).
  if (remote.count === shadowCount && shadowHash === remote.hash) {
    // Clean check: the grammar converged, so any republish run is over.
    if (epochStats.capExhausted) {
      bkLog('BK_GRAMMAR_EPOCH_CAP_CLEARED', { afterRepublishes: consecutiveEpochRepublishes });
    }
    consecutiveEpochRepublishes = 0;
    epochStats.capExhausted = false;
    return;
  }
  epochStats.mismatches++;
  epochStats.lastMismatch = {
    pluginCount: remote.count,
    pluginHash: remote.hash,
    shadowCount,
    shadowHash,
    reason,
    url: trimUrlForLog(window.location.href),
    frame: window === window.top ? 'top' : 'iframe',
  };
  bkLog('BK_GRAMMAR_EPOCH_MISMATCH', epochStats.lastMismatch);

  // Phase 2b: act on the mismatch (cooldown + consecutive cap + post-cap
  // trickle, above).
  if (consecutiveEpochRepublishes >= EPOCH_REPUBLISH_MAX_CONSECUTIVE) {
    if (!epochStats.capExhausted) {
      epochStats.capExhausted = true;
      bkLog('BK_GRAMMAR_EPOCH_CAP', {
        republishes: consecutiveEpochRepublishes, ...epochStats.lastMismatch,
      });
      firehoseStep('grammar_epoch:cap_exhausted', consecutiveEpochRepublishes);
    }
    const nowCapped = performance.now();
    if (nowCapped - lastEpochRepublishAt < EPOCH_CAP_RETRY_MS) return;
    lastEpochRepublishAt = nowCapped;
    epochStats.republishes++;
    bkLog('BK_GRAMMAR_EPOCH_CAP_RETRY', epochStats.lastMismatch);
    firehoseStep('grammar_epoch:cap_retry', epochStats.republishes);
    deps.republishAll('epoch_mismatch');
    return;
  }
  const now = performance.now();
  if (now - lastEpochRepublishAt < EPOCH_REPUBLISH_COOLDOWN_MS) return;
  lastEpochRepublishAt = now;
  consecutiveEpochRepublishes++;
  epochStats.republishes++;
  firehoseStep('grammar_epoch:republish', consecutiveEpochRepublishes);
  deps.republishAll('epoch_mismatch');
}

// --- Phase 3a: trigger-redundancy probe (DESIGN_GRAMMAR_EPOCH_HANDSHAKE.md
// decision 4) ---
//
// Detect-only telemetry for trigger retirement: at each enumerated
// full-republish trigger firing, read the plugin's PRE-republish epoch and
// record whether the handshake alone would have seen this divergence
// (`diverged`) and whether the 2a quiescence gate would have let a check run
// at that instant (`busy`). An empty incremental batch is a pure read — the
// plugin applies nothing and answers with its current epoch (same shape the
// pure-delete push already posts, minus the deletes).
//
// The probe is its own read, NOT a sync participant: it bypasses postBatch
// (no pendingDeleteCodewords piggyback, no inFlightBatches participation —
// the regular traffic must not see the probe as "busy"), never feeds
// checkGrammarEpoch, and never republishes. Callers fire it BEFORE
// rotateSession, so the shadow snapshot below still describes the
// pre-republish state; the comparison runs against that snapshot when the
// response lands (rotation will have cleared the live set by then).
//
// `diverged: null` = the epoch was unreadable (transport failure, wholesale
// refusal, or a pre-handshake plugin build); the firing still gets its line
// so per-firing counts stay honest.
export function probeGrammarEpoch(reason: string): Promise<void> {
  const busy = inFlightBatches > 0 || pendingPuts.size > 0 || pendingDeleteCodewords.length > 0;
  const shadowCount = sentCodewords.size;
  // Hash the spoken translation of our letter tokens to match the plugin's
  // epoch (computed over the codewords it stored). See checkGrammarEpoch.
  const shadowHash = epochHashOf([...sentCodewords].map(tokenToSpokenCodeword));
  const request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'> = {
    session_id: sessionId,
    batch_index: 0,
    is_final: true,
    kind: 'incremental',
    conn_id: '', // stamped by the background SW
    hint_visibility: getHintVisibility(),
    app_id: '',
    table_id: '',
    elements: [],
  };
  return (async () => {
    let diverged: boolean | null = null;
    let pluginCount: number | null = null;
    let result = 'transport_failed';
    try {
      const resp: GrammarBatchResponse =
        await chrome.runtime.sendMessage({ type: 'GRAMMAR_BATCH', request } as Message);
      result = resp.result;
      const remote = (resp.result === 'ok' || resp.result === 'stored') ? resp.epoch : undefined;
      if (remote) {
        diverged = remote.count !== shadowCount || remote.hash !== shadowHash;
        pluginCount = remote.count;
      }
    } catch {
      // SW unreachable — diverged stays null.
    }
    bkLog('BK_TRIGGER_PROBE', {
      reason, diverged, busy, pluginCount, shadowCount, result,
      url: trimUrlForLog(window.location.href),
      frame: window === window.top ? 'top' : 'iframe',
    });
  })();
}

/**
 * Debounced entry point for every grammar-relevant change (MO mutations,
 * IT codeword claims, finalize-sweep detaches, bfcache restore). Coalesces
 * dense bursts into one catchup flush.
 */
export function scheduleSync(reason: string): void {
  if (batchedSyncTimer) clearTimeout(batchedSyncTimer);
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
 */
export async function syncNow(reason: string): Promise<void> {
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
      checkGrammarEpoch(resp, reason);
    } else if (isWholesaleRefusal(resp)) {
      // Refused without error (calibration): the deletes were drained by
      // postBatch but never applied — restore and retry after calibration.
      pendingDeleteCodewords.push(...drainedDeletes);
      bkLog('BK_SYNC_REFUSED', { result: resp.result, deletes: drainedDeletes.length });
      scheduleRefusalRetry();
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
    stampStrictViewport(chunk);
    const resp = await postBatch({
      session_id: sessionId,
      batch_index: Math.floor(start / DEFAULT_SCAN_BATCH_SIZE),
      is_final: isLast,
      kind: 'incremental',
      ...sessionMeta,
      elements: chunk.map(w => w.scanned),
    });
    if (isWholesaleRefusal(resp)) {
      // Nothing in this chunk (or any later one) was applied. Re-queue every
      // remaining put — the drain-time validity filter handles wrappers that
      // detach in the meantime — restore the deletes that rode this batch,
      // and retry once calibration has had a chance to finish.
      for (const w of puts.slice(start)) pendingPuts.add(w);
      pendingDeleteCodewords.push(...deletesRidingHere);
      bkLog('BK_SYNC_REFUSED', {
        result: resp.result, requeued: puts.length - start, deletes: deletesRidingHere.length,
      });
      scheduleRefusalRetry();
      return;
    }
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
    if (isLast) checkGrammarEpoch(resp, reason);
    if (deps.isHintsVisible() && resp.succeeded.length > 0) {
      deps.reconcile();
    }
    await new Promise(r => setTimeout(r, 0));
  }

  void reason;
}

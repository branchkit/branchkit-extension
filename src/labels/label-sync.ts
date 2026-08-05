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
 *     don't send anything). Cleared on session_id rotation.
 *
 *     That clear used to be justified as "the plugin clears its own session
 *     state on the same event". It does NOT — since the storm-resilience
 *     change it INHERITS the prior session's codewords as unconfirmed and
 *     drops whatever the rebuild fails to re-confirm when an is_final batch
 *     lands. The difference matters: a codeword nobody re-Puts is deleted
 *     plugin-side while this side has forgotten it ever existed, so neither
 *     end reports anything. That is exactly how the range-pick chips were
 *     being dropped on every rescan, and the old wording is why it took a
 *     log trace to find. Holders outside the wrapper store re-publish off
 *     the is_final chokepoint in postBatch for this reason.
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
import { GrammarBatchRequest, GrammarBatchResponse, Message, ScannedElement } from '../types';
import { isVoiceAlphabetLoaded, tokenToSpokenCodeword } from './words';
import { DEFAULT_SCAN_BATCH_SIZE } from '../scan/scanner';
import { sweepDisconnectedAfterBatch } from '../scan/batch-sweep';
import { getHintVisibility } from '../config';
import { documentInstanceId } from './document-identity';
import { republishAll } from './holder-registry';
import { labelReservoir } from './label-reservoir';
import { bkLog } from '../debug/bk-log';
import { detachWrapper } from '../core/wrapper-lifecycle';
import { pageSession } from '../lifecycle/page-session';
import {
  hasSent, markSent, unmarkSent, sentCount, queueDelete, queuePut, rotateSession,
  drainPendingPuts, requeuePut, hasPendingDeletes, drainPendingDeletes, requeueDeletes,
  getSessionId,
} from './put-queue';
import { firehoseStep } from '../debug/firehose';
import { recordSyncPost } from '../debug/sync-trace';
import { getSettleEngine } from '../lifecycle/settle-engine-ref';

/**
 * Content.ts-owned collaborators the catchup sync needs. Injected once at
 * boot via initLabelSync because they touch state this module doesn't own
 * (the wrapper store, wrapper teardown, badge paint, visibility flag).
 */
export interface LabelSyncDeps {
  store: WrapperStore;
  /**
   * Single level-triggered convergence pass (claim + build).
   *
   * Optional: it defaults to the live SettleEngine, which this module can now
   * reach on its own (lifecycle/settle-engine-ref.ts). It stays overridable
   * because tests drive the sync with no engine standing and need to observe
   * the request rather than serve it.
   */
  reconcile?: () => void;
}

let deps: LabelSyncDeps;

export function initLabelSync(d: LabelSyncDeps): void {
  deps = d;
}

/**
 * Ask for a convergence pass. The injected override wins (tests observe the
 * request); otherwise the live engine serves it directly.
 *
 * Nothing to serve it is a real boot state, not an error — a sync landing
 * before content.ts has constructed the engine has nothing to converge yet,
 * and the next pass is level-triggered anyway.
 */
// The put queue and the session id live in a leaf now (labels/put-queue.ts).
// Re-exported here because six modules already import them from this path and
// the split is about the IMPORT GRAPH, not about renaming a public surface —
// callers that only want the queue should import the leaf directly, and the
// three that had to (wrapper-lifecycle, label-reservoir, page-session) now do.
export {
  queuePut, dropPendingPut, queueDelete, cancelPendingDelete,
  markSent, hasSent, hasPendingDeletes, drainPendingDeletes,
  getSessionId, rotateSession,
} from './put-queue';

function requestReconcile(): void {
  if (deps.reconcile) { deps.reconcile(); return; }
  getSettleEngine()?.reconcile();
}


/**
 * Full grammar re-push: rotate the session, then re-queue every live,
 * hintable wrapper. The recovery arm shared by three paths that all leave the
 * plugin holding a grammar we can no longer describe with deltas —
 *
 *   - SW restart (the service worker's in-memory per-frame grammar went with
 *     it, and it wiped ours before we reconnected),
 *   - bfcache restore (navigate-away ran purgeTab + session_end, then the
 *     frozen V8 context — shadow and all — was reactivated on back/forward),
 *   - the shadow-desync tripwire above.
 *
 * `rotateSession` drops the stale shadow and hands the plugin a fresh
 * session_id, so its `ensureFrameSession` clears stale per-prefix entries.
 *
 * This lived in content.ts purely because it was written before the module
 * existed. Every collaborator it has is right here — the session, the put
 * queue, the sync debounce — and the store it walks is already an injected
 * dep, so the entry point was holding it for no one. Its `deps.republishAll`
 * field is gone with it; the tripwire calls this directly.
 */
export function republishAllGrammar(reason: string): void {
  // This used to close over the module-imported `store` and was callable from
  // import time; reading it off `deps` made it depend on initLabelSync. Every
  // caller today is well after that, but a function that could not fail should
  // not silently start throwing if a future caller lands earlier in boot.
  if (!deps) { bkLog('BK_GRAMMAR_REPUBLISH_PREINIT', { reason }, 'warn'); return; }
  rotateSession();
  let requeued = 0;
  for (const w of deps.store.all) {
    // `disconnectedAt` is load-bearing and mutation-covered. The `codeword`
    // half is NOT observable: the drain in fireBatchedSync re-checks it (and
    // re-checks it later, which is the check that matters — a codeword can go
    // away between queue and flush). Deleting it here passes every test, and
    // that is the truth rather than a coverage gap. It stays because dropping
    // it would let empty-codeword wrappers into pendingPuts, and this phase is
    // behaviour-equivalent by construction; retire it with the drain's filter
    // as one deliberate change if that redundancy is ever worth closing.
    if (w.scanned.codeword && w.disconnectedAt === null) {
      queuePut(w);
      requeued++;
    }
  }
  // Holders outside the store are NOT re-queued here: they re-publish off the
  // is_final chokepoint in postBatch, which covers this path AND the ones this
  // function never touches — notably a plain rescan, which is the common case.
  bkLog('BK_GRAMMAR_REPUBLISH', { reason, requeued, wrappers: deps.store.all.length });
  scheduleSync(reason);
}

/**
 * The hidden half of the visibility⇔speakability invariant
 * (DESIGN_HINT_VISIBILITY_SPEAKABILITY): the user hid the badges, so their
 * codewords must stop being matchable — a mishear must not activate a link
 * nobody can see. Queues a delete for every PUBLISHED store-wrapper codeword
 * and kicks a sync; the plugin's emptiness-aware gate drops the hints tag when
 * the session empties. Holder records (find chips, palette rows) describe
 * other UI that is still on screen — they are exempt and keep flowing through
 * the `is_final` chokepoint untouched. Called from setBadgesVisible(false)
 * (voice "toggle", Shift+F, the popup button) — NOT from the transient screen
 * borrow, which hides pixels for milliseconds and must not churn grammar.
 */
export function retractAllGrammar(reason: string): void {
  if (!deps) { bkLog('BK_GRAMMAR_RETRACT_PREINIT', { reason }, 'warn'); return; }
  let queued = 0;
  for (const w of deps.store.all) {
    const cw = w.scanned.codeword;
    if (cw && hasSent(cw)) {
      queueDelete(cw);
      queued++;
    }
  }
  bkLog('BK_GRAMMAR_RETRACT', { reason, queued, wrappers: deps.store.all.length });
  if (queued > 0) scheduleSync(reason);
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

/**
 * Publish pre-serialized grammar records that have no ElementWrapper — the
 * range-disambiguation badges (activate/range-disambiguation.ts, design in
 * notes/DESIGN_TEXT_TARGETING.md). One incremental single-batch POST through
 * postBatch so doc_id stamping, shadow accounting (markSent), and the desync
 * tripwire all see these codewords exactly like element puts. Returns the
 * codewords the plugin admitted.
 */
export async function publishRecords(records: ScannedElement[]): Promise<Set<string>> {
  const admitted = new Set<string>();
  if (records.length === 0 || !isVoiceAlphabetLoaded()) return admitted;
  const sid = getSessionId();
  const resp = await postBatch({
    session_id: sid,
    batch_index: 0,
    // NOT final: is_final closes a session rotation's inheritance window
    // plugin-side (batch.go commitBatchElements), dropping every codeword the
    // rebuild hasn't re-confirmed yet. A chip publish is an incremental add to
    // a session it didn't rotate, so claiming finality over it would settle
    // someone else's rebuild early and delete the page's live hints. The
    // rotating scan path owns that flag; the stale-session TTL sweep remains
    // the backstop for a rotation whose real final batch never arrives.
    is_final: false,
    kind: 'incremental',
    conn_id: '', // stamped by the background SW
    hint_visibility: getHintVisibility(),
    app_id: '',
    table_id: '',
    elements: records,
  });
  if (resp.result === 'ok' || resp.result === 'stored') {
    const failed = new Set(resp.failed.map(f => f.codeword));
    for (const r of records) {
      if (!failed.has(r.codeword)) {
        markSent(r.codeword);
        admitted.add(r.codeword);
      }
    }
    checkShadowDesync(resp, sid, 'range_records');
  }
  return admitted;
}

/** Retire published no-wrapper records: queue plugin-side deletes for the
 * codewords the shadow holds and kick a sync so they don't linger matchable. */
export function retireRecords(codewords: string[]): void {
  let queued = 0;
  for (const cw of codewords) {
    if (hasSent(cw)) {
      queueDelete(cw);
      queued++;
    }
  }
  if (queued > 0) scheduleSync('range_records_retire');
}


export async function postBatch(
  request: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id' | 'doc_id'>,
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
  // doc_id is stamped here — the one choke point every grammar POST (scan
  // path, catchup sync, pure-delete flush) flows through — so the plugin
  // can bind this frame session to THIS document, not just to a reusable
  // (tab, frame) slot. See GrammarBatchRequest.doc_id.
  const fullRequest: Omit<GrammarBatchRequest, 'tab_id' | 'frame_id'> =
    deletes.length > 0
      ? { ...request, doc_id: documentInstanceId, delete_codewords: deletes }
      : { ...request, doc_id: documentInstanceId };
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
      for (const cw of deletes) unmarkSent(cw);
      // An is_final batch closes the session's inheritance window: the plugin
      // drops every codeword the rebuild did not re-confirm. Rebuilds are
      // assembled from `store.all`, so a codeword held OUTSIDE the store is
      // never in one and is dropped every time — badges painted, matching
      // nothing.
      //
      // Hooked HERE rather than at the rotation call sites because finalizing
      // is the thing that drops them, and it has four+ entry points (the scan
      // orchestrator's chunked push, syncNow, republishAllGrammar,
      // republishForActivation, the alphabet swap). Patching call sites left
      // the common one — a plain rescan — uncovered. Re-entrancy is bounded:
      // range holders publish with is_final:false, and the store holder's
      // republish delegate is a DELIBERATE no-op — its records ARE the
      // rebuild whose final batch fires this hook, and a real re-push here
      // would finalize again and retrigger unboundedly (see the StoreHolder
      // wiring in content.ts). So this cannot retrigger itself.
      if (request.is_final) republishAll();
    } else if (deletes.length > 0) {
      // Refusal (calibration_active) or plugin-side error: nothing applied.
      requeueDeletes(deletes);
    }
    trace(resp.result, resp.failed.length);
    return resp;
  } catch {
    // Restore drained deletes on transport failure so they're carried
    // on the next attempt — otherwise an SW restart mid-scan would
    // strand the deletes silently.
    requeueDeletes(deletes);
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
// The push is display-grade (HUD menus + narrowing data) since display-grade
// demotion phase 2 — no badge opacity and no match truth ride it — so the
// cadence is relaxed toward the settle cadence (was 80ms/400ms when every
// paint waited translucent on the ACK).
const BATCHED_SYNC_DEBOUNCE_MS = 250;
// Max-wait deadline for the sync debounce (round 22b/22c): a pure trailing
// debounce starves under sustained churn — during a fling, claims and strict
// deltas reset the timer continuously and the sync NEVER fired for the
// whole scroll+swap window. Same debounce+deadline shape as the
// huge-mutation refresh (mutation-source.ts) and whenDOMSettles: the
// deadline is armed by the FIRST schedule of a burst, NOT reset by later
// ones, and whichever timer fires first clears both — so a sustained storm
// ships coalesced deltas at least every BATCHED_SYNC_MAX_WAIT_MS.
const BATCHED_SYNC_MAX_WAIT_MS = 1000;

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
 * badges but their codewords never reach the plugin's display collections —
 * missing HUD rows until an unrelated session rotation.
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

// --- Shadow-desync tripwire ---
//
// Deliberately NOT the epoch handshake reborn: one int on final batches,
// one comparison, and the existing republishAllGrammar as the recovery —
// no epochs, no ladder, no probes. What it detects is the one failure the
// delta-sync design cannot self-heal: the plugin's per-frame grammar
// diverging from our sentCodewords shadow (wiped out from under us, or
// entries the plugin holds that we no longer know about). The shadow then
// computes empty deltas forever — painted badges, voice-dead — until an
// unrelated rotation. Three independent members of this family have now
// occurred (tab_switch destructive cleanup 2026-06-12, SW-restart
// confirmLabels wedge, the doc-mismatch session_end wipe of 2026-07-24);
// this catches the members nobody has met yet. Sensing-freeze compliant:
// it widens the existing batch reconcile, no new observer/timer/gate.
//
// Race honesty: the scan path and the catchup sync are independent
// pipelines, so a final batch's count CAN transiently disagree with the
// shadow while the other pipeline is mid-flight. The cooldown caps a
// spurious fire at one republish (same cost as a bfcache restore), and
// the log line makes any recurrence visible during soak.
const SHADOW_DESYNC_REPUBLISH_COOLDOWN_MS = 10_000;
let lastShadowDesyncRepublishAt = 0;

/**
 * Test-only. The cooldown is module state that outlives a test, and vitest
 * reinstalls fake timers at the REAL clock each `beforeEach` — so a test that
 * advanced time and republished leaves a stamp in the *future* relative to the
 * next test, silently suppressing its republish. That made the
 * `committed_codewords` guard test pass on the cooldown rather than the guard.
 */
export function _resetShadowDesyncCooldownForTesting(): void {
  lastShadowDesyncRepublishAt = 0;
}

export function checkShadowDesync(resp: GrammarBatchResponse, requestSessionId: string, context: string): void {
  if (resp.result !== 'ok' && resp.result !== 'stored') return;
  if (typeof resp.committed_codewords !== 'number') return;
  // A rotation happened while this batch was in flight: the count
  // describes a dead session and the shadow was just cleared — nothing
  // meaningful to compare.
  if (requestSessionId !== getSessionId()) return;
  const shadow = sentCount();
  if (resp.committed_codewords === shadow) return;
  bkLog('BK_GRAMMAR_SHADOW_DESYNC', { committed: resp.committed_codewords, shadow, context });
  const now = Date.now();
  if (now - lastShadowDesyncRepublishAt < SHADOW_DESYNC_REPUBLISH_COOLDOWN_MS) return;
  lastShadowDesyncRepublishAt = now;
  republishAllGrammar(`shadow_desync_${context}`);
}

/**
 * Debounced entry point for every grammar-relevant change (MO mutations,
 * IT codeword claims, finalize-sweep detaches, bfcache restore). Coalesces
 * dense bursts into one catchup flush. (The round-34b mass-claim fast path
 * retired with display-grade demotion phase 2 — it existed to shrink the
 * bk-pending translucent window, which no longer exists.)
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
  const drained = drainPendingPuts();
  let puts = drained.filter(w =>
    w.scanned.codeword && deps.store.findWrapperFor(w.element) === w,
  );

  // Visibility gates the puts (DESIGN_HINT_VISIBILITY_SPEAKABILITY): while
  // badges are hidden, a put would publish a codeword for something the user
  // cannot see — the catch-up scans that run during a hide would silently
  // undo retractAllGrammar. DEFER, never drop: requeue and let the shown
  // edge flush (republishAllGrammar re-queues everything anyway), so the
  // transient screen borrow (find/pick) loses nothing. Deletes flow
  // regardless — retraction and detach cleanup must work while hidden.
  if (!pageSession.badgesVisible && puts.length > 0) {
    for (const w of puts) requeuePut(w);
    bkLog('BK_GRAMMAR_PUTS_DEFERRED', { reason, deferred: puts.length });
    puts = [];
  }

  // Pure-empty delta — nothing changed since last push. Skip the
  // round-trip entirely. This is the "hash-skip for free" case: in
  // the steady state the only way to land here is "MO fired but no
  // hintability change", which is the bulk of cosmetic-mutation
  // pages (style toggles, animation classes, hover state churn).
  if (puts.length === 0 && !hasPendingDeletes()) {
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
    const sid = getSessionId();
    const drainedDeletes = drainPendingDeletes();
    const resp = await postBatch({
      session_id: sid,
      batch_index: 0,
      is_final: true,
      kind: 'incremental',
      ...sessionMeta,
      elements: [],
    }, drainedDeletes);
    if (resp.result === 'ok' || resp.result === 'stored') {
      checkShadowDesync(resp, sid, 'delete_flush');
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
  // delta is ~40 chunks — sequential awaits summed to a 3-3.5s HUD-staleness
  // window. The plugin imposes
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

  const handleResponse = (chunk: ElementWrapper[], resp: GrammarBatchResponse, deletesRiding: string[], isLast: boolean, sid: string): void => {
    if (resp.result === 'error') {
      // Transport failure ('error' is synthetic — the SW's transportFailure
      // or a failed sendMessage; the plugin only answers ok/stored/
      // calibration_active). The plugin never saw this chunk, so its
      // per-codeword `failed` list describes nothing the plugin decided —
      // detaching on it is what turned "BranchKit closed" into a
      // paint→detach→rediscover→repaint flash loop on every live page.
      // Keep the wrappers painted (typing works regardless), re-queue
      // their Puts, and stop dispatching
      // further chunks (they'd fail the same way). postBatch already
      // restored any deletes that rode this chunk. No retry timer:
      // convergence comes from the next churn-triggered sync, the liveness
      // onResync after an SW restart, or the sse_connect reactivate
      // (rotate + full re-Put) once the host returns — a timer here would
      // hammer forever in the standalone-with-stale-alphabet steady state.
      halted = true;
      for (const w of chunk) requeuePut(w);
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
      for (const w of chunk) requeuePut(w);
      bkLog('BK_SYNC_REFUSED', {
        result: resp.result, requeued: chunk.length, deletes: deletesRiding.length,
      });
      scheduleRefusalRetry();
      return;
    }
    if (resp.failed.length > 0) {
      const failedSet = new Set(resp.failed.map(f => f.codeword));
      let requeued = 0;
      for (const w of chunk) {
        // Guard the empty string (round 30): a wrapper released while its
        // chunk was in flight has codeword '' — an ''-keyed failure would
        // match EVERY such wrapper. A per-codeword plugin failure keeps the
        // badge painted (display-grade demotion phase 2: it is fully
        // speakable under sealed dispatch; the miss is a HUD-menu row) and
        // re-queues the Put for the next delta.
        if (w.scanned.codeword && failedSet.has(w.scanned.codeword)) {
          if (w.element.isConnected) {
            requeuePut(w);
            requeued++;
          } else {
            detachWrapper(w.element);
          }
        }
      }
      if (requeued > 0) bkLog('BK_SYNC_PUT_FAILED_REQUEUED', { requeued });
    }
    const succeededSet = new Set(resp.succeeded);
    for (const cw of succeededSet) markSent(cw);
    // (Deletes that rode this chunk were already settled by postBatch.)
    const succeededWrappers = chunk.filter(w => succeededSet.has(w.scanned.codeword));
    // The sweep pushes the codewords of wrappers that left the DOM. Collected
    // locally and handed back rather than letting it mutate the queue's array
    // in place — same order, same batch, and the queue keeps its encapsulation.
    const sweptDeletes: string[] = [];
    sweepDisconnectedAfterBatch(succeededWrappers, (el) => el.isConnected, sweptDeletes, detachWrapper);
    requeueDeletes(sweptDeletes);
    // Reconcile on the final chunk only — intermediate responses
    // describe a half-applied sync by construction.
    if (pageSession.badgesVisible && resp.succeeded.length > 0) {
      requestReconcile();
    }
    // Middle chunks describe a half-applied sync; only the final chunk's
    // post-commit count is comparable against the settled shadow.
    if (isLast) checkShadowDesync(resp, sid, 'sync_final');
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
    const sid = getSessionId();
    const resp = await postBatch({
      session_id: sid,
      batch_index: index,
      is_final: isLast,
      kind: 'incremental',
      ...sessionMeta,
      elements: chunk.map(w => w.scanned),
    }, deletesRiding);
    handleResponse(chunk, resp, deletesRiding, isLast, sid);
  };

  // A halt (refusal or transport failure) leaves chunks that were never
  // dispatched: their puts were drained from pendingPuts at the top of this
  // sync but no handleResponse will ever re-queue them — without this they
  // silently vanish from the delta, stranding painted badges unmatchable
  // until an unrelated rotation. Dispatched chunks re-queue themselves in
  // handleResponse; this covers only the ones the halt short-circuited.
  const requeueUndispatched = (fromIndex: number): void => {
    for (const c of chunks.slice(fromIndex)) {
      for (const w of c) requeuePut(w);
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

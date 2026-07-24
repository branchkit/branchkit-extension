/**
 * BranchKit Browser — scan orchestration (content side).
 *
 * The full-document discovery pipeline: the promise-chain scan lock (one
 * scan at a time, triggers fold into a single pending re-run), the 50ms
 * trigger coalescer, the batched walk (round 31: batches PIPELINE — paint
 * proceeds at walk speed while grammar POSTs fly concurrently), and the
 * per-batch claim/attach/POST/ack partitioning. Lifted verbatim out of
 * content.ts per notes/DESIGN_RESTRUCTURE_ROUND3.md; the per-frame gates it
 * reads (hintMachineryEnabled / suspended) moved onto PageSession with it.
 */

import { ScannedElement, HintVisibility } from '../types';
import { DiscoverySource, ElementWrapper } from '../scan/element-wrapper';
import { scanInBatches, DEFAULT_SCAN_BATCH_SIZE } from './scanner';
import { filterNewBatchRefs } from './batch-dedup';
import * as idRegistry from './registry';
import { store } from '../core/store';
import { attachWrapper, detachWrapper } from '../core/wrapper-lifecycle';
import { dropDisconnectedWrappers } from '../observe/limbo';
import { observeInvisibleCandidates } from '../observe/visibility-tracker';
import { stampStrictViewport } from '../lifecycle/strict-viewport';
import { pageSession } from '../lifecycle/page-session';
import { getActiveAdapter } from '../adapters';
import { getCompiledRule, applyUserRuleToScan } from '../rules/rule-apply';
import { applyExclusions, collectInclusions } from '../rules/domain-rules';
import { isRecallLoaded, resolvePreferredCodeword, rememberClaimedCodewords } from '../labels/codeword-recall';
import {
  queuePut, queueDelete, markSent, hasPendingDeletes, drainPendingDeletes,
  getSessionId, claimLabels, postBatch,
} from '../labels/label-sync';
import { recordCpu, claimCounters } from '../debug/perf-counters';
import { getHintVisibility } from '../config';
import { yieldTask } from '../lifecycle/page-session';

/**
 * Full re-discovery of hintable elements in the document. Idempotent:
 * already-known elements keep their wrappers (and codewords); newly
 * discovered elements get fresh wrappers; elements no longer in the DOM
 * are dropped.
 *
 * doScan no longer claims codewords directly — that's the tracker's
 * job, gated by viewport intersection. doScan only ensures every
 * hintable element has a wrapper that the tracker is observing.
 */
// Promise-chain lock for doScanBatched. Multiple call sites (chrome.storage
// onChanged for alphabet/rules/badge settings; MO settle; focus restore; nav
// recovery; explicit triggers from messages) can fire within the same tick.
// Pre-fix the chained scans overlapped: each got the same getSessionId(),
// each ran its own batch generator, and they posted batches with overlapping
// batch_indices. The plugin processed both, and the same DOM element ended
// up with two distinct wrappers each holding a different "real" codeword —
// either neither could cleanly invalidate the other or, depending on
// attach-order timing, the same codeword landed on two wrappers. QuickBase
// table virtualization reliably reproduced this 2026-06-05T17:00:42.
//
// Pattern: one scan runs at a time; if more triggers arrive while a scan is
// in flight, they collapse into a single pending re-run that fires after
// the current scan completes. Two triggers that arrive during one in-flight
// scan still produce only one re-run — the scheduling is idempotent for the
// pending slot.
let scanChain: Promise<void> = Promise.resolve();
let scanPending = false;
// `source` labels wrappers this scan attaches (wave.discovery_sources):
// 'scan' for the boot/storage/activation walks, 'rescan' when the nav-rescan
// tail drives it. A trigger folded into an already-pending run keeps the
// pending run's label — diagnostic, not load-bearing.
export function doScan(source: DiscoverySource = 'scan'): Promise<void> {
  // Lever 2 (visibility-defer): pageSession.hintMachineryEnabled is the single gate for ALL
  // scan work, not just the boot path. It's false for an ineligible frame
  // (Lever 1 frame-skip) or a backgrounded tab whose activation is deferred —
  // neither should run a full-document discovery walk. So a rescan/reactivate/
  // show_hints message that arrives while deferred no-ops here; the scan runs
  // from kickInitialScan when the tab is first shown (activateHintMachinery sets
  // this flag before kickInitialScan, so the normal activation scan still runs).
  // Also no-op while suspended (Lever 3): a rescan/reactivate for a hidden tab
  // waits; resume() runs the catch-up scan after re-attaching the observer.
  if (!pageSession.hintMachineryEnabled || pageSession.suspended) return scanChain;
  // If a scan is in flight and another is already pending, fold this
  // trigger into the existing pending re-run.
  if (scanPending) return scanChain;
  scanPending = true;
  scanChain = scanChain.then(async () => {
    // Clear the pending flag at the START of the run, so triggers that
    // arrive DURING this scan can schedule the next re-run. Triggers that
    // arrived before we got here have already been folded; the flag's
    // role from here forward is "is the NEXT slot taken."
    scanPending = false;
    try {
      await doScanBatched(source);
    } catch {
      // Swallow so a failed scan doesn't break the chain. The next
      // trigger still gets a fresh attempt.
    }
  });
  return scanChain;
}

/**
 * Coalesce multiple doScan triggers that fire close together (storage
 * onChanged for alphabet + domain rules + badge settings all delivered
 * within a tick is the common case) into a single rescan. Without this,
 * each storage event runs its own ~500-900 ms doScanBatched and the user
 * sees a back-to-back stall pair right at page load. The 50 ms window is
 * tight enough to feel immediate but wide enough to fold all chrome
 * storage events from one logical change.
 *
 * Callers that need the scan to have completed before continuing should
 * still call doScan() directly. The chrome.storage listeners do not —
 * they kick the scan and let the rest of the page-state recovery (DOM
 * settle, show, etc.) wait on its own timers.
 */
let doScanCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
const DO_SCAN_COALESCE_MS = 50;
export function scheduleDoScan(): void {
  if (doScanCoalesceTimer) return;
  doScanCoalesceTimer = pageSession.resources.timeout(() => {
    doScanCoalesceTimer = null;
    doScan();
  }, DO_SCAN_COALESCE_MS);
}


async function doScanBatched(source: DiscoverySource): Promise<void> {
  const __cpuStart = performance.now();

  // Uses the LabelStage session id — see Problem 1 in the design doc.
  const cr = getCompiledRule();
  const adapter = getActiveAdapter(window.location.href);

  // Inclusions run ONCE per scan (item 15: per-batch inclusion would
  // be N querySelectorAll for the whole document). Pre-mark these
  // refs so the scanner walk doesn't rediscover them.
  let inclusionRefs: Element[] = [];
  let inclusionElements: ScannedElement[] = [];
  if (cr?.includeSelector) {
    const inc = collectInclusions(new Set(), cr.includeSelector, document);
    inclusionRefs = inc.refs;
    inclusionElements = inc.elements;
  }
  const initialSeen = new Set<Element>(inclusionRefs);

  // Drop wrappers whose elements disconnected since the last scan
  // BEFORE walking — same as the old doScan path's end-of-pass sweep
  // but moved up so the per-batch loop starts from a clean store.
  dropDisconnectedWrappers();

  const sessionMeta = {
    conn_id: '', // stamped by the background SW in postGrammarBatch
    hint_visibility: getHintVisibility(),
    app_id: '',
    table_id: '',
  };

  let batchIndex = 0;

  // Round 31: batches PIPELINE. Each processScanBatch attaches + paints
  // synchronously before its POST, so the walk (and therefore paint)
  // proceeds at content speed while the grammar round-trips fly
  // concurrently — the old shape awaited each batch's POST before
  // walking the next, which on a report load serialized paint behind
  // ~25 sequential plugin round-trips (the Rango gap, DESIGN_FLING_WAVE
  // round 31). Claims stay ordered: everything up to each batch's POST
  // runs in call order on the main thread. Rejections are swallowed at
  // push time (parity with doScan's catch) so an unhandled rejection
  // can't fire while the collection awaits later batches.
  const inFlight: Promise<void>[] = [];

  // Synthetic first "batch" for inclusion-rule elements, if any. Goes
  // through the same processing path so its codewords get Put and the
  // succeeded ones paint. is_final stays false because the scanner
  // walk will follow with at least its own terminal batch.
  if (inclusionRefs.length > 0) {
    inFlight.push(processScanBatch(
      { refs: inclusionRefs, elements: inclusionElements, isLast: false, invisibleCandidates: [] },
      getSessionId(), batchIndex, sessionMeta, adapter, source,
    ).catch(() => {}));
    batchIndex++;
  }

  for (const batch of scanInBatches(
    adapter ? document : document, DEFAULT_SCAN_BATCH_SIZE, initialSeen,
  )) {
    if (batch.isLast) {
      // The terminal batch carries is_final, which closes the plugin's
      // scan window — it must be ADMITTED after every middle batch, so
      // hold its POST until the in-flight ones settle (same ordering
      // discipline as syncNow's pipelined chunks, round 29c).
      await Promise.allSettled(inFlight);
      await processScanBatch(batch, getSessionId(), batchIndex, sessionMeta, adapter, source);
    } else {
      inFlight.push(
        processScanBatch(batch, getSessionId(), batchIndex, sessionMeta, adapter, source)
          .catch(() => {}),
      );
    }
    batchIndex++;
    // Yield to the event loop between batches so MutationObserver
    // can fire and any DOM removal mid-scan flags the wrapper's
    // element as disconnected before the next batch (item 5
    // mitigation; the sweep itself runs in processScanBatch).
    // scheduler.yield, not setTimeout(0) — the timer hop costs
    // 50-150ms per batch under load (storm-hop class, instance #5).
    await yieldTask();
  }
  // Belt-and-braces: if the generator yielded no isLast batch (empty
  // document), middle POSTs may still be in flight — settle them before
  // the deletes flush below reads hasPendingDeletes.
  await Promise.allSettled(inFlight);

  // If the batch sweeps queued deletes, flush them now via an empty
  // deletes-only batch — otherwise they'd strand until the next
  // user-driven scan. Deletes no longer hitchhike on the pipelined
  // middle batches (postBatch takes them explicitly and settles the
  // sentCodewords shadow itself), so this ordered flush is the scan
  // path's one delete carrier. Reuses the same session_id so
  // plugin-side session tracking stays consistent.
  if (hasPendingDeletes()) {
    await postBatch({
      session_id: getSessionId(),
      batch_index: batchIndex,
      is_final: true,
      kind: 'scan',
      conn_id: sessionMeta.conn_id,
      hint_visibility: sessionMeta.hint_visibility,
      app_id: sessionMeta.app_id,
      table_id: sessionMeta.table_id,
      elements: [],
    }, drainPendingDeletes());
  }
  recordCpu('doScanBatched', performance.now() - __cpuStart);
}

async function processScanBatch(
  batch: { refs: Element[]; elements: ScannedElement[]; isLast: boolean; invisibleCandidates: Element[] },
  sessionId: string, batchIndex: number,
  sessionMeta: { conn_id: string; hint_visibility: HintVisibility; app_id: string; table_id: string },
  adapter: ReturnType<typeof getActiveAdapter>,
  source: DiscoverySource,
): Promise<void> {
  // Sync slab 1: exclusions + dedup + candidate construction. Measured
  // separately from the surrounding awaits so the recorded ms reflects
  // actual main-thread block time, not wall-clock through claim+POST.
  // Compare with `doScanBatched` (wall-clock across all batches +
  // yields) — that bucket is useful for "how long did this scan feel"
  // but a single high value there doesn't imply a freeze. The sync
  // buckets here are the freeze attribution surface.
  const __syncAStart = performance.now();
  {
    const cr = getCompiledRule();
    if (cr?.excludes.length) applyExclusions(batch.refs, batch.elements, cr.excludes);
  }

  // Drop refs whose wrappers already exist in the store
  // (notes/DESIGN_OPTION_B_REATTEMPT.md "Problem 2"). Their codewords
  // are already in the plugin's session.Codewords from a prior batch
  // and will be re-pushed by the cumulative buildTabPrefixState.
  // Re-claiming pool labels for them depletes the pool: the duplicate
  // wrapper would be discarded but the just-claimed label stays in
  // the pool's `assigned` map. Empirically this drained the pool
  // after ~10 rescans on QuickBase.
  const { newRefs, newElements } = filterNewBatchRefs(
    batch.refs, batch.elements, (el) => store.findWrapperFor(el) !== undefined,
  );
  recordCpu('processScanBatch:syncA', performance.now() - __syncAStart);

  // No new elements to claim — bail unless this is the terminal batch,
  // in which case the protocol still needs an is_final marker so the
  // plugin closes out the scan window.
  if (newRefs.length === 0 && !batch.isLast) {
    return;
  }

  // Pool-claim codewords for the batch. claimLabels serializes per
  // tab via withTabLock so multi-frame pages don't collide.
  //
  // Regime B reclaim (DESIGN_REGIME_B_RECALL.md): resolve each element's
  // remembered codeword by fingerprint and request it, so after a reload the
  // RIGHT element gets its own letter back instead of whatever sits front-of-
  // pool. Skipped when nothing is remembered (fresh page) so we don't pay the
  // per-element fingerprint read for no reclaim.
  const scanPreferred = isRecallLoaded()
    ? newRefs.map((el) => resolvePreferredCodeword(idRegistry.computeFingerprint(el), null) ?? '')
    : [];
  const labels = await claimLabels(newRefs.length, scanPreferred);

  // Build candidate wrappers with codewords assigned. These attach and
  // paint BEFORE the grammar POST (round 31): the badge appears at walk
  // speed in the translucent bk-pending state and the ACK solidifies it —
  // exactly the tracker/IO path's contract. The old shape held
  // attachWrapper until after the POST "so no badge paints before the
  // plugin acknowledges", but with sequential per-batch round-trips that
  // serialized ALL paint behind ~25 plugin POSTs on a report load:
  // seconds of bare grid rows while Rango painted during its walk. The
  // badge-implies-functional contract is carried by bk-pending, not by
  // withholding paint.
  const candidates: ElementWrapper[] = [];
  for (let i = 0; i < newRefs.length; i++) {
    const label = i < labels.length ? labels[i] : '';
    if (!label) continue;  // pool exhausted; element stays unaddressable
    newElements[i].codeword = label;
    claimCounters.scanPathClaimed++;
    const cw = new ElementWrapper(newRefs[i], newElements[i]);
    cw.tClaimed = performance.now(); // scan-path claim: born codeworded
    candidates.push(cw);
  }

  // Even an empty batch sends an is_final marker so the plugin
  // knows the scan ended (matters for the C7 cleanup window).
  if (candidates.length === 0 && !batch.isLast) {
    return;
  }

  const adapterName = adapter?.name ?? '';
  void adapterName; // reserved for plugin-side adapter-aware routing

  // Sync slab 2: attach loop + paint, now PRE-POST. Everything here is
  // synchronous; if any of it takes >50ms it's a real main-thread block.
  const __syncBStart = performance.now();

  stampStrictViewport(candidates);
  for (const w of candidates) {
    attachWrapper(w, source);
  }

  // Record the scan-path claims in the codeword memory (SW + live index). The
  // tracker path does this via its onCodewordsChanged callback; the scan path
  // claims labels upfront (claimLabels), so without this its codewords would
  // never seed a future reclaim — the SPA-rebuild churn the QuickBase sidebar
  // hit. See rememberClaimedCodewords / codeword-recall.
  if (candidates.length > 0) rememberClaimedCodewords(candidates);

  // Paint immediately, at full opacity. Gated by pageSession.badgesVisible
  // so manual-mode batches don't paint until "show".
  if (pageSession.badgesVisible && candidates.length > 0) {
    pageSession.engine.reconcile();
  }

  // Surface terminal-batch invisibleCandidates to the
  // ResizeObserver path (same as the old doScan's end-of-pass).
  if (batch.isLast && batch.invisibleCandidates.length > 0) {
    observeInvisibleCandidates(batch.invisibleCandidates);
  }
  recordCpu('processScanBatch:syncB', performance.now() - __syncBStart);

  const resp = await postBatch({
    session_id: sessionId,
    batch_index: batchIndex,
    is_final: batch.isLast,
    kind: 'scan',
    conn_id: sessionMeta.conn_id,
    hint_visibility: sessionMeta.hint_visibility,
    app_id: sessionMeta.app_id,
    table_id: sessionMeta.table_id,
    elements: candidates.map(w => w.scanned),
  });

  // Transport failure (result 'error' is synthetic — the SW's
  // transportFailure or a failed sendMessage; the plugin only ever answers
  // ok/stored/calibration_active): the plugin never saw the batch, so this
  // is not a rejection and the rollback below must not run. Detaching here
  // is what made hints FLASH whenever BranchKit was closed with a persisted
  // voice alphabet: paint → failed POST → detach → the reconcile/MO
  // machinery rediscovers the bare elements → repaint → fail again. Keep
  // the wrappers attached and painted (bk-pending carries the voice-not-
  // live signal; typing works regardless — the extension-independence
  // contract) and queue their Puts. Convergence when voice returns needs no
  // retry timer: the sse_connect reactivate and the liveness onResync both
  // rotate + re-queue every live codeworded wrapper.
  if (resp.result === 'error') {
    for (const w of candidates) {
      if (w.scanned.codeword === '' || store.findWrapperFor(w.element) !== w) continue;
      if (!w.element.isConnected) {
        // Disconnected during the round-trip; never sent, so a plain
        // detach (no plugin-side Delete) is correct.
        detachWrapper(w.element);
        continue;
      }
      queuePut(w);
    }
    return;
  }

  // Response partitioning — solidify or roll back. The wrapper may have
  // been detached (MO removal, dedup by a later scan) or its element
  // disconnected during the round-trip, so revalidate store ownership
  // per wrapper (round 30's lesson) before acting on the ACK.
  const succeededSet = new Set(resp.succeeded);
  for (const w of candidates) {
    const cw = w.scanned.codeword;
    const stillMine = cw !== '' && store.findWrapperFor(w.element) === w;
    if (cw !== '' && succeededSet.has(cw)) {
      if (stillMine && w.element.isConnected) {
        // Delta-sync: the plugin acknowledged this codeword, so it's live
        // on the plugin side. Mark it so future detaches know to send a
        // Delete and future syncs skip re-Putting it.
        markSent(cw);
      } else if (stillMine) {
        // Element disconnected during the round-trip. Plugin holds the
        // codeword; markSent first so detachWrapper's delta-sync queues
        // the Delete through the normal plumbing.
        markSent(cw);
        detachWrapper(w.element);
      } else {
        // Already detached mid-flight (before markSent, so no Delete was
        // queued then). The plugin holds the codeword — queue the Delete
        // manually, UNLESS the released label was already reclaimed by a
        // live wrapper, in which case the plugin entry now (or soon)
        // belongs to that wrapper and deleting it would orphan a painted
        // badge.
        if (!store.all.some((lw) => lw.scanned.codeword === cw)) {
          queueDelete(cw);
        }
      }
    } else if (stillMine) {
      // Failed or unacknowledged: never live on the plugin side. Keep the
      // badge painted — under sealed dispatch it is fully speakable without
      // the plugin entry (display-grade demotion phase 2); the miss is a
      // HUD-menu row. Queue a re-Put and let the next delta retry.
      if (w.element.isConnected) {
        queuePut(w);
      } else {
        // Disconnected during the round-trip; never sent, plain detach.
        detachWrapper(w.element);
      }
    }
  }
}


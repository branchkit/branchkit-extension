/**
 * The local mirror of plugin-side grammar state, and the queue of changes not
 * yet sent to it.
 *
 * Three collections and a session id, which rotate together and are therefore
 * one thing:
 *
 *   sentCodewords          — what the plugin currently holds, as far as this
 *                            frame knows. The shadow every delta is computed
 *                            against.
 *   pendingPuts            — wrappers whose codeword exists locally but has
 *                            not been pushed.
 *   pendingDeleteCodewords — codewords queued for plugin-side delete.
 *   sessionId              — which plugin-side session all of the above
 *                            belongs to. Rotating it invalidates the other
 *                            three, which is why `rotateSession` lives here
 *                            and resets all four atomically.
 *
 * WHY THIS IS A SEPARATE MODULE, since it was carved out of label-sync and the
 * batching logic that reads it still lives there. Three modules needed the
 * queue and nothing else: `core/wrapper-lifecycle` (five symbols),
 * `labels/label-reservoir` (three), and `lifecycle/page-session` (the session
 * id). Reaching them through label-sync made label-sync unimportable BY those
 * modules, and that single fact was what kept three callback seams alive in
 * content.ts — `initLabelSync`'s `detachWrapper` and `isBadgesVisible`, and
 * the reservoir's `onLeakSwept`. The queue is a leaf, so every one of those
 * inverts (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md §6f).
 *
 * So: nothing here may import anything that reaches label-sync, page-session
 * or wrapper-lifecycle. It is a sink on purpose. `debug/bk-log` (whose only
 * import is a type) and the `ElementWrapper` TYPE are the whole dependency
 * budget.
 */

import { bkLog } from '../debug/bk-log';
import type { ElementWrapper } from '../scan/element-wrapper';

const sentCodewords: Set<string> = new Set();
const pendingPuts: Set<ElementWrapper> = new Set();
const pendingDeleteCodewords: string[] = [];

// --- Puts ---

/** Enqueue a newly-codeworded wrapper for the next Put. */
export function queuePut(w: ElementWrapper): void {
  pendingPuts.add(w);
}

/** Drop a pending Put (the wrapper detached before it was flushed). */
export function dropPendingPut(w: ElementWrapper): void {
  pendingPuts.delete(w);
}

/**
 * Snapshot and clear the pending Puts.
 *
 * Callers drain BEFORE any await so a codeword claimed during the round-trip
 * re-queues for the next push rather than being lost to the clear.
 */
export function drainPendingPuts(): ElementWrapper[] {
  const drained = [...pendingPuts];
  pendingPuts.clear();
  return drained;
}

/** Put back a wrapper whose push failed or was superseded. */
export function requeuePut(w: ElementWrapper): void {
  pendingPuts.add(w);
}

// --- Deletes ---

/** Queue a codeword for plugin-side delete on the next batch. */
export function queueDelete(codeword: string): void {
  pendingDeleteCodewords.push(codeword);
}

/**
 * Un-queue a delete for a codeword that came BACK before the batch flushed.
 *
 * The element path never needs this: its Puts and Deletes ride the same
 * debounced batch, so the plugin applies them together in a defined order.
 * `publishRecords` (the range-pick chips) POSTs immediately while retires wait
 * for the debounce — so a codeword released and re-claimed in one turn is Put
 * now and Deleted a quarter-second later, leaving a chip that is painted and
 * armed but absent from the hint collections, and therefore missing from the
 * Discovery HUD's suffix menu. Recycling codewords is deliberate (a chip the
 * user is mid-way through saying must not be renamed), so the retire has to
 * yield instead.
 */
export function cancelPendingDelete(codeword: string): void {
  for (let i = pendingDeleteCodewords.length - 1; i >= 0; i--) {
    if (pendingDeleteCodewords[i] === codeword) pendingDeleteCodewords.splice(i, 1);
  }
}

/** Whether any deletes are queued (drives the scan path's terminal flush). */
export function hasPendingDeletes(): boolean {
  return pendingDeleteCodewords.length > 0;
}

/** Drain the queued deletes for an outbound batch. The caller owns settling
 *  them — see postBatch, which re-queues on refusal or transport failure. */
export function drainPendingDeletes(): string[] {
  if (pendingDeleteCodewords.length === 0) return [];
  const drained = pendingDeleteCodewords.slice();
  pendingDeleteCodewords.length = 0;
  return drained;
}

/** Put drained deletes back — a refused batch applied none of them. */
export function requeueDeletes(codewords: readonly string[]): void {
  pendingDeleteCodewords.push(...codewords);
}

// --- The sent shadow ---

/** Mark a codeword as live on the plugin side (acknowledged in a POST). */
export function markSent(codeword: string): void {
  sentCodewords.add(codeword);
}

/** Whether the plugin currently holds this codeword. */
export function hasSent(codeword: string): boolean {
  return sentCodewords.has(codeword);
}

/** Forget a codeword the plugin has now dropped (an applied delete). */
export function unmarkSent(codeword: string): void {
  sentCodewords.delete(codeword);
}

/** Size of the shadow — the count `checkShadowDesync` compares against. */
export function sentCount(): number {
  return sentCodewords.size;
}

// --- Session ---

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

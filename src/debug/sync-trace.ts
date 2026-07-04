/**
 * BranchKit Browser — grammar-sync transport trace (round 22b,
 * DESIGN_FLING_WAVE.md).
 *
 * The 22b drill showed the post-swap incremental sync shipping NOTHING for
 * ~25s (289 badges stuck translucent until the epoch rotate+republish),
 * and the existing logging can't say why: BK_SYNC_REFUSED covers wholesale
 * refusals, but silent sendMessage failures, slow round-trips, and
 * session-rotation races are invisible. This ring records every postBatch
 * outcome so the next drill names the stall's mechanism the way the churn
 * ring named the wipe.
 *
 * Pure observation — no behavior change, no retry logic here.
 */

export interface SyncTraceRecord {
  /** performance.now at postBatch entry. */
  t: number;
  /** Round-trip wall time (ms). */
  elapsedMs: number;
  /** Response result, or the synthetic cases: 'error' (sendMessage threw),
   * 'local_ack' (standalone — no plugin connected). */
  result: string;
  /** Put elements in the request. */
  elements: number;
  /** Deletes riding the request. */
  deletes: number;
  /** Per-codeword failures in the response. */
  failedN: number;
  /** First 8 chars of the session id — enough to see rotation races. */
  session: string;
  kind: string;
  batchIndex: number;
  isFinal: boolean;
}

const RING_MAX = 200;
const ring: SyncTraceRecord[] = [];
let totalPosts = 0;
let totalTransportErrors = 0;

export function recordSyncPost(rec: SyncTraceRecord): void {
  totalPosts++;
  if (rec.result === 'error') totalTransportErrors++;
  ring.push(rec);
  if (ring.length > RING_MAX) ring.splice(0, ring.length - RING_MAX);
}

/** Snapshot view: totals + the window's records, newest last. */
export function syncTraceStats(windowMs: number): {
  posts_total: number;
  transport_errors_total: number;
  recent: Array<{
    t: number;
    elapsed_ms: number;
    result: string;
    elements: number;
    deletes: number;
    failed_n: number;
    session: string;
    kind: string;
    batch: number;
    is_final: boolean;
  }>;
} {
  const cutoff = performance.now() - windowMs;
  return {
    posts_total: totalPosts,
    transport_errors_total: totalTransportErrors,
    recent: ring
      .filter((r) => r.t >= cutoff)
      .map((r) => ({
        t: Math.round(r.t),
        elapsed_ms: Math.round(r.elapsedMs),
        result: r.result,
        elements: r.elements,
        deletes: r.deletes,
        failed_n: r.failedN,
        session: r.session,
        kind: r.kind,
        batch: r.batchIndex,
        is_final: r.isFinal,
      })),
  };
}

export function resetSyncTrace(): void {
  ring.length = 0;
  totalPosts = 0;
  totalTransportErrors = 0;
}

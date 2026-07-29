/**
 * Which documents currently hold a live liveness Port, as a leaf.
 *
 * The set itself used to live inside `background/frame-liveness.ts`, which is
 * its only WRITER. It moved here because it gained a second READER —
 * `labels/label-pool.ts`, for the stranded-assignment reap
 * (notes/DESIGN_ASSIGNED_LABEL_RECLAIM.md) — and frame-liveness already imports
 * `releaseDocument` FROM label-pool, so a direct import back would close a
 * cycle. A leaf both sides import closes none, and needs no injected callback.
 *
 * IN-MEMORY AND WORKER-SCOPED, which is load-bearing for every reader: an MV3
 * service worker is idle-terminated routinely, and on restart this set is EMPTY
 * even though the pages are still there and still hold labels. Content scripts
 * re-register their Ports through the SW-restart healer, but not instantly.
 *
 * So "not live" means "no Port right now", NOT "this document is gone". Any
 * reclaim keyed off this must additionally require age — see
 * `ASSIGNMENT_STALE_MS` in label-pool.ts. Treating absence as death on its own
 * would free the labels of the page the user is looking at, moments after every
 * worker restart.
 */

const livePortDocs = new Set<string>();

export function markDocLive(docId: string): void {
  livePortDocs.add(docId);
}

export function markDocGone(docId: string): void {
  livePortDocs.delete(docId);
}

/** Does this document hold a live liveness Port *in this worker generation*? */
export function isDocPortLive(docId: string): boolean {
  return livePortDocs.has(docId);
}

/** Test seam — production only adds and removes through the Port lifecycle. */
export function _resetDocLivenessForTesting(): void {
  livePortDocs.clear();
}

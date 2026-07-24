/**
 * BranchKit Browser — this document's pool-ownership identity.
 *
 * One UUID per content-script context, minted at module evaluation. A
 * content-script context IS a document: bfcache freezes and restores the
 * same context (same id), prerender activation continues the same context
 * (same id), navigation creates a new context (new id) — exactly the
 * lifetime that label ownership follows. This CS-minted id is the pool's
 * primary ownership key (DESIGN_DOCUMENT_SCOPED_POOL_OWNERSHIP.md);
 * the browser-native `sender.documentId` (Chrome 106+/Firefox 153+) is too
 * new to be the floor and serves only as a future cross-check.
 */

export const documentInstanceId: string = (() => {
  try {
    return crypto.randomUUID();
  } catch {
    // Ancient/embedded contexts without crypto.randomUUID — good enough:
    // uniqueness matters per-tab, not cryptographically.
    return `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
})();

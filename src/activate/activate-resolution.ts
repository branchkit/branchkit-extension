/**
 * BranchKit Browser — Activate action element resolution.
 *
 * Codeword-first resolution. The codeword IS the addressing layer
 * (`registry.ts:121` predates the actual code: "codeword assignment is the
 * addressing layer like Rango's label pool"); the registry id was a
 * parallel scheme that never worked as primary because the cache entry's
 * id is frozen at the value carried in the first batch — which is 0,
 * since wrappers go through `attachWrapper` (and therefore
 * `idRegistry.register`) AFTER the batch is sent. So `id="0"` in
 * dispatched params is the steady state for almost every entry, and
 * tier 1 by-registry-id is dead weight.
 *
 *   1. Codeword → pre-phrase snapshot       — happy path; resolves the
 *      target captured at hint-show time even if the store has since
 *      churned (SPA virtualization, React swap during the spoken word).
 *   2. Codeword → live store (byCodeword)   — fallback when the
 *      snapshot didn't include this wrapper (post-snapshot discovery).
 *   3. Registry id → WeakRef.deref()        — only reached when the
 *      caller passed an id and the codeword paths returned nothing;
 *      diagnostic + soak-window safety net. The cache id staleness
 *      means this almost never fires in production.
 *   4. Registry id → fingerprint fallback   — sibling of tier 3 for
 *      React-swap recovery when the WeakRef is dead.
 *
 * Returns a target Element + resolution tag + diagnostic detail. The
 * caller wires the activation effect (focus/click/flash). See
 * docs/completed/DESIGN_ELEMENT_IDENTITY_REGISTRY.md §6.
 */

import type { ElementWrapper } from '../scan/element-wrapper';
import type { Fingerprint, RegistryEntry } from '../scan/registry';
import type { DispatchResult } from '../types';

export interface ResolutionResult {
  target: Element | null;
  resolution: DispatchResult['resolution'];
  detail: string;
  fp: string;
}

export interface ResolutionDeps {
  /** Our own frame id, or null if the SW handshake hasn't completed. */
  myFrameId: number | null;
  /** Registry lookups + rebind/unregister side effects. */
  registry: {
    get: (id: number) => RegistryEntry | undefined;
    rebindRef: (id: number, el: Element) => void;
    unregister: (id: number) => void;
    fingerprintFallback: (fp: Fingerprint, candidates: Iterable<Element>) => Element | null;
    fingerprintToString: (fp: Fingerprint) => string;
  };
  /** Candidates for tier-2 fingerprint match (caller passes a live scan). */
  candidates: () => Iterable<Element>;
  /** Tier 3a: codeword → wrapper via pre-phrase snapshot. */
  resolveFromSnapshot: (codeword: string) => ElementWrapper | undefined;
  /** Tier 3b: codeword → wrapper via live store. Caller splits the codeword. */
  resolveFromStore: (codeword: string) => ElementWrapper | undefined;
}

export function resolveTarget(
  idParam: number,
  frameIdParam: number,
  codeword: string,
  deps: ResolutionDeps,
): ResolutionResult {
  let target: Element | null = null;
  let resolution: DispatchResult['resolution'] = 'none';
  let detail = '';
  let fp = '';

  // Frame-routing context: the SW's `getFrameForLabel` already routed
  // this action via the label-pool, which is the live source of truth
  // for codeword→frame ownership. The cached `frame_id` in the
  // dispatched params can be stale (it's frozen at batch-send time
  // from whichever frame originally claimed the codeword; subsequent
  // re-claims by sibling frames don't rewrite it). So a frame-mismatch
  // against `params.frame_id` is only a safety check for the id-based
  // tiers — codeword resolution against our own store IS the
  // authoritative ownership signal: if `store.byCodeword(cw)` returns
  // a wrapper, we own this codeword regardless of the stale id.
  const frameMismatch =
    deps.myFrameId !== null && frameIdParam >= 0 && frameIdParam !== deps.myFrameId;

  // Tier 1: codeword → snapshot. The snapshot is taken at hint-show
  // time and captures the wrappers the user was looking at when they
  // spoke. Resolving against it survives SPA churn that happened
  // between hint-show and dispatch.
  if (codeword) {
    const fromSnapshot = deps.resolveFromSnapshot(codeword);
    if (fromSnapshot) {
      target = fromSnapshot.element;
      resolution = 'snapshot';
    } else {
      // Tier 2: codeword → live store. Wrapper attached after the
      // snapshot (post-discovery batch).
      const live = deps.resolveFromStore(codeword);
      if (live) {
        target = live.element;
        resolution = 'live_store';
      }
    }
  }

  // Tier 3 + 4: registry id. Reached only when codeword resolution
  // returned nothing AND we passed the stale-id frame check. The cache
  // entry's id is frozen at batch-send time (pre-attachWrapper), so
  // almost every production dispatch carries id=0 and skips this
  // block. Kept as the diagnostic safety net during the codeword-first
  // soak.
  if (!target && idParam > 0 && !frameMismatch) {
    const entry = deps.registry.get(idParam);
    if (entry) {
      fp = deps.registry.fingerprintToString(entry.fingerprint);
      const live = entry.ref.deref();
      if (live && live.isConnected) {
        target = live;
        resolution = 'registry';
      } else {
        const found = deps.registry.fingerprintFallback(entry.fingerprint, deps.candidates());
        if (found) {
          target = found;
          resolution = 'fingerprint';
          deps.registry.rebindRef(idParam, found);
        } else {
          detail = `id=${idParam} dead, fingerprint not found`;
          // Both tier 3 and tier 4 failed — the entry can never
          // resolve. Lazy-delete so it stops occupying memory and
          // can't accidentally tier-3-hit some future element that
          // happens to share its fingerprint shape.
          deps.registry.unregister(idParam);
        }
      }
    } else if (!detail) {
      detail = `id=${idParam} not in registry`;
    }
  }

  // No resolution at all AND the frame check failed: report the
  // mismatch so the actuator log shows why this frame skipped. A
  // codeword that fails to resolve here is the harder case — wrapper
  // genuinely missing or destroyed — not a routing issue.
  if (!target && !detail && frameMismatch) {
    detail = `id=${idParam} for frame ${frameIdParam}, this is frame ${deps.myFrameId}`;
  }

  return { target, resolution, detail, fp };
}

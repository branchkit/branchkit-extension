/**
 * BranchKit Browser — Activate action element resolution.
 *
 * Three-tier algorithm extracted from content.ts so it's unit-testable:
 *   1. Registry id → WeakRef.deref()  (happy path; identity preserved)
 *   2. Registry id → fingerprint fallback over live candidates (React swap)
 *   3. Codeword → snapshot, then live store (SW-restart / id-not-found)
 *
 * Returns a target Element + resolution tag + diagnostic detail. The
 * caller wires the activation effect (focus/click/flash). See
 * docs/completed/DESIGN_ELEMENT_IDENTITY_REGISTRY.md §6.
 */

import type { ElementWrapper } from './element-wrapper';
import type { Fingerprint, RegistryEntry } from './registry';
import type { DispatchResult } from './types';

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
  /** Side effect: ask the plugin to invalidate its commands cache. */
  onStaleId: (reason: string) => void;
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

  // Frame-routing safety: if the dispatch targets a different frame,
  // skip all resolution tiers so only the intended frame acts.
  const frameMismatch =
    deps.myFrameId !== null && frameIdParam >= 0 && frameIdParam !== deps.myFrameId;

  if (idParam > 0 && !frameMismatch) {
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
          // Both tier 1 and tier 2 failed — the entry can never
          // resolve. Lazy-delete so it stops occupying memory and
          // can't accidentally tier-1-hit some future element that
          // happens to share its fingerprint shape.
          deps.registry.unregister(idParam);
        }
      }
    } else {
      detail = `id=${idParam} not in registry`;
      // Plugin's grammar is dispatching against an id we never minted
      // (or have since cleared). Ask it to invalidate so the next push
      // does a full re-registration.
      deps.onStaleId('stale_id');
    }
  } else if (frameMismatch) {
    detail = `id=${idParam} for frame ${frameIdParam}, this is frame ${deps.myFrameId}`;
  }

  if (!target && codeword && !frameMismatch) {
    const fromSnapshot = deps.resolveFromSnapshot(codeword);
    if (fromSnapshot) {
      target = fromSnapshot.element;
      resolution = 'snapshot';
    } else {
      const live = deps.resolveFromStore(codeword);
      if (live) {
        target = live.element;
        resolution = 'live_store';
      }
    }
  }

  return { target, resolution, detail, fp };
}

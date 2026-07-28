/**
 * BranchKit Browser — binding the three-tier resolution to the live page.
 *
 * `activate-resolution.ts` holds the ALGORITHM and deliberately imports
 * nothing but types, which is what lets it carry a real unit test. Someone has
 * to hand it the live page though — this frame's id, the element registry, the
 * DOM to sweep, the phrase snapshot, the wrapper store — and that binding was
 * written out twice: once in `content.ts`'s `activate` arm and once in
 * `voice-dispatch.ts`'s element verbs.
 *
 * The two copies were byte-identical (18 non-blank lines each, diffed rather
 * than eyeballed). The duplication predates the BRANCHKIT_ACTION split —
 * §6g.5 measured it as one of the reasons both arms look alike — but the split
 * turned "twice in one file" into "twice across a module boundary", which is
 * worse: nothing keeps them in step and nothing points at the other.
 *
 * Here rather than in either of the modules the two call sites already share
 * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md §6k):
 *
 *   - NOT `activate-resolution.ts`. It imports three types and nothing else,
 *     which is exactly why its algorithm is testable. Binding five live
 *     singletons into it would trade that away for adjacency.
 *   - NOT `sealed-gate.ts`, which §6j.3 suggested. That module is one rule in
 *     two halves and its coherence is the point; resolution wiring is a third,
 *     unrelated concern.
 *
 * What this is NOT responsible for: the holder consult. `content.ts`'s
 * `activate` arm asks `resolveCodewordAboveAmbient` about range picks and
 * search badges BEFORE reaching here, and the element verbs do not. That
 * asymmetry is pre-existing and untouched — folding it in would be a behaviour
 * change wearing a refactor's clothes, and it belongs to its own commit with
 * its own field test if it belongs to anything.
 */

import { store } from '../core/store';
import { pageSession } from '../lifecycle/page-session';
import * as idRegistry from '../scan/registry';
import { deepQuerySelectorAll } from '../scan/scanner';
import { resolveInPhrase } from './snapshot';
import { resolveTarget, type ResolutionResult } from './activate-resolution';

export interface DispatchTarget extends ResolutionResult {
  /**
   * The parsed `id` param, handed back rather than re-parsed by the caller.
   * `content.ts`'s activate arm needs it after resolution for the three
   * BK_ACTIVATE_PATH emits (`wrapperId`, and the registry lookup behind
   * `fingerprint`) — diagnostics, not resolution. Returning it is what keeps
   * the `'0'` default in ONE place; a second `parseInt(params?.id ?? '0', 10)`
   * at the call site is exactly the detail that drifts between copies, which
   * is the whole reason this module exists.
   */
  idParam: number;
}

/**
 * Resolve a dispatch's `codeword` / `id` / `frame_id` params against this
 * frame, through all three tiers.
 *
 * Takes the raw params rather than parsed numbers so the `parseInt` defaults
 * live here and nowhere else.
 */
export function resolveDispatchTarget(
  params: Record<string, string> | undefined,
  codeword: string,
): DispatchTarget {
  const idParam = parseInt(params?.id ?? '0', 10);
  const frameIdParam = params?.frame_id != null ? parseInt(params.frame_id, 10) : -1;
  const resolved = resolveTarget(
    idParam, frameIdParam, codeword,
    {
      myFrameId: pageSession.myFrameId,
      registry: {
        get: idRegistry.get,
        rebindRef: idRegistry.rebindRef,
        unregister: idRegistry.unregister,
        fingerprintFallback: idRegistry.fingerprintFallback,
        fingerprintToString: idRegistry.fingerprintToString,
      },
      candidates: () => deepQuerySelectorAll(document, '*'),
      resolveFromSnapshot: (cw) => resolveInPhrase(cw, performance.now()),
      resolveFromStore: (cw) => store.byCodeword(cw),
    },
  );
  return { ...resolved, idParam };
}

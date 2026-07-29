/**
 * BranchKit Browser — the pull-resolution strict gate, and its refusal.
 *
 * Two halves of one rule, which is why they are one module: a sealed-alphabet
 * dispatch (the marker is `prefix_letter` in the params) does NOT consult the
 * `_strict` mirror the push path used, so seen-is-clickable is enforced HERE,
 * at dispatch, against live state — fresher than the pushed mirror ever was.
 * A pair that resolves to nothing, or to an element the user cannot currently
 * see (off-screen band claim, CSS-hidden hover target, occluded badge),
 * refuses instead of clicking blind.
 *
 * Both call sites spell the rule the same way, and both need both halves:
 *
 *   if (params?.prefix_letter != null && !sealedDispatchSeen(target)) {
 *     reportNoSuchHint(action, codeword, resolution, fp, params);
 *     return;
 *   }
 *
 * One of those sites is the voice `activate` arm, which stays in `content.ts`
 * because it reaches the nav-wedge preempt; the other is the element-verb arm,
 * which moved to activate/voice-dispatch.ts. Splitting them left the gate with
 * callers on both sides of that line, so it belongs to neither.
 *
 * See ext notes/DESIGN_STATIC_PAIR_GRAMMAR.md 0c and
 * notes/DESIGN_ENTRY_POINT_TOPOLOGY.md §6i.
 */

import { store } from '../core/store';
import { isRectOnScreen } from '../core/layout-cache';
import { isVisible } from '../scan/scanner';
import { isOccludedLive } from '../observe/occlusion';
import { flashToast } from '../render/toast';
import { reportDispatchResult } from '../plugin/resolve';
import { trimFrameUrl } from '../core/frame';
import type { DispatchResult } from '../types';

/**
 * Can the user actually SEE the element this dispatch resolved to?
 *
 * `isVisible(target)` IS the live cssHidden check (phase 1) and
 * `isOccludedLive` the live occlusion check (phase 2) — no stored flags
 * (notes/DESIGN_OBSERVED_STATE_READ_TIME.md).
 */
export function sealedDispatchSeen(target: unknown): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const w = store.findWrapperFor(target);
  const rect = target.getBoundingClientRect();
  return (
    isRectOnScreen(rect, window.innerWidth, window.innerHeight) &&
    isVisible(target) &&
    !(w !== undefined && isOccludedLive(w))
  );
}

/** The refused-pair feedback + dispatch result for a sealed miss. Explicit
 *  feedback over silence is the accepted UX (2026-07-18). */
export function reportNoSuchHint(
  action: string,
  codeword: string,
  resolution: DispatchResult['resolution'],
  fp: string,
  params: Record<string, string> | undefined,
): void {
  flashToast(`No hint "${(params?.prefix_word && params?.suffix_word)
    ? `${params.prefix_word} ${params.suffix_word}` : codeword}"`);
  reportDispatchResult({
    action, codeword, resolution, elem_tag: '', taken: 'skipped',
    ok: false, frame: trimFrameUrl(window.location.href),
    detail: 'no_such_hint', fp,
  });
}

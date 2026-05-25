/**
 * BranchKit Browser — per-batch rescan dedup.
 *
 * Drops refs that already have wrappers attached. Their codewords are
 * already in the plugin's session.Codewords from a prior batch in the
 * same content-script lifetime; re-claiming a pool label for them
 * leaks the label (the duplicate wrapper would be discarded but the
 * pool's `assigned` map still holds the new label).
 *
 * See notes/DESIGN_OPTION_B_REATTEMPT.md "Problem 2".
 */

import { ScannedElement } from './types';

export function filterNewBatchRefs(
  refs: Element[],
  elements: ScannedElement[],
  isAttached: (el: Element) => boolean,
): { newRefs: Element[]; newElements: ScannedElement[] } {
  const newRefs: Element[] = [];
  const newElements: ScannedElement[] = [];
  for (let i = 0; i < refs.length; i++) {
    if (isAttached(refs[i])) continue;
    newRefs.push(refs[i]);
    newElements.push(elements[i]);
  }
  return { newRefs, newElements };
}

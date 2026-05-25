/**
 * BranchKit Browser — post-batch isConnected sweep.
 *
 * Pure helper for the per-batch grammar protocol's RED item 5
 * mitigation (notes/DESIGN_HINT_PIPELINE_RESYNC.md). Lives in its own
 * file so unit tests can drive it with stub predicates without
 * pulling in content.ts's module-level side effects (the SW listener,
 * the IntersectionTracker construction, etc.).
 */

import { ElementWrapper } from './element-wrapper';

/**
 * For each wrapper Put-successfully in a batch, check if its element
 * is still in the DOM. If not, push the codeword onto `queue` (for
 * piggyback on the next batch's `delete_codewords`) and call `detach`
 * to release the codeword locally and drop the wrapper from the
 * store. Returns the number of wrappers swept.
 *
 * `isConnected` and `detach` are parameterized for testability — the
 * production caller passes `(el) => el.isConnected` and the
 * `detachWrapper` from content.ts.
 *
 * Wrappers with empty codewords (pool exhausted at claim time) are
 * skipped: there's nothing for the plugin to Delete, and the wrapper
 * is already unaddressable.
 */
export function sweepDisconnectedAfterBatch(
  wrappers: ElementWrapper[],
  isConnected: (el: Element) => boolean,
  queue: string[],
  detach: (el: Element) => void,
): number {
  let swept = 0;
  for (const w of wrappers) {
    if (!w.scanned.codeword) continue;
    if (isConnected(w.element)) continue;
    queue.push(w.scanned.codeword);
    detach(w.element);
    swept++;
  }
  return swept;
}

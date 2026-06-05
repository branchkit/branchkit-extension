/**
 * BranchKit Browser — strict-viewport flag for grammar batches.
 *
 * The IO band (`isInViewport`) uses a 200px margin so wrappers entering the
 * margin pre-claim codewords and pre-paint badges — the scroll-ahead UX. The
 * `in_strict_viewport` flag on the batch payload is the *match-eligibility*
 * cut: only entries whose rect intersects the visible viewport land in the
 * companion `browser_hints_<prefix>_strict` collection that the Discovery HUD
 * and the activate command's dependent capture read. Band-but-not-strict
 * wrappers still get badges (the scroll-ahead cue) but voice commands against
 * them drop silently — saying "gust harp" when harp is below the fold is a
 * no-op, not a click on something the user can't see.
 *
 * Called once per outbound batch — single layout-read pass over the batch's
 * elements, then a write pass. Cost is bounded to batch size (~10-20).
 */

import { ElementWrapper } from '../scan/element-wrapper';

export function stampStrictViewport(wrappers: ElementWrapper[]): void {
  if (wrappers.length === 0) return;
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const rects: (DOMRect | null)[] = wrappers.map(w => {
    try { return w.element.getBoundingClientRect(); } catch { return null; }
  });
  wrappers.forEach((w, i) => {
    const r = rects[i];
    const inStrict =
      r != null && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    w.scanned.in_strict_viewport = inStrict;
    // The reconciler reads `lastSentStrictViewport` to decide whether a
    // post-scroll re-push is needed. The batch send that follows this
    // stamp call will transmit the current value, so record it here as
    // the synced baseline.
    w.lastSentStrictViewport = inStrict;
  });
}

/**
 * Walk the store and return wrappers whose current strict-viewport status
 * differs from what was last pushed to the plugin's `_strict` companion
 * collection. Codewords-without-claim and limbo wrappers are excluded —
 * the former can't be in the collection yet (no codeword), the latter
 * hold their state by design until rebind or finalize. Reads fresh
 * `getBoundingClientRect` because the IO band's `isInViewport` flag is
 * the band notion, not the strict-viewport notion this function tracks.
 *
 * Cost: O(codeworded wrappers) gBCRs in one read pass. Called from
 * scroll-settle and other reposition triggers, both already debounced.
 */
export function collectStrictViewportDelta(
  wrappers: Iterable<ElementWrapper>,
): ElementWrapper[] {
  const delta: ElementWrapper[] = [];
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  for (const w of wrappers) {
    if (w.disconnectedAt !== null) continue;
    if (!w.scanned.codeword) continue;
    let inStrict = false;
    try {
      const r = w.element.getBoundingClientRect();
      inStrict =
        r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    } catch {
      inStrict = false;
    }
    if (inStrict !== w.lastSentStrictViewport) delta.push(w);
  }
  return delta;
}

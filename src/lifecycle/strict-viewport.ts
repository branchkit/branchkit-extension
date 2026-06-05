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
    w.scanned.in_strict_viewport =
      r != null && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
  });
}

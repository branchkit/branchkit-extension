/**
 * BranchKit Browser — strict-viewport flag for grammar batches.
 *
 * The IO band (`isInViewport`) uses a wide margin (VIEWPORT_MARGIN_PX) so wrappers entering the
 * margin pre-claim codewords and pre-paint badges — the scroll-ahead UX. The
 * `in_strict_viewport` flag on the batch payload is the *match-eligibility*
 * cut: only entries whose rect intersects the visible viewport land in the
 * companion `browser_hints_<prefix>_strict` collection that the Discovery HUD
 * and the activate command's dependent capture read. Band-but-not-strict
 * wrappers still get badges (the scroll-ahead cue) but voice commands against
 * them drop silently — saying "gust harp" when harp is below the fold is a
 * no-op, not a click on something the user can't see.
 *
 * Two more "can't see it" cuts share this rule, each read off a wrapper flag set
 * by its own settle pass: `occluded` (a visible target covered by an overlay) and
 * `cssHidden` (a target that is visibility:hidden / opacity:0 — a hover-reveal
 * action bar whose badge the visibility recheck has hidden). Either forces
 * in_strict_viewport=false: if the badge isn't shown, voice doesn't match it.
 *
 * Iframe behavior: a wrapper's own rect being in the iframe's viewport is
 * necessary but not sufficient. The iframe element itself must be visible in
 * its parent's viewport (recursively up to the top frame). Pages like
 * QuickBase load auxiliary iframes positioned off-screen — their inside
 * elements report as "in strict" under iframe-local geometry but the user
 * can't see them. `isAncestorChainInVisibleViewport` walks the frame
 * ancestry; if any iframe element is off-screen in its parent, all wrappers
 * inside it are off-strict. Cross-origin boundaries fall back to assuming
 * visible — we can't see across, and degrading to today's behavior beats
 * silently dropping legitimate hints.
 *
 * Called once per outbound batch — single layout-read pass over the batch's
 * elements, one ancestor-chain check (cached for the batch), then a write
 * pass. Cost is bounded to batch size (~10-20).
 */

import { ElementWrapper } from '../scan/element-wrapper';
import type { SettleGather } from './gather';

/**
 * True iff every iframe in this window's ancestor chain has its `<iframe>`
 * element on-screen in the parent's strict viewport. Top-frame contexts and
 * cross-origin barriers both pass through as visible — top frames have no
 * ancestor to check, and cross-origin checks would always fail closed
 * otherwise, silencing legitimate hints in same-tab cross-origin embeds.
 *
 * The result is intended to be computed once per outbound batch — it
 * doesn't vary per-wrapper, and an iframe's position relative to its parent
 * only shifts on the parent's scroll/resize, which the child can't directly
 * observe anyway. The next reconcile tick in the child catches up to any
 * drift.
 */
export function isAncestorChainInVisibleViewport(w: Window): boolean {
  let current: Window = w;
  // Bounded loop guard: pathologically deep iframe trees (or a window
  // implementation that misreports `current === parent`) shouldn't spin.
  // 32 levels is well beyond any real page.
  for (let depth = 0; depth < 32; depth++) {
    let parent: Window;
    try {
      parent = current.parent;
    } catch {
      return true;
    }
    if (current === parent) return true;

    let frameEl: Element | null;
    let pvh: number;
    let pvw: number;
    try {
      frameEl = current.frameElement;
      if (!frameEl) return true;
      pvh = parent.innerHeight;
      pvw = parent.innerWidth;
    } catch {
      return true;
    }

    let r: DOMRect;
    try {
      r = frameEl.getBoundingClientRect();
    } catch {
      return true;
    }
    if (!(r.bottom > 0 && r.top < pvh && r.right > 0 && r.left < pvw)) {
      return false;
    }

    current = parent;
  }
  return true;
}

export function stampStrictViewport(wrappers: ElementWrapper[]): void {
  if (wrappers.length === 0) return;
  const ancestorOk = isAncestorChainInVisibleViewport(window);
  const vh = window.innerHeight;
  const vw = window.innerWidth;
  const rects: (DOMRect | null)[] = wrappers.map(w => {
    try { return w.element.getBoundingClientRect(); } catch { return null; }
  });
  wrappers.forEach((w, i) => {
    const r = rects[i];
    // `!w.occluded`: a target covered by another element (occlusion hit-test) is
    // off-strict so voice can't match a hint the user can't see — same rule as
    // below-the-fold, applied to visually-covered targets. No-op when the
    // bkOcclusion flag is off (occluded stays false).
    // `!w.cssHidden`: same rule for a CSS-invisible target (visibility:hidden /
    // opacity:0 — a hover-reveal action bar) whose badge the visibility recheck
    // has hidden. If the user can't see the badge, voice shouldn't match it.
    const inStrict = ancestorOk && !w.occluded && !w.cssHidden
      && r != null && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
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
 * Cost: O(codeworded wrappers) gBCRs in one read pass — or zero layout reads
 * when the settle pipeline passes its gather snapshot (Phase B of
 * notes/DESIGN_UNIFIED_RECONCILER.md), which already read the codeworded
 * set's rects in the same settle. Flags (`occluded`, `cssHidden`,
 * `lastSentStrictViewport`) are always read live — earlier settle steps
 * write them after the gather. Called from scroll-settle and other
 * reposition triggers, both already debounced.
 */
export function collectStrictViewportDelta(
  wrappers: Iterable<ElementWrapper>,
  gather?: SettleGather,
): ElementWrapper[] {
  const delta: ElementWrapper[] = [];
  const ancestorOk = gather?.ancestorChainVisible ?? isAncestorChainInVisibleViewport(window);
  const vh = gather?.vh ?? window.innerHeight;
  const vw = gather?.vw ?? window.innerWidth;
  for (const w of wrappers) {
    if (w.disconnectedAt !== null) continue;
    if (!w.scanned.codeword) continue;
    let inStrict = false;
    // Occluded (covered) and cssHidden (visibility:hidden/opacity:0, badge hidden
    // by the visibility recheck) targets are both off-strict — see
    // stampStrictViewport. A hint the user can't see shouldn't be voice-matchable.
    if (ancestorOk && !w.occluded && !w.cssHidden) {
      const cached = gather?.rects.get(w);
      if (cached) {
        inStrict =
          cached.bottom > 0 && cached.top < vh && cached.right > 0 && cached.left < vw;
      } else {
        try {
          const r = w.element.getBoundingClientRect();
          inStrict =
            r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
        } catch {
          inStrict = false;
        }
      }
    }
    if (inStrict !== w.lastSentStrictViewport) delta.push(w);
  }
  return delta;
}

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
 * Two more "can't see it" cuts share this rule: `occluded` (a visible target
 * covered by an overlay — a wrapper flag set by the occlusion pass) and
 * CSS-invisibility (visibility:hidden / opacity:0 — a hover-reveal action bar
 * whose badge the paint gate keeps hidden), read live per batch member
 * (notes/DESIGN_OBSERVED_STATE_READ_TIME.md phase 1). Either forces
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
import { isVisible } from '../scan/scanner';
import { isOccludedLive } from '../observe/occlusion';
import { harnessHooksEnabled } from '../debug/harness-hooks';
import { lastStrictProbe } from './strict-probe';

// Harness-only (settle-storm diagnosis): counts of batch-POST stamps whose
// recomputed inStrict DISAGREED with the plan's value from the last settle
// pass, attributed to the input that moved between plan time and POST time.
// A persistent nonzero here names the stamp as the baseline writer that
// keeps knocking lastSentStrictViewport away from the plan's view — the
// plan then re-detects the same delta every pass (the re-push loop).
// Drained by the settle pipeline into the firehose; plain counters so this
// module needs no messaging dependency (unit tests just see them idle).
const stampDisagree = { total: 0, geometry: 0, occluded: 0, cssHidden: 0, ancestor: 0 };

export function drainStampDisagree(): typeof stampDisagree {
  const out = { ...stampDisagree };
  stampDisagree.total = 0;
  stampDisagree.geometry = 0;
  stampDisagree.occluded = 0;
  stampDisagree.cssHidden = 0;
  stampDisagree.ancestor = 0;
  return out;
}

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
    // `occludedLive`: a target covered by another element (live hit-test,
    // flag-gated) or clipped by its scroll container is off-strict so voice
    // can't match a hint the user can't see — same rule as below-the-fold,
    // applied to visually-covered targets.
    // `cssHiddenLive`: same rule for a CSS-invisible target (visibility:hidden /
    // opacity:0 — a hover-reveal action bar) whose badge the paint gate keeps
    // hidden. Both read fresh per batch member — the stamp already pays a live
    // rect per member; the style read and the bounded hit-test join it
    // (read-time, no stored flags: DESIGN_OBSERVED_STATE_READ_TIME phases 1+2).
    const stampOnScreen = r != null && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw;
    let cssHiddenLive: boolean;
    try { cssHiddenLive = !isVisible(w.element); } catch { cssHiddenLive = true; }
    // Only pay the hit-test when the cheaper cuts pass — an off-screen or
    // CSS-hidden target is off-strict regardless.
    const occludedLive = stampOnScreen && !cssHiddenLive && isOccludedLive(w);
    const inStrict = ancestorOk && !occludedLive && !cssHiddenLive && stampOnScreen;
    if (harnessHooksEnabled()) {
      const probe = lastStrictProbe.get(w);
      if (probe && probe.inStrict !== inStrict) {
        stampDisagree.total++;
        if (probe.onScreen !== stampOnScreen) stampDisagree.geometry++;
        if ((probe.clipped || probe.overlayCovered) !== occludedLive) stampDisagree.occluded++;
        if (probe.cssHidden !== cssHiddenLive) stampDisagree.cssHidden++;
        if (probe.ancestor !== ancestorOk) stampDisagree.ancestor++;
      }
    }
    w.scanned.in_strict_viewport = inStrict;
    // The reconciler reads `lastSentStrictViewport` to decide whether a
    // post-scroll re-push is needed. The batch send that follows this
    // stamp call will transmit the current value, so record it here as
    // the synced baseline.
    w.lastSentStrictViewport = inStrict;
  });
}

// (collectStrictViewportDelta is gone — Phase E of
// notes/DESIGN_UNIFIED_RECONCILER.md. The strict delta is the plan's
// strictDelta list, derived from the settle gather; the between-settle
// triggers that used this live-read variant now request the pass instead.
// `stampStrictViewport` above stays: it is the batch-send write path, not a
// settle step.)

/**
 * BranchKit Browser — hint occlusion detection (hit-test).
 *
 * Subcase 2 of notes/DESIGN_HINT_OCCLUSION_FILTERING.md ("same-stacking-context
 * invisibility"): a target is present in the DOM with valid geometry — so the
 * CSS `isVisible()` check passes — but another element is painted on top of it
 * (an overlay, a scrolled-in layer, an `overflow:hidden`+`max-height:0` collapse
 * clipping it). Because badges are body-mounted at max z-index, they paint ABOVE
 * the covering layer → "ghost" badges floating on targets the user can't see.
 *
 * Detection is `document.elementFromPoint` hit-tests at several points across the
 * target (center + four interior corners), mirroring Link Hints. The target is
 * occluded when a MAJORITY of the in-viewport sample points are covered by
 * something other than the target (or its own ancestor/descendant — same visible
 * thing). Multi-point beats center-only on PARTIAL occlusion: an overlay that
 * covers most of the box but leaves the center in a visible sliver (the QuickBase
 * sidebar case) is caught by the corner samples. `opacity:0` ancestors still
 * receive hit-tests, so a hover-revealed control (always-mode) stays NOT occluded.
 *
 * Flag-gated (`bkOcclusion`, default off) and consumed by two layers: the visual
 * pass hides occluded badges, and the strict-viewport computation drops them so
 * voice can't match a hidden target.
 */

import type { ElementWrapper } from '../scan/element-wrapper';

let occlusionEnabled = false;

export function setOcclusionEnabled(enabled: boolean): void {
  occlusionEnabled = enabled;
}

/**
 * Recompute a wrapper's effective occlusion as the OR of its two input signals —
 * `overlayCovered` (elementFromPoint hit-test) and `clipped` (IO rooted at the
 * scroll container) — and, when it changed, hide/show the badge to match. The
 * single writer of `w.occluded` + `setOccluded`, called by both producers so they
 * compose instead of fighting. Voice (strict-viewport) reads `w.occluded`
 * directly on the next settle. Returns true if the effective state flipped.
 */
export function applyOcclusion(w: ElementWrapper): boolean {
  const eff = w.overlayCovered || w.clipped;
  if (eff === w.occluded) return false;
  w.occluded = eff;
  w.hint?.setOccluded(eff);
  return true;
}

export function isOcclusionEnabled(): boolean {
  return occlusionEnabled;
}

/**
 * Pure decision: given a target and whatever `elementFromPoint` returned at the
 * target's center, is the target occluded by something else?
 *
 * - `null` hit → the point is off-viewport or fell in a gap; DEFER (treat as not
 *   occluded) rather than hide a badge we can't reason about.
 * - hit IS the target, or the target's own descendant (its visible text/icon),
 *   or an ancestor that wraps the target (e.g. the target is a `<span>` inside
 *   the `<a>` we hit) → same visible element, NOT occluded.
 * - anything else painted on top → occluded.
 */
export function isHitOccluding(target: Element, hit: Element | null): boolean {
  if (!hit) return false;
  if (hit === target) return false;
  if (target.contains(hit)) return false;
  if (hit.contains(target)) return false;
  return true;
}

// Sample points as fractions of the target's box. Center + four interior corners,
// inset to 0.2/0.8 so they probe the box's extent without landing on a border or
// an adjacent element. A point off the viewport hit-tests to null (counts as
// not-covered) — a partially-off-viewport target won't be aggressively hidden.
const SAMPLE_FRACTIONS: ReadonlyArray<readonly [number, number]> = [
  [0.5, 0.5],
  [0.2, 0.2],
  [0.8, 0.2],
  [0.2, 0.8],
  [0.8, 0.8],
];
const OCCLUDED_MAJORITY = 3; // of SAMPLE_FRACTIONS.length (5)

/**
 * Hit-test several points across a target to decide if it's visually covered.
 * Occluded when a majority of the sample points are covered by another element.
 * Returns false when the flag is off or the target has no area. Up to 5
 * synchronous `elementFromPoint` reads (early-exits once the majority is decided,
 * so typically 3–4); callers must gate to the visible set and debounce (see
 * `reconcileOcclusion`).
 */
export function isOccluded(el: Element): boolean {
  if (!occlusionEnabled) return false;
  let r: DOMRect;
  try {
    r = el.getBoundingClientRect();
  } catch {
    return false;
  }
  if (r.width < 1 || r.height < 1) return false;
  const doc = el.ownerDocument;
  if (!doc) return false;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  let covered = 0;
  let checked = 0;
  for (const [fx, fy] of SAMPLE_FRACTIONS) {
    checked++;
    const x = r.left + r.width * fx;
    const y = r.top + r.height * fy;
    // Off-viewport points hit-test to null → not-covered (don't hide a target
    // that's partly scrolled past the viewport edge).
    const inViewport = x >= 0 && y >= 0 && x <= vw && y <= vh;
    const hit = inViewport ? doc.elementFromPoint(x, y) : null;
    if (isHitOccluding(el, hit)) covered++;
    if (covered >= OCCLUDED_MAJORITY) return true;
    // Once enough points are confirmed NOT covered, a majority is impossible.
    if (checked - covered >= SAMPLE_FRACTIONS.length - OCCLUDED_MAJORITY + 1) return false;
  }
  return covered >= OCCLUDED_MAJORITY;
}

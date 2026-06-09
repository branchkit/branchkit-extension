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
 * Detection is a `document.elementFromPoint` hit-test at the target's center,
 * mirroring Link Hints. If the topmost element there is the target (or its own
 * ancestor/descendant — same visible thing), it's not occluded; anything else on
 * top means occluded. `opacity:0` ancestors still receive hit-tests, so a
 * hover-revealed control (the user runs always-mode) correctly stays NOT occluded.
 *
 * Flag-gated (`bkOcclusion`, default off) and consumed by two layers: the visual
 * pass hides occluded badges, and the strict-viewport computation drops them so
 * voice can't match a hidden target.
 */

let occlusionEnabled = false;

export function setOcclusionEnabled(enabled: boolean): void {
  occlusionEnabled = enabled;
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

/**
 * Hit-test a target's center to decide if it's visually covered. Returns false
 * when the flag is off, the target has no area, or its center is outside the
 * viewport (elementFromPoint would return null there — defer). One synchronous
 * layout read (`elementFromPoint`); callers must gate to the visible set and
 * debounce (see `reconcileOcclusion`).
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
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // A center outside the viewport hit-tests to null; defer instead of hiding.
  if (cx < 0 || cy < 0 || cx > vw || cy > vh) return false;
  const doc = el.ownerDocument;
  if (!doc) return false;
  const hit = doc.elementFromPoint(cx, cy);
  return isHitOccluding(el, hit);
}

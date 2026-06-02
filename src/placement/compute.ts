// Pure placement math — no DOM reads.
//
// Given geometry already gathered from the page, decide where a badge's
// top-left corner goes. Mirrors Rango's nudge model (ratio of badge size,
// not absolute overhang), so the badge sits ON the text's top-left corner
// with a fractional overhang up-and-left. The space clamp pulls the offset
// in when the available room is tight.

export interface Nudge {
  /** Horizontal nudge ratio: 0 = badge fully left of target; 1 = badge fully
   *  inside target at target.left. Rango defaults 0.3 for small-font text,
   *  rising to 1 for large icon-only targets that can host the badge. */
  x: number;
  /** Vertical nudge ratio: 0 = badge fully above target; 1 = badge inside at
   *  target.top. Rango defaults 0.5 small / 0.6 medium / 0.8 large / 1 inside. */
  y: number;
}

export interface PlacementInputs {
  /** Where the badge anchors: first-visible-text rect if the target has text,
   *  else the element's own rect. */
  targetRect: { left: number; top: number };
  badgeSize: { w: number; h: number };
  nudge: Nudge;
  /** Room to the left/top inside the nearest clip ancestor. `undefined` means
   *  unconstrained (no clip ancestor found). */
  availableSpace: { left: number | undefined; top: number | undefined };
  /** Viewport-fixed clamp point if a sticky/fixed ancestor exists, else null. */
  stickyBound: { left: number; top: number } | null;
}

export interface PlacementResult {
  x: number;
  y: number;
  /** True when a sticky/fixed ancestor makes the badge's clamp viewport-fixed,
   *  so window-scroll reposition must not skip it as compositor-tracked. */
  scrollSensitive: boolean;
  /** True when this placement actually depended on ancestor geometry — the
   *  available-space clamp bit, or a sticky/fixed bound applied. A layout
   *  change (resize, container resize) can move that geometry, so such a badge
   *  must be re-placed on the 'all' sweep. When false, the offset is purely
   *  target-relative (target rect + badge size) and therefore layout-invariant
   *  — on the compositor-driven anchor path it never needs re-placing. */
  geometryDependent: boolean;
}

export function computePlacement(inp: PlacementInputs): PlacementResult {
  const { targetRect, badgeSize: size, nudge, availableSpace: space, stickyBound } = inp;

  // Ratio nudge: 1 - ratio = fraction of badge that hangs past the target's
  // left/top edge. nudge=(1,1) puts the badge fully inside at the target's
  // top-left (large icon-host targets); nudge=(0.3,0.5) hangs 70% of width
  // and 50% of height past the edge — small-font text default, badge sits
  // mostly above-and-left of the first character.
  const hintOffsetX = size.w * (1 - nudge.x);
  const hintOffsetY = size.h * (1 - nudge.y);

  const clampedOffsetX = space.left !== undefined
    ? Math.min(hintOffsetX, Math.max(0, space.left - 1))
    : hintOffsetX;
  const clampedOffsetY = space.top !== undefined
    ? Math.min(hintOffsetY, Math.max(0, space.top - 1))
    : hintOffsetY;
  // The space clamp only feeds the offset when it actually bit. A defined-but-
  // generous available space leaves the offset untouched, so a resize won't
  // change the result — that badge is not geometry-dependent.
  const spaceClamped = clampedOffsetX < hintOffsetX || clampedOffsetY < hintOffsetY;

  // Purely target-relative — NO viewport-origin floor. A `Math.max(0, …)` here
  // would clamp the badge to the viewport's top-left when the target is
  // scrolled above/left of it, and on the anchor path that clamp delta (how far
  // the target was off-viewport at bake time) gets frozen into the
  // scroll-invariant `anchor() + Npx` offset — stranding the badge by exactly
  // that amount when the target scrolls back into view. Negative coordinates
  // are correct: they mean "above/left of the target", which `anchor()` and the
  // nesting re-place both resolve against the live target.
  let x = targetRect.left - clampedOffsetX;
  let y = targetRect.top - clampedOffsetY;

  const scrollSensitive = !!stickyBound;
  if (stickyBound) {
    x = Math.max(stickyBound.left, x);
    y = Math.max(stickyBound.top, y);
  }

  return { x, y, scrollSensitive, geometryDependent: scrollSensitive || spaceClamped };
}

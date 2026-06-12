// Pure placement math — no DOM reads.
//
// Given geometry already gathered from the page, decide where a badge's
// top-left corner goes. Mirrors Rango's nudge model (ratio of badge size,
// not absolute overhang), so the badge sits ON the text's top-left corner
// with a fractional overhang up-and-left.

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
}

export interface PlacementResult {
  x: number;
  y: number;
}

export function computePlacement(inp: PlacementInputs): PlacementResult {
  const { targetRect, badgeSize: size, nudge } = inp;

  // Ratio nudge: 1 - ratio = fraction of badge that hangs past the target's
  // left/top edge. nudge=(1,1) puts the badge fully inside at the target's
  // top-left (large icon-host targets); nudge=(0.3,0.5) hangs 70% of width
  // and 50% of height past the edge — small-font text default, badge sits
  // mostly above-and-left of the first character.
  const hintOffsetX = size.w * (1 - nudge.x);
  const hintOffsetY = size.h * (1 - nudge.y);

  // Purely target-relative — NO viewport-origin floor. A `Math.max(0, …)` here
  // would clamp the badge to the viewport's top-left when the target is
  // scrolled above/left of it, and that clamp delta (how far the target was
  // off-viewport at bake time) gets frozen into the scroll-invariant baked
  // offset (candidate minus target top-left) — stranding the badge by exactly
  // that amount when the target scrolls back into view. Negative coordinates
  // are correct: they mean "above/left of the target", which the reconciler
  // resolves against the live target rect every pass.
  return {
    x: targetRect.left - hintOffsetX,
    y: targetRect.top - hintOffsetY,
  };
}

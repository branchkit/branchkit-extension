// Pure placement math — no DOM reads.
//
// Given geometry already gathered from the page, decide where a badge's
// top-left corner goes. Extracted from RangoStrategy.positionAtTopLeft so the
// decision is a single reusable core shared by both positioning paths (the
// Firefox nesting path and the CSS-anchor path) and is unit-testable without a
// DOM. See DESIGN_OBSERVER_DRIVEN_LAYOUT.md "Anchor-first architecture".

export type NudgeKind = 'inside' | 'outside';
export interface Nudge { kind: NudgeKind; x: number; y: number }

export interface PlacementInputs {
  /** Where the badge anchors: first-visible-text rect if the target has text,
   *  else the element's own rect. */
  targetRect: { left: number; top: number };
  /** The element's own rect — the sticky overlap fallback anchors to this. */
  elementRect: { left: number; bottom: number };
  badgeSize: { w: number; h: number };
  nudge: Nudge;
  /** Room to the left/top inside the nearest clip ancestor. `undefined` means
   *  unconstrained (no clip ancestor found). */
  availableSpace: { left: number | undefined; top: number | undefined };
  /** Viewport-fixed clamp point if a sticky/fixed ancestor exists, else null. */
  stickyBound: { left: number; top: number } | null;
  /** Whether the badge sits inside an overflow-scroll list. Only consulted in
   *  the sticky overlap fallback; callers may pass false when stickyBound is
   *  null (the fallback can't fire) to skip the ancestor walk. */
  inScrollList: boolean;
  hasText: boolean;
}

export interface PlacementResult {
  x: number;
  y: number;
  /** True when a sticky/fixed ancestor makes the badge's clamp viewport-fixed,
   *  so window-scroll reposition must not skip it as compositor-tracked. */
  scrollSensitive: boolean;
}

export function computePlacement(inp: PlacementInputs): PlacementResult {
  const { targetRect, elementRect, badgeSize: size, nudge, availableSpace: space, stickyBound, inScrollList, hasText } = inp;

  // 'inside': nudge is a ratio (1 = badge at target top-left, no offset).
  // 'outside': nudge is an absolute pixel overhang past the target's edge.
  const hintOffsetX = nudge.kind === 'inside'
    ? size.w * (1 - nudge.x)
    : Math.max(0, size.w - nudge.x);
  const hintOffsetY = nudge.kind === 'inside'
    ? size.h * (1 - nudge.y)
    : Math.max(0, size.h - nudge.y);

  const clampedOffsetX = space.left !== undefined
    ? Math.min(hintOffsetX, Math.max(0, space.left - 1))
    : hintOffsetX;
  const clampedOffsetY = space.top !== undefined
    ? Math.min(hintOffsetY, Math.max(0, space.top - 1))
    : hintOffsetY;

  let x = Math.max(0, targetRect.left - clampedOffsetX);
  let y = Math.max(0, targetRect.top - clampedOffsetY);

  const scrollSensitive = !!stickyBound;
  if (stickyBound) {
    x = Math.max(stickyBound.left, x);
    y = Math.max(stickyBound.top, y);
  }

  const overlapIntoText = (y + size.h) - targetRect.top;
  const badgeOverlapsText = overlapIntoText > size.h * 0.4;
  if (stickyBound && badgeOverlapsText && hasText && !inScrollList) {
    x = Math.max(stickyBound.left, elementRect.left);
    y = elementRect.bottom - size.h * 0.5;
  }

  return { x, y, scrollSensitive };
}

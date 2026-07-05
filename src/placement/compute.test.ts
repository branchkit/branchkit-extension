import { describe, it, expect } from 'vitest';
import { computePlacement, PlacementInputs } from './compute';

function base(overrides: Partial<PlacementInputs> = {}): PlacementInputs {
  return {
    targetRect: { left: 200, top: 100 },
    badgeSize: { w: 50, h: 24 },
    // Rango's small-font default. With a 50x24 badge, hangs 35px left and
    // 12px up of the target.
    nudge: { x: 0.3, y: 0.5 },
    ...overrides,
  };
}

describe('computePlacement', () => {
  it('ratio nudge sits the badge on the target with a fractional overhang up-and-left', () => {
    const r = computePlacement(base());
    // hintOffsetX = 50 * (1 - 0.3) = 35; x = 200 - 35 = 165
    // hintOffsetY = 24 * (1 - 0.5) = 12; y = 100 - 12 = 88
    expect(r).toEqual({ x: 165, y: 88 });
  });

  it('nudge=(1,0.2) — small icon-only targets — left edges aligned, ~20% of the badge overlapping the icon top (rounds 36/36c: no neighbor bleed, reads as attached)', () => {
    const r = computePlacement(base({ nudge: { x: 1, y: 0.2 }, badgeSize: { w: 22, h: 15 }, targetRect: { left: 363, top: 327 } }));
    expect(r.x).toBe(363);        // left edges aligned — zero horizontal overhang
    expect(r.y).toBe(327 - 12);   // 80% above, 20% on the icon's top
  });

  it('nudge=(1,1) puts the badge inside the target at its top-left corner', () => {
    const r = computePlacement(base({ nudge: { x: 1, y: 1 } }));
    // ratio 1 => offset 0 => badge at target top-left
    expect(r).toEqual({ x: 200, y: 100 });
  });

  it('stays target-relative (no viewport floor) when the offset goes negative', () => {
    // Target near the viewport origin: the ratio overhang pushes the badge
    // above-and-left into negative viewport coords. That is correct — the
    // offset must describe "up-and-left of the target", not be clamped to
    // viewport (0,0). A floor here would bake a viewport-dependent delta into
    // the scroll-invariant reconcile offset and strand the badge on scroll-back.
    const r = computePlacement(base({ targetRect: { left: 2, top: 1 } }));
    // x = 2 - 35 = -33; y = 1 - 12 = -11
    expect(r).toEqual({ x: -33, y: -11 });
  });

  it('keeps a scrolled-above target relative, not pinned to the viewport top', () => {
    // The strand repro: target scrolled above the viewport (negative top).
    // Pre-fix this clamped y to 0 and the baked offset froze the +|top| delta.
    const r = computePlacement(base({ nudge: { x: 1, y: 1 }, targetRect: { left: 200, top: -43 } }));
    // ratio 1 => offset 0 => badge sits exactly at the target top (-43),
    // so the baked offset is 0 and the badge tracks on scroll-back.
    expect(r).toEqual({ x: 200, y: -43 });
  });
});

import { describe, it, expect } from 'vitest';
import { computePlacement, PlacementInputs } from './compute';

function base(overrides: Partial<PlacementInputs> = {}): PlacementInputs {
  return {
    targetRect: { left: 200, top: 100 },
    badgeSize: { w: 50, h: 24 },
    // Rango's small-font default. With a 50x24 badge, hangs 35px left and
    // 12px up of the target.
    nudge: { x: 0.3, y: 0.5 },
    availableSpace: { left: undefined, top: undefined },
    stickyBound: null,
    ...overrides,
  };
}

describe('computePlacement', () => {
  it('ratio nudge sits the badge on the target with a fractional overhang up-and-left', () => {
    const r = computePlacement(base());
    // hintOffsetX = 50 * (1 - 0.3) = 35; x = 200 - 35 = 165
    // hintOffsetY = 24 * (1 - 0.5) = 12; y = 100 - 12 = 88
    expect(r).toEqual({ x: 165, y: 88, scrollSensitive: false, geometryDependent: false });
  });

  it('nudge=(1,1) puts the badge inside the target at its top-left corner', () => {
    const r = computePlacement(base({ nudge: { x: 1, y: 1 } }));
    // ratio 1 => offset 0 => badge at target top-left
    expect(r).toEqual({ x: 200, y: 100, scrollSensitive: false, geometryDependent: false });
  });

  it('clamps the offset to available space so the badge never overflows its clip ancestor', () => {
    const r = computePlacement(base({ availableSpace: { left: 5, top: 4 } }));
    // clampedOffsetX = min(35, max(0, 5-1)) = 4; x = 200 - 4 = 196
    // clampedOffsetY = min(12, max(0, 4-1)) = 3; y = 100 - 3 = 97
    // both axes clamped => offset rode ancestor geometry
    expect(r).toEqual({ x: 196, y: 97, scrollSensitive: false, geometryDependent: true });
  });

  it('marks scrollSensitive and clamps to the sticky bound', () => {
    const r = computePlacement(base({ stickyBound: { left: 190, top: 80 } }));
    // unclamped x = 165 < 190 => x = 190; y = 88 > 80 => y unchanged 88
    expect(r.scrollSensitive).toBe(true);
    expect(r.geometryDependent).toBe(true);
    expect(r.x).toBe(190);
    expect(r.y).toBe(88);
  });

  it('leaves geometryDependent false when available space is defined but generous', () => {
    // space is defined but larger than the offset, so the clamp never bites —
    // a resize won't move this badge, so it must NOT be flagged geometry-dependent.
    const r = computePlacement(base({ availableSpace: { left: 999, top: 999 } }));
    expect(r).toEqual({ x: 165, y: 88, scrollSensitive: false, geometryDependent: false });
  });

  it('stays target-relative (no viewport floor) when the offset goes negative', () => {
    // Target near the viewport origin: the ratio overhang pushes the badge
    // above-and-left into negative viewport coords. That is correct — the
    // offset must describe "up-and-left of the target", not be clamped to
    // viewport (0,0). A floor here would bake a viewport-dependent delta into
    // the scroll-invariant anchor offset and strand the badge on scroll-back.
    const r = computePlacement(base({ targetRect: { left: 2, top: 1 } }));
    // x = 2 - 35 = -33; y = 1 - 12 = -11
    expect(r).toEqual({ x: -33, y: -11, scrollSensitive: false, geometryDependent: false });
  });

  it('keeps a scrolled-above target relative, not pinned to the viewport top', () => {
    // The strand repro: target scrolled above the viewport (negative top).
    // Pre-fix this clamped y to 0 and the anchor bake froze the +|top| delta.
    const r = computePlacement(base({ nudge: { x: 1, y: 1 }, targetRect: { left: 200, top: -43 } }));
    // ratio 1 => offset 0 => badge sits exactly at the target top (-43),
    // so the baked anchor offset is 0 and the badge tracks on scroll-back.
    expect(r).toEqual({ x: 200, y: -43, scrollSensitive: false, geometryDependent: false });
  });

  it('flush-left tight clip: clamp keeps the badge inside but it still sits on the target', () => {
    // YouTube Shorts case: text rect is at the clip ancestor's left edge.
    // Pre-Rango-model this collapsed the offset to 0 and pulled the badge
    // entirely onto the text. With ratio nudge the unclamped offset is 35,
    // the clamp at space.left=0 still pulls it to 0, but the badge already
    // sat partly on the text — the worst case is now the same as the inside
    // mode (badge at target.left), no surprise jump.
    const r = computePlacement(base({ availableSpace: { left: 0, top: 200 } }));
    // clampedOffsetX = min(35, max(0, -1)) = 0; x = 200; y = 100 - 12 = 88
    expect(r.x).toBe(200);
    expect(r.y).toBe(88);
    expect(r.geometryDependent).toBe(true);
  });
});

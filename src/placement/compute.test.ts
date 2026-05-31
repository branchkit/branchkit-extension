import { describe, it, expect } from 'vitest';
import { computePlacement, PlacementInputs } from './compute';

function base(overrides: Partial<PlacementInputs> = {}): PlacementInputs {
  return {
    targetRect: { left: 200, top: 100 },
    elementRect: { left: 200, bottom: 130 },
    badgeSize: { w: 16, h: 12 },
    nudge: { kind: 'outside', x: 3, y: 0 },
    availableSpace: { left: undefined, top: undefined },
    stickyBound: null,
    inScrollList: false,
    hasText: true,
    ...overrides,
  };
}

describe('computePlacement', () => {
  it('outside nudge places the badge up-and-left of the target by (size - overhang)', () => {
    const r = computePlacement(base());
    // hintOffsetX = max(0, 16 - 3) = 13; x = 200 - 13 = 187
    // hintOffsetY = max(0, 12 - 0) = 12; y = 100 - 12 = 88
    // no clamp, no sticky => offset is purely target-relative
    expect(r).toEqual({ x: 187, y: 88, scrollSensitive: false, geometryDependent: false });
  });

  it('inside nudge keeps the badge within the target (ratio offset)', () => {
    const r = computePlacement(base({ nudge: { kind: 'inside', x: 1, y: 1 }, hasText: false }));
    // ratio 1 => offset 0 => badge at target top-left
    expect(r).toEqual({ x: 200, y: 100, scrollSensitive: false, geometryDependent: false });
  });

  it('clamps the offset to available space so the badge never overflows its clip ancestor', () => {
    const r = computePlacement(base({ availableSpace: { left: 5, top: 4 } }));
    // clampedOffsetX = min(13, max(0, 5-1)) = 4; x = 200 - 4 = 196
    // clampedOffsetY = min(12, max(0, 4-1)) = 3; y = 100 - 3 = 97
    // both axes clamped => offset rode ancestor geometry
    expect(r).toEqual({ x: 196, y: 97, scrollSensitive: false, geometryDependent: true });
  });

  it('marks scrollSensitive and clamps to the sticky bound', () => {
    // sticky.top kept above the unclamped y so the overlap fallback can't fire.
    const r = computePlacement(base({ stickyBound: { left: 190, top: 80 } }));
    // unclamped x = 187 < 190 => x = 190; y = 88 > 80 => y unchanged 88
    // overlapIntoText = (88 + 12) - 100 = 0, not > 4.8 => no fallback
    expect(r.scrollSensitive).toBe(true);
    expect(r.geometryDependent).toBe(true);
    expect(r.x).toBe(190);
    expect(r.y).toBe(88);
  });

  it('leaves geometryDependent false when available space is defined but generous', () => {
    // space is defined but larger than the offset, so the clamp never bites —
    // a resize won't move this badge, so it must NOT be flagged geometry-dependent.
    const r = computePlacement(base({ availableSpace: { left: 999, top: 999 } }));
    expect(r).toEqual({ x: 187, y: 88, scrollSensitive: false, geometryDependent: false });
  });

  it('applies the overlap-into-text fallback when a sticky clamp pushes the badge onto the text', () => {
    // Sticky top forces y down onto the text; fallback re-anchors below.
    const r = computePlacement(base({
      stickyBound: { left: 190, top: 120 },
      elementRect: { left: 200, bottom: 130 },
    }));
    // y clamped to 120; overlapIntoText = (120 + 12) - 100 = 32 > 12*0.4=4.8
    // fallback: x = max(190, 200) = 200; y = 130 - 6 = 124
    expect(r.x).toBe(200);
    expect(r.y).toBe(124);
  });

  it('suppresses the overlap fallback when the target is in a scroll list', () => {
    const r = computePlacement(base({
      stickyBound: { left: 190, top: 120 },
      inScrollList: true,
    }));
    // fallback skipped; plain sticky clamp stands: x = max(190,187)=190, y=120
    expect(r.x).toBe(190);
    expect(r.y).toBe(120);
  });

  it('suppresses the overlap fallback when the target has no text', () => {
    const r = computePlacement(base({
      stickyBound: { left: 190, top: 120 },
      hasText: false,
    }));
    expect(r.x).toBe(190);
    expect(r.y).toBe(120);
  });

  it('stays target-relative (no viewport floor) when the overhang goes negative', () => {
    // Target near the viewport origin: the outside overhang pushes the badge
    // above-and-left of it, into negative viewport coords. That is correct —
    // the offset must describe "up-and-left of the target", not be clamped to
    // viewport (0,0). A floor here would bake a viewport-dependent delta into
    // the scroll-invariant anchor offset and strand the badge on scroll-back.
    const r = computePlacement(base({ targetRect: { left: 2, top: 1 } }));
    // x = 2 - 13 = -11; y = 1 - 12 = -11
    expect(r).toEqual({ x: -11, y: -11, scrollSensitive: false, geometryDependent: false });
  });

  it('keeps a scrolled-above target relative, not pinned to the viewport top', () => {
    // The strand repro: target scrolled above the viewport (negative top).
    // Pre-fix this clamped y to 0 and the anchor bake froze the +|top| delta.
    const r = computePlacement(base({ nudge: { kind: 'inside', x: 1, y: 1 }, hasText: false, targetRect: { left: 200, top: -43 } }));
    // inside ratio 1 => offset 0 => badge sits exactly at the target top (-43),
    // so the baked anchor offset is 0 and the badge tracks on scroll-back.
    expect(r).toEqual({ x: 200, y: -43, scrollSensitive: false, geometryDependent: false });
  });
});

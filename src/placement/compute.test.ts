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
    expect(r).toEqual({ x: 187, y: 88, scrollSensitive: false });
  });

  it('inside nudge keeps the badge within the target (ratio offset)', () => {
    const r = computePlacement(base({ nudge: { kind: 'inside', x: 1, y: 1 }, hasText: false }));
    // ratio 1 => offset 0 => badge at target top-left
    expect(r).toEqual({ x: 200, y: 100, scrollSensitive: false });
  });

  it('clamps the offset to available space so the badge never overflows its clip ancestor', () => {
    const r = computePlacement(base({ availableSpace: { left: 5, top: 4 } }));
    // clampedOffsetX = min(13, max(0, 5-1)) = 4; x = 200 - 4 = 196
    // clampedOffsetY = min(12, max(0, 4-1)) = 3; y = 100 - 3 = 97
    expect(r).toEqual({ x: 196, y: 97, scrollSensitive: false });
  });

  it('marks scrollSensitive and clamps to the sticky bound', () => {
    // sticky.top kept above the unclamped y so the overlap fallback can't fire.
    const r = computePlacement(base({ stickyBound: { left: 190, top: 80 } }));
    // unclamped x = 187 < 190 => x = 190; y = 88 > 80 => y unchanged 88
    // overlapIntoText = (88 + 12) - 100 = 0, not > 4.8 => no fallback
    expect(r.scrollSensitive).toBe(true);
    expect(r.x).toBe(190);
    expect(r.y).toBe(88);
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

  it('never returns negative coordinates', () => {
    const r = computePlacement(base({ targetRect: { left: 2, top: 1 } }));
    expect(r.x).toBe(0);
    expect(r.y).toBe(0);
  });
});

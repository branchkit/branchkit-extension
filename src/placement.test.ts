import { describe, it, expect } from 'vitest';
import { OccupancyBitmap, generateCandidates } from './placement/greedy';
import { leaderLineGeometry } from './placement/geometry';

describe('OccupancyBitmap', () => {
  it('marks and tests overlapping rects', () => {
    const bm = new OccupancyBitmap(160, 160);
    bm.mark({ x: 10, y: 10, width: 20, height: 20 });
    expect(bm.test({ x: 15, y: 15, width: 10, height: 10 })).toBe(true);
  });

  it('returns false for non-overlapping rects', () => {
    const bm = new OccupancyBitmap(160, 160);
    bm.mark({ x: 0, y: 0, width: 8, height: 8 });
    expect(bm.test({ x: 80, y: 80, width: 8, height: 8 })).toBe(false);
  });

  it('handles boundary alignment — non-8px-aligned rects mark correct cells', () => {
    const bm = new OccupancyBitmap(80, 80);
    bm.mark({ x: 3, y: 5, width: 10, height: 10 });
    // Should mark cells covering (0,0)-(16,16) since ceil((3+10)/8)=2, ceil((5+10)/8)=2
    expect(bm.test({ x: 0, y: 0, width: 1, height: 1 })).toBe(true);
    expect(bm.test({ x: 12, y: 14, width: 1, height: 1 })).toBe(true);
    expect(bm.test({ x: 16, y: 16, width: 8, height: 8 })).toBe(false);
  });

  it('clamps rects partially outside viewport', () => {
    const bm = new OccupancyBitmap(80, 80);
    // Should not throw — just clamp to viewport bounds
    bm.mark({ x: -10, y: -10, width: 30, height: 30 });
    expect(bm.test({ x: 0, y: 0, width: 8, height: 8 })).toBe(true);
  });

  it('clamps rects fully outside viewport', () => {
    const bm = new OccupancyBitmap(80, 80);
    bm.mark({ x: -100, y: -100, width: 10, height: 10 });
    expect(bm.test({ x: 0, y: 0, width: 80, height: 80 })).toBe(false);
  });

  it('clears all cells', () => {
    const bm = new OccupancyBitmap(80, 80);
    bm.mark({ x: 0, y: 0, width: 80, height: 80 });
    expect(bm.test({ x: 40, y: 40, width: 8, height: 8 })).toBe(true);
    bm.clear();
    expect(bm.test({ x: 40, y: 40, width: 8, height: 8 })).toBe(false);
  });

  it('zero-size viewport does not throw', () => {
    expect(() => new OccupancyBitmap(0, 0)).not.toThrow();
    const bm = new OccupancyBitmap(0, 0);
    bm.mark({ x: 0, y: 0, width: 10, height: 10 });
    expect(bm.test({ x: 0, y: 0, width: 10, height: 10 })).toBe(false);
  });

  it('test returns false for empty rect', () => {
    const bm = new OccupancyBitmap(80, 80);
    bm.mark({ x: 0, y: 0, width: 80, height: 80 });
    expect(bm.test({ x: 40, y: 40, width: 0, height: 0 })).toBe(false);
  });
});

describe('generateCandidates', () => {
  const target = { left: 100, right: 300, top: 200, bottom: 230 };
  const badge = { w: 40, h: 18 };

  it('returns 6 candidates in priority order', () => {
    const candidates = generateCandidates(target, badge);
    expect(candidates).toHaveLength(6);
    expect(candidates.map(c => c.position)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('position 1 (inside-left) matches documented offsets', () => {
    const c = generateCandidates(target, badge)[0];
    expect(c.x).toBe(target.left - badge.w * 0.3);
    expect(c.y).toBe(target.top + 2);
    expect(c.width).toBe(badge.w);
    expect(c.height).toBe(badge.h);
  });

  it('position 2 (above-left) matches documented offsets', () => {
    const c = generateCandidates(target, badge)[1];
    expect(c.x).toBe(target.left);
    expect(c.y).toBe(target.top - badge.h - 2);
  });

  it('position 3 (above-right) matches documented offsets', () => {
    const c = generateCandidates(target, badge)[2];
    expect(c.x).toBe(target.right - badge.w);
    expect(c.y).toBe(target.top - badge.h - 2);
  });

  it('position 4 (below-left) matches documented offsets', () => {
    const c = generateCandidates(target, badge)[3];
    expect(c.x).toBe(target.left);
    expect(c.y).toBe(target.bottom + 2);
  });

  it('position 5 (below-right) matches documented offsets', () => {
    const c = generateCandidates(target, badge)[4];
    expect(c.x).toBe(target.right - badge.w);
    expect(c.y).toBe(target.bottom + 2);
  });

  it('position 6 (below-far-right) matches documented offsets', () => {
    const c = generateCandidates(target, badge)[5];
    expect(c.x).toBe(target.right + 4);
    expect(c.y).toBe(target.bottom + 2);
  });

  it('all candidates have badge dimensions', () => {
    const candidates = generateCandidates(target, badge);
    for (const c of candidates) {
      expect(c.width).toBe(badge.w);
      expect(c.height).toBe(badge.h);
    }
  });

  it('generates candidates even when target is at viewport edge', () => {
    const edgeTarget = { left: -5, right: 50, top: -10, bottom: 20 };
    const candidates = generateCandidates(edgeTarget, badge);
    expect(candidates).toHaveLength(6);
    // Candidates may have negative coords — the bitmap rejects them, not the generator
    expect(candidates[1].y).toBeLessThan(0);
  });
});

describe('leaderLineGeometry', () => {
  it('horizontal line has angle 0', () => {
    const { length, angle } = leaderLineGeometry({ x: 0, y: 50 }, { x: 100, y: 50 });
    expect(angle).toBe(0);
    expect(length).toBe(100);
  });

  it('vertical line (downward) has angle pi/2', () => {
    const { length, angle } = leaderLineGeometry({ x: 50, y: 0 }, { x: 50, y: 80 });
    expect(angle).toBeCloseTo(Math.PI / 2);
    expect(length).toBe(80);
  });

  it('diagonal matches Pythagorean theorem', () => {
    const { length, angle } = leaderLineGeometry({ x: 0, y: 0 }, { x: 30, y: 40 });
    expect(length).toBeCloseTo(50);
    expect(angle).toBeCloseTo(Math.atan2(40, 30));
  });

  it('reverse horizontal has angle pi', () => {
    const { angle } = leaderLineGeometry({ x: 100, y: 0 }, { x: 0, y: 0 });
    expect(angle).toBeCloseTo(Math.PI);
  });

  it('zero distance', () => {
    const { length, angle } = leaderLineGeometry({ x: 5, y: 5 }, { x: 5, y: 5 });
    expect(length).toBe(0);
    expect(angle).toBe(0);
  });
});

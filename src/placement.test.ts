import { describe, it, expect } from 'vitest';
import { leaderLineGeometry } from './placement/geometry';

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

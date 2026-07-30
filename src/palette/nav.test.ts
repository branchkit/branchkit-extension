import { describe, it, expect } from 'vitest';
import { applyNavIntent, paletteJumpStep } from './nav';

describe('paletteJumpStep', () => {
  it('is half the visible rows, floored', () => {
    expect(paletteJumpStep(20)).toBe(10);
    expect(paletteJumpStep(21)).toBe(10);
  });

  it('never stalls on a tiny or empty viewport', () => {
    expect(paletteJumpStep(1)).toBe(1);
    expect(paletteJumpStep(0)).toBe(1);
    expect(paletteJumpStep(-5)).toBe(1);
    expect(paletteJumpStep(NaN)).toBe(1);
  });

  it('stays strictly inside the viewport, so a jump never lands blind', () => {
    for (const v of [2, 5, 8, 13, 20, 47]) {
      expect(paletteJumpStep(v)).toBeLessThan(v);
    }
  });
});

describe('applyNavIntent — single steps wrap', () => {
  it('walks forward and wraps past the end', () => {
    expect(applyNavIntent('next', 0, 5, 10)).toBe(1);
    expect(applyNavIntent('next', 4, 5, 10)).toBe(0);
  });

  it('walks back and wraps past the start', () => {
    expect(applyNavIntent('prev', 4, 5, 10)).toBe(3);
    expect(applyNavIntent('prev', 0, 5, 10)).toBe(4);
  });
});

describe('applyNavIntent — jumps clamp', () => {
  it('moves half a screen', () => {
    expect(applyNavIntent('pageNext', 0, 100, 20)).toBe(10);
    expect(applyNavIntent('pagePrev', 50, 100, 20)).toBe(40);
  });

  it('lands exactly on the edge rather than no-oping, so repeats walk out', () => {
    expect(applyNavIntent('pageNext', 95, 100, 20)).toBe(99);
    expect(applyNavIntent('pageNext', 99, 100, 20)).toBe(99);
    expect(applyNavIntent('pagePrev', 4, 100, 20)).toBe(0);
    expect(applyNavIntent('pagePrev', 0, 100, 20)).toBe(0);
  });

  it('does NOT wrap — the whole reason jumps differ from single steps', () => {
    expect(applyNavIntent('pageNext', 99, 100, 20)).not.toBe(0);
    expect(applyNavIntent('pagePrev', 0, 100, 20)).not.toBe(99);
  });
});

describe('applyNavIntent — ends', () => {
  it('goes to the first and last rows', () => {
    expect(applyNavIntent('first', 42, 100, 20)).toBe(0);
    expect(applyNavIntent('last', 42, 100, 20)).toBe(99);
  });

  it('is idempotent, which is what lets a bare g stand in for gg', () => {
    const once = applyNavIntent('first', 42, 100, 20);
    expect(applyNavIntent('first', once, 100, 20)).toBe(once);
  });
});

describe('applyNavIntent — degenerate input', () => {
  it('returns 0 for an empty list', () => {
    for (const i of ['next', 'prev', 'pageNext', 'pagePrev', 'first', 'last'] as const) {
      expect(applyNavIntent(i, 0, 0, 10)).toBe(0);
    }
  });

  it('clamps a selection that outran the list (teardown frame)', () => {
    expect(applyNavIntent('next', 99, 3, 10)).toBe(0); // clamped to 2, then wraps
    expect(applyNavIntent('prev', -7, 3, 10)).toBe(2); // clamped to 0, then wraps
  });
});

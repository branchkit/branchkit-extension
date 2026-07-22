import { describe, it, expect } from 'vitest';
import { planModify, nextGrowthDir, opposite, nativeGranularity } from './selection-grammar';

describe('planModify — verb × granularity × direction × count → Selection.modify args', () => {
  it('extends in the growth direction by default (bare "extend word")', () => {
    expect(planModify('extend', 'word', undefined, 1, 'forward')).toEqual({
      alter: 'extend', direction: 'forward', granularity: 'word', count: 1,
    });
    // A backward-growing selection keeps growing backward on a bare extend.
    expect(planModify('extend', 'sentence', undefined, 1, 'backward')).toMatchObject({
      direction: 'backward', granularity: 'sentence',
    });
  });

  it('honors an explicit spoken direction ("extend back word")', () => {
    expect(planModify('extend', 'word', 'backward', 1, 'forward')).toMatchObject({
      direction: 'backward', granularity: 'word',
    });
  });

  it('shrink extends toward the anchor — opposite the growth direction', () => {
    expect(planModify('shrink', 'word', undefined, 1, 'forward')).toMatchObject({
      alter: 'extend', direction: 'backward',
    });
    expect(planModify('shrink', 'line', undefined, 1, 'backward')).toMatchObject({
      direction: 'forward',
    });
  });

  it('clamps count to a whole number >= 1', () => {
    expect(planModify('extend', 'word', undefined, 3, 'forward').count).toBe(3);
    expect(planModify('extend', 'word', undefined, 0, 'forward').count).toBe(1);
    expect(planModify('extend', 'word', undefined, NaN, 'forward').count).toBe(1);
    expect(planModify('extend', 'word', undefined, 2.9, 'forward').count).toBe(2);
  });

  it('maps lineboundary through unchanged (extend to end/start)', () => {
    expect(nativeGranularity('lineboundary')).toBe('lineboundary');
    expect(planModify('extend', 'lineboundary', 'forward', 1, 'forward').granularity)
      .toBe('lineboundary');
  });
});

describe('nextGrowthDir — the tracked direction state machine', () => {
  it('re-aims growth when an explicit direction is spoken', () => {
    expect(nextGrowthDir('extend', 'backward', 'forward')).toBe('backward');
    expect(nextGrowthDir('extend', 'forward', 'backward')).toBe('forward');
  });

  it('leaves growth unchanged for a bare extend or any shrink', () => {
    expect(nextGrowthDir('extend', undefined, 'forward')).toBe('forward');
    expect(nextGrowthDir('shrink', undefined, 'forward')).toBe('forward');
    expect(nextGrowthDir('shrink', 'backward', 'backward')).toBe('backward');
  });

  it('flip inverts the growth direction', () => {
    expect(nextGrowthDir('flip', undefined, 'forward')).toBe('backward');
    expect(nextGrowthDir('flip', undefined, 'backward')).toBe('forward');
  });
});

describe('opposite', () => {
  it('swaps the two directions', () => {
    expect(opposite('forward')).toBe('backward');
    expect(opposite('backward')).toBe('forward');
  });
});

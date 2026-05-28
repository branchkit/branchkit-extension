/**
 * BranchKit Browser — limbo-wrapper rebind matcher tests.
 *
 * Pure-function tests for `findLimboMatch`. Element refs are stubs —
 * the matcher only looks at `lastRect` on the wrapper, plus the
 * caller-supplied `newRect`.
 */

import { describe, it, expect } from 'vitest';
import { ElementWrapper } from './element-wrapper';
import {
  bumpRebindCounter,
  findLimboMatch,
  newRebindCounters,
  REBIND_DISTANCE_THRESHOLD_PX,
} from './rebind';
import type { ScannedElement } from './types';

function fakeElement(label = 'el'): Element {
  return { tagName: 'BUTTON', __debug: label } as unknown as Element;
}

function fakeScanned(overrides: Partial<ScannedElement> = {}): ScannedElement {
  return {
    label: 'click me',
    id: 1,
    category: 'button',
    type: 'button',
    adapter: null,
    codeword: 'arch',
    ...overrides,
  };
}

function fakeRect(x: number, y: number, w = 20, h = 20): DOMRect {
  return {
    x, y, width: w, height: h,
    top: y, left: x, right: x + w, bottom: y + h,
    toJSON: () => ({}),
  } as DOMRect;
}

function limbo(id: number, rect: DOMRect | null, codeword = `cw${id}`): ElementWrapper {
  const w = new ElementWrapper(fakeElement(`limbo${id}`), fakeScanned({ id, codeword }));
  w.disconnectedAt = 1_000;
  w.lastRect = rect;
  return w;
}

describe('findLimboMatch', () => {
  it('returns no_candidates when the fingerprint pool is empty', () => {
    const out = findLimboMatch([], fakeRect(0, 0), REBIND_DISTANCE_THRESHOLD_PX);
    expect(out).toEqual({ kind: 'no_candidates' });
  });

  it('returns rebind_clean for a single fingerprint match (no rect needed)', () => {
    const w = limbo(7, fakeRect(100, 200));
    const out = findLimboMatch([w], null, REBIND_DISTANCE_THRESHOLD_PX);
    expect(out).toEqual({ kind: 'rebind_clean', wrapper: w });
  });

  it('returns rebind_position for the nearest match within threshold', () => {
    // Two candidates at distinctly different last positions; new element
    // sits next to the second one.
    const wTop = limbo(1, fakeRect(100, 100));        // center (110, 110)
    const wBot = limbo(2, fakeRect(100, 500));        // center (110, 510)
    const newRect = fakeRect(108, 498);               // center (118, 508)
    const out = findLimboMatch([wTop, wBot], newRect, REBIND_DISTANCE_THRESHOLD_PX);
    expect(out.kind).toBe('rebind_position');
    if (out.kind === 'rebind_position') {
      expect(out.wrapper).toBe(wBot);
      expect(out.candidateCount).toBe(2);
      // per-axis distance: max(|108-110|, |498-510|) but using centers
      // so max(|118-110|, |508-510|) = max(8, 2) = 8
      expect(out.distance).toBe(8);
    }
  });

  it('refuses on distance when the closest candidate exceeds the threshold', () => {
    // Both candidates shifted hundreds of pixels — page rearranged.
    const w1 = limbo(1, fakeRect(0, 0));
    const w2 = limbo(2, fakeRect(0, 200));
    const newRect = fakeRect(0, 600);                 // 400px from nearest
    const out = findLimboMatch([w1, w2], newRect, REBIND_DISTANCE_THRESHOLD_PX);
    expect(out.kind).toBe('refuse_distance');
    if (out.kind === 'refuse_distance') {
      expect(out.candidates).toEqual([w1, w2]);
      expect(out.bestDistance).toBe(400);
    }
  });

  it('refuses when no candidate has a lastRect to tiebreak with', () => {
    // Both candidates entered limbo before layout cache was warmed —
    // can't safely pick one. (Pre-disconnect cache miss is a real edge
    // case: page-load races; first-paint discoveries that hadn't been
    // through cacheLayout yet.)
    const w1 = limbo(1, null);
    const w2 = limbo(2, null);
    const out = findLimboMatch([w1, w2], fakeRect(0, 0), REBIND_DISTANCE_THRESHOLD_PX);
    expect(out.kind).toBe('refuse_distance');
    if (out.kind === 'refuse_distance') {
      expect(out.bestDistance).toBe(Infinity);
      expect(out.candidates).toEqual([w1, w2]);
    }
  });

  it('refuses multi-match when newRect is null (single match would have rebound)', () => {
    const w1 = limbo(1, fakeRect(0, 0));
    const w2 = limbo(2, fakeRect(0, 200));
    const out = findLimboMatch([w1, w2], null, REBIND_DISTANCE_THRESHOLD_PX);
    expect(out.kind).toBe('refuse_distance');
  });

  it('uses per-axis (Chebyshev) distance, not Euclidean', () => {
    // (60, 60) is Euclidean ~85 from origin but per-axis 60.
    const wA = limbo(1, fakeRect(0, 0));              // center (10, 10)
    const wB = limbo(2, fakeRect(200, 0));            // far away on x
    const newRect = fakeRect(60, 60);                 // center (70, 70)
    // Per-axis (max(|70-10|, |70-10|)) = 60. Above threshold of 50.
    const out = findLimboMatch([wA, wB], newRect, REBIND_DISTANCE_THRESHOLD_PX);
    expect(out.kind).toBe('refuse_distance');
    if (out.kind === 'refuse_distance') {
      expect(out.bestDistance).toBe(60);
    }
  });

  it('picks the closest of three when one is right next to the new element', () => {
    const wA = limbo(1, fakeRect(0, 0));              // center (10, 10), dist 100
    const wB = limbo(2, fakeRect(95, 95));            // center (105, 105), dist 5
    const wC = limbo(3, fakeRect(200, 200));          // center (210, 210), dist 100
    const newRect = fakeRect(100, 100);               // center (110, 110)
    const out = findLimboMatch([wA, wB, wC], newRect, REBIND_DISTANCE_THRESHOLD_PX);
    expect(out.kind).toBe('rebind_position');
    if (out.kind === 'rebind_position') {
      expect(out.wrapper).toBe(wB);
      expect(out.distance).toBe(5);
      expect(out.candidateCount).toBe(3);
    }
  });

  it('threshold is inclusive — exactly at the threshold rebinds', () => {
    const wA = limbo(1, fakeRect(0, 0));              // center (10, 10)
    const wB = limbo(2, fakeRect(200, 200));
    const newRect = fakeRect(60, 10);                 // center (70, 20)
    // Per-axis: max(|70-10|, |20-10|) = 60. Above default 50. With
    // threshold 60, should rebind.
    const out = findLimboMatch([wA, wB], newRect, 60);
    expect(out.kind).toBe('rebind_position');
    const out2 = findLimboMatch([wA, wB], newRect, 59);
    expect(out2.kind).toBe('refuse_distance');
  });
});

describe('bumpRebindCounter', () => {
  it('increments the bucket matching the outcome kind', () => {
    const c = newRebindCounters();
    const w = limbo(1, null);

    bumpRebindCounter(c, { kind: 'rebind_clean', wrapper: w });
    bumpRebindCounter(c, { kind: 'rebind_clean', wrapper: w });
    bumpRebindCounter(c, { kind: 'rebind_position', wrapper: w, distance: 12, candidateCount: 3 });
    bumpRebindCounter(c, { kind: 'refuse_distance', bestDistance: 200, candidates: [w] });

    expect(c).toEqual({
      rebind_clean: 2,
      rebind_position: 1,
      refuse_distance: 1,
      refuse_no_match: 0,
    });
  });

  it('no_candidates is intentionally not counted', () => {
    // It's a "no rebind decision was needed" signal, not a refusal.
    // The finalize sweeper owns refuse_no_match.
    const c = newRebindCounters();
    bumpRebindCounter(c, { kind: 'no_candidates' });
    bumpRebindCounter(c, { kind: 'no_candidates' });
    expect(c).toEqual({
      rebind_clean: 0,
      rebind_position: 0,
      refuse_distance: 0,
      refuse_no_match: 0,
    });
  });

  it('counter keys match the four LimboMatchOutcome buckets', () => {
    // Locks the relationship: every counter except refuse_no_match must
    // correspond to a kind the matcher can return. If a new outcome
    // kind is added without a counter, this test guards the gap.
    const c = newRebindCounters();
    const matcherBuckets = ['rebind_clean', 'rebind_position', 'refuse_distance'] as const;
    for (const k of matcherBuckets) expect(c).toHaveProperty(k);
    expect(c).toHaveProperty('refuse_no_match');
    expect(Object.keys(c).sort()).toEqual([
      'rebind_clean', 'rebind_position', 'refuse_distance', 'refuse_no_match',
    ].sort());
  });
});

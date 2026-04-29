/**
 * BranchKit Browser — Allocator unit tests.
 *
 * Pure-function tests for the ranking comparator. No DOM env required:
 * `HintCandidate.rect` is a structural subset of DOMRect, so plain
 * objects work as test inputs.
 *
 * Run: npm test
 */

import { describe, it, expect } from 'vitest';
import {
  HintCandidate,
  HintRect,
  Point,
  rankByDistance,
  getRankedCandidates,
} from './allocator';

function rect(left: number, top: number, width = 10, height = 10): HintRect {
  return { left, top, width, height };
}

function cand(id: string, r: HintRect, oldCodeword?: string): HintCandidate {
  return oldCodeword ? { id, rect: r, oldCodeword } : { id, rect: r };
}

const ORIGIN: Point = { x: 0, y: 0 };

describe('rankByDistance', () => {
  it('returns 0 when both candidates are equidistant and at identical position', () => {
    const c = rankByDistance(ORIGIN);
    const a = cand('a', rect(100, 100));
    const b = cand('b', rect(100, 100));
    expect(c(a, b)).toBe(0);
  });

  it('ranks the closer candidate first', () => {
    const c = rankByDistance({ x: 50, y: 50 });
    const near = cand('near', rect(40, 40));
    const far = cand('far', rect(500, 500));
    expect(c(near, far)).toBeLessThan(0);
    expect(c(far, near)).toBeGreaterThan(0);
  });

  it('measures distance to the rect center, not the corner', () => {
    // Two rects with identical top-left but different sizes: the larger
    // rect's center is farther from origin.
    const c = rankByDistance(ORIGIN);
    const small = cand('small', rect(100, 100, 10, 10));
    const big = cand('big', rect(100, 100, 200, 200));
    expect(c(small, big)).toBeLessThan(0);
  });

  it('on equal distance, tiebreaks by top (lower top first)', () => {
    // Both rects equidistant from origin (square symmetry around y=x).
    // Pick rects that visually differ only in vertical position.
    const focus: Point = { x: 100, y: 100 };
    const c = rankByDistance(focus);
    const upper = cand('upper', rect(110, 90));   // center at (115, 95)
    const lower = cand('lower', rect(90, 110));   // center at (95, 115)
    // Both are sqrt(50) from focus center.
    expect(c(upper, lower)).toBeLessThan(0);
  });

  it('on equal distance and identical top, tiebreaks by left', () => {
    // Same y (so identical top), both equidistant horizontally.
    const c = rankByDistance({ x: 100, y: 0 });
    const left = cand('left', rect(80, 0));   // center at (85, 5)
    const right = cand('right', rect(110, 0)); // center at (115, 5)
    // Both 15 px from focus.
    expect(c(left, right)).toBeLessThan(0);
  });
});

describe('getRankedCandidates', () => {
  it('returns an empty array unchanged', () => {
    expect(getRankedCandidates([], ORIGIN)).toEqual([]);
  });

  it('returns a single-element array unchanged', () => {
    const only = cand('only', rect(50, 50));
    expect(getRankedCandidates([only], ORIGIN)).toEqual([only]);
  });

  it('sorts closer-to-focus candidates first', () => {
    const focus: Point = { x: 0, y: 0 };
    const far = cand('far', rect(500, 500));
    const mid = cand('mid', rect(100, 100));
    const near = cand('near', rect(10, 10));
    const result = getRankedCandidates([far, mid, near], focus);
    expect(result.map(c => c.id)).toEqual(['near', 'mid', 'far']);
  });

  it('does not mutate the input array', () => {
    const focus: Point = { x: 0, y: 0 };
    const input = [
      cand('far', rect(500, 500)),
      cand('near', rect(10, 10)),
    ];
    const before = [...input];
    getRankedCandidates(input, focus);
    expect(input).toEqual(before);
  });

  it('preserves input order on full ties (stable sort)', () => {
    // Identical rects → ties through every comparator branch.
    // Stable sort preserves discovery order, which the caller may have
    // imposed meaningfully (e.g. DOM order from scanElements).
    const r = rect(100, 100);
    const a = cand('a', r);
    const b = cand('b', r);
    const c = cand('c', r);
    const result = getRankedCandidates([a, b, c], ORIGIN);
    expect(result.map(x => x.id)).toEqual(['a', 'b', 'c']);
  });

  it('treats negative-coordinate rects (above/left of viewport) like any other', () => {
    // Off-screen-but-tracked candidates appear with negative top/left
    // when scrolled past. Distance still ranks them correctly.
    const focus: Point = { x: 0, y: 0 };
    const above = cand('above', rect(-5, -5));   // very close to origin
    const below = cand('below', rect(200, 200)); // far from origin
    const result = getRankedCandidates([below, above], focus);
    expect(result.map(c => c.id)).toEqual(['above', 'below']);
  });

  it('accepts oldCodeword on the candidate without affecting ranking', () => {
    // Sprint C ships rank-and-pair; oldCodeword is reserved for a
    // future stability metric and must not influence the comparator yet.
    const focus: Point = { x: 0, y: 0 };
    const withOld = cand('with', rect(500, 500), 'arch');
    const withoutOld = cand('without', rect(10, 10));
    const result = getRankedCandidates([withOld, withoutOld], focus);
    expect(result.map(c => c.id)).toEqual(['without', 'with']);
  });
});

import { describe, it, expect } from 'vitest';
import { bandOverhang, planBandWindow, type BandCandidate } from './band-window';
import { geometryInBand } from '../core/layout-cache';

const VW = 1000;
const VH = 800;
const rect = (top: number, bottom: number, left = 10, right = 60) =>
  ({ top, bottom, left, right, width: right - left, height: bottom - top }) as DOMRect;

describe('bandOverhang', () => {
  it('is 0 for anything intersecting the viewport', () => {
    expect(bandOverhang(rect(10, 30), VW, VH)).toBe(0);
    expect(bandOverhang(rect(-5, 5), VW, VH)).toBe(0);   // straddling the top
    expect(bandOverhang(rect(VH - 5, VH + 50), VW, VH)).toBe(0); // straddling the fold
  });

  it('measures the distance outside, per axis', () => {
    expect(bandOverhang(rect(-200, -150), VW, VH)).toBe(150);      // above
    expect(bandOverhang(rect(VH + 100, VH + 150), VW, VH)).toBe(100); // below
    expect(bandOverhang(rect(10, 30, -400, -300), VW, VH)).toBe(300); // left
  });

  it('agrees with geometryInBand — same geometry, distance vs boolean', () => {
    for (const r of [rect(10, 30), rect(-200, -150), rect(-2000, -1900), rect(VH + 50, VH + 90)]) {
      for (const m of [0.0001, 100, 500, 1000, 2500]) {
        expect(bandOverhang(r, VW, VH) < m).toBe(geometryInBand(r, VW, VH, m));
      }
    }
  });
});

describe('planBandWindow', () => {
  const c = (name: string, overhang: number, held = false): BandCandidate<string> =>
    ({ item: name, overhang, held });

  it('claims what is in band and untaken, keeps what is in band and taken', () => {
    const plan = planBandWindow([c('a', 0), c('b', 0, true), c('c', 500)], 10, 1000);
    expect(plan.toClaim).toEqual(['a', 'c']);
    expect(plan.toKeep).toEqual(['b']);
    expect(plan.toDrop).toEqual([]);
    expect(plan.margin).toBe(1000);
  });

  it('drops only what is out of band AND holding — an untaken far member is a no-op', () => {
    const plan = planBandWindow([c('near', 0, true), c('far', 5000, true), c('idle', 5000)], 10, 1000);
    expect(plan.toDrop).toEqual(['far']);
    expect(plan.toClaim).toEqual([]);
    expect(plan.toKeep).toEqual(['near']);
  });

  it('under budget pressure the margin tightens to the nearest members', () => {
    // Six candidates spread through the band, budget of three: the three
    // NEAREST win, regardless of the order they appear in.
    const plan = planBandWindow(
      [c('far', 900), c('near', 0), c('mid', 400), c('far2', 800), c('near2', 50), c('mid2', 300)],
      3, 1000);
    expect(plan.toClaim.sort()).toEqual(['mid2', 'near', 'near2']);
    expect(plan.margin).toBeLessThan(1000);
  });

  it('near-first is the property document order does not give', () => {
    // The hand-rolled version of this took the first N in DOM order, which on
    // a long page badges whatever appears earliest — not what the user is
    // looking at. Here the earliest candidates are the farthest away.
    const plan = planBandWindow(
      [c('first', 900), c('second', 800), c('third', 0)], 1, 1000);
    expect(plan.toClaim).toEqual(['third']);
  });

  it('does not tighten when the band fits inside the budget', () => {
    const plan = planBandWindow([c('a', 0), c('b', 900)], 5, 1000);
    expect(plan.margin).toBe(1000);
    expect(plan.toClaim).toEqual(['a', 'b']);
  });

  it('includes the whole cutoff row when members share an overhang', () => {
    // Grid cells in one row share an overhang; the +1 in the tightening keeps
    // the cutoff row whole rather than splitting it arbitrarily.
    const plan = planBandWindow(
      [c('r1a', 100), c('r1b', 100), c('r1c', 100), c('r2', 700)], 2, 1000);
    expect(plan.toClaim).toEqual(['r1a', 'r1b', 'r1c']);
  });

  it('without hardCap the budget is a geometric target, not a ceiling', () => {
    // The link badges' contract: tightening keeps the cutoff row whole and the
    // codeword pool absorbs any excess. Twelve members tied at overhang 0 give
    // tightening nothing to separate them by, so all twelve are claimed.
    const flat = Array.from({ length: 12 }, (_, i) => c(`m${i}`, 0));
    expect(planBandWindow(flat, 9, 1000).toClaim).toHaveLength(12);
  });

  it('with hardCap the budget is a ceiling, ties resolved in document order', () => {
    // The chips' contract: MAX_RANGE_BADGES is what the overflow toast
    // promises, and a tenth chip is a codeword spent outside the question.
    const flat = Array.from({ length: 12 }, (_, i) => c(`m${i}`, 0));
    const plan = planBandWindow(flat, 9, 1000, { hardCap: true });
    expect(plan.toClaim).toHaveLength(9);
    expect(plan.toClaim[0]).toBe('m0');
  });

  it('hardCap counts already-held members against the budget', () => {
    const plan = planBandWindow(
      [c('held1', 0, true), c('held2', 0, true), c('new1', 0), c('new2', 0)],
      3, 1000, { hardCap: true });
    expect(plan.toKeep).toEqual(['held1', 'held2']);
    expect(plan.toClaim).toEqual(['new1']); // only one slot left
  });

  it('an empty candidate set plans nothing', () => {
    const plan = planBandWindow<string>([], 9, 1000);
    expect(plan).toEqual({ toClaim: [], toKeep: [], toDrop: [], margin: 1000 });
  });
});

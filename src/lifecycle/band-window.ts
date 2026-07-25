/**
 * The band window: which of a set of viewport-ranked things should hold a
 * codeword right now.
 *
 * Pure arithmetic, no DOM, no store. Extracted from `SettleEngine.bandConverge`
 * so the link badges and the range-pick chips answer that question with ONE
 * derivation instead of two that drift. They differ in what a claim MEANS (a
 * wrapper writes its codeword and queues a grammar delta; a chip paints a badge
 * and publishes a record) and in exit policy — so this returns the decision and
 * each caller keeps its own sink.
 *
 * The budget-tightening rule is the load-bearing part, and the reason a
 * hand-rolled second version is a bug farm: when more members sit inside the
 * full band than the codeword budget can address, the margin shrinks to the
 * budget-th nearest overhang, so scarce codewords land closest-to-viewport
 * first. Take-the-first-N-in-document-order instead badges whatever appears
 * earliest in the DOM, which on a long page is not what the user is looking at.
 * The margin is a function of GEOMETRY ONLY — independent of which members
 * currently hold codewords — so the near/far partition is stable across passes
 * and cannot oscillate.
 */

/** How far outside the viewport a rect sits, in px; 0 = it intersects.
 *  `bandOverhang(r,…) < m` is exactly `geometryInBand(r,…,m)` — the same
 *  geometry as a distance instead of a boolean, so the two can't disagree. */
export function bandOverhang(r: DOMRectReadOnly, vw: number, vh: number): number {
  return Math.max(0, -r.bottom, r.top - vh, -r.right, r.left - vw);
}

export interface BandCandidate<T> {
  item: T;
  /** From `bandOverhang`. */
  overhang: number;
  /** Does this member hold a codeword right now? */
  held: boolean;
}

export interface BandPlan<T> {
  /** In band, holds nothing yet — claim for these. */
  toClaim: T[];
  /** In band and already holding — the sink clears any pending exit state. */
  toKeep: T[];
  /** Out of band and holding — release candidates. Whether a release actually
   *  happens is the sink's call (the wrapper path runs them through a
   *  two-strike ledger first; hysteresis is exit policy, not geometry). */
  toDrop: T[];
  /** The margin actually applied, after budget tightening. Diagnostic. */
  margin: number;
}

export interface BandOptions {
  /**
   * Trim claims to the budget even when tightening can't separate ties.
   *
   * Off (the link badges): the budget is a GEOMETRIC target. Tightening's +1
   * deliberately keeps the cutoff row whole — grid cells in one row share an
   * overhang, and a half-badged row looks broken — so the claim set may run a
   * little over; the codeword pool absorbs the excess by handing out nothing.
   *
   * On (the range-pick chips): the budget is a PROMISE. MAX_RANGE_BADGES is
   * what the overflow toast tells the user, and a tenth chip would be a
   * codeword spent outside the nine the question offers. Needed because the
   * common chip case is a dozen matches all fully on screen at overhang 0,
   * where tightening has nothing to separate them by.
   */
  hardCap?: boolean;
}

/**
 * Partition `candidates` into claim/keep/drop against a codeword budget.
 *
 * `fullMargin` is the band's reach under no pressure — how far outside the
 * viewport a member may sit and still be worth a codeword. Under budget
 * pressure the reach tightens; it never widens.
 */
export function planBandWindow<T>(
  candidates: readonly BandCandidate<T>[],
  budget: number,
  fullMargin: number,
  opts: BandOptions = {},
): BandPlan<T> {
  let inFullBand = 0;
  for (const c of candidates) if (c.overhang < fullMargin) inFullBand++;

  let margin = fullMargin;
  if (inFullBand > budget) {
    // +1 so the cutoff row is included (grid cells in one row share an
    // overhang) and the check below stays a strict `<`. Capped at the full
    // margin so this only ever tightens, never widens.
    const overhangs = candidates
      .filter((c) => c.overhang < fullMargin)
      .map((c) => c.overhang)
      .sort((a, b) => a - b);
    margin = Math.min(fullMargin, overhangs[budget - 1] + 1);
  }

  const toClaim: T[] = [];
  const toKeep: T[] = [];
  const toDrop: T[] = [];
  for (const c of candidates) {
    if (c.overhang < margin) {
      if (c.held) toKeep.push(c.item);
      else toClaim.push(c.item);
    } else if (c.held) {
      toDrop.push(c.item);
    }
  }
  // Ties resolve in candidate order (document order for both callers), which is
  // stable across passes. See BandOptions.hardCap for why this is opt-in.
  const room = Math.max(0, budget - toKeep.length);
  return {
    toClaim: opts.hardCap ? toClaim.slice(0, room) : toClaim,
    toKeep,
    toDrop,
    margin,
  };
}

/**
 * BranchKit Browser — limbo-wrapper rebind matcher.
 *
 * Step 3 of `notes/completed/DESIGN_WRAPPER_IDENTITY_STABILITY.md`. When
 * `discoverInSubtree` encounters a new hintable element, it consults
 * this module to decide whether the element is the React-rendered
 * replacement for an existing limbo wrapper — in which case the wrapper
 * (and its codeword + badge) gets rebound rather than torn down and
 * re-created with a fresh codeword.
 *
 * Pure: the caller pre-filters limbo wrappers by fingerprint
 * (registry-side concern); this module only resolves the multi-match
 * tiebreaker via position. Keeps fingerprint and registry imports out
 * of element-wrapper.ts (which would otherwise close the cycle).
 *
 * Distance is per-axis (max of |dx|, |dy|), not Euclidean — vertical
 * and horizontal mismatches mean different things on different sites
 * (a vertically-stable column with horizontal scroll, a horizontally-
 * stable row with vertical scroll, etc.); the per-axis worst-case is
 * the safer threshold.
 */

import type { ElementWrapper } from '../scan/element-wrapper';

/** Initial threshold (px). Per design doc, tunable from soak data. */
export const REBIND_DISTANCE_THRESHOLD_PX = 50;

export type LimboMatchOutcome =
  | { kind: 'rebind_clean'; wrapper: ElementWrapper }
  | { kind: 'rebind_position'; wrapper: ElementWrapper; distance: number; candidateCount: number }
  | { kind: 'refuse_distance'; bestDistance: number; candidates: ElementWrapper[] }
  | { kind: 'no_candidates' };

/**
 * Resolve a new element to a limbo wrapper or signal that none fit.
 *
 * Inputs:
 * - `fingerprintMatches`: limbo wrappers whose fingerprints the caller
 *   has already verified equal the new element's. Empty when there's no
 *   plausible rebind candidate.
 * - `newRect`: bounding rect of the new element (caller forces one
 *   layout read). Used only when ≥2 candidates exist.
 * - `distanceThresholdPx`: maximum per-axis center-distance to accept
 *   a position-tiebreaker match. Above this, the limbo wrappers are
 *   judged too spatially scrambled to safely rebind.
 *
 * The caller acts on the outcome:
 * - `rebind_clean` / `rebind_position`: rebind the named wrapper.
 * - `refuse_distance`: finalize the listed candidates and create a
 *   fresh wrapper for the new element.
 * - `no_candidates`: create a fresh wrapper.
 */
export function findLimboMatch(
  fingerprintMatches: ElementWrapper[],
  newRect: DOMRect | null,
  distanceThresholdPx: number,
): LimboMatchOutcome {
  if (fingerprintMatches.length === 0) return { kind: 'no_candidates' };
  if (fingerprintMatches.length === 1) {
    return { kind: 'rebind_clean', wrapper: fingerprintMatches[0] };
  }

  // Without a rect we can't tiebreak — refuse on ambiguity.
  if (!newRect) {
    return {
      kind: 'refuse_distance',
      bestDistance: Infinity,
      candidates: fingerprintMatches,
    };
  }

  const newCx = newRect.left + newRect.width / 2;
  const newCy = newRect.top + newRect.height / 2;

  let best: { wrapper: ElementWrapper; distance: number } | null = null;
  for (const w of fingerprintMatches) {
    if (!w.lastRect) continue;
    const cx = w.lastRect.left + w.lastRect.width / 2;
    const cy = w.lastRect.top + w.lastRect.height / 2;
    const d = Math.max(Math.abs(cx - newCx), Math.abs(cy - newCy));
    if (!best || d < best.distance) best = { wrapper: w, distance: d };
  }

  if (!best || best.distance > distanceThresholdPx) {
    return {
      kind: 'refuse_distance',
      bestDistance: best?.distance ?? Infinity,
      candidates: fingerprintMatches,
    };
  }

  return {
    kind: 'rebind_position',
    wrapper: best.wrapper,
    distance: best.distance,
    candidateCount: fingerprintMatches.length,
  };
}

/**
 * Per-bucket counters for soak-period calibration. Live counters live
 * in `content.ts`; this type is shared with the debug overlay.
 */
export interface RebindCounters {
  rebind_clean: number;
  rebind_position: number;
  refuse_distance: number;
  refuse_no_match: number;
  /** Key-ownership transfers (DESIGN_CODEWORD_KEY_OWNERSHIP.md): a new node
   *  inherited a predecessor's codeword via its strong key, bypassing the
   *  fingerprint/position path. Tracked separately so soak data can tell the
   *  two rebind routes apart. */
  rebind_key: number;
  /** Slot rebinds (DESIGN_FLING_WAVE.md Part 2): a recycled cell's new
   *  content inherited the limbo predecessor's wrapper via a surviving slot
   *  ancestor — different fingerprint, different key, same slot. Also the
   *  live probe for whether the grid's shells survive its swaps. */
  rebind_slot: number;
  /** Connected-predecessor takeovers by UNIQUE fingerprint (round 23,
   *  DESIGN_FLING_WAVE.md): the doomed predecessor was still in the DOM
   *  (insert-before-remove swap) so the limbo tiers couldn't see it. */
  takeover_fp: number;
  /** Same tier, ambiguous fingerprints resolved by the tight+margin
   *  position gate (identical per-row controls — checkboxes, pencils). */
  takeover_fp_position: number;
  /** Same tier, refused: multiple connected candidates and no candidate
   *  was uniquely co-located. Fresh attach (today's churn) follows. */
  refuse_fp_ambiguous: number;
  /** Row-coattail rides (round 26): a unique-fingerprint takeover
   *  established doomed-row ↔ replacement-row correspondence, and the
   *  row's OTHER wrappers (checkboxes, repeating lookup links — the
   *  content-ambiguous cohort no fingerprint or position gate can match)
   *  rode to their structural counterparts in the replacement row. */
  takeover_row: number;
}

export function newRebindCounters(): RebindCounters {
  return {
    rebind_clean: 0,
    rebind_position: 0,
    refuse_distance: 0,
    refuse_no_match: 0,
    rebind_key: 0,
    rebind_slot: 0,
    takeover_fp: 0,
    takeover_fp_position: 0,
    refuse_fp_ambiguous: 0,
    takeover_row: 0,
  };
}

/**
 * Increment the bucket corresponding to a discovery-time outcome.
 * `no_candidates` is intentionally NOT counted — it means there were no
 * limbo wrappers to consider, so the discovery is just a normal new
 * wrapper (not a rebind decision). `refuse_no_match` is bumped
 * separately by the finalize sweeper, not here.
 */
export function bumpRebindCounter(
  counters: RebindCounters,
  outcome: LimboMatchOutcome,
): void {
  switch (outcome.kind) {
    case 'rebind_clean':
    case 'rebind_position':
    case 'refuse_distance':
      counters[outcome.kind]++;
      return;
    case 'no_candidates':
      return;
  }
}

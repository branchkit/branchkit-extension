/**
 * BranchKit Browser — band-sweep dirty gate.
 *
 * `runSettlePipeline` arms the band-discovery sweep on EVERY settle (round 14
 * of DESIGN_FLING_WAVE), and each sweep re-walks document.body (~37ms on a
 * big DOM). Measured live (notes/DESIGN_BAND_SWEEP_DIRTY_GATE.md): on an idle
 * media tab whose settles come from attribute churn, 221 of 224 sweeps in 25
 * minutes yielded nothing — no content had been added, so nothing walkable
 * could exist that the incremental paths hadn't already handled.
 *
 * The gate skips a sweep only when all of:
 *   - not a mass-reveal fast-arm (those bypass — the sweep's follow-through
 *     paints the revealed cohort),
 *   - the DOM-add epoch equals the epoch the last sweep STARTED with (no
 *     observed adds since; mid-walk adds bump past the captured value and
 *     re-arm the next settle),
 *   - the last sweep finished less than LONG_STOP ago — the long-stop keeps
 *     the sweep's self-heal insurance for adds no observer can see (a shadow
 *     root attached before its host was ever walked, engine oddities).
 *
 * Reveal classes deliberately NOT gated on: class/style/open/hidden flips and
 * box-gain reveals promote through the parked-candidate sensors
 * (visibility-tracker), hover reveals through the pointer recheck — none of
 * them need the walk. Plan repairs below the fast-arm threshold are
 * existing-wrapper flag fixes the plan's own lists apply.
 *
 * Kill switch: `chrome.storage.local` `bkSweepGate: false` restores
 * every-settle arming (read at boot in content.ts, like bkOcclusion).
 */

export const SWEEP_LONG_STOP_MS = 30_000;

let gateEnabled = true;

export function setSweepGateEnabled(enabled: boolean): void {
  gateEnabled = enabled;
}

export function isSweepGateEnabled(): boolean {
  return gateEnabled;
}

export interface BandSweepGateInput {
  /** Current mutation-source DOM-add epoch. */
  domAddEpoch: number;
  /** Epoch captured when the last sweep's walk started (-1 = never swept). */
  sweptEpoch: number;
  /** performance.now() when the last sweep finished (0 = never swept). */
  sweepEndAt: number;
  now: number;
  /** Mass-reveal fast-arm (repairs >= REVEAL_REPAIR_FAST_ARM). */
  fastReveal: boolean;
}

export function shouldRunBandSweep(input: BandSweepGateInput): boolean {
  if (!gateEnabled) return true;
  if (input.fastReveal) return true;
  if (input.domAddEpoch !== input.sweptEpoch) return true;
  return input.now - input.sweepEndAt >= SWEEP_LONG_STOP_MS;
}

/**
 * BranchKit Browser — harness-only strict-input probe (settle-storm diagnosis).
 *
 * The plan (lifecycle/reconcile.ts) decides a `_strict` re-push by comparing
 * its computed inStrict against `lastSentStrictViewport`, but that baseline
 * is rewritten by `stampStrictViewport` at batch-POST time from a SECOND,
 * later computation (fresh gBCR + the settled wrapper flags). When the two
 * computations persistently disagree over a cohort, the same wrappers
 * re-enter the delta every pass — the settle-storm signature. This leaf
 * module holds the plan's last-pass inputs per wrapper so both sides can
 * attribute a flip to the exact input that moved. Leaf on purpose: reconcile
 * and strict-viewport both consume it, and an import edge between THEM would
 * cycle through gather/intersection-tracker (eval-time const reads).
 *
 * Populated only when harness hooks are enabled; a WeakMap, so it holds
 * nothing alive.
 */

import type { ElementWrapper } from '../scan/element-wrapper';

export interface StrictProbe {
  onScreen: boolean;
  clipped: boolean;
  overlayCovered: boolean;
  cssHidden: boolean;
  ancestor: boolean;
  inStrict: boolean;
}

export const lastStrictProbe = new WeakMap<ElementWrapper, StrictProbe>();

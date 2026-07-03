/**
 * BranchKit Browser — settle-plan unit tests.
 *
 * Pins the plan's per-action-class derivation (the settle pipeline's engine
 * — see reconcile.ts and notes/DESIGN_UNIFIED_RECONCILER.md): real connected
 * elements (the candidate/shown predicates read isConnected) + a synthetic
 * gather snapshot so the plan never falls back to live layout reads. Rects
 * are plain DOMRect-shaped objects in a 1000×800 viewport.
 *
 * Run: npm test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { HintBadge } from '../render/hints';
import {
  computeReconcilePlanLists,
  type ReconcilePlanLists,
} from './reconcile';
import type { SettleGather } from './gather';

function storeOf(wrappers: ElementWrapper[]): WrapperStore {
  const store = new WrapperStore();
  for (const w of wrappers) store.addWrapper(w);
  return store;
}

const VW = 1000;
const VH = 800;
// RECONCILE_BAND_MARGIN_PX is 1000 — beyond-band needs top > VH + 1000.
const ON_SCREEN = { top: 100, left: 100, width: 50, height: 20 };
const IN_BAND_OFF_SCREEN = { top: VH + 500, left: 100, width: 50, height: 20 };
const OFF_BAND = { top: VH + 3000, left: 100, width: 50, height: 20 };
const ZERO_BOX = { top: 0, left: 0, width: 0, height: 0 };

function rect(r: { top: number; left: number; width: number; height: number }): DOMRect {
  return {
    top: r.top, left: r.left,
    bottom: r.top + r.height, right: r.left + r.width,
    width: r.width, height: r.height, x: r.left, y: r.top,
    toJSON() { return this; },
  } as DOMRect;
}

let liveId = 100;
function liveWrapper(opts: {
  codeword?: string;
  hint?: 'visible' | 'dormant' | 'none';
  inViewport?: boolean;
  disconnected?: boolean;
  cssHidden?: boolean;
  occluded?: boolean;
  lastSent?: boolean;
}): ElementWrapper {
  const el = document.createElement('a');
  document.body.appendChild(el);
  const scanned: ScannedElement = {
    label: 'x', id: ++liveId, category: 'link', type: 'link', adapter: null,
    codeword: opts.codeword ?? '',
  };
  const w = new ElementWrapper(el, scanned);
  const hint = opts.hint ?? 'none';
  if (hint !== 'none') w.hint = { isVisible: hint === 'visible' } as HintBadge;
  w.isInViewport = opts.inViewport ?? false;
  if (opts.disconnected) w.disconnectedAt = 1;
  if (opts.cssHidden) w.cssHidden = true;
  if (opts.occluded) w.occluded = true;
  w.lastSentStrictViewport = opts.lastSent;
  return w;
}

function gatherOf(
  entries: Array<[ElementWrapper, { top: number; left: number; width: number; height: number }, boolean?]>,
  overlay?: Array<[ElementWrapper, boolean]>,
): SettleGather {
  const rects = new Map<ElementWrapper, DOMRect>();
  const cssVisible = new Map<ElementWrapper, boolean>();
  for (const [w, r, visible] of entries) {
    rects.set(w, rect(r));
    if (visible !== undefined) cssVisible.set(w, visible);
  }
  return {
    vw: VW, vh: VH, ancestorChainVisible: true, rects, cssVisible,
    overlayCovered: new Map(overlay ?? []),
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('computeReconcilePlanLists', () => {
  it('lists a visible hint with off-band geometry for release (stale-TRUE)', () => {
    const w = liveWrapper({ hint: 'visible', inViewport: true, codeword: 'ape' });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, OFF_BAND, true]]));
    expect(lists.toRelease).toEqual([w]);
    expect(lists.toRepair).toEqual([]);
  });

  it('does NOT release a dormant (hidden) off-band badge — desired state, not drift', () => {
    const w = liveWrapper({ hint: 'dormant', inViewport: false });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, OFF_BAND]]));
    expect(lists.toRelease).toEqual([]);
    expect(lists.toRepair).toEqual([]);
    expect(lists.toShow).toEqual([]);
    expect(lists.toHide).toEqual([]);
  });

  it('lists a flag-out in-band hinted wrapper for repair (stale-FALSE)', () => {
    const w = liveWrapper({ hint: 'dormant', inViewport: false });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, IN_BAND_OFF_SCREEN, true]]));
    expect(lists.toRepair).toEqual([w]);
  });

  it('lists a never-hinted in-band candidate for repair, skipping boxless rects', () => {
    const candidate = liveWrapper({});
    const boxless = liveWrapper({});
    const lists = computeReconcilePlanLists(
      storeOf([candidate, boxless]), null,
      gatherOf([[candidate, IN_BAND_OFF_SCREEN], [boxless, ZERO_BOX]]),
    );
    expect(lists.toRepair).toEqual([candidate]);
  });

  it('excludes limbo wrappers from every class', () => {
    const w = liveWrapper({ hint: 'visible', inViewport: true, codeword: 'ape', disconnected: true });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, OFF_BAND, true]]));
    for (const k of Object.keys(lists) as Array<keyof ReconcilePlanLists>) {
      expect(lists[k]).toEqual([]);
    }
  });

  it('claims follow the repaired flag: a repaired codeword-less wrapper lands in toClaim', () => {
    const w = liveWrapper({ hint: 'dormant', inViewport: false });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, IN_BAND_OFF_SCREEN, true]]));
    expect(lists.toRepair).toEqual([w]);
    expect(lists.toClaim).toEqual([w]);
  });

  it('releases drop the flag: a released wrapper does not land in toShow', () => {
    const w = liveWrapper({ hint: 'visible', inViewport: true, codeword: 'ape' });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, OFF_BAND, true]]));
    expect(lists.toRelease).toEqual([w]);
    expect(lists.toShow).toEqual([]);
    expect(lists.toHide).toEqual([]);
  });

  it('re-shows a repaired dormant badge that is CSS-visible and on-screen (scroll-back)', () => {
    const w = liveWrapper({ hint: 'dormant', inViewport: false });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, ON_SCREEN, true]]));
    expect(lists.toRepair).toEqual([w]);
    expect(lists.toShow).toEqual([w]);
  });

  it('re-shows a repaired dormant badge that is in-band but OFF-screen (paint the band)', () => {
    // Shown-ness is band-scoped (notes/DESIGN_PAINT_THE_BAND.md): the badge
    // paints below the fold and rides into view already painted.
    const w = liveWrapper({ hint: 'dormant', inViewport: false });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, IN_BAND_OFF_SCREEN, true]]));
    expect(lists.toRepair).toEqual([w]);
    expect(lists.toShow).toEqual([w]);
  });

  it('hides a showing badge whose target went CSS-invisible', () => {
    const w = liveWrapper({ hint: 'visible', inViewport: true, codeword: 'ape' });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, ON_SCREEN, false]]));
    expect(lists.toHide).toEqual([w]);
    expect(lists.toShow).toEqual([]);
    // …and the write-through flag flips with it (delta-only).
    expect(lists.cssHiddenDelta).toEqual([[w, true]]);
  });

  it('emits no cssHidden delta when the flag already matches', () => {
    const visible = liveWrapper({ hint: 'visible', inViewport: true, codeword: 'ape' });
    const hidden = liveWrapper({ hint: 'visible', inViewport: true, codeword: 'oak', cssHidden: true });
    const lists = computeReconcilePlanLists(
      storeOf([visible, hidden]), null,
      gatherOf([[visible, ON_SCREEN, true], [hidden, ON_SCREEN, false]]),
    );
    expect(lists.cssHiddenDelta).toEqual([]);
  });

  it('clears cssHidden for a target that became CSS-visible again', () => {
    const w = liveWrapper({ hint: 'dormant', inViewport: true, codeword: 'ape', cssHidden: true });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, ON_SCREEN, true]]));
    expect(lists.cssHiddenDelta).toEqual([[w, false]]);
    expect(lists.toShow).toEqual([w]);
  });

  it('lists a paintable codeworded badge-less wrapper for build', () => {
    const w = liveWrapper({ codeword: 'ape', inViewport: true });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, ON_SCREEN, true]]));
    expect(lists.toBuild).toEqual([w]);
    // No repair happened → the live build pass would not run this settle, so
    // the wrapper must not be predicted shown (or transitioned) by recheck.
    expect(lists.toShow).toEqual([]);
  });

  it('a build alongside a repair is simulated as already-showing (no toShow double-count)', () => {
    const repairTrigger = liveWrapper({ hint: 'dormant', inViewport: false });
    const buildable = liveWrapper({ codeword: 'ape', inViewport: true });
    const lists = computeReconcilePlanLists(
      storeOf([repairTrigger, buildable]), null,
      gatherOf([[repairTrigger, IN_BAND_OFF_SCREEN, true], [buildable, ON_SCREEN, true]]),
    );
    expect(lists.toRepair).toEqual([repairTrigger]);
    expect(lists.toBuild).toEqual([buildable]);
    // The built wrapper is simulated as already showing, so it must not be
    // double-counted in toShow. (repairTrigger DOES land there: band-scoped
    // shown-ness re-shows the repaired dormant badge off-screen too.)
    expect(lists.toShow).toEqual([repairTrigger]);
  });

  it('builds an off-screen in-band target (paint the band) but never a CSS-hidden one', () => {
    const offScreen = liveWrapper({ codeword: 'ape', inViewport: true });
    const hidden = liveWrapper({ codeword: 'oak', inViewport: true });
    const lists = computeReconcilePlanLists(
      storeOf([offScreen, hidden]), null,
      gatherOf([[offScreen, IN_BAND_OFF_SCREEN, true], [hidden, ON_SCREEN, false]]),
    );
    expect(lists.toBuild).toEqual([offScreen]);
  });
});

describe('strictDelta (folded into the plan, cutover 4/4)', () => {
  it('lastSent-vs-wantsStrict drives the delta', () => {
    const entering = liveWrapper({ codeword: 'ape', hint: 'visible', inViewport: true, lastSent: false });
    const leaving = liveWrapper({ codeword: 'oak', hint: 'visible', inViewport: true, lastSent: true });
    const settled = liveWrapper({ codeword: 'elm', hint: 'visible', inViewport: true, lastSent: true });
    const lists = computeReconcilePlanLists(
      storeOf([entering, leaving, settled]), null,
      gatherOf([[entering, ON_SCREEN, true], [leaving, IN_BAND_OFF_SCREEN, true], [settled, ON_SCREEN, true]]),
    );
    expect(lists.strictDelta).toEqual([entering, leaving]);
  });

  it('folds the gather hit-test into the occlusion input', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', inViewport: true, lastSent: true });
    const lists = computeReconcilePlanLists(
      storeOf([w]), null,
      gatherOf([[w, ON_SCREEN, true]], [[w, true]]),
    );
    // Covered by an overlay → off-strict; lastSent=true → delta.
    expect(lists.strictDelta).toEqual([w]);
  });

  it('folds the clip flag (stable across the pipeline) into the occlusion input', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', inViewport: true, lastSent: true });
    w.clipped = true;
    const lists = computeReconcilePlanLists(
      storeOf([w]), null,
      gatherOf([[w, ON_SCREEN, true]], [[w, false]]),
    );
    expect(lists.strictDelta).toEqual([w]);
  });

  it('uses cssHidden as the visibility apply will leave it, not as it stands', () => {
    // Target went CSS-invisible this settle: the recheck sim writes
    // cssHidden=true, so strict must already see it hidden — same settle,
    // no one-settle lag.
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', inViewport: true, lastSent: true });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, ON_SCREEN, false]]));
    expect(lists.toHide).toEqual([w]);
    expect(lists.strictDelta).toEqual([w]);
  });

  it('keeps a pre-existing cssHidden for wrappers outside the recheck set', () => {
    // Dormant codeword-holder out of band: not in the recheck set, so the
    // current flag stands.
    const w = liveWrapper({ codeword: 'ape', hint: 'dormant', inViewport: false, lastSent: true, cssHidden: true });
    const lists = computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, OFF_BAND]]));
    expect(lists.strictDelta).toEqual([w]); // off-strict (cssHidden + off-screen) vs lastSent=true
  });

  // Boundary semantics, ported from the deleted collectStrictViewportDelta
  // spec: any pixel of the element in the visible viewport counts as
  // in-strict. Pinned so a refactor can't silently change "barely visible".
  function strictOf(w: ElementWrapper, r: { top: number; left: number; width: number; height: number }): ElementWrapper[] {
    return computeReconcilePlanLists(storeOf([w]), null, gatherOf([[w, r, true]])).strictDelta;
  }

  it('counts an element straddling the top edge as in-strict (partial visibility)', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', inViewport: true, lastSent: false });
    expect(strictOf(w, { top: -10, left: 100, width: 100, height: 20 })).toEqual([w]);
  });

  it('counts an element straddling the bottom edge as in-strict (partial visibility)', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', inViewport: true, lastSent: false });
    expect(strictOf(w, { top: VH - 10, left: 100, width: 100, height: 20 })).toEqual([w]);
  });

  it('counts an element fully off-top as out-of-strict', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', inViewport: true, lastSent: true });
    expect(strictOf(w, { top: -50, left: 100, width: 100, height: 20 })).toEqual([w]);
  });

  it('counts a zero-size element at a visible coordinate as in-strict', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', inViewport: true, lastSent: false });
    expect(strictOf(w, { top: 100, left: 100, width: 0, height: 0 })).toEqual([w]);
  });

  it('counts an element exactly at top=0 as in-strict', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', inViewport: true, lastSent: false });
    expect(strictOf(w, { top: 0, left: 0, width: 100, height: 100 })).toEqual([w]);
  });

  it('queues a never-pushed wrapper as a delta (undefined lastSent counts as a change)', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', inViewport: true, lastSent: undefined });
    expect(strictOf(w, IN_BAND_OFF_SCREEN)).toEqual([w]); // off-strict vs undefined
  });
});

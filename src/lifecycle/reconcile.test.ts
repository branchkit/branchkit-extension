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
  disconnected?: boolean;
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
  if (opts.disconnected) w.disconnectedAt = 1;
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
    const w = liveWrapper({ hint: 'visible', codeword: 'ape' });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, OFF_BAND, true]]));
    expect(lists.toRelease).toEqual([w]);
  });

  it('does NOT release a dormant (hidden) off-band badge — desired state, not drift', () => {
    const w = liveWrapper({ hint: 'dormant' });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, OFF_BAND]]));
    expect(lists.toRelease).toEqual([]);
    expect(lists.toShow).toEqual([]);
    expect(lists.toHide).toEqual([]);
  });

  it('claims an in-band codeword-less wrapper — dormant badge or bare (no repair class)', () => {
    // The flag era listed these for stale-FALSE repair; with derived
    // membership they go straight to toClaim.
    const dormant = liveWrapper({ hint: 'dormant' });
    const bare = liveWrapper({});
    const lists = computeReconcilePlanLists(
      storeOf([dormant, bare]),
      gatherOf([[dormant, IN_BAND_OFF_SCREEN, true], [bare, IN_BAND_OFF_SCREEN]]),
    );
    expect(lists.toClaim).toEqual([dormant, bare]);
  });

  it('skips boxless rects (zero-rect guard) from every lifecycle class', () => {
    const boxless = liveWrapper({});
    const boxlessCodeworded = liveWrapper({ codeword: 'ape' });
    const lists = computeReconcilePlanLists(
      storeOf([boxless, boxlessCodeworded]),
      gatherOf([[boxless, ZERO_BOX], [boxlessCodeworded, ZERO_BOX]]),
    );
    expect(lists.toClaim).toEqual([]);
    expect(lists.toRelease).toEqual([]);
  });

  it('excludes limbo wrappers from every class', () => {
    const w = liveWrapper({ hint: 'visible', codeword: 'ape', disconnected: true });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, OFF_BAND, true]]));
    for (const k of Object.keys(lists) as Array<keyof ReconcilePlanLists>) {
      if (k === 'strictFlips') continue; // harness counters, not an action class
      expect(lists[k]).toEqual([]);
    }
  });

  it('releases an off-band codeword holder even when its badge is dormant (pool hygiene)', () => {
    // Release expanded from visible-hint-only to all codeworded off-band
    // wrappers: the IO exit branch that used to release dormant holders is
    // gone, so the plan owns the whole release direction.
    const w = liveWrapper({ codeword: 'ape', hint: 'dormant' });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, OFF_BAND, true]]));
    expect(lists.toRelease).toEqual([w]);
  });

  it('a released wrapper does not land in toShow', () => {
    const w = liveWrapper({ hint: 'visible', codeword: 'ape' });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, OFF_BAND, true]]));
    expect(lists.toRelease).toEqual([w]);
    expect(lists.toShow).toEqual([]);
    expect(lists.toHide).toEqual([]);
  });

  it('re-shows a dormant badge that is CSS-visible and on-screen (scroll-back)', () => {
    const w = liveWrapper({ hint: 'dormant' });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, ON_SCREEN, true]]));
    expect(lists.toClaim).toEqual([w]);
    expect(lists.toShow).toEqual([w]);
  });

  it('re-shows a dormant badge that is in-band but OFF-screen (paint the band)', () => {
    // Shown-ness is band-scoped (notes/DESIGN_PAINT_THE_BAND.md): the badge
    // paints below the fold and rides into view already painted.
    const w = liveWrapper({ hint: 'dormant' });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, IN_BAND_OFF_SCREEN, true]]));
    expect(lists.toClaim).toEqual([w]);
    expect(lists.toShow).toEqual([w]);
  });

  it('hides a showing badge whose target went CSS-invisible', () => {
    const w = liveWrapper({ hint: 'visible', codeword: 'ape' });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, ON_SCREEN, false]]));
    expect(lists.toHide).toEqual([w]);
    expect(lists.toShow).toEqual([]);
  });

  it('re-shows a dormant badge whose target became CSS-visible again', () => {
    // Read-time cssHidden: recovery needs no flag clear — the gather says
    // visible, the plan acts on it (DESIGN_OBSERVED_STATE_READ_TIME phase 1).
    const w = liveWrapper({ hint: 'dormant', codeword: 'ape' });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, ON_SCREEN, true]]));
    expect(lists.toShow).toEqual([w]);
  });

  it('lists a paintable codeworded badge-less wrapper for build', () => {
    const w = liveWrapper({ codeword: 'ape' });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, ON_SCREEN, true]]));
    expect(lists.toBuild).toEqual([w]);
    // No repair happened → the live build pass would not run this settle, so
    // the wrapper must not be predicted shown (or transitioned) by recheck.
    expect(lists.toShow).toEqual([]);
  });

  it('a build alongside owed claims is simulated as already-showing (no toShow double-count)', () => {
    const claimTrigger = liveWrapper({ hint: 'dormant' });
    const buildable = liveWrapper({ codeword: 'ape' });
    const lists = computeReconcilePlanLists(
      storeOf([claimTrigger, buildable]),
      gatherOf([[claimTrigger, IN_BAND_OFF_SCREEN, true], [buildable, ON_SCREEN, true]]),
    );
    expect(lists.toClaim).toEqual([claimTrigger]);
    expect(lists.toBuild).toEqual([buildable]);
    // The built wrapper is simulated as already showing, so it must not be
    // double-counted in toShow. (claimTrigger DOES land there: band-scoped
    // shown-ness re-shows the dormant badge off-screen too.)
    expect(lists.toShow).toEqual([claimTrigger]);
  });

  it('builds an off-screen in-band target (paint the band) but never a CSS-hidden one', () => {
    const offScreen = liveWrapper({ codeword: 'ape' });
    const hidden = liveWrapper({ codeword: 'oak' });
    const lists = computeReconcilePlanLists(
      storeOf([offScreen, hidden]),
      gatherOf([[offScreen, IN_BAND_OFF_SCREEN, true], [hidden, ON_SCREEN, false]]),
    );
    expect(lists.toBuild).toEqual([offScreen]);
  });
});

describe('strictDelta (folded into the plan, cutover 4/4)', () => {
  it('lastSent-vs-wantsStrict drives the delta', () => {
    const entering = liveWrapper({ codeword: 'ape', hint: 'visible', lastSent: false });
    const leaving = liveWrapper({ codeword: 'oak', hint: 'visible', lastSent: true });
    const settled = liveWrapper({ codeword: 'elm', hint: 'visible', lastSent: true });
    const lists = computeReconcilePlanLists(
      storeOf([entering, leaving, settled]),
      gatherOf([[entering, ON_SCREEN, true], [leaving, IN_BAND_OFF_SCREEN, true], [settled, ON_SCREEN, true]]),
    );
    expect(lists.strictDelta).toEqual([entering, leaving]);
  });

  it('folds the gather hit-test into the occlusion input', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', lastSent: true });
    const lists = computeReconcilePlanLists(
      storeOf([w]),
      gatherOf([[w, ON_SCREEN, true]], [[w, true]]),
    );
    // Covered by an overlay → off-strict; lastSent=true → delta.
    expect(lists.strictDelta).toEqual([w]);
  });

  it('folds the clip flag (stable across the pipeline) into the occlusion input', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', lastSent: true });
    w.clipped = true;
    const lists = computeReconcilePlanLists(
      storeOf([w]),
      gatherOf([[w, ON_SCREEN, true]], [[w, false]]),
    );
    expect(lists.strictDelta).toEqual([w]);
  });

  it('derives cssHidden from the gather, so hide and strict-drop land the same settle', () => {
    // Target went CSS-invisible this settle: the gather says hidden, so the
    // hide AND the strict re-push both derive from it — no one-settle lag,
    // no stored flag to sequence against.
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', lastSent: true });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, ON_SCREEN, false]]));
    expect(lists.toHide).toEqual([w]);
    expect(lists.strictDelta).toEqual([w]);
  });

  it('lazy-reads cssHidden live for wrappers the gather vis set missed', () => {
    // Codeworded wrapper with an on-screen rect but NO gathered cssVisible
    // entry: the strict derivation falls back to a live isVisible() read
    // (bounded, counted by the lazyReads tripwire) — never a stored flag.
    // happy-dom reports a zero-size box for real elements, so the live read
    // says hidden → off-strict vs lastSent=true → delta.
    const w = liveWrapper({ codeword: 'ape', hint: 'dormant', lastSent: true });
    const lists = computeReconcilePlanLists(storeOf([w]), gatherOf([[w, ON_SCREEN]]));
    expect(lists.strictDelta).toEqual([w]);
  });

  // Boundary semantics, ported from the deleted collectStrictViewportDelta
  // spec: any pixel of the element in the visible viewport counts as
  // in-strict. Pinned so a refactor can't silently change "barely visible".
  function strictOf(w: ElementWrapper, r: { top: number; left: number; width: number; height: number }): ElementWrapper[] {
    return computeReconcilePlanLists(storeOf([w]), gatherOf([[w, r, true]])).strictDelta;
  }

  it('counts an element straddling the top edge as in-strict (partial visibility)', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', lastSent: false });
    expect(strictOf(w, { top: -10, left: 100, width: 100, height: 20 })).toEqual([w]);
  });

  it('counts an element straddling the bottom edge as in-strict (partial visibility)', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', lastSent: false });
    expect(strictOf(w, { top: VH - 10, left: 100, width: 100, height: 20 })).toEqual([w]);
  });

  it('counts an element fully off-top as out-of-strict', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', lastSent: true });
    expect(strictOf(w, { top: -50, left: 100, width: 100, height: 20 })).toEqual([w]);
  });

  it('counts a zero-size element at a visible coordinate as in-strict', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', lastSent: false });
    expect(strictOf(w, { top: 100, left: 100, width: 0, height: 0 })).toEqual([w]);
  });

  it('counts an element exactly at top=0 as in-strict', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', lastSent: false });
    expect(strictOf(w, { top: 0, left: 0, width: 100, height: 100 })).toEqual([w]);
  });

  it('queues a never-pushed wrapper as a delta (undefined lastSent counts as a change)', () => {
    const w = liveWrapper({ codeword: 'ape', hint: 'visible', lastSent: undefined });
    expect(strictOf(w, IN_BAND_OFF_SCREEN)).toEqual([w]); // off-strict vs undefined
  });
});

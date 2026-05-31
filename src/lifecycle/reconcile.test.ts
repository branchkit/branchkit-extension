/**
 * BranchKit Browser — shadow reconcile-plan unit tests.
 *
 * The plan computes the actual→desired delta WITHOUT driving anything; these
 * pin each delta bucket and the band-divergence check. See reconcile.ts and
 * notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md.
 *
 * Run: npm test
 */

import { describe, it, expect } from 'vitest';
import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { TargetRectStore } from '../observe/target-rect-store';
import { ScannedElement, Category } from '../types';
import { HintBadge } from '../render/hints';
import { computeReconcilePlan, RECONCILE_BAND_MARGIN_PX } from './reconcile';

const VP = { width: 1000, height: 800 };

function rect(x: number, y: number, w = 10, h = 10): DOMRectReadOnly {
  return {
    x, y, width: w, height: h,
    left: x, top: y, right: x + w, bottom: y + h,
    toJSON: () => ({}),
  } as DOMRectReadOnly;
}

let nextEl = 0;
function makeWrapper(opts: {
  inViewport: boolean;
  codeword: string;
  hint?: boolean;
  category?: Category;
  disconnected?: boolean;
}): ElementWrapper {
  const el = { tagName: 'A', __n: nextEl++ } as unknown as Element;
  const scanned: ScannedElement = {
    label: 'x',
    id: nextEl,
    category: opts.category ?? 'link',
    type: 'link',
    adapter: null,
    codeword: opts.codeword,
  };
  const w = new ElementWrapper(el, scanned);
  w.isInViewport = opts.inViewport;
  if (opts.hint) w.hint = {} as HintBadge;
  if (opts.disconnected) w.disconnectedAt = 1;
  return w;
}

function storeOf(wrappers: ElementWrapper[]): WrapperStore {
  const store = new WrapperStore();
  for (const w of wrappers) store.addWrapper(w);
  return store;
}

describe('computeReconcilePlan', () => {
  it('returns an all-zero plan for a perfectly-synced store', () => {
    const store = storeOf([
      makeWrapper({ inViewport: true, codeword: 'ape', hint: true }),
      makeWrapper({ inViewport: false, codeword: '' }),
    ]);
    const plan = computeReconcilePlan(store, null, new TargetRectStore(), VP, RECONCILE_BAND_MARGIN_PX);
    expect(plan.needClaim).toBe(0);
    expect(plan.needBuild).toBe(0);
    expect(plan.needRelease).toBe(0);
    expect(plan.needTeardown).toBe(0);
  });

  it('counts needClaim for an in-band wrapper with no codeword', () => {
    const store = storeOf([makeWrapper({ inViewport: true, codeword: '' })]);
    expect(computeReconcilePlan(store, null, new TargetRectStore(), VP, RECONCILE_BAND_MARGIN_PX).needClaim).toBe(1);
  });

  it('counts needBuild for the noHintObject case', () => {
    const store = storeOf([makeWrapper({ inViewport: true, codeword: 'ape', hint: false })]);
    expect(computeReconcilePlan(store, null, new TargetRectStore(), VP, RECONCILE_BAND_MARGIN_PX).needBuild).toBe(1);
  });

  it('counts needRelease for an off-band wrapper still holding a codeword', () => {
    const store = storeOf([makeWrapper({ inViewport: false, codeword: 'ape' })]);
    expect(computeReconcilePlan(store, null, new TargetRectStore(), VP, RECONCILE_BAND_MARGIN_PX).needRelease).toBe(1);
  });

  it('counts needTeardown for a hint the category filter now excludes', () => {
    const store = storeOf([makeWrapper({ inViewport: true, codeword: 'ape', hint: true, category: 'link' })]);
    expect(computeReconcilePlan(store, 'button', new TargetRectStore(), VP, RECONCILE_BAND_MARGIN_PX).needTeardown).toBe(1);
  });

  it('ignores limbo (disconnected) wrappers', () => {
    const store = storeOf([makeWrapper({ inViewport: true, codeword: '', disconnected: true })]);
    const plan = computeReconcilePlan(store, null, new TargetRectStore(), VP, RECONCILE_BAND_MARGIN_PX);
    expect(plan.needClaim).toBe(0);
  });

  it('flags band.staleTrue when the IO flag says in but geometry says out', () => {
    const w = makeWrapper({ inViewport: true, codeword: 'ape', hint: true });
    const rects = new TargetRectStore();
    rects.write(w.element, rect(0, VP.height + RECONCILE_BAND_MARGIN_PX + 50)); // far below band
    const plan = computeReconcilePlan(storeOf([w]), null, rects, VP, RECONCILE_BAND_MARGIN_PX);
    expect(plan.band.rectsKnown).toBe(1);
    expect(plan.band.staleTrue).toBe(1);
    expect(plan.band.staleFalse).toBe(0);
  });

  it('flags band.staleFalse when the IO flag says out but geometry says in', () => {
    const w = makeWrapper({ inViewport: false, codeword: '' });
    const rects = new TargetRectStore();
    rects.write(w.element, rect(10, 10)); // squarely in viewport
    const plan = computeReconcilePlan(storeOf([w]), null, rects, VP, RECONCILE_BAND_MARGIN_PX);
    expect(plan.band.staleFalse).toBe(1);
    expect(plan.band.staleTrue).toBe(0);
  });

  it('does not flag divergence when the flag agrees with geometry', () => {
    const w = makeWrapper({ inViewport: true, codeword: 'ape', hint: true });
    const rects = new TargetRectStore();
    rects.write(w.element, rect(10, 10));
    const plan = computeReconcilePlan(storeOf([w]), null, rects, VP, RECONCILE_BAND_MARGIN_PX);
    expect(plan.band.staleTrue + plan.band.staleFalse).toBe(0);
  });
});

/**
 * BranchKit Browser — shadow reconcile-plan unit tests.
 *
 * The plan computes the actual→desired delta WITHOUT driving anything; these
 * pin each delta bucket. See reconcile.ts and
 * notes/completed/DESIGN_HINT_LIFECYCLE_RECONCILER.md.
 *
 * Run: npm test
 */

import { describe, it, expect } from 'vitest';
import { ElementWrapper, WrapperStore } from '../scan/element-wrapper';
import { ScannedElement, Category } from '../types';
import { HintBadge } from '../render/hints';
import { computeReconcilePlan } from './reconcile';

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
    const plan = computeReconcilePlan(store, null);
    expect(plan.needClaim).toBe(0);
    expect(plan.needBuild).toBe(0);
    expect(plan.needRelease).toBe(0);
    expect(plan.needTeardown).toBe(0);
  });

  it('counts needClaim for an in-band wrapper with no codeword', () => {
    const store = storeOf([makeWrapper({ inViewport: true, codeword: '' })]);
    expect(computeReconcilePlan(store, null).needClaim).toBe(1);
  });

  it('counts needBuild for the noHintObject case', () => {
    const store = storeOf([makeWrapper({ inViewport: true, codeword: 'ape', hint: false })]);
    expect(computeReconcilePlan(store, null).needBuild).toBe(1);
  });

  it('counts needRelease for an off-band wrapper still holding a codeword', () => {
    const store = storeOf([makeWrapper({ inViewport: false, codeword: 'ape' })]);
    expect(computeReconcilePlan(store, null).needRelease).toBe(1);
  });

  it('counts needTeardown for a hint the category filter now excludes', () => {
    const store = storeOf([makeWrapper({ inViewport: true, codeword: 'ape', hint: true, category: 'link' })]);
    expect(computeReconcilePlan(store, 'button').needTeardown).toBe(1);
  });

  it('ignores limbo (disconnected) wrappers', () => {
    const store = storeOf([makeWrapper({ inViewport: true, codeword: '', disconnected: true })]);
    const plan = computeReconcilePlan(store, null);
    expect(plan.needClaim).toBe(0);
  });
});

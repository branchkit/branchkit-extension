/**
 * BranchKit Browser — occlusion-memo unit tests (shadow phase).
 *
 * Pins the reuse/retest decision table of the dirty-region epoch cache
 * (notes/DESIGN_OCCLUSION_HITTEST_MEMO.md): rect-key changes, dirty cells
 * under sample points, the epoch rule (a wrapper that skipped a gather can't
 * reuse), the fail-open taps (removal, overflow, disconnected resolve), and
 * divergence counting. Geometry is driven through explicit DOMRects; queued
 * elements get mocked getBoundingClientRect.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ElementWrapper } from '../scan/element-wrapper';
import {
  occlusionMemoAllDirty,
  occlusionMemoNoteMutations,
  occlusionMemoNotePointer,
  occlusionMemoNoteTarget,
  occlusionMemoResolveDirty,
  occlusionMemoShadowTest,
  occlusionMemoEndGather,
  setOcclusionMemoEnabled,
  _resetOcclusionMemoForTests,
} from './occlusion-memo';
import { lifecycleCounters, resetLifecycleCounters } from '../debug/perf-counters';
import { _resetFirehoseForTests } from '../debug/firehose';

const VW = 800;
const VH = 600;

let sentSteps: string[];

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    left, top, width, height,
    right: left + width, bottom: top + height,
    x: left, y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function wrapper(el?: Element): ElementWrapper {
  return { element: el ?? document.createElement('a') } as ElementWrapper;
}

function elementAt(r: DOMRect, connected = true): Element {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => r;
  if (connected) document.body.appendChild(el);
  return el;
}

/** One full warm-up gather so the cache leaves boot all-dirty with an entry. */
function primeGather(w: ElementWrapper, r: DOMRect, result = false): void {
  occlusionMemoResolveDirty(VW, VH);
  occlusionMemoShadowTest(w, r, result);
  occlusionMemoEndGather();
}

beforeEach(() => {
  document.body.replaceChildren();
  _resetOcclusionMemoForTests();
  resetLifecycleCounters();
  _resetFirehoseForTests();
  sentSteps = [];
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: {
      sendMessage: vi.fn((msg: { data: { step: string } }) => {
        sentSteps.push(msg.data.step);
        return Promise.resolve();
      }),
    },
  };
});

describe('reuse decision table', () => {
  it('boot is all-dirty; a clean second gather would reuse', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    primeGather(w, r);
    expect(lifecycleCounters.occlusionMemoRetestAllDirty).toBe(1);

    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoWouldReuse).toBe(1);
    expect(lifecycleCounters.occlusionMemoDiverged).toBe(0);
  });

  it('a moved rect retests (rect key), sub-pixel jitter does not', () => {
    const w = wrapper();
    primeGather(w, rect(100, 100, 100, 50));

    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, rect(100.3, 99.8, 100.2, 50.1), false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoWouldReuse).toBe(1);

    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, rect(140, 100, 100, 50), false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoRetestRect).toBe(1);
  });

  it('a cold wrapper retests as cold once the window is clean', () => {
    const seeded = wrapper();
    primeGather(seeded, rect(0, 0, 10, 10)); // consumes boot all-dirty

    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(wrapper(), rect(100, 100, 100, 50), false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoRetestCold).toBe(1);
  });

  it('a wrapper that skipped a gather retests (epoch rule)', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    primeGather(w, r);

    // Gather it sat out (badge hidden that settle): dirt window consumed
    // without validating w.
    primeGather(wrapper(), rect(0, 0, 10, 10));

    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoRetestEpoch).toBe(1);
    expect(lifecycleCounters.occlusionMemoWouldReuse).toBe(0);
  });
});

describe('dirty cells', () => {
  it('a mutated element localizes: overlapping wrapper retests, distant one reuses', () => {
    const near = wrapper();
    const nearRect = rect(100, 100, 100, 50); // top-left region
    const far = wrapper();
    const farRect = rect(600, 450, 100, 50); // bottom-right region
    // Boot gather validates both.
    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(near, nearRect, false);
    occlusionMemoShadowTest(far, farRect, false);
    occlusionMemoEndGather();
    resetLifecycleCounters();

    // An overlay mutated over the near wrapper's cells only.
    occlusionMemoNoteMutations([
      { type: 'attributes', target: elementAt(rect(90, 90, 60, 60)) } as unknown as MutationRecord,
    ]);
    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(near, nearRect, false);
    occlusionMemoShadowTest(far, farRect, false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoRetestCells).toBe(1);
    expect(lifecycleCounters.occlusionMemoWouldReuse).toBe(1);
  });

  it('a pointer tap marks the cell under the event coordinates', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    primeGather(w, r);

    occlusionMemoNotePointer(150, 125); // inside the wrapper's box
    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoRetestCells).toBe(1);
  });

  it('cells reset after the gather consumes them', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    primeGather(w, r);

    occlusionMemoNotePointer(150, 125);
    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, false);
    occlusionMemoEndGather();

    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoWouldReuse).toBe(1);
  });
});

describe('fail-open taps', () => {
  it('a childList removal fails the window open', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    primeGather(w, r);

    const removed = document.createElement('div');
    occlusionMemoNoteMutations([
      { type: 'childList', addedNodes: [], removedNodes: [removed], target: document.body } as unknown as MutationRecord,
    ]);
    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoRetestAllDirty).toBe(2); // boot + removal
    expect(lifecycleCounters.occlusionMemoAllDirtyBy['removal']).toBe(1);
  });

  it('more than K queued elements fails open', () => {
    const w = wrapper();
    primeGather(w, rect(100, 100, 100, 50));
    for (let i = 0; i < 17; i++) {
      occlusionMemoNoteTarget(elementAt(rect(10 * i, 10, 5, 5)));
    }
    expect(lifecycleCounters.occlusionMemoAllDirtyBy['element-overflow']).toBe(1);
  });

  it('a queued element that vanished before the gather fails open', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    primeGather(w, r);

    occlusionMemoNoteTarget(elementAt(rect(600, 450, 50, 50), false)); // disconnected
    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoAllDirtyBy['resolve-disconnected']).toBe(1);
    expect(lifecycleCounters.occlusionMemoRetestAllDirty).toBe(2);
  });

  it('a queued element that collapsed to zero box fails open', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    primeGather(w, r);

    occlusionMemoNoteTarget(elementAt(rect(600, 450, 0, 0)));
    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoAllDirtyBy['resolve-vanished']).toBe(1);
  });

  it('own badge elements never queue', () => {
    const w = wrapper();
    primeGather(w, rect(100, 100, 100, 50));
    const own = document.createElement('div');
    own.setAttribute('data-branchkit-hint', '');
    document.body.appendChild(own);
    occlusionMemoNoteMutations([
      { type: 'attributes', target: own } as unknown as MutationRecord,
      { type: 'childList', addedNodes: [], removedNodes: [own], target: document.body } as unknown as MutationRecord,
    ]);
    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, rect(100, 100, 100, 50), false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoWouldReuse).toBe(1);
  });
});

describe('divergence', () => {
  it('counts and firehoses a would-reuse verdict that disagrees with the fresh test', () => {
    const el = document.createElement('a');
    el.className = 'buy-button';
    const w = wrapper(el);
    const r = rect(100, 100, 100, 50);
    primeGather(w, r, false);

    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, true); // flipped with no signal
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoDiverged).toBe(1);
    expect(sentSteps).toContain('occlusion_memo:diverged:false->true:a.buy-button');

    // The fresh result was stored — a clean follow-up gather agrees again.
    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, true);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoDiverged).toBe(1);
  });
});

describe('kill switch', () => {
  it('disabled: taps and shadow checks are no-ops', () => {
    setOcclusionMemoEnabled(false);
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    occlusionMemoAllDirty('scroll');
    occlusionMemoNotePointer(10, 10);
    occlusionMemoResolveDirty(VW, VH);
    occlusionMemoShadowTest(w, r, false);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoRetestAllDirty).toBe(0);
    expect(lifecycleCounters.occlusionMemoWouldReuse).toBe(0);
    expect(lifecycleCounters.occlusionMemoAllDirtyBy).toEqual({});
  });
});

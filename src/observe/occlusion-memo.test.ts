/**
 * BranchKit Browser — occlusion-memo unit tests.
 *
 * Pins the reuse/retest decision table of the dirty-region epoch cache
 * (notes/DESIGN_OCCLUSION_HITTEST_MEMO.md): rect-key changes, dirty cells
 * under sample points, the epoch rule (a wrapper that skipped a gather can't
 * reuse), the fail-open taps (removal, overflow, disconnected resolve),
 * authoritative reuse (hit returns the cached verdict and revalidates the
 * epoch), and shadow-mode divergence counting. Geometry is driven through
 * explicit DOMRects; queued elements get mocked getBoundingClientRect.
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
  occlusionMemoLookup,
  occlusionMemoStore,
  occlusionMemoEndGather,
  setOcclusionMemoMode,
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

/** One gather over (wrapper, rect, freshResult) tuples, mimicking batch 3's
 * authoritative loop. Returns the effective verdicts (cache hit or fresh). */
function gatherOnce(items: Array<[ElementWrapper, DOMRect, boolean]>): boolean[] {
  occlusionMemoResolveDirty(VW, VH);
  const out: boolean[] = [];
  for (const [w, r, fresh] of items) {
    const hit = occlusionMemoLookup(w, r);
    if (hit !== null) {
      out.push(hit.value);
      continue;
    }
    occlusionMemoStore(w, r, fresh);
    out.push(fresh);
  }
  occlusionMemoEndGather();
  return out;
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
  it('boot is all-dirty; a clean second gather reuses the cached verdict', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    expect(gatherOnce([[w, r, true]])).toEqual([true]);
    expect(lifecycleCounters.occlusionMemoRetestAllDirty).toBe(1);

    // Fresh result deliberately contradicts the cache: the hit must win
    // (fresh is never computed on a hit in authoritative mode).
    expect(gatherOnce([[w, r, false]])).toEqual([true]);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(1);
  });

  it('a hit revalidates the epoch — consecutive clean gathers keep reusing', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    gatherOnce([[w, r, false]]);
    gatherOnce([[w, r, false]]);
    gatherOnce([[w, r, false]]);
    gatherOnce([[w, r, false]]);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(3);
  });

  it('a moved rect retests (rect key), sub-pixel jitter does not', () => {
    const w = wrapper();
    gatherOnce([[w, rect(100, 100, 100, 50), false]]);

    gatherOnce([[w, rect(100.3, 99.8, 100.2, 50.1), false]]);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(1);

    gatherOnce([[w, rect(140, 100, 100, 50), false]]);
    expect(lifecycleCounters.occlusionMemoRetestRect).toBe(1);
  });

  it('a cold wrapper retests as cold once the window is clean', () => {
    gatherOnce([[wrapper(), rect(0, 0, 10, 10), false]]); // consumes boot all-dirty
    gatherOnce([[wrapper(), rect(100, 100, 100, 50), false]]);
    expect(lifecycleCounters.occlusionMemoRetestCold).toBe(1);
  });

  it('a wrapper that skipped a gather retests (epoch rule)', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    const bystander = wrapper();
    const br = rect(0, 0, 10, 10);
    gatherOnce([[w, r, false], [bystander, br, false]]);
    // Gather w sat out (badge hidden that settle): the dirt window was
    // consumed without validating w.
    gatherOnce([[bystander, br, false]]);

    gatherOnce([[w, r, false], [bystander, br, false]]);
    expect(lifecycleCounters.occlusionMemoRetestEpoch).toBe(1);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(2); // bystander both times
  });
});

describe('dirty cells', () => {
  it('a mutated element localizes: overlapping wrapper retests, distant one reuses', () => {
    const near = wrapper();
    const nearRect = rect(100, 100, 100, 50); // top-left region
    const far = wrapper();
    const farRect = rect(600, 450, 100, 50); // bottom-right region
    gatherOnce([[near, nearRect, false], [far, farRect, false]]);
    resetLifecycleCounters();

    // An overlay mutated over the near wrapper's cells only.
    occlusionMemoNoteMutations([
      { type: 'attributes', target: elementAt(rect(90, 90, 60, 60)) } as unknown as MutationRecord,
    ]);
    gatherOnce([[near, nearRect, false], [far, farRect, false]]);
    expect(lifecycleCounters.occlusionMemoRetestCells).toBe(1);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(1);
  });

  it('a pointer tap marks the cell under the event coordinates', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    gatherOnce([[w, r, false]]);

    occlusionMemoNotePointer(150, 125); // inside the wrapper's box
    gatherOnce([[w, r, false]]);
    expect(lifecycleCounters.occlusionMemoRetestCells).toBe(1);
  });

  it('a pointer tap dirties the neighboring cells too (hover paints extend past the crossed cell)', () => {
    const adjacent = wrapper();
    const adjacentRect = rect(220, 170, 40, 30); // one cell over from the pointer's cell
    const far = wrapper();
    const farRect = rect(600, 450, 100, 50);
    gatherOnce([[adjacent, adjacentRect, false], [far, farRect, false]]);

    occlusionMemoNotePointer(150, 125); // cell (1,1); neighborhood spans rows/cols 0-2
    gatherOnce([[adjacent, adjacentRect, false], [far, farRect, false]]);
    expect(lifecycleCounters.occlusionMemoRetestCells).toBe(1);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(1);
  });

  it('cells reset after the gather consumes them', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    gatherOnce([[w, r, false]]);

    occlusionMemoNotePointer(150, 125);
    gatherOnce([[w, r, false]]);
    gatherOnce([[w, r, false]]);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(1);
  });
});

describe('fail-open taps', () => {
  it('a removal of a never-seen element fails the window open', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    gatherOnce([[w, r, false]]);

    occlusionMemoNoteMutations([
      { type: 'childList', addedNodes: [], removedNodes: [document.createElement('div')], target: document.body } as unknown as MutationRecord,
    ]);
    gatherOnce([[w, r, false]]);
    expect(lifecycleCounters.occlusionMemoRetestAllDirty).toBe(2); // boot + removal
    expect(lifecycleCounters.occlusionMemoAllDirtyBy['resolve-vanished']).toBe(1);
  });

  it('more than K queued elements fails open', () => {
    gatherOnce([[wrapper(), rect(100, 100, 100, 50), false]]);
    for (let i = 0; i < 129; i++) {
      occlusionMemoNoteTarget(elementAt(rect((i % 100) * 8, 10, 5, 5)));
    }
    expect(lifecycleCounters.occlusionMemoAllDirtyBy['element-overflow']).toBe(1);
  });

  it('a never-seen queued element that vanished before the gather fails open', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    gatherOnce([[w, r, false]]);

    occlusionMemoNoteTarget(elementAt(rect(600, 450, 50, 50), false)); // disconnected
    gatherOnce([[w, r, false]]);
    expect(lifecycleCounters.occlusionMemoAllDirtyBy['resolve-vanished']).toBe(1);
    expect(lifecycleCounters.occlusionMemoRetestAllDirty).toBe(2);
  });

  it('a seen element that vanishes localizes to its last-known cells', () => {
    const near = wrapper();
    const nearRect = rect(100, 100, 100, 50);
    const far = wrapper();
    const farRect = rect(600, 450, 100, 50);
    gatherOnce([[near, nearRect, false], [far, farRect, false]]);

    // The overlay resolves once while visible (recording its cells)...
    const overlayRect = rect(90, 90, 60, 60); // over `near` only
    const overlay = elementAt(overlayRect);
    occlusionMemoNoteTarget(overlay);
    gatherOnce([[near, nearRect, false], [far, farRect, false]]);
    resetLifecycleCounters();

    // ...then collapses (display:none) — a dropdown closing. Localized:
    // only the wrapper under its old cells retests; no fail-open.
    overlay.getBoundingClientRect = () => rect(90, 90, 0, 0);
    occlusionMemoNoteTarget(overlay);
    gatherOnce([[near, nearRect, false], [far, farRect, false]]);
    expect(lifecycleCounters.occlusionMemoVanishLocalized).toBe(1);
    expect(lifecycleCounters.occlusionMemoRetestCells).toBe(1);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(1);
    expect(lifecycleCounters.occlusionMemoAllDirtyBy).toEqual({});
  });

  it('a seen element that MOVES marks old and new cells', () => {
    const near = wrapper();
    const nearRect = rect(100, 100, 100, 50); // top-left
    const far = wrapper();
    const farRect = rect(600, 450, 100, 50); // bottom-right
    const mid = wrapper();
    const midRect = rect(350, 250, 80, 40); // center — untouched region
    gatherOnce([[near, nearRect, false], [far, farRect, false], [mid, midRect, false]]);

    const overlay = elementAt(rect(90, 90, 60, 60)); // over `near`
    occlusionMemoNoteTarget(overlay);
    gatherOnce([[near, nearRect, false], [far, farRect, false], [mid, midRect, false]]);
    resetLifecycleCounters();

    // Slides to cover `far`: both its old cells (near) and new cells (far)
    // must retest; `mid` reuses.
    overlay.getBoundingClientRect = () => rect(590, 440, 60, 60);
    occlusionMemoNoteTarget(overlay);
    gatherOnce([[near, nearRect, false], [far, farRect, false], [mid, midRect, false]]);
    expect(lifecycleCounters.occlusionMemoRetestCells).toBe(2);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(1);
  });

  it('history survives a vanish fail-open — the Gmail-tick shape converges to localization', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    gatherOnce([[w, r, false]]);

    // Tick 1: a NEVER-SEEN span is removed (no history → window fails open)
    // while its replacement is added (resolved → history recorded). The
    // fail-open must NOT wipe that fresh history.
    const gen1 = elementAt(rect(600, 450, 60, 20));
    occlusionMemoNoteMutations([
      { type: 'childList', addedNodes: [gen1], removedNodes: [elementAt(rect(0, 0, 0, 0), false)], target: document.body } as unknown as MutationRecord,
    ]);
    gatherOnce([[w, r, false]]);
    expect(lifecycleCounters.occlusionMemoAllDirtyBy['resolve-vanished']).toBe(1);

    // Tick 2: gen1 is removed, gen2 added — gen1 HAS history now, so the
    // swap localizes and the distant wrapper reuses.
    resetLifecycleCounters();
    gen1.remove();
    const gen2 = elementAt(rect(600, 450, 60, 20));
    occlusionMemoNoteMutations([
      { type: 'childList', addedNodes: [gen2], removedNodes: [gen1], target: document.body } as unknown as MutationRecord,
    ]);
    gatherOnce([[w, r, false]]);
    expect(lifecycleCounters.occlusionMemoVanishLocalized).toBe(1);
    expect(lifecycleCounters.occlusionMemoAllDirtyBy).toEqual({});
    expect(lifecycleCounters.occlusionMemoReuse).toBe(1);
  });

  it('vanish history does not survive an all-dirty window', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    gatherOnce([[w, r, false]]);

    const overlay = elementAt(rect(600, 450, 60, 60));
    occlusionMemoNoteTarget(overlay);
    gatherOnce([[w, r, false]]);

    occlusionMemoAllDirty('scroll'); // wipes the history
    gatherOnce([[w, r, false]]);
    resetLifecycleCounters();

    overlay.getBoundingClientRect = () => rect(600, 450, 0, 0);
    occlusionMemoNoteTarget(overlay);
    gatherOnce([[w, r, false]]);
    expect(lifecycleCounters.occlusionMemoVanishLocalized).toBe(0);
    expect(lifecycleCounters.occlusionMemoAllDirtyBy['resolve-vanished']).toBe(1);
  });

  it('own badge elements never queue', () => {
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    gatherOnce([[w, r, false]]);
    const own = document.createElement('div');
    own.setAttribute('data-branchkit-hint', '');
    document.body.appendChild(own);
    occlusionMemoNoteMutations([
      { type: 'attributes', target: own } as unknown as MutationRecord,
      { type: 'childList', addedNodes: [], removedNodes: [own], target: document.body } as unknown as MutationRecord,
    ]);
    gatherOnce([[w, r, false]]);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(1);
  });
});

describe('shadow mode', () => {
  it('counts and firehoses a hit that disagrees with the fresh test; fresh wins', () => {
    setOcclusionMemoMode('shadow');
    const el = document.createElement('a');
    el.className = 'buy-button';
    const w = wrapper(el);
    const r = rect(100, 100, 100, 50);

    // Shadow caller shape: lookup always followed by a fresh test + store.
    occlusionMemoResolveDirty(VW, VH);
    expect(occlusionMemoLookup(w, r)).toBeNull(); // boot all-dirty
    occlusionMemoStore(w, r, false, null);
    occlusionMemoEndGather();

    occlusionMemoResolveDirty(VW, VH);
    const hit = occlusionMemoLookup(w, r);
    expect(hit).toEqual({ value: false });
    occlusionMemoStore(w, r, true, hit); // fresh flipped with no signal
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoDiverged).toBe(1);
    expect(sentSteps).toContain('occlusion_memo:diverged:false->true:a.buy-button');

    // The fresh result was stored — a clean follow-up gather agrees again.
    occlusionMemoResolveDirty(VW, VH);
    const hit2 = occlusionMemoLookup(w, r);
    expect(hit2).toEqual({ value: true });
    occlusionMemoStore(w, r, true, hit2);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoDiverged).toBe(1);
  });
});

describe('kill switch', () => {
  it('off: taps, lookups, and stores are no-ops', () => {
    setOcclusionMemoMode('off');
    const w = wrapper();
    const r = rect(100, 100, 100, 50);
    occlusionMemoAllDirty('scroll');
    occlusionMemoNotePointer(10, 10);
    occlusionMemoResolveDirty(VW, VH);
    expect(occlusionMemoLookup(w, r)).toBeNull();
    occlusionMemoStore(w, r, true);
    occlusionMemoEndGather();
    expect(lifecycleCounters.occlusionMemoRetestAllDirty).toBe(0);
    expect(lifecycleCounters.occlusionMemoReuse).toBe(0);
    expect(lifecycleCounters.occlusionMemoAllDirtyBy).toEqual({});

    // Nothing was cached while off.
    setOcclusionMemoMode('on');
    occlusionMemoResolveDirty(VW, VH);
    expect(occlusionMemoLookup(w, r)).toBeNull();
  });
});

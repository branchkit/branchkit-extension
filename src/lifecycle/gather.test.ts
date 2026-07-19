/**
 * BranchKit Browser — settle-gather unit tests.
 *
 * Pins the read-set membership of the once-per-settle read pass (Phase B of
 * notes/DESIGN_UNIFIED_RECONCILER.md, re-based by
 * DESIGN_OBSERVED_STATE_READ_TIME phase 3): the rect set is every live
 * connected wrapper (band membership is derived, not stored), the vis set is
 * showing badges + codeworded build candidates, and limbo/disconnected
 * wrappers are excluded. Geometry values themselves are happy-dom
 * zero-rects; the membership logic is what the settle steps depend on.
 *
 * Run: npm test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { HintBadge } from '../render/hints';
import { setOcclusionEnabled } from '../observe/occlusion';
import { gatherSettleReads } from './gather';

let nextId = 0;
function make(opts: {
  codeword?: string;
  hint?: boolean;
  hintVisible?: boolean;
  disconnected?: boolean;
  connected?: boolean;
}): ElementWrapper {
  const node = document.createElement('a');
  if (opts.connected ?? true) document.body.appendChild(node);
  const scanned: ScannedElement = {
    label: 'x',
    id: ++nextId,
    category: 'link',
    type: 'link',
    adapter: null,
    codeword: opts.codeword ?? '',
  };
  const w = new ElementWrapper(node, scanned);
  if (opts.hint) w.hint = { isVisible: opts.hintVisible ?? false } as HintBadge;
  if (opts.disconnected) w.disconnectedAt = 1;
  return w;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('gatherSettleReads set membership', () => {
  it('reads rects for every live connected wrapper (derived band membership)', () => {
    const hinted = make({ hint: true });
    const codeworded = make({ codeword: 'ape' });
    const bare = make({});
    const g = gatherSettleReads([hinted, codeworded, bare]);
    expect(g.rects.get(hinted)).toBeDefined();
    expect(g.rects.get(codeworded)).toBeDefined();
    expect(g.rects.get(bare)).toBeDefined();
  });

  it('excludes limbo wrappers entirely', () => {
    const limbo = make({ hint: true, codeword: 'ape', disconnected: true });
    const g = gatherSettleReads([limbo]);
    expect(g.rects.size).toBe(0);
    expect(g.cssVisible.size).toBe(0);
  });

  it('excludes disconnected wrappers entirely', () => {
    const dead = make({ connected: false });
    const g = gatherSettleReads([dead]);
    expect(g.rects.has(dead)).toBe(false);
  });

  it('resolves cssVisible for showing badges and build candidates', () => {
    const showing = make({ hint: true, hintVisible: true });
    // Codeworded with no showing badge = the plan's build candidate — its
    // cssVisible rides the gather batch (the lazyReads finding).
    const buildCandidate = make({ codeword: 'ape' });
    // Dormant badge WITHOUT a codeword: the scroll-history set the dormancy
    // design refuses to style-read every settle.
    const dormant = make({ hint: true });
    const g = gatherSettleReads([showing, buildCandidate, dormant]);
    expect(g.cssVisible.has(showing)).toBe(true);
    expect(typeof g.cssVisible.get(showing)).toBe('boolean');
    expect(g.cssVisible.has(buildCandidate)).toBe(true);
    expect(g.cssVisible.has(dormant)).toBe(false);
    // …but the dormant hint still gets a rect (full-store rect set).
    expect(g.rects.get(dormant)).toBeDefined();
  });

  it('reports viewport dimensions and the top-frame ancestor-chain check', () => {
    const g = gatherSettleReads([]);
    expect(g.vw).toBe(window.innerWidth);
    expect(g.vh).toBe(window.innerHeight);
    expect(g.ancestorChainVisible).toBe(true);
  });

  it('hit-tests the visible badge set only when occlusion is enabled', () => {
    const visibleBadge = make({ hint: true, hintVisible: true });
    const dormantBadge = make({ hint: true });
    // Flag off (the default): no hit-tests at all.
    expect(gatherSettleReads([visibleBadge]).overlayCovered.size).toBe(0);
    setOcclusionEnabled(true);
    try {
      const g = gatherSettleReads([visibleBadge, dormantBadge]);
      expect(g.overlayCovered.has(visibleBadge)).toBe(true);
      expect(g.overlayCovered.has(dormantBadge)).toBe(false);
    } finally {
      setOcclusionEnabled(false);
    }
  });
});

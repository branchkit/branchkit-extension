/**
 * BranchKit Browser — settle-gather unit tests.
 *
 * Pins the bounded-set membership of the once-per-settle read pass (Phase B
 * of notes/DESIGN_UNIFIED_RECONCILER.md): which wrappers get a rect, which
 * get a cssVisible resolution, and which are excluded (limbo, IO-owned
 * non-candidates). Geometry values themselves are happy-dom zero-rects; the
 * membership logic is what the settle steps depend on.
 *
 * Run: npm test
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { HintBadge } from '../render/hints';
import { gatherSettleReads } from './gather';

let nextId = 0;
function make(opts: {
  codeword?: string;
  hint?: boolean;
  inViewport?: boolean;
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
  if (opts.hint) w.hint = {} as HintBadge;
  w.isInViewport = opts.inViewport ?? false;
  if (opts.disconnected) w.disconnectedAt = 1;
  return w;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('gatherSettleReads set membership', () => {
  it('reads rects for hinted, codeworded, and never-hinted candidate wrappers', () => {
    const hinted = make({ hint: true });
    const codeworded = make({ codeword: 'ape', inViewport: true });
    const candidate = make({}); // no hint, flag out, no codeword, connected
    const g = gatherSettleReads([hinted, codeworded, candidate]);
    expect(g.rects.get(hinted)).toBeDefined();
    expect(g.rects.get(codeworded)).toBeDefined();
    expect(g.rects.get(candidate)).toBeDefined();
  });

  it('excludes limbo wrappers entirely', () => {
    const limbo = make({ hint: true, codeword: 'ape', disconnected: true });
    const g = gatherSettleReads([limbo]);
    expect(g.rects.size).toBe(0);
    expect(g.cssVisible.size).toBe(0);
  });

  it('excludes IO-owned non-candidates (no hint, flag in, no codeword)', () => {
    // A wrapper the IO believes is in-band but that has no hint and no
    // codeword is the IO's to converge (claim path) — none of the three
    // settle read passes sweep it, so the gather must not either.
    const ioOwned = make({ inViewport: true });
    const g = gatherSettleReads([ioOwned]);
    expect(g.rects.has(ioOwned)).toBe(false);
  });

  it('excludes disconnected never-hinted candidates', () => {
    const dead = make({ connected: false });
    const g = gatherSettleReads([dead]);
    expect(g.rects.has(dead)).toBe(false);
  });

  it('resolves cssVisible for hinted in-viewport wrappers and build candidates', () => {
    const dormant = make({ hint: true, inViewport: false });
    const active = make({ hint: true, inViewport: true });
    // Codeworded with no showing badge = the plan's build candidate — its
    // cssVisible rides the gather batch (the lazyReads finding).
    const buildCandidate = make({ codeword: 'ape', inViewport: true });
    const g = gatherSettleReads([dormant, active, buildCandidate]);
    expect(g.cssVisible.has(active)).toBe(true);
    expect(typeof g.cssVisible.get(active)).toBe('boolean');
    expect(g.cssVisible.has(buildCandidate)).toBe(true);
    // Dormant codeword-less badge: style-read only in the rare repair case,
    // never on the steady-state settle path.
    expect(g.cssVisible.has(dormant)).toBe(false);
    // …but the dormant hint still gets a rect (teardown's stale-FALSE sweep).
    expect(g.rects.get(dormant)).toBeDefined();
  });

  it('reports viewport dimensions and the top-frame ancestor-chain check', () => {
    const g = gatherSettleReads([]);
    expect(g.vw).toBe(window.innerWidth);
    expect(g.vh).toBe(window.innerHeight);
    expect(g.ancestorChainVisible).toBe(true);
  });
});

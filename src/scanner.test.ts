/**
 * BranchKit Browser — scanInBatches generator tests.
 *
 * Pins the per-batch yield contract that doScan (post-Option B) relies on:
 * batches sum to the same set scanElements returns, the terminal batch
 * carries `isLast: true` and the invisibleCandidates list, and an empty
 * scan still yields one terminal batch so callers' end-of-scan branches
 * don't need a special "no batches" path.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { scanElements, scanInBatches, DEFAULT_SCAN_BATCH_SIZE } from './scanner';

function html(markup: string): void {
  document.body.innerHTML = markup;
}

function nButtons(n: number): string {
  let out = '';
  for (let i = 0; i < n; i++) out += `<button id="b${i}">btn ${i}</button>`;
  return out;
}

// happy-dom's getBoundingClientRect returns a zero rect for every element
// (no layout engine). scanner's isVisible() rejects rects under 5x5, which
// would filter out every button in the test fixtures. Patch the prototype
// to return a 100x20 rect by default; the opacity-0 test still gets
// filtered out via getComputedStyle. Restored in afterEach.
const originalGetRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  document.body.innerHTML = '';
  Element.prototype.getBoundingClientRect = function (this: Element) {
    return {
      x: 0, y: 0, top: 0, left: 0, right: 100, bottom: 20,
      width: 100, height: 20,
      toJSON: () => ({}),
    } as DOMRect;
  };
});

afterEach(() => {
  Element.prototype.getBoundingClientRect = originalGetRect;
});

describe('scanInBatches', () => {
  it('yields one terminal batch with isLast=true for an empty scan', () => {
    html('<div>nothing hintable here</div>');
    const batches = [...scanInBatches(document)];
    expect(batches).toHaveLength(1);
    expect(batches[0].isLast).toBe(true);
    expect(batches[0].elements).toEqual([]);
    expect(batches[0].refs).toEqual([]);
    expect(batches[0].invisibleCandidates).toEqual([]);
  });

  it('yields a single batch when total elements <= batchSize', () => {
    html(nButtons(5));
    const batches = [...scanInBatches(document, 10)];
    expect(batches).toHaveLength(1);
    expect(batches[0].isLast).toBe(true);
    expect(batches[0].elements).toHaveLength(5);
    expect(batches[0].refs).toHaveLength(5);
  });

  it('splits into batches of batchSize, marking only the last isLast=true', () => {
    html(nButtons(33));
    const batches = [...scanInBatches(document, 10)];
    // 33 / 10 = 4 batches: 10, 10, 10, 3
    expect(batches).toHaveLength(4);
    expect(batches.map(b => b.elements.length)).toEqual([10, 10, 10, 3]);
    expect(batches.map(b => b.isLast)).toEqual([false, false, false, true]);
  });

  it('union of yielded refs equals scanElements refs, same order', () => {
    html(nButtons(25));
    const all = scanElements(document);
    const batches = [...scanInBatches(document, 7)];

    const refsFromBatches = batches.flatMap(b => b.refs);
    const idsFromBatches = batches.flatMap(b => b.elements.map(e => e.type + ':' + (e.label || '')));
    const refsFromScan = all.refs;
    const idsFromScan = all.elements.map(e => e.type + ':' + (e.label || ''));

    expect(refsFromBatches).toEqual(refsFromScan);
    expect(idsFromBatches).toEqual(idsFromScan);
  });

  it('puts invisibleCandidates only on the terminal batch', () => {
    html(`
      ${nButtons(12)}
      <button id="hidden" style="display: none">hidden</button>
      <button id="opacity0" style="opacity: 0">invisible</button>
    `);
    const batches = [...scanInBatches(document, 5)];
    // Last batch always carries invisibleCandidates; earlier batches don't.
    for (const b of batches.slice(0, -1)) {
      expect(b.invisibleCandidates).toEqual([]);
    }
    const last = batches[batches.length - 1];
    expect(last.isLast).toBe(true);
    // opacity-0 element matches HINTABLE_SELECTOR but fails isVisible.
    // display:none doesn't match (zero width/height excluded earlier).
    expect(last.invisibleCandidates.length).toBeGreaterThan(0);
  });

  it('defaults batchSize to DEFAULT_SCAN_BATCH_SIZE when omitted', () => {
    html(nButtons(DEFAULT_SCAN_BATCH_SIZE * 2 + 1));
    const batches = [...scanInBatches(document)];
    expect(batches).toHaveLength(3);
    expect(batches[0].elements).toHaveLength(DEFAULT_SCAN_BATCH_SIZE);
    expect(batches[1].elements).toHaveLength(DEFAULT_SCAN_BATCH_SIZE);
    expect(batches[2].elements).toHaveLength(1);
    expect(batches[2].isLast).toBe(true);
  });

  it('dedupes across batches — no element appears in two batches', () => {
    html(nButtons(40));
    const batches = [...scanInBatches(document, 13)];
    const allRefs = batches.flatMap(b => b.refs);
    expect(new Set(allRefs).size).toBe(allRefs.length);
  });

  it('respects a custom subtree root', () => {
    html(`
      ${nButtons(3)}
      <div id="subtree">${nButtons(7)}</div>
    `);
    const subtree = document.getElementById('subtree')!;
    const batches = [...scanInBatches(subtree, 100)];
    expect(batches).toHaveLength(1);
    expect(batches[0].elements).toHaveLength(7);
  });

  it('initialSeen pre-marks elements so the walk skips them', () => {
    html(nButtons(10));
    const allButtons = Array.from(document.querySelectorAll('button'));
    const skipped = new Set<Element>(allButtons.slice(0, 4));

    const batches = [...scanInBatches(document, 100, skipped)];
    expect(batches).toHaveLength(1);
    expect(batches[0].elements).toHaveLength(6);
    // Skipped refs must not appear in yielded refs.
    for (const ref of batches[0].refs) {
      expect(skipped.has(ref)).toBe(false);
    }
  });

  it('initialSeen still yields a terminal empty batch when everything is pre-marked', () => {
    html(nButtons(5));
    const all = new Set<Element>(Array.from(document.querySelectorAll('button')));
    const batches = [...scanInBatches(document, 100, all)];
    expect(batches).toHaveLength(1);
    expect(batches[0].isLast).toBe(true);
    expect(batches[0].elements).toEqual([]);
  });
});

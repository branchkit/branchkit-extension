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
import {
  scanElements, scanInBatches, DEFAULT_SCAN_BATCH_SIZE, subtreeMaybeHintable,
  deepQuerySelectorAll, getPerfCounters, resetPerfCounters, isVisible,
  effectiveVisualBox, isHintable,
} from './scanner';

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

describe('subtreeMaybeHintable', () => {
  it('returns true when the root itself matches', () => {
    html('<button id="root">x</button>');
    const root = document.getElementById('root')!;
    expect(subtreeMaybeHintable(root)).toBe(true);
  });

  it('returns true when a light-DOM descendant matches', () => {
    html('<div id="root"><span><a href="#">link</a></span></div>');
    const root = document.getElementById('root')!;
    expect(subtreeMaybeHintable(root)).toBe(true);
  });

  it('returns false for a subtree with no hintable element', () => {
    html('<div id="root"><span>text</span><p>more text</p></div>');
    const root = document.getElementById('root')!;
    expect(subtreeMaybeHintable(root)).toBe(false);
  });

  it('does not pierce shadow roots (shadow content handled elsewhere)', () => {
    html('<div id="root"></div>');
    const root = document.getElementById('root')!;
    const shadow = root.attachShadow({ mode: 'open' });
    shadow.innerHTML = '<button>shadow btn</button>';
    expect(subtreeMaybeHintable(root)).toBe(false);
  });
});

describe('deepQuerySelectorAll — opaque-subtree pruning (A2)', () => {
  beforeEach(() => resetPerfCounters());

  it('still pierces a shadow host in a normal subtree', () => {
    html('<div id="host"></div>');
    const host = document.getElementById('host')!;
    host.attachShadow({ mode: 'open' }).innerHTML = '<button id="sb">x</button>';
    const found = deepQuerySelectorAll(document, 'button');
    expect(found.some(el => el.id === 'sb')).toBe(true);
  });

  it('pierces shadow hosts on spec-permitted non-div tags (span/section/etc)', () => {
    // These sat in the old "doesn't host shadow DOM in practice" leaf list,
    // so declarative-shadow / uncommon hosts on them were never pierced.
    html('<span id="s"></span><section id="sec"></section>');
    document.getElementById('s')!
      .attachShadow({ mode: 'open' }).innerHTML = '<button id="in-span">x</button>';
    document.getElementById('sec')!
      .attachShadow({ mode: 'open' }).innerHTML = '<button id="in-section">x</button>';
    const found = deepQuerySelectorAll(document, 'button');
    expect(found.some(el => el.id === 'in-span')).toBe(true);
    expect(found.some(el => el.id === 'in-section')).toBe(true);
  });

  it('skips the shadow-host walk inside an opaque <svg> subtree', () => {
    // A custom-element host nested inside an <svg> would normally be pierced;
    // the opaque-subtree prune means we never descend into the <svg> to find
    // it. The counter records the pruned root.
    html('<svg id="icon"><g><my-widget></my-widget></g></svg>');
    const widget = document.querySelector('my-widget')!;
    widget.attachShadow({ mode: 'open' }).innerHTML = '<button id="hidden">x</button>';
    const found = deepQuerySelectorAll(document, 'button');
    expect(found.some(el => el.id === 'hidden')).toBe(false);
    expect(getPerfCounters().shadowHostPrunedSubtrees).toBeGreaterThan(0);
  });

  it('still finds light-DOM hintables (main pass is not pruned by opaque tags)', () => {
    // The native selector pass is untouched: a real anchor anywhere in the
    // document is still returned even when opaque subtrees are present.
    html('<svg><circle /></svg><a id="link" href="#">go</a>');
    const found = deepQuerySelectorAll(document, 'a[href]');
    expect(found.some(el => el.id === 'link')).toBe(true);
  });
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

describe('isVisible — native checkVisibility delegation', () => {
  // happy-dom has no Element.checkVisibility, so the suite otherwise runs the
  // legacy ancestor-opacity walk. Stub it per-element to pin the native
  // branch: the ancestor gate must delegate with checkOpacity +
  // checkVisibilityCSS and trust the verdict.
  it('returns the native verdict and passes the opacity/CSS options', () => {
    html('<div><button id="b">go</button></div>');
    const el = document.getElementById('b')! as Element & {
      checkVisibility?: (opts?: Record<string, boolean>) => boolean;
    };
    let seenOpts: Record<string, boolean> | undefined;
    el.checkVisibility = (opts) => { seenOpts = opts as Record<string, boolean>; return false; };
    expect(isVisible(el)).toBe(false);
    expect(seenOpts?.checkOpacity).toBe(true);
    expect(seenOpts?.checkVisibilityCSS).toBe(true);
    el.checkVisibility = () => true;
    expect(isVisible(el)).toBe(true);
  });

  it('own-style carve-outs still run before the native gate (opacity:0 rejects without consulting it)', () => {
    html('<div><button id="b" style="opacity: 0">go</button></div>');
    const el = document.getElementById('b')! as Element & { checkVisibility?: () => boolean };
    let consulted = false;
    el.checkVisibility = () => { consulted = true; return true; };
    expect(isVisible(el)).toBe(false);
    expect(consulted).toBe(false);
  });
});

describe('isVisible — autosized text-entry carve-out (QuickBase 2px filter inputs)', () => {
  // The shared beforeEach patches every rect to 100x20; narrow it here so
  // [data-tiny] elements measure 2x19 (the react-select empty-input shape).
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const tiny = this.hasAttribute?.('data-tiny');
      return {
        x: 0, y: 0, top: 0, left: 0,
        right: tiny ? 2 : 100, bottom: tiny ? 19 : 20,
        width: tiny ? 2 : 100, height: tiny ? 19 : 20,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });

  it('a 2px-wide empty text input inside a visible wrapper is visible', () => {
    html('<div id="wrap"><input id="f" type="text" data-tiny></div>');
    expect(isVisible(document.getElementById('f')!)).toBe(true);
  });

  it('climbs past an equally-tiny autosize sizer to the real box (react-select nesting)', () => {
    // QuickBase gridColumnFilter: input sits in an inline-grid measuring
    // container that is as tiny as the input; the visible box is 2 levels up.
    html('<div id="box"><div id="sizer" data-tiny><input id="f" type="text" data-tiny></div></div>');
    expect(isVisible(document.getElementById('f')!)).toBe(true);
  });

  it('gives up when no real box exists within the climb bound', () => {
    let markup = '<input id="f" type="text" data-tiny>';
    for (let i = 0; i < 6; i++) markup = `<div data-tiny>${markup}</div>`;
    html(markup);
    expect(isVisible(document.getElementById('f')!)).toBe(false);
  });

  it('textarea and select get the same parent fallback', () => {
    html('<div><textarea id="t" data-tiny></textarea><select id="s" data-tiny></select></div>');
    expect(isVisible(document.getElementById('t')!)).toBe(true);
    expect(isVisible(document.getElementById('s')!)).toBe(true);
  });

  it('size-only fallback does NOT rescue an explicitly hidden input', () => {
    html('<div><input id="f" type="text" data-tiny style="visibility:hidden"></div>');
    expect(isVisible(document.getElementById('f')!)).toBe(false);
  });

  it('does NOT rescue an opacity:0 text input (unlike checkbox/radio)', () => {
    html('<div><input id="f" type="text" data-tiny style="opacity:0"></div>');
    expect(isVisible(document.getElementById('f')!)).toBe(false);
  });

  it('does NOT rescue a tiny input whose parent is itself invisible', () => {
    html('<div style="opacity:0"><input id="f" type="text" data-tiny></div>');
    expect(isVisible(document.getElementById('f')!)).toBe(false);
  });

  it('a tiny non-form element stays invisible (gate unchanged)', () => {
    html('<div><a href="#" id="a" data-tiny>x</a></div>');
    expect(isVisible(document.getElementById('a')!)).toBe(false);
  });
});

describe('effectiveVisualBox', () => {
  beforeEach(() => {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const tiny = this.hasAttribute?.('data-tiny');
      return {
        x: 0, y: 0, top: 0, left: 0,
        right: tiny ? 2 : 100, bottom: tiny ? 19 : 20,
        width: tiny ? 2 : 100, height: tiny ? 19 : 20,
        toJSON: () => ({}),
      } as DOMRect;
    };
  });

  it('a normal-size input answers for itself', () => {
    html('<div><input id="f" type="text"></div>');
    const f = document.getElementById('f')!;
    expect(effectiveVisualBox(f)).toBe(f);
  });

  it('a tiny input climbs past tiny sizers to the first real box', () => {
    html('<div id="box"><div id="sizer" data-tiny><input id="f" type="text" data-tiny></div></div>');
    expect(effectiveVisualBox(document.getElementById('f')!))
      .toBe(document.getElementById('box')!);
  });

  it('a tiny NON-form element answers for itself (no climb)', () => {
    html('<div id="box"><a href="#" id="a" data-tiny>x</a></div>');
    const a = document.getElementById('a')!;
    expect(effectiveVisualBox(a)).toBe(a);
  });

  it('returns the element itself when no real box exists within the bound', () => {
    let markup = '<input id="f" type="text" data-tiny>';
    for (let i = 0; i < 6; i++) markup = `<div data-tiny>${markup}</div>`;
    html(markup);
    const f = document.getElementById('f')!;
    expect(effectiveVisualBox(f)).toBe(f);
  });
});

describe('orphan labels — bare <label> with no live associated control', () => {
  it('rejects a label with no control (QuickBase view-mode field names)', () => {
    html('<label id="l">Billing Address 1</label>');
    expect(isHintable(document.getElementById('l')!)).toBe(false);
  });

  it('suppresses a label whose control is visible — the control carries the hint', () => {
    html('<label id="l" for="f">City</label><input id="f" type="text">');
    expect(isHintable(document.getElementById('l')!)).toBe(false);
    expect(isHintable(document.getElementById('f')!)).toBe(true);
  });

  it('suppresses a label wrapping a visible control — the control carries the hint', () => {
    html('<label id="l"><input id="f" type="checkbox">Remember me</label>');
    expect(isHintable(document.getElementById('l')!)).toBe(false);
    expect(isHintable(document.getElementById('f')!)).toBe(true);
  });

  it('keeps the label when its control is hidden (styled file-upload pattern)', () => {
    // checkVisibility stub = the suite's stand-in for a display:none control
    // (happy-dom has no layout; the patched 100x20 rect makes everything
    // "visible" otherwise). type=file, not checkbox: hidden checkboxes with
    // a visible parent are answered visible by isVisible's carve-out and
    // carry their own badge, so their labels are correctly suppressed.
    html('<label id="l" for="f">Upload</label><input id="f" type="file">');
    const f = document.getElementById('f')! as Element & { checkVisibility?: () => boolean };
    f.checkVisibility = () => false;
    expect(isHintable(document.getElementById('l')!)).toBe(true);
    expect(isHintable(f)).toBe(false);
  });

  it('rejects a label whose control is disabled', () => {
    html('<label id="l" for="f">Locked</label><input id="f" type="text" disabled>');
    expect(isHintable(document.getElementById('l')!)).toBe(false);
  });

  it('accepts an orphan label that earns hintability another way (role)', () => {
    html('<label id="l" role="button">Act</label>');
    expect(isHintable(document.getElementById('l')!)).toBe(true);
  });

  it('scanElements skips orphan labels (counted) and visible-control labels (redundant)', () => {
    resetPerfCounters();
    html('<label>Dead one</label><label>Dead two</label><label for="f">Live</label><input id="f" type="text">');
    const { elements } = scanElements();
    const labels = elements.filter((e) => e.type === 'label');
    expect(labels.length).toBe(0);
    expect(elements.filter((e) => e.type === 'input').length).toBe(1);
    expect(getPerfCounters().scanRejectedOrphanLabel).toBe(2);
    expect(getPerfCounters().scanRejectedRedundant).toBe(1);
  });
});

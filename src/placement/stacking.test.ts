/**
 * BranchKit Browser — stacking-context z-index tests.
 *
 * Pins the two-phase walk in `calculateZIndex` (ported from Rango):
 *   - phase 1: max z-index among descendants that create their own
 *     stacking context (so a chat-bubble floating over the target's
 *     icon doesn't bury the hint),
 *   - phase 2: walk ancestors UP, overwriting (not max-ing) z-index
 *     with each stacking-context ancestor's value, halting when an
 *     ancestor contains the mount node (beyond that lies the badge's
 *     own context).
 *
 * happy-dom returns the inline style for getComputedStyle, so the tests
 * set style.zIndex / style.position directly to drive the algorithm.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { calculateZIndex, createsStackingContext } from './stacking';

const mounted: Element[] = [];
function mount(html: string): Element {
  const wrapper = document.createElement('div');
  wrapper.innerHTML = html;
  document.body.appendChild(wrapper);
  mounted.push(wrapper);
  return wrapper;
}

afterEach(() => {
  for (const el of mounted) el.remove();
  mounted.length = 0;
});

describe('createsStackingContext', () => {
  it('returns true for the document element', () => {
    expect(createsStackingContext(document.documentElement)).toBe(true);
  });

  it('returns true for position+zIndex elements', () => {
    const el = mount('<div></div>').firstElementChild!;
    (el as HTMLElement).style.position = 'relative';
    (el as HTMLElement).style.zIndex = '5';
    expect(createsStackingContext(el)).toBe(true);
  });

  it('returns false for position:static even with a zIndex value', () => {
    const el = mount('<div></div>').firstElementChild!;
    (el as HTMLElement).style.position = 'static';
    (el as HTMLElement).style.zIndex = '5';
    expect(createsStackingContext(el)).toBe(false);
  });

  it('returns true for fixed/sticky positioning', () => {
    const fixed = mount('<div></div>').firstElementChild!;
    (fixed as HTMLElement).style.position = 'fixed';
    expect(createsStackingContext(fixed)).toBe(true);

    const sticky = mount('<div></div>').firstElementChild!;
    (sticky as HTMLElement).style.position = 'sticky';
    expect(createsStackingContext(sticky)).toBe(true);
  });

  it('returns true for opacity < 1', () => {
    const el = mount('<div></div>').firstElementChild!;
    (el as HTMLElement).style.opacity = '0.5';
    expect(createsStackingContext(el)).toBe(true);
  });

  it('returns true for transform != none', () => {
    const el = mount('<div></div>').firstElementChild!;
    (el as HTMLElement).style.transform = 'translateZ(0)';
    expect(createsStackingContext(el)).toBe(true);
  });

  it('returns false for vanilla position:static div', () => {
    const el = mount('<div></div>').firstElementChild!;
    expect(createsStackingContext(el)).toBe(false);
  });
});

describe('calculateZIndex', () => {
  it('starts at the buffer (5) when no stacking-context ancestors/descendants', () => {
    const root = mount('<div><button id="t">click</button></div>');
    const target = root.querySelector('#t')!;
    // mountNode at body — the ancestor walk stops at body (contains mountNode).
    // No stacking ancestors below body, no stacking descendants → returns just
    // the +5 buffer.
    expect(calculateZIndex(target, document.body)).toBe(5);
  });

  it('takes the max z-index of stacking-context descendants of the target', () => {
    const root = mount(
      '<button id="t"><span id="a"></span><span id="b"></span></button>'
    );
    const target = root.querySelector('#t')!;
    const a = root.querySelector('#a') as HTMLElement;
    const b = root.querySelector('#b') as HTMLElement;
    a.style.position = 'relative'; a.style.zIndex = '10';
    b.style.position = 'relative'; b.style.zIndex = '30';
    // Descendants create stacking contexts at z=10 and z=30 respectively.
    // Phase 1 picks the max (30) — so a high-z descendant doesn't bury the
    // hint. Plus the buffer = 35.
    expect(calculateZIndex(target, document.body)).toBe(35);
  });

  it('overwrites (not max-es) z-index with each stacking-context ancestor', () => {
    const root = mount(
      '<div id="grand"><div id="parent"><button id="t">click</button></div></div>'
    );
    const target = root.querySelector('#t')!;
    const parent = root.querySelector('#parent') as HTMLElement;
    const grand = root.querySelector('#grand') as HTMLElement;
    parent.style.position = 'relative'; parent.style.zIndex = '100';
    grand.style.position = 'relative'; grand.style.zIndex = '5';
    // Ancestor walk: parent (z=100) → grand (z=5). Each OVERWRITES — so
    // the final running z is grand's 5, NOT the max 100. This is correct:
    // parent's 100 only matters inside grand's context; grand's context
    // is what determines the badge's stacking against the rest of the page.
    // Plus buffer = 10.
    expect(calculateZIndex(target, document.body)).toBe(10);
  });

  it('halts ancestor walk when an ancestor contains the mount node', () => {
    const root = mount(
      '<div id="far"><div id="halt"><div id="near"><button id="t">x</button></div></div></div>'
    );
    const target = root.querySelector('#t')!;
    const halt = root.querySelector('#halt') as HTMLElement;
    const far = root.querySelector('#far') as HTMLElement;
    const near = root.querySelector('#near') as HTMLElement;
    near.style.position = 'relative'; near.style.zIndex = '10';
    halt.style.position = 'relative'; halt.style.zIndex = '20';
    far.style.position = 'relative'; far.style.zIndex = '999';
    // Pretend the mount node lives inside `halt`. The walk should hit
    // `near` (z=10) then `halt` (contains the mount node) and STOP —
    // far's z=999 must never apply, because relative to halt's children
    // it would over-elevate the badge.
    const mountNode = document.createElement('div');
    halt.appendChild(mountNode);
    // near rewrites to 10, then halt contains mountNode → break. Buffer = +5.
    expect(calculateZIndex(target, mountNode)).toBe(15);
  });

  it('treats auto/NaN ancestor z-index as 0 (Rango-compatible)', () => {
    const root = mount('<div id="parent"><button id="t">click</button></div>');
    const target = root.querySelector('#t')!;
    const parent = root.querySelector('#parent') as HTMLElement;
    parent.style.position = 'relative'; // no explicit z-index → 'auto'
    // happy-dom's getComputedStyle returns '' for unset; parseInt(NaN) → 0.
    // Result: just the buffer.
    expect(calculateZIndex(target, document.body)).toBe(5);
  });

  it('handles fixed/sticky ancestor (creates a stacking context implicitly)', () => {
    const root = mount('<div id="parent"><button id="t">click</button></div>');
    const target = root.querySelector('#t')!;
    const parent = root.querySelector('#parent') as HTMLElement;
    parent.style.position = 'fixed'; parent.style.zIndex = '50';
    // Fixed positioning creates a stacking context whether or not
    // z-index is set — and z-index 50 here applies. +5 buffer.
    expect(calculateZIndex(target, document.body)).toBe(55);
  });
});

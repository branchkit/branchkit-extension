/**
 * BranchKit Browser — badge-placement probe-cache tests.
 *
 * The cached probe is the Firefox unresponsive-script fix: it stores the
 * scroll-invariant offset from the element rect to the first-visible-text
 * rect, so scroll-coalesced repositions don't re-walk text nodes or read
 * Range rects (each Range rect read forces synchronous layout — see the
 * notes in placement/position.ts and element-wrapper.ts).
 *
 * These tests pin the cache shape and the invalidation contract. The DOM
 * walking inside `probeFirstVisibleText` is covered by integration tests
 * (the harness exercises it on real fixtures); here we hold the cache
 * accountable: probe once, reuse on subsequent reads, drop on invalidate.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ElementWrapper, AnchorProbeOffset } from '../scan/element-wrapper';
import { ScannedElement } from '../types';
import { getOrComputeProbe, invalidateProbe, probeAnchor } from './position';

// `getOrComputeProbe` reads `getCachedRect(element)` from the shared
// layout-cache and falls through to `Range.getBoundingClientRect()` when
// the cache misses. JSDOM's text-walking is enough for the once-through
// path, but for stable assertions on the offset math we stub the element
// rect and seed the probe directly.
vi.mock('../layout-cache', () => ({
  getCachedRect: (el: Element) =>
    (el as unknown as { __rect: DOMRect }).__rect ??
    new DOMRect(0, 0, 100, 20),
  getCachedStyle: () => ({ fontSize: '14px' } as unknown as CSSStyleDeclaration),
  getCachedDims: () => ({ clientHeight: 100, scrollHeight: 100 }),
  isClipAncestor: () => false,
}));

function makeWrapper(element: Element): ElementWrapper {
  const scanned: ScannedElement = {
    label: 'x',
    id: 0,
    category: 'button',
    type: 'button',
    adapter: null,
    codeword: '',
  };
  return new ElementWrapper(element, scanned);
}

function seedProbe(w: ElementWrapper, offset: AnchorProbeOffset): void {
  w.cachedProbe = offset;
}

describe('getOrComputeProbe — cache read', () => {
  it('reconstructs absolute rect from cached offset + current element rect', () => {
    // Element is at (100, 200) now; the cached probe says the text starts
    // 12px right and 4px down from the element's top-left and is 30x16.
    // Expected absolute rect: (112, 204, 30, 16).
    const el = { __rect: new DOMRect(100, 200, 200, 30) } as unknown as Element;
    const w = makeWrapper(el);
    seedProbe(w, { kind: 'text', offsetX: 12, offsetY: 4, width: 30, height: 16 });

    const probe = getOrComputeProbe(w);
    expect(probe.kind).toBe('text');
    if (probe.kind === 'none') throw new Error('unreachable');
    expect(probe.rect.left).toBe(112);
    expect(probe.rect.top).toBe(204);
    expect(probe.rect.width).toBe(30);
    expect(probe.rect.height).toBe(16);
  });

  it('reconstructs from a different scroll position without recomputing', () => {
    // Same wrapper, same cached offset, but element rect has moved (the
    // page scrolled). Offset stays valid; reconstructed rect tracks the
    // element. This is the load-bearing case for the Firefox fix: scrolls
    // re-place without re-probing.
    const el = { __rect: new DOMRect(0, 0, 200, 30) } as unknown as Element;
    const w = makeWrapper(el);
    seedProbe(w, { kind: 'text', offsetX: 12, offsetY: 4, width: 30, height: 16 });

    // Move the element (simulate a scroll).
    (el as unknown as { __rect: DOMRect }).__rect = new DOMRect(0, -500, 200, 30);

    const probe = getOrComputeProbe(w);
    if (probe.kind === 'none') throw new Error('unreachable');
    expect(probe.rect.left).toBe(12);
    expect(probe.rect.top).toBe(-496); // -500 + 4
  });

  it('returns kind:none for a cached negative result without probing', () => {
    const el = { __rect: new DOMRect(0, 0, 100, 20) } as unknown as Element;
    const w = makeWrapper(el);
    seedProbe(w, { kind: 'none' });

    const probe = getOrComputeProbe(w);
    expect(probe.kind).toBe('none');
  });
});

describe('invalidateProbe', () => {
  it('drops the cached offset so the next read re-probes', () => {
    const el = { __rect: new DOMRect(0, 0, 200, 30) } as unknown as Element;
    const w = makeWrapper(el);
    seedProbe(w, { kind: 'text', offsetX: 12, offsetY: 4, width: 30, height: 16 });

    invalidateProbe(w);
    expect(w.cachedProbe).toBeNull();
  });

  it('is a no-op when there is no cached probe', () => {
    const el = { __rect: new DOMRect(0, 0, 100, 20) } as unknown as Element;
    const w = makeWrapper(el);
    expect(w.cachedProbe).toBeNull();

    invalidateProbe(w);
    expect(w.cachedProbe).toBeNull();
  });
});

describe('getOrComputeProbe — compute path', () => {
  it('runs the probe and stores the cache on first call against a fresh wrapper', () => {
    // Real DOM element with a text node so the TreeWalker has something to
    // find. JSDOM returns zero-sized Range rects for synthetic text, so we
    // assert the cache *shape* (hasText branch landed) rather than offset
    // values — the offset-from-element math is covered by the seeded tests.
    const div = document.createElement('div');
    div.textContent = 'hello world';
    document.body.appendChild(div);
    try {
      const w = makeWrapper(div);
      expect(w.cachedProbe).toBeNull();
      const probe = getOrComputeProbe(w);
      // JSDOM Range rects are 0x0 → probeAnchor returns kind:'none'.
      // That's still a cache hit — the cache stores the negative result
      // so we don't re-walk on every scroll.
      expect(w.cachedProbe).not.toBeNull();
      expect(w.cachedProbe?.kind).toBe(probe.kind);
    } finally {
      div.remove();
    }
  });
});

describe('probeAnchor — icon-or-text document order', () => {
  // The layout-cache mock returns a 100x20 rect for every element, which
  // fails the icon aspect gate (5:1). Elements opting in as icons carry a
  // __rect the mock serves instead.
  function withRect<T extends Element>(el: T, rect: DOMRect): T {
    (el as unknown as { __rect: DOMRect }).__rect = rect;
    return el;
  }

  it('anchors to a leading svg icon before the text (sidebar-row shape)', () => {
    const a = document.createElement('a');
    const svg = withRect(
      document.createElementNS('http://www.w3.org/2000/svg', 'svg') as unknown as Element,
      new DOMRect(4, 4, 20, 20),
    );
    const span = document.createElement('span');
    span.textContent = 'Companies';
    a.append(svg, span);
    document.body.appendChild(a);
    try {
      const probe = probeAnchor(a);
      expect(probe.kind).toBe('icon');
      if (probe.kind === 'none') throw new Error('unreachable');
      expect(probe.rect.width).toBe(20);
    } finally {
      a.remove();
    }
  });

  it('never anchors to svg interior nodes', () => {
    const a = document.createElement('a');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.appendChild(path);
    // Oversized svg fails the icon gate; the probe must pass over the whole
    // graphic rather than trying the <path> inside it.
    withRect(svg as unknown as Element, new DOMRect(0, 0, 400, 300));
    a.append(svg);
    document.body.appendChild(a);
    try {
      expect(probeAnchor(a).kind).toBe('none');
    } finally {
      a.remove();
    }
  });

  it('an oversized image does not beat following text', () => {
    const a = document.createElement('a');
    const img = withRect(document.createElement('img'), new DOMRect(0, 0, 300, 180));
    const span = document.createElement('span');
    span.textContent = 'Caption';
    a.append(img, span);
    document.body.appendChild(a);
    try {
      // JSDOM Range rects are 0x0 so the text branch can't land either —
      // the assertion is that the big image was NOT taken as an icon.
      expect(probeAnchor(a).kind).not.toBe('icon');
    } finally {
      a.remove();
    }
  });
});

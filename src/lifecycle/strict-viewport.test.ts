/**
 * BranchKit Browser — strict-viewport delta unit tests.
 *
 * Locks the rect-vs-viewport math `collectStrictViewportDelta` uses to
 * decide which wrappers need a `_strict` companion-collection re-push.
 * The check is `r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw` —
 * any pixel of the element in the visible viewport counts as in-strict.
 * These tests pin the boundary semantics so a future refactor can't
 * silently change "barely visible" behaviour.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { ElementWrapper } from '../scan/element-wrapper';
import { ScannedElement, Category } from '../types';
import { collectStrictViewportDelta, stampStrictViewport, isAncestorChainInVisibleViewport } from './strict-viewport';

interface FakeRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

function fakeElement(rect: FakeRect | null): Element {
  const el = {
    tagName: 'A',
    getBoundingClientRect(): DOMRect {
      if (rect == null) throw new Error('detached');
      return {
        top: rect.top,
        left: rect.left,
        bottom: rect.top + rect.height,
        right: rect.left + rect.width,
        width: rect.width,
        height: rect.height,
        x: rect.left,
        y: rect.top,
        toJSON() { return this; },
      } as DOMRect;
    },
  };
  return el as unknown as Element;
}

function makeWrapper(opts: {
  rect: FakeRect | null;
  codeword?: string;
  lastSent?: boolean;
  disconnected?: number | null;
  category?: Category;
  cssHidden?: boolean;
  occluded?: boolean;
}): ElementWrapper {
  const scanned: ScannedElement = {
    label: 'a',
    id: 1,
    category: opts.category ?? 'link',
    type: 'link',
    adapter: null,
    codeword: opts.codeword ?? 'ape bake',
  };
  const w = new ElementWrapper(fakeElement(opts.rect), scanned);
  w.lastSentStrictViewport = opts.lastSent;
  if (opts.disconnected !== undefined) w.disconnectedAt = opts.disconnected;
  if (opts.cssHidden !== undefined) w.cssHidden = opts.cssHidden;
  if (opts.occluded !== undefined) w.occluded = opts.occluded;
  return w;
}

const VW = 1000;
const VH = 800;

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { value: VW, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: VH, configurable: true });
});

describe('collectStrictViewportDelta — inclusion semantics', () => {
  it('skips wrappers without a codeword (no _strict entry to update)', () => {
    const w = makeWrapper({ rect: { top: 100, left: 100, width: 50, height: 20 }, codeword: '' });
    expect(collectStrictViewportDelta([w])).toEqual([]);
  });

  it('skips limbo wrappers (held by design)', () => {
    const w = makeWrapper({
      rect: { top: 100, left: 100, width: 50, height: 20 },
      disconnected: 1234,
      lastSent: false,
    });
    expect(collectStrictViewportDelta([w])).toEqual([]);
  });

  it('skips a wrapper whose current strict matches lastSent (no delta)', () => {
    const w = makeWrapper({
      rect: { top: 100, left: 100, width: 50, height: 20 },
      lastSent: true,
    });
    expect(collectStrictViewportDelta([w])).toEqual([]);
  });

  it('queues a wrapper that entered strict viewport (lastSent=false → true)', () => {
    const w = makeWrapper({
      rect: { top: 100, left: 100, width: 50, height: 20 },
      lastSent: false,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });

  it('queues a wrapper that left strict viewport (lastSent=true → false)', () => {
    const w = makeWrapper({
      rect: { top: -500, left: 100, width: 50, height: 20 },
      lastSent: true,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });

  it('queues a never-pushed wrapper as a delta (undefined → false counts as a change)', () => {
    const w = makeWrapper({
      rect: { top: -500, left: 100, width: 50, height: 20 },
      lastSent: undefined,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });
});

describe('collectStrictViewportDelta — visibility gate (cssHidden / occluded)', () => {
  it('drops a CSS-hidden target the recheck flagged, even fully in-viewport', () => {
    // The QuickBase WidgetActions case: rect is squarely in the viewport, but the
    // hover-reveal action bar is visibility:hidden so the badge is hidden — voice
    // must not match it. lastSent=true → it was in _strict, now flips out → delta.
    const w = makeWrapper({
      rect: { top: 100, left: 100, width: 50, height: 20 },
      lastSent: true,
      cssHidden: true,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });

  it('keeps a cssHidden target out of strict with no delta once already out', () => {
    const w = makeWrapper({
      rect: { top: 100, left: 100, width: 50, height: 20 },
      lastSent: false,
      cssHidden: true,
    });
    expect(collectStrictViewportDelta([w])).toEqual([]);
  });

  it('re-admits a target whose cssHidden cleared (badge re-shown on hover)', () => {
    const w = makeWrapper({
      rect: { top: 100, left: 100, width: 50, height: 20 },
      lastSent: false,
      cssHidden: false,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });

  it('drops an occluded target the same way (parity with cssHidden)', () => {
    const w = makeWrapper({
      rect: { top: 100, left: 100, width: 50, height: 20 },
      lastSent: true,
      occluded: true,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });
});

describe('collectStrictViewportDelta — rect boundary semantics', () => {
  it('counts an element fully off-top as out-of-strict', () => {
    const w = makeWrapper({
      rect: { top: -50, left: 100, width: 100, height: 20 },
      lastSent: true,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });

  it('counts an element fully off-bottom as out-of-strict', () => {
    const w = makeWrapper({
      rect: { top: VH + 50, left: 100, width: 100, height: 20 },
      lastSent: true,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });

  it('counts an element straddling the top edge as in-strict (partial visibility)', () => {
    const w = makeWrapper({
      rect: { top: -10, left: 100, width: 100, height: 20 },
      lastSent: false,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });

  it('counts an element straddling the bottom edge as in-strict (partial visibility)', () => {
    const w = makeWrapper({
      rect: { top: VH - 10, left: 100, width: 100, height: 20 },
      lastSent: false,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });

  it('counts a zero-size element at a visible coordinate as in-strict', () => {
    const w = makeWrapper({
      rect: { top: 100, left: 100, width: 0, height: 0 },
      lastSent: false,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });

  it('counts an element exactly at top=0 as in-strict', () => {
    const w = makeWrapper({
      rect: { top: 0, left: 0, width: 100, height: 100 },
      lastSent: false,
    });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });

  it('treats getBoundingClientRect throwing as out-of-strict', () => {
    const w = makeWrapper({ rect: null, lastSent: true });
    expect(collectStrictViewportDelta([w])).toEqual([w]);
  });
});

describe('stampStrictViewport', () => {
  it('writes both in_strict_viewport (current) and lastSentStrictViewport (baseline) in one pass', () => {
    const w = makeWrapper({
      rect: { top: 100, left: 100, width: 50, height: 20 },
      lastSent: undefined,
    });
    stampStrictViewport([w]);
    expect(w.scanned.in_strict_viewport).toBe(true);
    expect(w.lastSentStrictViewport).toBe(true);
  });

  it('sets both to false for an off-screen element', () => {
    const w = makeWrapper({
      rect: { top: VH + 100, left: 100, width: 50, height: 20 },
      lastSent: true,
    });
    stampStrictViewport([w]);
    expect(w.scanned.in_strict_viewport).toBe(false);
    expect(w.lastSentStrictViewport).toBe(false);
  });

  it('records false when the element rect throws (detached path)', () => {
    const w = makeWrapper({ rect: null, lastSent: true });
    stampStrictViewport([w]);
    expect(w.scanned.in_strict_viewport).toBe(false);
    expect(w.lastSentStrictViewport).toBe(false);
  });

  it('stamps a CSS-hidden but in-viewport target as off-strict', () => {
    const w = makeWrapper({
      rect: { top: 100, left: 100, width: 50, height: 20 },
      lastSent: undefined,
      cssHidden: true,
    });
    stampStrictViewport([w]);
    expect(w.scanned.in_strict_viewport).toBe(false);
    expect(w.lastSentStrictViewport).toBe(false);
  });

  it('is a no-op on an empty list (the hot scan-empty-batch path)', () => {
    expect(() => stampStrictViewport([])).not.toThrow();
  });
});

// Build a fake nested-frame Window for ancestor-chain testing without
// fighting the real DOM environment. Each level carries its own innerWidth/
// innerHeight + a frameElement whose getBoundingClientRect returns a
// controlled rect in the parent's coord space.
interface FakeFrame {
  parent: FakeFrame;
  frameElement: { getBoundingClientRect(): DOMRect } | null;
  innerWidth: number;
  innerHeight: number;
  /** Set to true to simulate a cross-origin barrier on `.parent` access. */
  parentThrows?: boolean;
  /** Set to true to simulate a cross-origin barrier on parent.innerWidth/innerHeight. */
  parentDimsThrow?: boolean;
}

function fakeFrame(opts: {
  inParentRect?: FakeRect;
  parent?: FakeFrame;
  pvw?: number;
  pvh?: number;
  parentThrows?: boolean;
  parentDimsThrow?: boolean;
}): FakeFrame {
  const top: FakeFrame = {
    parent: undefined as unknown as FakeFrame,
    frameElement: null,
    innerWidth: opts.pvw ?? 1000,
    innerHeight: opts.pvh ?? 800,
  };
  top.parent = top;  // top frame: parent === self
  const parent = opts.parent ?? top;
  const fr: FakeFrame = {
    parent,
    innerWidth: 500,
    innerHeight: 400,
    parentThrows: opts.parentThrows,
    parentDimsThrow: opts.parentDimsThrow,
    frameElement: opts.inParentRect ? {
      getBoundingClientRect(): DOMRect {
        const r = opts.inParentRect!;
        return {
          top: r.top, left: r.left,
          bottom: r.top + r.height, right: r.left + r.width,
          width: r.width, height: r.height,
          x: r.left, y: r.top,
          toJSON() { return this; },
        } as DOMRect;
      },
    } : null,
  };
  return fr;
}

function asWindow(f: FakeFrame): Window {
  // Wrap with property-getter traps so `parentThrows` / `parentDimsThrow`
  // can simulate the SecurityError that browsers throw on cross-origin
  // boundary access.
  return new Proxy(f as unknown as Window, {
    get(target, prop) {
      if (prop === 'parent') {
        if (f.parentThrows) throw new Error('SecurityError: cross-origin');
        if (f.parentDimsThrow) {
          // Return a parent whose innerWidth/innerHeight access throws.
          const realParent = f.parent;
          return new Proxy(realParent as unknown as Window, {
            get(_t, p) {
              if (p === 'innerWidth' || p === 'innerHeight') {
                throw new Error('SecurityError: cross-origin');
              }
              return (realParent as unknown as Record<string | symbol, unknown>)[p as string];
            },
          });
        }
        return f.parent;
      }
      return (target as unknown as Record<string | symbol, unknown>)[prop as string];
    },
  });
}

describe('isAncestorChainInVisibleViewport', () => {
  it('returns true in the top frame (no ancestors)', () => {
    const top: FakeFrame = {
      parent: undefined as unknown as FakeFrame,
      frameElement: null,
      innerWidth: 1000,
      innerHeight: 800,
    };
    top.parent = top;
    expect(isAncestorChainInVisibleViewport(asWindow(top))).toBe(true);
  });

  it('returns true when an iframe element is visible in parent viewport', () => {
    const child = fakeFrame({
      inParentRect: { top: 100, left: 100, width: 300, height: 200 },
    });
    expect(isAncestorChainInVisibleViewport(asWindow(child))).toBe(true);
  });

  it('returns false when the iframe element is off-screen below the parent viewport', () => {
    const child = fakeFrame({
      inParentRect: { top: 1000, left: 100, width: 300, height: 200 },  // parent vh=800
    });
    expect(isAncestorChainInVisibleViewport(asWindow(child))).toBe(false);
  });

  it('returns false when the iframe element is off-screen above', () => {
    const child = fakeFrame({
      inParentRect: { top: -500, left: 100, width: 300, height: 200 },
    });
    expect(isAncestorChainInVisibleViewport(asWindow(child))).toBe(false);
  });

  it('returns false when the iframe element is off-screen to the right', () => {
    const child = fakeFrame({
      inParentRect: { top: 100, left: 2000, width: 300, height: 200 },  // parent vw=1000
    });
    expect(isAncestorChainInVisibleViewport(asWindow(child))).toBe(false);
  });

  it('falls back to true when .parent access throws (cross-origin)', () => {
    const child = fakeFrame({
      inParentRect: { top: 100, left: 100, width: 300, height: 200 },
      parentThrows: true,
    });
    expect(isAncestorChainInVisibleViewport(asWindow(child))).toBe(true);
  });

  it('falls back to true when parent dimensions throw (cross-origin)', () => {
    const child = fakeFrame({
      inParentRect: { top: 100, left: 100, width: 300, height: 200 },
      parentDimsThrow: true,
    });
    expect(isAncestorChainInVisibleViewport(asWindow(child))).toBe(true);
  });

  it('walks multiple levels — all visible passes', () => {
    const grandparent: FakeFrame = {
      parent: undefined as unknown as FakeFrame,
      frameElement: null,
      innerWidth: 1000, innerHeight: 800,
    };
    grandparent.parent = grandparent;
    const middle = fakeFrame({
      inParentRect: { top: 50, left: 50, width: 500, height: 600 },
      parent: grandparent,
    });
    const inner = fakeFrame({
      inParentRect: { top: 100, left: 100, width: 200, height: 100 },
      parent: middle,
    });
    expect(isAncestorChainInVisibleViewport(asWindow(inner))).toBe(true);
  });

  it('walks multiple levels — any ancestor off-screen short-circuits to false', () => {
    const grandparent: FakeFrame = {
      parent: undefined as unknown as FakeFrame,
      frameElement: null,
      innerWidth: 1000, innerHeight: 800,
    };
    grandparent.parent = grandparent;
    // Middle is off-screen in grandparent.
    const middle = fakeFrame({
      inParentRect: { top: 2000, left: 50, width: 500, height: 600 },
      parent: grandparent,
    });
    // Inner is in-viewport relative to middle, but middle isn't visible.
    const inner = fakeFrame({
      inParentRect: { top: 100, left: 100, width: 200, height: 100 },
      parent: middle,
    });
    expect(isAncestorChainInVisibleViewport(asWindow(inner))).toBe(false);
  });
});

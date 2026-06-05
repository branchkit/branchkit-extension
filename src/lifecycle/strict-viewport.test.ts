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
import { collectStrictViewportDelta, stampStrictViewport } from './strict-viewport';

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

  it('is a no-op on an empty list (the hot scan-empty-batch path)', () => {
    expect(() => stampStrictViewport([])).not.toThrow();
  });
});

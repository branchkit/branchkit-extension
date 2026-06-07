import { describe, it, expect } from 'vitest';
import { isRectOnScreen } from './layout-cache';

const rect = (x: number, y: number, w: number, h: number): DOMRect =>
  ({ x, y, width: w, height: h, left: x, top: y, right: x + w, bottom: y + h } as DOMRect);

describe('isRectOnScreen', () => {
  const vw = 1280, vh = 800;

  it('accepts a rect fully inside the viewport', () => {
    expect(isRectOnScreen(rect(100, 100, 200, 40), vw, vh)).toBe(true);
  });

  it('accepts a rect partially on-screen (straddling an edge)', () => {
    expect(isRectOnScreen(rect(-50, 100, 200, 40), vw, vh)).toBe(true);
  });

  it('rejects YouTube\'s collapsed nav drawer parked off the left edge', () => {
    // Home/Shorts/etc. sit at x=-228, w=204 → right edge at -24, fully off-screen
    // but within the 200px IO margin, so isInViewport is true. Must not paint.
    expect(isRectOnScreen(rect(-228, 68, 204, 40), vw, vh)).toBe(false);
  });

  it('rejects rects off each edge', () => {
    expect(isRectOnScreen(rect(0, -100, 100, 40), vw, vh)).toBe(false);  // above
    expect(isRectOnScreen(rect(0, vh + 10, 100, 40), vw, vh)).toBe(false); // below
    expect(isRectOnScreen(rect(vw + 10, 0, 100, 40), vw, vh)).toBe(false); // right
    expect(isRectOnScreen(rect(-200, 0, 100, 40), vw, vh)).toBe(false);   // left
  });

  it('treats a zero-area rect flush at the origin as off-screen', () => {
    // The disconnected-element {0,0,0,0} sentinel — right/bottom are 0, not >0.
    expect(isRectOnScreen(rect(0, 0, 0, 0), vw, vh)).toBe(false);
  });
});

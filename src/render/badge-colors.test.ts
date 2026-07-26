/**
 * BranchKit Browser — adaptive badge color tests.
 *
 * Pins the color-reference resolution: badge text color is sampled from
 * the element the user actually sees (first visible text node's parent),
 * not the hintable container. QuickBase's table sidebar is the motivating
 * case — the <a> is styled blue while the visible span is near-black, and
 * sampling the anchor painted blue badges that matched nothing on screen.
 *
 * Run: npm test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  computeBadgeColors, computeTintedBadgeColors, clearContrastCache, __apcaBetween,
} from './badge-colors';
import { clearLayoutCache } from '../core/layout-cache';

function rgb(css: string): { r: number; g: number; b: number } {
  const m = css.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/)!;
  return { r: +m[1], g: +m[2], b: +m[3] };
}

// happy-dom has no layout; give every element a real box so the sr-only
// (sub-3px) skip in the color-reference walk doesn't reject text parents.
const originalGetRect = Element.prototype.getBoundingClientRect;

beforeEach(() => {
  document.body.innerHTML = '';
  clearLayoutCache();
  clearContrastCache();
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

describe('computeBadgeColors — color reference resolution', () => {
  it('samples the visible text color, not the container color (QuickBase sidebar)', () => {
    document.body.innerHTML =
      '<a id="t" href="#" style="color: rgb(0, 82, 204)">' +
      '<span style="color: rgb(33, 33, 33)">Companies</span></a>';
    const colors = computeBadgeColors(document.getElementById('t')!);
    const fg = rgb(colors.fg);
    // Near-black stays achromatic through the contrast adjustment; the
    // anchor's blue would leave b far above r.
    expect(Math.abs(fg.b - fg.r)).toBeLessThan(30);
  });

  it('falls back to the target color when the text is a direct child', () => {
    document.body.innerHTML =
      '<a id="t" href="#" style="color: rgb(180, 0, 0)">Read more</a>';
    const colors = computeBadgeColors(document.getElementById('t')!);
    const fg = rgb(colors.fg);
    // Hue is preserved by the oklch lightness adjustment — still red-dominant.
    expect(fg.r).toBeGreaterThan(fg.b);
  });

  it('skips whitespace-only text nodes when resolving the reference', () => {
    document.body.innerHTML =
      '<a id="t" href="#" style="color: rgb(0, 82, 204)">  ' +
      '<span style="color: rgb(33, 33, 33)">Sites</span></a>';
    const colors = computeBadgeColors(document.getElementById('t')!);
    const fg = rgb(colors.fg);
    expect(Math.abs(fg.b - fg.r)).toBeLessThan(30);
  });
});

describe('computeTintedBadgeColors — a highlighter, not a brand colour', () => {
  // The tint is a MEANING (search-match yellow), so it must not shift with the
  // page: solving its lightness the way the foreground is solved would keep the
  // hue angle and destroy the identity — yellow darkened enough to contrast
  // with white paper is olive. Legibility rides the ink and the rim instead.
  // Assertions are APCA contrast, not colour values, so retinting doesn't churn.
  const TINT = '#ffeb3b';
  const MIN_CONTRAST = 55;
  const EDGE_CONTRAST = 15; // a rim only has to be SEEN, not read

  function badgeOn(pageBg: string) {
    document.body.innerHTML = `<div style="background-color: ${pageBg}"><a id="t">link</a></div>`;
    const el = document.getElementById('t')!;
    return computeTintedBadgeColors(el, TINT);
  }

  it('wears the tint unchanged on every page — that is the identity', () => {
    for (const page of ['rgb(0,0,0)', 'rgb(255,255,255)', 'rgb(17,17,17)', 'rgb(253,246,227)']) {
      expect(rgb(badgeOn(page).bg)).toEqual({ r: 255, g: 235, b: 59 });
    }
  });

  it('keeps its label readable on the tint', () => {
    for (const page of ['rgb(0,0,0)', 'rgb(255,255,255)', 'rgb(17,17,17)']) {
      const c = badgeOn(page);
      expect(__apcaBetween(c.fg, c.bg)).toBeGreaterThan(MIN_CONTRAST);
    }
  });

  it('draws an edge on white paper, where the fill alone has none', () => {
    const c = badgeOn('rgb(255,255,255)');
    // The whole point: yellow on white is nearly edgeless, so the rim carries it.
    expect(__apcaBetween(c.bg, 'rgb(255,255,255)')).toBeLessThan(EDGE_CONTRAST);
    expect(__apcaBetween(c.border, 'rgb(255,255,255)')).toBeGreaterThan(MIN_CONTRAST);
  });

  it('draws an edge on a page that shares the tint', () => {
    // The case a fixed colour cannot survive on its own.
    const c = badgeOn('rgb(255,235,59)');
    expect(__apcaBetween(c.border, 'rgb(255,235,59)')).toBeGreaterThan(EDGE_CONTRAST);
  });

  it('is distinguishable from a hint badge on the same page', () => {
    // Hints fill with the page background; a tinted badge never does.
    for (const page of ['rgb(17,17,17)', 'rgb(255,255,255)']) {
      document.body.innerHTML = `<div style="background-color: ${page}"><a id="t">link</a></div>`;
      const el = document.getElementById('t')!;
      expect(rgb(computeBadgeColors(el).bg)).not.toEqual(rgb(computeTintedBadgeColors(el, TINT).bg));
    }
  });
});

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
  computeBadgeColors, computeAccentBadgeColors, clearContrastCache, __apcaBetween,
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

describe('computeAccentBadgeColors — distinct AND legible on any page', () => {
  // A fixed brand color fails exactly when it matters: a dark chip on a dark
  // page, or an accent matching the site's own palette, is invisible. The hue
  // is fixed; the lightness is solved per page. These assert LEGIBILITY (APCA
  // contrast), not color values, so tuning the accent doesn't churn the tests.
  const ACCENT = '#7c5cff';
  // The same floor computeBadgeColors' own adjustment targets.
  const MIN_CONTRAST = 55;

  function badgeOn(pageBg: string) {
    document.body.innerHTML = `<div style="background-color: ${pageBg}"><a id="t">link</a></div>`;
    const el = document.getElementById('t')!;
    return computeAccentBadgeColors(el, ACCENT);
  }

  it('separates from a black page', () => {
    const c = badgeOn('rgb(0, 0, 0)');
    expect(__apcaBetween(c.bg, 'rgb(0,0,0)')).toBeGreaterThan(MIN_CONTRAST);
    expect(__apcaBetween(c.fg, c.bg)).toBeGreaterThan(MIN_CONTRAST);
  });

  it('separates from a white page', () => {
    const c = badgeOn('rgb(255, 255, 255)');
    expect(__apcaBetween(c.bg, 'rgb(255,255,255)')).toBeGreaterThan(MIN_CONTRAST);
    expect(__apcaBetween(c.fg, c.bg)).toBeGreaterThan(MIN_CONTRAST);
  });

  it('separates from a page whose background IS the accent', () => {
    // The case a fixed color cannot survive.
    const c = badgeOn('rgb(124, 92, 255)');
    expect(__apcaBetween(c.bg, 'rgb(124,92,255)')).toBeGreaterThan(MIN_CONTRAST);
    expect(__apcaBetween(c.fg, c.bg)).toBeGreaterThan(MIN_CONTRAST);
  });

  it('keeps the accent hue rather than collapsing to grey', () => {
    // The hue is what says "search"; a solve that flattened it to black/white
    // would be legible and useless.
    for (const page of ['rgb(0,0,0)', 'rgb(255,255,255)', 'rgb(20,20,24)']) {
      const { r, g, b } = rgb(badgeOn(page).bg);
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      expect(spread).toBeGreaterThan(20);
    }
  });

  it('is visually distinct from a hint badge on the same page', () => {
    // Hints fill with the page background; an accent badge must not.
    document.body.innerHTML = '<div style="background-color: rgb(17,17,17)"><a id="t">link</a></div>';
    const el = document.getElementById('t')!;
    const hint = computeBadgeColors(el);
    const search = computeAccentBadgeColors(el, ACCENT);
    expect(__apcaBetween(search.bg, hint.bg)).toBeGreaterThan(MIN_CONTRAST);
  });
});

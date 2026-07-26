/**
 * Adaptive badge colors — APCA contrast pipeline.
 *
 * Resolves the page background behind a badge, then ensures three
 * contrast relationships:
 *   1. Badge fill vs page background (badge is visible as a shape)
 *   2. Badge text vs badge fill (label is readable)
 *   3. Category border vs page background (category signal reads)
 *
 * Uses APCA (Accessible Perceptual Contrast Algorithm) via apca-w3 for
 * perceptually accurate contrast measurement, and oklch lightness
 * adjustment when a color doesn't meet threshold. Adapted from Rango's
 * color pipeline.
 */

import { APCAcontrast, sRGBtoY } from 'apca-w3';
import { getCachedStyle, getCachedRect } from '../core/layout-cache';

// --- RGB type and parsing ---

export type RGB = { r: number; g: number; b: number; a: number };

const WHITE: RGB = { r: 255, g: 255, b: 255, a: 1 };
const BLACK: RGB = { r: 0, g: 0, b: 0, a: 1 };

function parseColor(str: string): RGB | null {
  if (!str || str === 'transparent' || str === 'rgba(0, 0, 0, 0)') return null;
  const m = str.match(/rgba?\(\s*([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)/);
  if (!m) return null;
  return {
    r: parseFloat(m[1]),
    g: parseFloat(m[2]),
    b: parseFloat(m[3]),
    a: m[4] !== undefined ? parseFloat(m[4]) : 1,
  };
}

export function parseHexColor(hex: string): RGB {
  hex = hex.replace('#', '');
  if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
    a: 1,
  };
}

// --- Alpha compositing ---

function compositeOver(fg: RGB, bg: RGB): RGB {
  const a = fg.a + bg.a * (1 - fg.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (fg.r * fg.a + bg.r * bg.a * (1 - fg.a)) / a,
    g: (fg.g * fg.a + bg.g * bg.a * (1 - fg.a)) / a,
    b: (fg.b * fg.a + bg.b * bg.a * (1 - fg.a)) / a,
    a,
  };
}

// --- Background resolution ---

function extractGradientColor(bgImage: string): RGB | null {
  const m = bgImage.match(/(?:rgb|rgba)\s*\([^)]+\)/);
  if (!m) return null;
  return parseColor(m[0]);
}

export function resolveBackgroundColor(el: Element): RGB {
  const layers: RGB[] = [];
  let current: Element | null = el;

  while (current) {
    // Cache-aware: this walk runs once per badge CONSTRUCTION and climbs
    // until it finds an opaque background — many transparent levels on
    // table-shaped DOM (tr → tbody → table → pane wrappers). The build pass
    // pre-warms the shared ancestor chain (content.ts cacheVisibility), so
    // sibling rows' badges reuse one read instead of N live walks — the
    // dominant per-badge construction cost on deep production DOM
    // (QuickBase fling profile, 2026-07-03).
    const style = getCachedStyle(current);
    let parsed = parseColor(style.backgroundColor);

    if (!parsed && style.backgroundImage?.includes('gradient(')) {
      parsed = extractGradientColor(style.backgroundImage);
    }

    if (parsed) {
      layers.push(parsed);
      if (parsed.a >= 1) break;
    }
    current = current.parentElement;
  }

  if (!layers.length || layers[layers.length - 1].a < 1) {
    layers.push(WHITE);
  }

  let result = layers[layers.length - 1];
  for (let i = layers.length - 2; i >= 0; i--) {
    result = compositeOver(layers[i], result);
  }
  return result;
}

// --- APCA contrast ---

const CONTRAST_THRESHOLD = 60;

function apcaContrast(fg: RGB, bg: RGB): number {
  return APCAcontrast(
    sRGBtoY([fg.r, fg.g, fg.b]),
    sRGBtoY([bg.r, bg.g, bg.b]),
  );
}

function isLightBackground(bg: RGB): boolean {
  return Math.abs(apcaContrast(BLACK, bg)) > Math.abs(apcaContrast(WHITE, bg));
}

// --- oklch conversion for lightness adjustment ---

function srgbToLinear(c: number): number {
  c /= 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function linearToSrgb(c: number): number {
  c = Math.max(0, Math.min(1, c));
  return Math.round((c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055) * 255);
}

function rgbToOklch(color: RGB): { l: number; c: number; h: number } {
  const r = srgbToLinear(color.r);
  const g = srgbToLinear(color.g);
  const b = srgbToLinear(color.b);

  const l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

  const l1 = Math.cbrt(l_);
  const m1 = Math.cbrt(m_);
  const s1 = Math.cbrt(s_);

  const L = 0.2104542553 * l1 + 0.7936177850 * m1 - 0.0040720468 * s1;
  const a = 1.9779984951 * l1 - 2.4285922050 * m1 + 0.4505937099 * s1;
  const bOk = 0.0259040371 * l1 + 0.7827717662 * m1 - 0.8086757660 * s1;

  const C = Math.sqrt(a * a + bOk * bOk);
  const h = Math.atan2(bOk, a);

  return { l: L, c: C, h };
}

function oklchToRgb(l: number, c: number, h: number): RGB {
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);

  const l1 = l + 0.3963377774 * a + 0.2158037573 * b;
  const m1 = l - 0.1055613458 * a - 0.0638541728 * b;
  const s1 = l - 0.0894841775 * a - 1.2914855480 * b;

  const l_ = l1 * l1 * l1;
  const m_ = m1 * m1 * m1;
  const s_ = s1 * s1 * s1;

  const r = +4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_;
  const g = -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_;
  const bOut = -0.0041960863 * l_ - 0.7034186147 * m_ + 1.7076147010 * s_;

  return {
    r: linearToSrgb(r),
    g: linearToSrgb(g),
    b: linearToSrgb(bOut),
    a: 1,
  };
}

// --- Lightness adjustment via binary search ---

const contrastCache = new Map<string, RGB>();

function adjustForContrast(fg: RGB, bg: RGB): RGB {
  const key = `${fg.r},${fg.g},${fg.b}:${bg.r},${bg.g},${bg.b}`;
  const cached = contrastCache.get(key);
  if (cached) return cached;

  const initial = Math.abs(apcaContrast(fg, bg));
  if (initial >= CONTRAST_THRESHOLD) {
    contrastCache.set(key, fg);
    return fg;
  }

  const { c, h } = rgbToOklch(fg);
  const bgIsLight = isLightBackground(bg);
  const extremeL = bgIsLight ? 0 : 1;

  const extreme = oklchToRgb(extremeL, c, h);
  if (Math.abs(apcaContrast(extreme, bg)) < CONTRAST_THRESHOLD) {
    contrastCache.set(key, extreme);
    return extreme;
  }

  let low = rgbToOklch(bg).l;
  let high = extremeL;

  for (let i = 0; i < 10; i++) {
    const mid = (low + high) / 2;
    const test = oklchToRgb(mid, c, h);
    const contrast = Math.abs(apcaContrast(test, bg));

    if (contrast >= CONTRAST_THRESHOLD && contrast < CONTRAST_THRESHOLD + 5) {
      contrastCache.set(key, test);
      return test;
    }

    if (contrast >= CONTRAST_THRESHOLD) {
      high = mid;
    } else {
      low = mid;
    }
  }

  const result = oklchToRgb(high, c, h);
  contrastCache.set(key, result);
  return result;
}

// --- Public API ---

export type BadgeColors = {
  bg: string;
  fg: string;
  border: string;
  /** The border color's "R G B" components (no alpha), so the render layer can
   *  vary the border's opacity — e.g. boost it to fully opaque in keyboard
   *  mode — without recomputing the color. Same hue as `fg`/`border`. */
  borderRgb: string;
};

function toCSS(c: RGB, alpha?: number): string {
  if (alpha !== undefined) {
    return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${alpha})`;
  }
  return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
}

/**
 * The element whose computed color the user actually SEES. The hintable
 * target is often a container — a sidebar <a> whose CSS `color` is blue
 * while the visible text inside is a span re-styled black (QuickBase's
 * table list). Sampling the container painted badge text in a color that
 * appears nowhere on screen. Mirrors Rango's reference-element semantics,
 * simplified: first visible text node's parent wins, an icon-ish
 * descendant covers text-free targets, the target itself is the fallback.
 * Form controls answer for themselves (their own color IS the visible
 * text color).
 */
function resolveColorReference(target: Element): Element {
  if (target instanceof HTMLInputElement ||
      target instanceof HTMLTextAreaElement ||
      target instanceof HTMLSelectElement ||
      target instanceof HTMLOptionElement) {
    return target;
  }
  const walker = document.createTreeWalker(target, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (!node.textContent || !/\S/.test(node.textContent)) continue;
    const parent = node.parentElement;
    if (!parent) continue;
    // Skip sr-only / visually-hidden text (1px clip technique).
    const rect = getCachedRect(parent);
    if (rect.width < 3 && rect.height < 3) continue;
    return parent;
  }
  return target.querySelector('svg, img') ?? target;
}

function getElementForegroundColor(target: Element): RGB {
  if (target instanceof SVGElement) {
    const stroke = target.getAttribute('stroke');
    if (stroke && stroke !== 'none') {
      const parsed = parseColor(stroke) || parseHexColor(stroke);
      if (parsed) return parsed;
    }
    const fill = target.getAttribute('fill');
    if (fill && fill !== 'none') {
      const parsed = parseColor(fill) || parseHexColor(fill);
      if (parsed) return parsed;
    }
  }
  const style = getCachedStyle(target);
  return parseColor(style.color) || BLACK;
}

/**
 * Compute adaptive badge colors for an element.
 *
 * Matches Rango's approach: resolves page background, uses it as badge
 * fill, adjusts element's text color for contrast as badge foreground,
 * and uses foreground at 0.3 alpha as border.
 */
export function computeBadgeColors(target: Element): BadgeColors {
  const pageBg = resolveBackgroundColor(target);

  const elementFg = getElementForegroundColor(resolveColorReference(target));
  const compositedFg = compositeOver(elementFg, pageBg);
  const adjustedFg = adjustForContrast(compositedFg, pageBg);

  return {
    bg: toCSS(pageBg),
    fg: toCSS(adjustedFg),
    border: toCSS(adjustedFg, 0.3),
    borderRgb: `${Math.round(adjustedFg.r)} ${Math.round(adjustedFg.g)} ${Math.round(adjustedFg.b)}`,
  };
}

/**
 * Colors for a badge that wears a MEANING — a search-match badge tinted with
 * the same highlighter yellow its match is painted in. Shown alongside the
 * page's link hints, it has no mode to lean on, so the colour is the only
 * thing saying "this one is a search hit".
 *
 * The hint path can't do this job by construction: it fills with the page's own
 * background, which is exactly what makes it read as native to everything.
 *
 * The obvious fix — a fixed colour — is what the user pushed back on, rightly:
 * a chip that happens to match the site's palette is invisible precisely when
 * it matters. The obvious fix to THAT — solve the tint's lightness per page,
 * as an earlier cut did — is wrong for a semantic colour. Yellow only reads as
 * yellow in a narrow lightness band; darkened enough to contrast with white
 * paper it becomes olive, and an olive badge no longer says "highlighter".
 * Solving lightness preserves the hue angle while destroying the identity.
 *
 * So this works the way a physical highlighter does. The FILL is the tint,
 * unconditionally — that is the thing being recognised, and highlighters do not
 * change colour with the paper. Legibility is carried by the two channels where
 * adaptation costs nothing:
 *
 *   - the INK is black or white by whichever reads on the tint, then
 *     contrast-adjusted against the FILL (what it actually sits on, not the
 *     page);
 *   - the RIM is the tint's own hue, lightness-solved against the PAGE. On
 *     white paper a yellow chip has almost no edge, so the rim becomes deep
 *     amber and draws it; on a dark page the fill already shouts and the rim
 *     quietly agrees. On a page that shares the tint, the rim is the only thing
 *     separating them, which is exactly what it is there for.
 *
 * Net: the badge is the same colour everywhere (learnable), always readable,
 * and always has an edge.
 */
export function computeTintedBadgeColors(target: Element, tintHex: string): BadgeColors {
  const pageBg = resolveBackgroundColor(target);
  const fill = parseHexColor(tintHex);
  const ink = adjustForContrast(isLightBackground(fill) ? BLACK : WHITE, fill);
  // Same hue as the fill, moved in lightness until it separates from the page.
  const rim = adjustForContrast(fill, pageBg);

  return {
    bg: toCSS(fill),
    fg: toCSS(ink),
    border: toCSS(rim),
    // Full-strength rim: unlike a hint badge, whose faint border is a category
    // cue on a page-coloured fill, this one is load-bearing — it is what gives
    // the chip an edge on paper that shares its colour. Keyboard mode's alpha
    // boost still rides --bk-b-rgb and simply has nothing left to boost.
    borderRgb: `${Math.round(rim.r)} ${Math.round(rim.g)} ${Math.round(rim.b)}`,
  };
}

export function clearContrastCache(): void {
  contrastCache.clear();
}

/** Test seam: APCA contrast between two CSS rgb() strings, so tests can assert
 *  legibility instead of pinning color values that any tuning would churn. */
export function __apcaBetween(a: string, b: string): number {
  const pa = parseColor(a);
  const pb = parseColor(b);
  if (!pa || !pb) return 0;
  return Math.abs(apcaContrast(pa, pb));
}

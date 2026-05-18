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
    const style = getComputedStyle(current);
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
  let currentL = rgbToOklch(fg).l;

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
    currentL = mid;
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
};

function toCSS(c: RGB, alpha?: number): string {
  if (alpha !== undefined) {
    return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${alpha})`;
  }
  return `rgb(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)})`;
}

/**
 * Compute adaptive badge colors for an element given its category border color.
 *
 * 1. Resolves page background behind the target
 * 2. Picks light or dark badge fill to contrast with page
 * 3. Picks text color to contrast with badge fill
 * 4. Adjusts category border color to contrast with page background
 */
export function computeBadgeColors(target: Element, categoryBorderHex: string): BadgeColors {
  const pageBg = resolveBackgroundColor(target);
  const bgIsLight = isLightBackground(pageBg);

  const badgeFill: RGB = bgIsLight
    ? { r: 255, g: 255, b: 255, a: 1 }
    : { r: 30, g: 30, b: 30, a: 1 };

  const textColor: RGB = bgIsLight
    ? { r: 26, g: 26, b: 26, a: 1 }
    : { r: 240, g: 240, b: 240, a: 1 };

  const categoryColor = parseHexColor(categoryBorderHex);
  const adjustedBorder = adjustForContrast(categoryColor, pageBg);

  return {
    bg: toCSS(badgeFill, 0.92),
    fg: toCSS(textColor),
    border: toCSS(adjustedBorder),
  };
}

export function clearContrastCache(): void {
  contrastCache.clear();
}

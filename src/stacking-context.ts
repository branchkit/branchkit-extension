/**
 * Stacking context detection and z-index calculation.
 *
 * Adapted from Rango's createsStackingContext.ts and Hint.ts.
 * Used to compute a per-badge z-index that renders above sibling
 * stacking contexts (transforms, filters, opacity < 1, will-change)
 * instead of relying on a hardcoded max z-index.
 */

import { getCachedStyle } from './layout-cache';

const SC_PROPERTIES =
  /\b(?:position|zIndex|opacity|mixBlendMode|transform|filter|backdrop-filter|perspective|clip-path|mask|mask-image|mask-border|isolation)\b/;

function isFlexOrGridChild(el: Element): boolean {
  const parent = el.parentNode;
  if (!(parent instanceof Element)) return false;
  const d = getCachedStyle(parent).display;
  return (
    d === 'flex' || d === 'inline-flex' ||
    d === '-webkit-box' || d === '-webkit-flex' || d === '-ms-flexbox' ||
    d === 'grid' || d === 'inline-grid'
  );
}

export function createsStackingContext(el: Element): boolean {
  if (el === document.documentElement) return true;

  const s = getCachedStyle(el);

  if (s.zIndex !== 'auto' && (s.position !== 'static' || isFlexOrGridChild(el))) {
    return true;
  }

  if (s.position === 'fixed' || s.position === 'sticky') return true;
  if (Number(s.opacity) < 1) return true;
  if (s.mixBlendMode !== 'normal') return true;
  if (s.transform !== 'none') return true;
  if (s.filter !== 'none') return true;

  const bd = s.getPropertyValue('backdrop-filter');
  if (bd && bd !== 'none') return true;

  if (s.perspective !== 'none') return true;
  if (s.clipPath !== 'none') return true;

  const mask = s.getPropertyValue('mask');
  if (mask && mask !== 'none') return true;
  const maskImage = s.getPropertyValue('mask-image');
  if (maskImage && maskImage !== 'none') return true;
  const maskBorder = s.getPropertyValue('mask-border');
  if (maskBorder && maskBorder !== 'none') return true;

  if (s.isolation === 'isolate') return true;
  if (SC_PROPERTIES.test(s.willChange)) return true;

  return false;
}

/**
 * Calculate the z-index a badge needs to render above all stacking
 * contexts within `target` and respect ancestor context boundaries.
 *
 * Walks descendants for the max z-index among stacking contexts, then
 * walks ancestors — resetting at each new stacking context boundary —
 * so the badge sits above siblings in the nearest context.
 *
 * Returns max + 5 as a safety buffer for hover-triggered z-index bumps.
 */
export function calculateZIndex(target: Element, badgeHost: Element): number {
  let zIndex = 0;

  for (const desc of target.querySelectorAll('*')) {
    if (createsStackingContext(desc)) {
      const parsed = parseInt(getCachedStyle(desc).zIndex, 10);
      if (!isNaN(parsed) && parsed > zIndex) zIndex = parsed;
    }
  }

  let current: Element | null = target;
  while (current) {
    if (current.contains(badgeHost)) break;

    if (createsStackingContext(current)) {
      const parsed = parseInt(getCachedStyle(current).zIndex, 10);
      zIndex = isNaN(parsed) ? 0 : parsed;
    }

    current = current.parentElement;
  }

  return zIndex + 5;
}

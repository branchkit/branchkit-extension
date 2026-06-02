/**
 * Stacking-context detection + z-index calculation.
 *
 * Ported from Rango (`src/content/hints/positioning/createsStackingContext.ts`
 * and `Hint.ts:calculateZIndex`). Two fixes applied to the Rango source:
 *   1. The original checked `style.filter !== "none"` for several CSS
 *      properties (backdrop-filter, perspective, clip-path, mask, mask-image,
 *      mask-border) — a copy-paste bug that made those branches dead. Fixed
 *      so each property tests its own value.
 *   2. `isFlexOrGridChild` reads `parentElement` instead of `parentNode` for
 *      a typed Element source.
 *
 * Used to place each badge in its target's natural stacking context rather
 * than at the global maximum z-index. Result: modals/dropdowns with their
 * own stacking context naturally cover the badge instead of being covered.
 */

const willChangeProps =
  /\b(?:position|zIndex|opacity|mixBlendMode|transform|filter|backdrop-filter|perspective|clip-path|mask|mask-image|mask-border|isolation)\b/;

function isFlexOrGridChild(element: Element): boolean {
  const parent = element.parentElement;
  if (!parent) return false;
  const display = getComputedStyle(parent).display;
  return (
    display === 'flex' ||
    display === 'inline-flex' ||
    display === '-webkit-box' ||
    display === '-webkit-flex' ||
    display === '-ms-flexbox' ||
    display === 'grid' ||
    display === 'inline-grid'
  );
}

export function createsStackingContext(element: Element): boolean {
  // https://developer.mozilla.org/en-US/docs/Web/CSS/CSS_Positioning/Understanding_z_index/The_stacking_context
  if (element === document.documentElement) return true;

  const style = getComputedStyle(element);

  // Normalize-to-default for unset properties. Real browsers return
  // 'auto' for unset zIndex and 'static' for unset position; happy-dom
  // (used by our unit tests) returns ''. Treating '' as the default
  // makes the predicate work in both.
  const zIndex = style.zIndex || 'auto';
  const position = style.position || 'static';

  if (zIndex !== 'auto' && (position !== 'static' || isFlexOrGridChild(element))) {
    return true;
  }
  if (position === 'fixed' || position === 'sticky') return true;
  // parseFloat('') is NaN — falsy under Number.isFinite, so unset opacity
  // (which real browsers return as '1') skips this branch correctly in
  // both environments.
  const opacity = parseFloat(style.opacity);
  if (Number.isFinite(opacity) && opacity < 1) return true;
  if (style.mixBlendMode && style.mixBlendMode !== 'normal') return true;
  if (style.transform && style.transform !== 'none') return true;
  if (style.filter && style.filter !== 'none') return true;
  if (style.backdropFilter && style.backdropFilter !== 'none') return true;
  if (style.perspective && style.perspective !== 'none') return true;
  if (style.clipPath && style.clipPath !== 'none') return true;
  if (style.mask && style.mask !== 'none') return true;
  if (style.maskImage && style.maskImage !== 'none') return true;
  // `mask-border` is in the CSS spec but not yet in TS's CSSStyleDeclaration
  // typings — read via index signature.
  const maskBorder = (style as unknown as Record<string, string>)['mask-border'];
  if (maskBorder && maskBorder !== 'none') return true;
  if (style.isolation === 'isolate') return true;
  if (willChangeProps.test(style.willChange)) return true;

  return false;
}

/**
 * Z-index for a badge hosted near `target` and mounted under `hintMountNode`
 * (which may be `document.body` for the anchor-positioning path or a nested
 * ancestor for the fallback path).
 *
 * Algorithm (from Rango's Hint.ts:calculateZIndex):
 *   1. Take the max z-index among stacking-context descendants of `target`
 *      (so a chat-bubble floating on top of the target's icon doesn't bury
 *      the hint).
 *   2. Walk ancestors of `target` upward. For each one that creates a
 *      stacking context, OVERWRITE the running z-index with its value (not
 *      max). Stop when an ancestor contains the mount node — beyond that
 *      lies the badge's own context, whose z-indices are irrelevant to its
 *      relative position.
 *   3. Add 5 as a buffer — guards against sites that bump their z-index
 *      slightly after layout (Gmail's hover rows).
 *
 * The badge ends up "in" the target's natural stacking context. A modal in
 * a higher-z context naturally covers it; a chat-bubble in the same context
 * still sits below it.
 */
export function calculateZIndex(target: Element, hintMountNode: Node): number {
  let zIndex = 0;

  for (const descendant of target.querySelectorAll('*')) {
    if (createsStackingContext(descendant)) {
      const di = parseInt(getComputedStyle(descendant).zIndex, 10);
      if (!Number.isNaN(di)) zIndex = Math.max(zIndex, di);
    }
  }

  let current: Element | null = target;
  while (current) {
    if (current.contains(hintMountNode)) break;
    if (createsStackingContext(current)) {
      const ci = parseInt(getComputedStyle(current).zIndex, 10);
      zIndex = Number.isNaN(ci) ? 0 : ci;
    }
    current = current.parentElement;
  }

  return zIndex + 5;
}

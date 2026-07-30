/**
 * BranchKit Browser — palette selection movement (pure)
 * (notes/DESIGN_PALETTE_KEYBOARD_NAV.md).
 *
 * All of the index arithmetic for keyboard navigation lives here so the frame
 * only measures the DOM and renders — the same pure-core/glue split
 * classifyMarkInput, filterPalette and buildMarkerSequence already use.
 *
 * WRAP vs CLAMP is deliberate and mixed:
 *  - single-row steps WRAP, which is right on a short list (k from the first row
 *    reaches the last), and is the behaviour the arrow keys already have;
 *  - jumps CLAMP, because a half-screen move that teleports bottom-to-top is
 *    disorienting. Clamping also means a jump at the end lands exactly ON the
 *    end rather than no-oping, so repeated presses walk to the edge.
 */

import type { PaletteNavIntent } from '../keymap/palette-reserved';

/**
 * How far `d`/`u` move: HALF the rows currently in view, floored, at least one.
 *
 * "Half" is inherited from the command these keys are bound to
 * (`scroll_half_down`) rather than invented, so the key means the same thing in
 * the palette as it does on the page. Three-quarters was considered and rejected
 * on that basis. Flooring keeps the step strictly smaller than the viewport, so
 * you always land on a row that was already visible — a jump is never blind.
 *
 * Viewport-relative rather than a constant because #list is `max-height: 52vh`:
 * the row count genuinely varies with window height.
 */
export function paletteJumpStep(visibleRows: number): number {
  if (!Number.isFinite(visibleRows)) return 1;
  return Math.max(1, Math.floor(visibleRows / 2));
}

/**
 * The selection index after `intent`, given the current index, the list length
 * and how many rows are on screen. Out-of-range inputs are clamped rather than
 * thrown: the caller measures live DOM, which can disagree with `flat` for a
 * frame during teardown.
 */
export function applyNavIntent(
  intent: PaletteNavIntent,
  selected: number,
  count: number,
  visibleRows: number,
): number {
  if (count <= 0) return 0;
  const at = Math.min(Math.max(selected, 0), count - 1);
  const step = paletteJumpStep(visibleRows);
  const clamp = (i: number): number => Math.min(Math.max(i, 0), count - 1);
  switch (intent) {
    case 'next':
      return (at + 1) % count;
    case 'prev':
      return (at - 1 + count) % count;
    case 'pageNext':
      return clamp(at + step);
    case 'pagePrev':
      return clamp(at - step);
    case 'first':
      return 0;
    case 'last':
      return count - 1;
  }
}

/**
 * BranchKit Browser — the scroll commands' dispatcher bindings.
 *
 * Fourteen registrations lifted out of content.ts
 * (notes/DESIGN_ENTRY_POINT_TOPOLOGY.md phase 3b). They were inline for no
 * reason but that nobody moved them: every body is a call into `scroller.ts`
 * and closes over nothing the entry point owns.
 *
 * ## Why this is not part of `scroller.ts`
 *
 * `scroller.ts` imports nothing but a type. That makes it safe for `scan/find`
 * to depend on for the mechanism alone. Registering commands there would mean
 * importing `core/singletons` for the dispatcher, which drags the whole
 * dispatcher/keyboard/mode-chip closure into everything that wanted to scroll
 * an element — the same layering argument §6f made for the put queue. The
 * mechanism stays a leaf; the binding lives one layer up, here.
 */

import { dispatcher } from '../core/singletons';
import {
  scroll, scrollElement, scrollToPercent, scrollRegion, snapToElement,
  cycleScrollTarget, getCycleTarget, findScrollableRegions, setScrollTarget, resetCycleTarget,
  getDefaultScrollTarget, flashRegionHighlight,
  type ScrollDirection, type ScrollAmount, type ScrollRegion,
} from './scroller';
import { startRangePick, isRangePickPending, repositionPickChips } from './range-disambiguation';
import { flashToast } from '../render/toast';
import { bkLog } from '../debug/bk-log';

/**
 * Scroll whatever is currently in charge: the cycled target if the user picked
 * one, otherwise the page's default scroller.
 *
 * This rule was written out ten times inline, once per direction/amount pair.
 * It is one rule, and `scroll()`/`scrollElement()` take the same
 * `(direction, amount, count)` shape, so it collapses to a single delegate.
 * `count` defaults to 1 in both, which is what the six amount-only bindings
 * relied on.
 */
function scrollActive(direction: ScrollDirection, amount: ScrollAmount, count = 1): void {
  const target = getCycleTarget();
  if (target) scrollElement(target, direction, amount, count);
  else scroll(direction, amount, count);
}

/**
 * "scroll target(s)" — the badge-pick twin of cycling. Badge every scrollable
 * pane via the range-pick machinery (modal chips, exclusive codeword claim,
 * Escape cancels) and set whichever the user picks as the cycle target.
 *
 * Each chip's Range SELECTS the container element — its border box doesn't
 * move as content scrolls, so the chip sits on the pane's corner, and the
 * on-screen gate is intersection (bandOverhang 0), so a pane taller than the
 * viewport is still pickable. One region skips the question entirely.
 */
function startScrollTargetPick(): void {
  const regions = findScrollableRegions();
  // Which elements the pick admitted, greppable per field report ("why did
  // THAT get a chip / why didn't the table get one"): tag#id.class + rect +
  // overflow, enough to name an element without a live DOM.
  bkLog('BK_SCROLL_REGIONS', {
    regions: regions.slice(0, 20).map((el) => {
      const r = el.getBoundingClientRect();
      return {
        el: `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}`
          + (typeof el.className === 'string' && el.className
            ? '.' + el.className.split(/\s+/).slice(0, 2).join('.') : ''),
        rect: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)],
        overflow: getComputedStyle(el).overflowY,
      };
    }),
  });
  if (regions.length === 0) {
    flashToast('No scrollable panes found');
    return;
  }
  // A single region still asks (one chip): the first field test auto-set it,
  // and "sometimes chips, sometimes a silent flash" read as broken. Chips
  // every time is the predictable contract — pick it or Escape.
  const ranges = regions.map((el) => {
    const r = document.createRange();
    r.selectNode(el);
    return r;
  });
  // anchor 'icon': chips sit fully INSIDE the pane's corner — a pane flush
  // against a viewport edge would clip a text-nudged chip half off-screen
  // (field: QuickBase side panel). onEnd retires the pane overlays on every
  // exit; painted only if the pick actually armed (isRangePickPending), so
  // the not-armed fallback can't strand them.
  startRangePick(ranges, (range) => {
    const el = pickedElement(range);
    if (el === null) return;
    setScrollTarget(el);
    flashToast('Scroll target set');
  }, { anchor: 'icon', onEnd: clearPickOverlays });
  if (isRangePickPending()) paintPickOverlays(regions);
}

// --- Pane overlays: which area each chip stands for -------------------------
//
// A chip on a pane's corner says "pickable", not "pickable WHAT" (field:
// which region is this chip for?). While the pick is up, every candidate
// pane wears a transparent tint — the same blue the cycle/set flash uses, so
// one color consistently means "scroll area". The tints FOLLOW their panes:
// scrolling mid-pick (finding an off-screen chip is exactly when you scroll)
// left static rects hanging in space (field 2026-08-03). A capture-phase
// scroll listener — inner-pane scrolls don't bubble but do capture — plus
// resize, rAF-coalesced, re-reads live rects. Pick-scoped sensing: installed
// at paint, gone with the question (the onEnd contract), so it adds no
// page-lifetime observer. Tagged as our own UI so the page MutationObserver
// skips the nodes.

let pickOverlays: { el: HTMLElement; overlay: HTMLElement }[] = [];
let overlayRaf = 0;

function repositionPickOverlays(): void {
  overlayRaf = 0;
  for (const { el, overlay } of pickOverlays) {
    const r = el.getBoundingClientRect();
    const gone = !el.isConnected || (r.width === 0 && r.height === 0);
    overlay.style.display = gone ? 'none' : '';
    if (gone) continue;
    overlay.style.left = `${r.left}px`;
    overlay.style.top = `${r.top}px`;
    overlay.style.width = `${r.width}px`;
    overlay.style.height = `${r.height}px`;
  }
  // The chips bake their position at paint and the settle cadence that would
  // re-place them is quiet during a pick — move them on the same trigger as
  // the tints, or a mid-pick scroll strands them off their panes.
  repositionPickChips();
}

function scheduleOverlayReposition(): void {
  if (pickOverlays.length === 0 || overlayRaf !== 0) return;
  overlayRaf = requestAnimationFrame(repositionPickOverlays);
}

function paintPickOverlays(regions: HTMLElement[]): void {
  clearPickOverlays();
  for (const el of regions) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const o = document.createElement('div');
    o.setAttribute('data-branchkit-hint', '');
    o.style.cssText = `
      position: fixed; left: ${r.left}px; top: ${r.top}px;
      width: ${r.width}px; height: ${r.height}px;
      border: 2px solid rgba(0, 122, 255, 0.55);
      background: rgba(0, 122, 255, 0.08);
      border-radius: 4px; pointer-events: none;
      z-index: 2147483640;
    `;
    document.body.appendChild(o);
    pickOverlays.push({ el, overlay: o });
  }
  if (pickOverlays.length > 0) {
    document.addEventListener('scroll', scheduleOverlayReposition, { capture: true, passive: true });
    window.addEventListener('resize', scheduleOverlayReposition, { passive: true });
  }
}

function clearPickOverlays(): void {
  if (pickOverlays.length === 0) return;
  document.removeEventListener('scroll', scheduleOverlayReposition, { capture: true });
  window.removeEventListener('resize', scheduleOverlayReposition);
  if (overlayRaf !== 0) {
    cancelAnimationFrame(overlayRaf);
    overlayRaf = 0;
  }
  for (const { overlay } of pickOverlays) overlay.remove();
  pickOverlays = [];
}

/** The element a `selectNode` Range names: the child at its start boundary. */
function pickedElement(range: Range): HTMLElement | null {
  const el = range.startContainer.childNodes[range.startOffset];
  if (el instanceof HTMLElement) return el;
  return range.commonAncestorContainer instanceof HTMLElement
    ? range.commonAncestorContainer : null;
}

const countOf = (params: Record<string, string>): number =>
  parseInt(params.count || '1', 10) || 1;

export function registerScrollCommands(): void {
  dispatcher.register('scroll_down', (p) => scrollActive('down', 'step', countOf(p)));
  dispatcher.register('scroll_up', (p) => scrollActive('up', 'step', countOf(p)));

  dispatcher.register('scroll_half_down', () => scrollActive('down', 'half'));
  dispatcher.register('scroll_half_up', () => scrollActive('up', 'half'));
  dispatcher.register('scroll_full_down', () => scrollActive('down', 'full'));
  dispatcher.register('scroll_full_up', () => scrollActive('up', 'full'));
  dispatcher.register('scroll_top', () => scrollActive('up', 'top'));
  dispatcher.register('scroll_bottom', () => scrollActive('down', 'bottom'));
  dispatcher.register('scroll_left', () => scrollActive('left', 'step'));
  dispatcher.register('scroll_right', () => scrollActive('right', 'step'));

  dispatcher.register('cycle_scroll_target', () => { cycleScrollTarget(); });
  dispatcher.register('scroll_target_pick', () => { startScrollTargetPick(); });
  // The way back: without this, a picked pane owns the scroll keys until a
  // find commit happens to reset it — there was no deliberate exit. The flash
  // outlines the scroller "the page" resolves to RIGHT NOW (on app-shell
  // pages that's the geometric main pane, not the root), so releasing shows
  // where scrolling went — the same blue the pick and cycle flashes use.
  dispatcher.register('scroll_target_reset', () => {
    resetCycleTarget();
    flashRegionHighlight(getDefaultScrollTarget('y'));
    flashToast('Scrolling the page');
  });

  // The generic voice form. NOTE: unlike the ten above, this one does NOT
  // consult the cycle target — it scrolls a named region or the page. That
  // asymmetry arrived with the region parameter and is preserved here rather
  // than quietly unified; changing it changes what "scroll down" does after
  // the user has cycled a target, which is a product call, not a refactor.
  dispatcher.register('scroll', (p) => {
    const direction = (p.direction || 'down') as ScrollDirection;
    const amount = (p.amount || 'step') as ScrollAmount;
    const count = countOf(p);
    const region = p.region as ScrollRegion | undefined;

    if (region) scrollRegion(region, direction, amount, count);
    else scroll(direction, amount, count);
  });

  dispatcher.register('scroll_to_percent', (p) => {
    scrollToPercent(parseInt(p.percent || '50', 10));
  });

  dispatcher.register('scroll_to_element', (p) => {
    const position = (p.position || 'top') as 'top' | 'center' | 'bottom';
    if (!p.selector) return;
    const el = document.querySelector(p.selector);
    if (el) snapToElement(el, position);
  });
}

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
  type ScrollDirection, type ScrollAmount, type ScrollRegion,
} from './scroller';
import { startRangePick } from './range-disambiguation';
import { flashToast } from '../render/toast';

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
  // (field: QuickBase side panel).
  startRangePick(ranges, (range) => {
    const el = pickedElement(range);
    if (el === null) return;
    setScrollTarget(el);
    flashToast('Scroll target set');
  }, { anchor: 'icon' });
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
  // find commit happens to reset it — there was no deliberate exit.
  dispatcher.register('scroll_target_reset', () => {
    resetCycleTarget();
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

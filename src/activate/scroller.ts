/**
 * BranchKit Browser — Scroll system.
 *
 * Container detection (Surfingkeys' test-scroll with event suppression),
 * smooth scroll animator (RAF with key-hold friction, reduced-motion),
 * per-region named scrolling (Rango's geometric detection).
 */

// --- Scrollable container detection ---

let suppressScrollEvent = 0;

/**
 * Test whether an element is actually scrollable along an axis.
 * CSS check first, then verify by attempting a scroll and reverting.
 * Uses Surfingkeys' full-height probe + event suppression.
 */
export function isScrollableElement(el: HTMLElement, dir: 'x' | 'y'): boolean {
  const overflowProp = dir === 'y' ? 'overflowY' : 'overflowX';
  const overflow = getComputedStyle(el)[overflowProp];
  if (!/auto|scroll|overlay/.test(overflow)) {
    // document.documentElement and document.body are special: they may
    // scroll even without explicit overflow (the viewport is the scroller).
    if (el !== document.documentElement && el !== document.body) return false;
  }

  const scrollProp = dir === 'y' ? 'scrollTop' : 'scrollLeft';
  const sizeProp = dir === 'y' ? 'clientHeight' : 'clientWidth';
  const before = el[scrollProp];
  const probeAmount = el[sizeProp] || 1;

  suppressScrollEvent++;
  el[scrollProp] = before + probeAmount;
  const movedForward = el[scrollProp] !== before;
  el[scrollProp] = before;

  if (!movedForward) {
    el[scrollProp] = before - probeAmount;
    const movedBack = el[scrollProp] !== before;
    el[scrollProp] = before;
    suppressScrollEvent--;
    return movedBack;
  }

  suppressScrollEvent--;
  return true;
}

/**
 * Check if a scroll event should be suppressed (it was caused by detection probes).
 */
export function shouldSuppressScrollEvent(): boolean {
  return suppressScrollEvent > 0;
}

// --- Site override map ---

const SCROLL_OVERRIDES: Record<string, string> = {
  'twitter.com': '[data-testid="primaryColumn"]',
  'x.com': '[data-testid="primaryColumn"]',
  'reddit.com': 'shreddit-app',
  'old.reddit.com': '.listing-page',
  'notion.so': '.notion-frame .notion-scroller',
  'slack.com': '.p-workspace__primary_view_body',
  'linear.app': '[data-panel-id="panel-main"]',
  'mail.google.com': '.AO',
  'docs.google.com': '.kix-appview-editor',
};

function getSiteOverride(): HTMLElement | null {
  const hostname = window.location.hostname.replace(/^www\./, '');
  for (const [site, selector] of Object.entries(SCROLL_OVERRIDES)) {
    if (hostname === site || hostname.endsWith('.' + site)) {
      const el = document.querySelector(selector);
      if (el instanceof HTMLElement && isScrollableElement(el, 'y')) {
        return el;
      }
    }
  }
  return null;
}

// --- Container resolution ---

/**
 * Find the scrollable container for a given element, walking up the DOM.
 * Returns the first ancestor that passes isScrollableElement.
 */
export function findScrollableAncestor(
  el: Element | null,
  axis: 'x' | 'y' = 'y',
): HTMLElement {
  let current = el;
  while (current && current !== document.documentElement) {
    if (
      current instanceof HTMLElement &&
      current !== document.body &&
      isScrollableElement(current, axis)
    ) {
      return current;
    }
    current = current.parentElement;
  }
  // Fallback: document.documentElement (viewport scroll)
  return document.documentElement;
}

/**
 * Find the default scroll target (no explicit region).
 * Priority: site override > focused element's scroller > document.
 */
export function getDefaultScrollTarget(axis: 'x' | 'y' = 'y'): HTMLElement {
  const override = getSiteOverride();
  if (override) return override;

  const focused = document.activeElement;
  if (focused && focused !== document.body && focused !== document.documentElement) {
    const ancestor = findScrollableAncestor(focused, axis);
    if (ancestor !== document.documentElement) return ancestor;
  }

  return findScrollableAncestor(document.body, axis);
}

// --- Smooth scroll animator ---

let activeToken: symbol | null = null;
let keyHeldCounter = 0;

let _prefersReducedMotion: MediaQueryList | null = null;
function prefersReducedMotion(): boolean {
  if (!_prefersReducedMotion && typeof window !== 'undefined') {
    _prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  }
  return _prefersReducedMotion?.matches ?? false;
}

function easeOutQuad(t: number): number {
  return t * (2 - t);
}

/**
 * Animate a scroll on an element. Most-recent-wins cancellation.
 * Honors prefers-reduced-motion by skipping animation.
 */
function animateScroll(
  el: HTMLElement,
  axis: 'x' | 'y',
  delta: number,
  immediate = false,
  direction?: ScrollDirection,
): void {
  const prop = axis === 'y' ? 'scrollTop' : 'scrollLeft';

  if (immediate || prefersReducedMotion()) {
    el[prop] += delta;
    if (direction) checkBoundary(el, axis, direction);
    return;
  }

  const token = Symbol();
  activeToken = token;
  const start = el[prop];
  const absDelta = Math.abs(delta);
  const baseDuration = Math.max(100, 20 * Math.log(absDelta || 1));
  const duration = keyHeldCounter > 0 ? baseDuration * 0.6 : baseDuration;
  const t0 = performance.now();

  // Override site CSS scroll-behavior during animation
  const prevBehavior = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';

  function step(now: number): void {
    if (activeToken !== token) {
      el.style.scrollBehavior = prevBehavior;
      return;
    }
    const t = Math.min(1, (now - t0) / duration);
    const eased = easeOutQuad(t);
    el[prop] = start + delta * eased;
    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      el.style.scrollBehavior = prevBehavior;
      if (direction) checkBoundary(el, axis, direction);
    }
  }
  requestAnimationFrame(step);
}

/** Signal that a scroll key is being held (for friction). */
export function setKeyHeld(held: boolean): void {
  keyHeldCounter += held ? 1 : -1;
  if (keyHeldCounter < 0) keyHeldCounter = 0;
}

// --- Boundary detection ---

export type ScrollBoundary = 'top' | 'bottom' | 'left' | 'right';

let onBoundaryHit: ((boundary: ScrollBoundary, el: HTMLElement) => void) | null = null;

export function setScrollBoundaryCallback(
  cb: ((boundary: ScrollBoundary, el: HTMLElement) => void) | null,
): void {
  onBoundaryHit = cb;
}

function checkBoundary(el: HTMLElement, axis: 'x' | 'y', direction: ScrollDirection): void {
  if (!onBoundaryHit) return;
  const prop = axis === 'y' ? 'scrollTop' : 'scrollLeft';
  const maxProp = axis === 'y' ? 'scrollHeight' : 'scrollWidth';
  const sizeProp = axis === 'y' ? 'clientHeight' : 'clientWidth';
  const maxScroll = el[maxProp] - el[sizeProp];

  if ((direction === 'up' || direction === 'left') && el[prop] <= 0) {
    onBoundaryHit(direction === 'up' ? 'top' : 'left', el);
  } else if ((direction === 'down' || direction === 'right') && el[prop] >= maxScroll - 1) {
    onBoundaryHit(direction === 'down' ? 'bottom' : 'right', el);
  }
}

// --- Scroll operations ---

const STEP_PX = 80;

export type ScrollDirection = 'up' | 'down' | 'left' | 'right';
export type ScrollAmount = 'step' | 'half' | 'full' | 'top' | 'bottom';

/**
 * Scroll a specific element by a parameterized amount.
 */
export function scrollElement(
  el: HTMLElement,
  direction: ScrollDirection,
  amount: ScrollAmount = 'step',
  count = 1,
): void {
  const axis: 'x' | 'y' = direction === 'left' || direction === 'right' ? 'x' : 'y';
  const sign = direction === 'up' || direction === 'left' ? -1 : 1;

  if (amount === 'top' || amount === 'bottom') {
    const prop = axis === 'y' ? 'scrollTop' : 'scrollLeft';
    const maxProp = axis === 'y' ? 'scrollHeight' : 'scrollWidth';
    const sizeProp = axis === 'y' ? 'clientHeight' : 'clientWidth';
    const target = amount === 'top' ? 0 : el[maxProp] - el[sizeProp];
    const delta = target - el[prop];
    animateScroll(el, axis, delta, false, direction);
    return;
  }

  const sizeProp = axis === 'y' ? 'clientHeight' : 'clientWidth';
  const viewSize = el[sizeProp];
  let delta: number;

  switch (amount) {
    case 'step':
      delta = STEP_PX * count * sign;
      break;
    case 'half':
      delta = viewSize * 0.5 * count * sign;
      break;
    case 'full':
      delta = viewSize * count * sign;
      break;
    default:
      delta = STEP_PX * count * sign;
  }

  animateScroll(el, axis, delta, false, direction);
}

/**
 * High-level scroll: resolve default target and scroll.
 */
export function scroll(
  direction: ScrollDirection,
  amount: ScrollAmount = 'step',
  count = 1,
): void {
  const axis: 'x' | 'y' = direction === 'left' || direction === 'right' ? 'x' : 'y';
  const target = getDefaultScrollTarget(axis);
  scrollElement(target, direction, amount, count);
}

// --- Scroll by percentage ---

/**
 * Scroll to a percentage of the document/container height.
 * "scroll halfway" = 50%, "scroll to 80 percent" = 80%.
 */
export function scrollToPercent(percent: number, el?: HTMLElement): void {
  const target = el ?? getDefaultScrollTarget('y');
  const maxScroll = target.scrollHeight - target.clientHeight;
  const destination = (maxScroll * Math.max(0, Math.min(100, percent))) / 100;
  const delta = destination - target.scrollTop;
  animateScroll(target, 'y', delta);
}

// --- Per-region named scrolling ---

export type ScrollRegion = 'main' | 'leftSidebar' | 'rightSidebar';

/**
 * Find all scrollable elements in the document with sufficient content.
 * Filters to elements with >5 descendants to avoid tiny scroll containers.
 */
function findScrollableRegions(): HTMLElement[] {
  const all: HTMLElement[] = [];
  const candidates = document.querySelectorAll('*');
  for (const el of candidates) {
    if (!(el instanceof HTMLElement)) continue;
    if (!isScrollableElement(el, 'y')) continue;
    if (el.children.length < 5) continue;
    // Exclude fixed/sticky overlays (modals, dropdowns)
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'sticky') continue;
    all.push(el);
  }
  return all;
}

/**
 * Detect named scroll regions using Rango's geometric approach.
 */
export function findRegion(region: ScrollRegion): HTMLElement | null {
  const override = getSiteOverride();

  if (region === 'main') {
    if (override) return override;
    // Sample center points and walk up to scrollable ancestor
    const cx = window.innerWidth / 2;
    const cy = window.innerHeight / 2;
    const el = document.elementFromPoint(cx, cy);
    if (el instanceof HTMLElement) {
      const scroller = findScrollableAncestor(el, 'y');
      if (scroller !== document.documentElement) return scroller;
    }
    return document.documentElement;
  }

  const regions = findScrollableRegions();
  if (regions.length === 0) return null;

  // Sort by x position of bounding rect
  const withRects = regions.map(el => ({
    el,
    rect: el.getBoundingClientRect(),
  }));
  withRects.sort((a, b) => a.rect.left - b.rect.left);

  if (region === 'leftSidebar') {
    // Leftmost scrollable container (by right edge being in the left third)
    const threshold = window.innerWidth / 3;
    const left = withRects.find(r => r.rect.right <= threshold);
    return left?.el ?? null;
  }

  if (region === 'rightSidebar') {
    // Rightmost scrollable container (by left edge being in the right third)
    const threshold = (window.innerWidth * 2) / 3;
    const right = [...withRects].reverse().find(r => r.rect.left >= threshold);
    return right?.el ?? null;
  }

  return null;
}

/**
 * Scroll a named region.
 */
export function scrollRegion(
  region: ScrollRegion,
  direction: ScrollDirection,
  amount: ScrollAmount = 'step',
  count = 1,
): void {
  const target = findRegion(region);
  if (target) {
    scrollElement(target, direction, amount, count);
  }
}

// --- Scroll at element (scroll the container holding a hinted element) ---

/**
 * Find and scroll the container holding a specific element.
 */
export function scrollAtElement(
  element: Element,
  direction: ScrollDirection,
  amount: ScrollAmount = 'step',
  count = 1,
): void {
  const axis: 'x' | 'y' = direction === 'left' || direction === 'right' ? 'x' : 'y';
  const container = findScrollableAncestor(element, axis);
  scrollElement(container, direction, amount, count);
}

// --- Snap scroll (scroll element to visible position) ---

/**
 * Detect the height of sticky/fixed headers at the top of a container
 * using elementsFromPoint. Scans at the target's x coordinate to catch
 * headers that don't span the full width.
 */
function detectStickyHeaderHeight(
  target: Element,
  scrollOffset: number,
): number {
  const targetRect = target.getBoundingClientRect();
  const probeX = targetRect.x + 5;
  const probeY = targetRect.y - scrollOffset + 5;

  const els = document.elementsFromPoint(probeX, probeY);
  for (const el of els) {
    if (el === target || el.contains(target)) break;

    const style = getComputedStyle(el);
    if (
      style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.opacity !== '0' &&
      (style.position === 'sticky' || style.position === 'fixed')
    ) {
      return el.getBoundingClientRect().height;
    }
  }
  return 0;
}

/**
 * Scroll a container so that a target element appears at the top,
 * accounting for sticky/fixed headers. After scroll completes, re-probes
 * for sticky elements that may have appeared at the new position
 * (handles stacked sticky headers).
 */
export function snapToElement(
  target: Element,
  position: 'top' | 'center' | 'bottom' = 'top',
): void {
  const container = findScrollableAncestor(target, 'y');
  const containerRect = container === document.documentElement
    ? { top: 0, height: window.innerHeight, width: window.innerWidth }
    : container.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();

  let scrollDelta: number;
  const relativeTop = targetRect.top - containerRect.top + container.scrollTop;

  switch (position) {
    case 'top':
      scrollDelta = relativeTop - container.scrollTop;
      break;
    case 'center':
      scrollDelta = relativeTop - container.scrollTop - containerRect.height / 2 + targetRect.height / 2;
      break;
    case 'bottom':
      scrollDelta = relativeTop - container.scrollTop - containerRect.height + targetRect.height;
      break;
  }

  let stickyHeight = 0;
  if (position === 'top') {
    stickyHeight = detectStickyHeaderHeight(target, scrollDelta);

    const scrollTarget = container === document.documentElement ? globalThis : container;
    scrollTarget.addEventListener(
      'scrollend',
      () => {
        const rect = target.getBoundingClientRect();
        const probeX = rect.x + 5;
        const probeY = rect.y + 5;
        const els = document.elementsFromPoint(probeX, probeY);

        for (const el of els) {
          if (el === target || el.contains(target)) break;

          const style = getComputedStyle(el);
          if (
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            style.opacity !== '0' &&
            (style.position === 'sticky' || style.position === 'fixed')
          ) {
            const stickyBottom = el.getBoundingClientRect().bottom;
            container.scrollBy({
              left: 0,
              top: rect.top - stickyBottom,
              behavior: prefersReducedMotion() ? 'instant' : 'smooth',
            });
            break;
          }
        }
      },
      { once: true },
    );
  }

  animateScroll(container, 'y', scrollDelta - stickyHeight);
}

// --- Cycle target (keyboard: cycle through scrollable containers) ---

let cycleTargets: HTMLElement[] = [];
let cycleIndex = -1;
let cycleHighlight: HTMLElement | null = null;

/**
 * Cycle to the next scrollable container and briefly highlight it.
 */
export function cycleScrollTarget(): HTMLElement | null {
  cycleTargets = findScrollableRegions();
  if (cycleTargets.length === 0) return null;

  cycleIndex = (cycleIndex + 1) % cycleTargets.length;
  const target = cycleTargets[cycleIndex];

  // Remove previous highlight
  if (cycleHighlight) {
    cycleHighlight.remove();
    cycleHighlight = null;
  }

  // Show brief highlight overlay
  const rect = target.getBoundingClientRect();
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position: fixed;
    left: ${rect.left}px;
    top: ${rect.top}px;
    width: ${rect.width}px;
    height: ${rect.height}px;
    border: 2px solid #007AFF;
    background: rgba(0, 122, 255, 0.05);
    pointer-events: none;
    z-index: 2147483647;
    transition: opacity 0.2s;
  `;
  document.body.appendChild(overlay);
  cycleHighlight = overlay;

  setTimeout(() => {
    if (cycleHighlight === overlay) {
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 200);
      cycleHighlight = null;
    }
  }, 800);

  return target;
}

/**
 * Get the currently selected cycle target (for subsequent scroll commands).
 */
export function getCycleTarget(): HTMLElement | null {
  if (cycleIndex >= 0 && cycleIndex < cycleTargets.length) {
    const target = cycleTargets[cycleIndex];
    if (target.isConnected) return target;
  }
  return null;
}

export function resetCycleTarget(): void {
  cycleIndex = -1;
  cycleTargets = [];
  if (cycleHighlight) {
    cycleHighlight.remove();
    cycleHighlight = null;
  }
}

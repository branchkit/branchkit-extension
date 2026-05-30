/**
 * Full pointer/mouse/click event dispatch.
 *
 * Sites with custom event handling (React synthetic events, drag
 * libraries, Notion-style editors) expect the full browser event
 * sequence, not just a bare .click(). Adapted from Rango's
 * dispatchEvents.ts.
 */

function getCenter(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function pointer(type: string, x: number, y: number): PointerEvent {
  return new PointerEvent(type, {
    pointerId: 1,
    isPrimary: true,
    pointerType: 'mouse',
    clientX: x,
    clientY: y,
    composed: true,
    button: type === 'pointermove' ? -1 : 0,
    buttons: type === 'pointerdown' ? 1 : 0,
    bubbles: true,
    cancelable: true,
  });
}

function mouse(type: string, x: number, y: number): MouseEvent {
  return new MouseEvent(type, {
    clientX: x,
    clientY: y,
    composed: true,
    button: 0,
    buttons: type === 'mousedown' ? 1 : 0,
    bubbles: true,
    cancelable: true,
  });
}

function getFocusable(el: Element): HTMLElement | null {
  let current: Element | null = el;
  while (current) {
    if (current instanceof HTMLElement && current.tabIndex >= 0) return current;
    current = current.parentElement;
  }
  return el instanceof HTMLElement ? el : null;
}

let lastClicked: Element | undefined;

/**
 * Dispatch the full pointer→mouse→focus→click sequence that browsers
 * produce for a real mouse click. This satisfies React's synthetic
 * event system, drag libraries, and custom editors.
 */
export function dispatchClick(el: Element): void {
  if (lastClicked) dispatchUnhover(lastClicked);

  const { x, y } = getCenter(el);

  el.dispatchEvent(pointer('pointerdown', x, y));
  el.dispatchEvent(mouse('mousedown', x, y));

  const focusable = getFocusable(el);
  if (focusable) {
    focusable.focus();
  }

  el.dispatchEvent(pointer('pointerup', x, y));
  el.dispatchEvent(mouse('mouseup', x, y));
  el.dispatchEvent(mouse('click', x, y));

  lastClicked = el;
}

export function dispatchHover(el: Element): void {
  const { x, y } = getCenter(el);

  el.dispatchEvent(pointer('pointerover', x, y));
  el.dispatchEvent(pointer('pointerenter', x, y));
  el.dispatchEvent(pointer('pointermove', x, y));

  el.dispatchEvent(mouse('mouseover', x, y));
  el.dispatchEvent(mouse('mouseenter', x, y));
  el.dispatchEvent(mouse('mousemove', x, y));
}

export function dispatchUnhover(el: Element): void {
  const { x, y } = getCenter(el);

  el.dispatchEvent(pointer('pointermove', x, y));
  el.dispatchEvent(mouse('mousemove', x, y));

  el.dispatchEvent(pointer('pointerout', x, y));
  el.dispatchEvent(pointer('pointerleave', x, y));

  el.dispatchEvent(mouse('mouseout', x, y));
  el.dispatchEvent(mouse('mouseleave', x, y));
}

/**
 * Outcome of `activateElement`: which element actually received the
 * activation, and what kind of delegation (if any) occurred between the
 * caller's `el` argument and the final target. Used by the activate
 * handler's BK_ACTIVATE_PATH instrumentation to identify "wrong element
 * activated" bugs — when wrapper.element != clicked.element, the
 * delegation tag tells you which `activateElement` branch fired.
 */
export interface ActivationResult {
  target: HTMLElement;
  delegation: 'none' | 'anchor' | 'file-picker' | 'select';
}

/**
 * Click an element using the appropriate strategy:
 * - New-tab anchors: window.open() for explicit tab control
 * - Anchors wrapping a child element: delegate to the anchor
 * - File inputs: .click() (triggers file picker)
 * - Selects: focus + synthetic open
 * - Everything else (including anchors): full event sequence
 */
export function activateElement(
  el: HTMLElement,
  opts: { newTab?: boolean } = {},
): ActivationResult {
  if (el instanceof HTMLSelectElement) {
    if (el.disabled) return { target: el, delegation: 'select' };
    el.focus();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return { target: el, delegation: 'select' };
  }

  if (el instanceof HTMLInputElement && el.type === 'file') {
    if (el.disabled) return { target: el, delegation: 'file-picker' };
    el.click();
    return { target: el, delegation: 'file-picker' };
  }

  const anchor = el.closest('a') as HTMLAnchorElement | null;

  if (opts.newTab && anchor?.href) {
    window.open(anchor.href, '_blank');
    return { target: anchor ?? el, delegation: anchor !== el ? 'anchor' : 'none' };
  }

  const target = (anchor && anchor !== el) ? anchor : el;
  const delegation = (anchor && anchor !== el) ? 'anchor' as const : 'none' as const;

  dispatchHover(target);
  dispatchClick(target);
  return { target, delegation };
}

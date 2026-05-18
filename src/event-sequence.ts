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

function isEditable(el: Element): boolean {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLElement && el.isContentEditable) return true;
  return false;
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

  if (el instanceof HTMLElement && isEditable(el)) {
    window.focus();
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
 * Click an element using the appropriate strategy:
 * - Anchors: native .click() for proper tab/navigation handling
 * - File inputs: focus + Enter key (triggers file picker)
 * - Selects: focus + synthetic open
 * - Everything else: full event sequence
 */
export function activateElement(
  el: HTMLElement,
  opts: { newTab?: boolean } = {},
): void {
  if (el instanceof HTMLSelectElement) {
    el.focus();
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    return;
  }

  if (el instanceof HTMLInputElement && el.type === 'file') {
    el.focus();
    el.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Enter', code: 'Enter', bubbles: true, composed: true,
    }));
    el.dispatchEvent(new KeyboardEvent('keyup', {
      key: 'Enter', code: 'Enter', bubbles: true, composed: true,
    }));
    return;
  }

  const anchor = el.closest('a') as HTMLAnchorElement | null;
  if (anchor) {
    if (opts.newTab && anchor.href) {
      window.open(anchor.href, '_blank');
    } else {
      anchor.click();
    }
    return;
  }

  dispatchClick(el);
}

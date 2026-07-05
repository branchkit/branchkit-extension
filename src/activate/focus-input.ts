/**
 * BranchKit Browser — focus-input command (Vimium's `gi`).
 *
 * Focus the first visible text input on the page. While the mode is active,
 * Tab / Shift+Tab cycle through the page's text inputs (only text fields, not
 * every focusable), and any other key drops you into the focused field to type.
 * If there's only one input it's focused and the mode doesn't engage.
 */

const TEXT_INPUT_SELECTOR = [
  'input:not([type])',
  'input[type="text"]', 'input[type="search"]', 'input[type="email"]',
  'input[type="url"]', 'input[type="number"]', 'input[type="password"]',
  'input[type="tel"]', 'input[type="date"]',
  'textarea',
  '[contenteditable=""]', '[contenteditable="true"]',
].join(',');

function defaultIsVisible(el: HTMLElement): boolean {
  const check = (el as Element & { checkVisibility?: (o?: object) => boolean }).checkVisibility;
  if (typeof check === 'function') return check.call(el, { checkVisibilityCSS: true });
  return el.getClientRects().length > 0;
}

/**
 * The page's focusable text inputs, sorted by positive tabIndex first (ascending,
 * keeping DOM order on ties) then DOM order — Vimium's ordering. Disabled/readonly
 * fields are excluded. The visibility predicate is injectable for tests (jsdom
 * has no layout).
 */
export function collectTextInputs(
  root: ParentNode = document,
  isVisible: (el: HTMLElement) => boolean = defaultIsVisible,
): HTMLElement[] {
  const els = Array.from(root.querySelectorAll<HTMLElement>(TEXT_INPUT_SELECTOR));
  const candidates = els.filter((el) => {
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && (el.disabled || el.readOnly)) {
      return false;
    }
    return isVisible(el);
  });
  return candidates
    .map((el, i) => ({ el, i, tab: el.tabIndex }))
    .sort((a, b) => {
      if (a.tab > 0 && b.tab > 0) return (a.tab - b.tab) || (a.i - b.i);
      if (a.tab > 0) return -1;
      if (b.tab > 0) return 1;
      return a.i - b.i;
    })
    .map((x) => x.el);
}

let active = false;
let inputs: HTMLElement[] = [];
let idx = -1;

function focusAt(i: number): void {
  idx = i;
  const el = inputs[idx];
  el.focus();
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
    try { el.select(); } catch { /* some input types reject select() */ }
  }
}

/** Focus the first text input; engage Tab-cycle mode if there's more than one. */
export function focusFirstInput(): void {
  inputs = collectTextInputs();
  if (inputs.length === 0) { active = false; return; }
  focusAt(0);
  active = inputs.length > 1;
}

export function isFocusInputActive(): boolean {
  return active;
}

/**
 * While focus-input mode is active: Tab → next field, Shift+Tab → previous
 * (cycles), Escape exits. A bare modifier is ignored (stays in the mode); any
 * other key exits and passes through so it types into the focused field. Returns
 * true if it consumed the key. Must run before the hint key handler.
 */
export function handleFocusInputKey(e: KeyboardEvent): boolean {
  if (!active) return false;
  if (e.key === 'Tab') {
    // If focus wandered off our set (e.g. a click), let native Tab take over.
    if (!inputs.includes(document.activeElement as HTMLElement)) { active = false; return false; }
    e.preventDefault();
    e.stopPropagation();
    focusAt((idx + (e.shiftKey ? -1 : 1) + inputs.length) % inputs.length);
    return true;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    active = false;
    // Blur the field too (same as the general Insert-mode Escape) so you land
    // back in Normal mode rather than still focused and unable to press keys.
    const el = document.activeElement;
    if (el instanceof HTMLElement) el.blur();
    return true;
  }
  if (e.key === 'Shift' || e.key === 'Control' || e.key === 'Alt' || e.key === 'Meta') {
    return false; // bare modifier — stay in the mode, don't consume
  }
  active = false; // any other key exits; let it through to type into the field
  return false;
}

/** Test-only reset. */
export function _resetFocusInputForTesting(): void {
  active = false;
  inputs = [];
  idx = -1;
}

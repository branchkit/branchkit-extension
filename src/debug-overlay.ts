/**
 * BranchKit Browser — hint-diagnostics debug overlay (Phase 3 of
 * `docs/completed/DESIGN_HINT_DIAGNOSTICS.md`).
 *
 * Toggled by Ctrl+Alt+A (same trigger as the Phase 2 snapshot — pressing
 * the key writes a snapshot AND flips the overlay). Draws a colored box
 * over every wrapper + every "almost-hintable" candidate so the
 * diagnostic categories that *don't* have a visible badge today become
 * visible.
 *
 * 5 tiers per the design:
 *
 *   Green  — registered + in viewport + has codeword   (badge IS visible)
 *   Yellow — registered + in viewport + no codeword    (pool exhausted)
 *   Orange — registered + off-screen                   (not in viewport)
 *   Red    — would-be hintable + register-rejected     (fingerprint collision)
 *   Blue   — matched selector + isHintable rejected    (EXCLUDE/invisible/redundant)
 *
 * The overlay is a single root <div> appended to documentElement, with
 * absolute children per wrapper/candidate. Page-coord positioning
 * (rect.top + scrollY) so boxes stay anchored to elements during scroll.
 *
 * **Static at toggle-on:** does not react to DOM mutation or page
 * scroll-induced layout shifts. Re-toggling re-renders against the
 * current state. Live updates were rejected for v1 — the overlay is
 * a frozen-frame debugging tool, not an inspector.
 */

import { ElementWrapper, WrapperStore } from './element-wrapper';
import { enumerateAlmostHintable } from './scanner';

type OverlayColor = 'green' | 'yellow' | 'orange' | 'blue';

interface OverlayColorScheme {
  border: string;
  bg: string;
  label: string;
}

// GitHub Dark palette — distinct hues against typical site backgrounds,
// readable label text.
const COLORS: Record<OverlayColor, OverlayColorScheme> = {
  green:  { border: '#39d353', bg: 'rgba(57, 211, 83, 0.10)',  label: '#39d353' },
  yellow: { border: '#f0c33c', bg: 'rgba(240, 195, 60, 0.10)', label: '#f0c33c' },
  orange: { border: '#ff8c42', bg: 'rgba(255, 140, 66, 0.10)', label: '#ff8c42' },
  blue:   { border: '#58a6ff', bg: 'rgba(88, 166, 255, 0.10)', label: '#58a6ff' },
};

// One below max signed-int z-index. The find-overlay and scroller use
// max; this stays under those but above all normal page content + the
// hint badges (which don't set z-index explicitly).
const Z_INDEX = 2_147_483_646;

const ROOT_DATA_ATTR = 'data-branchkit-debug-overlay';

interface OverlayState {
  active: boolean;
  root: HTMLDivElement | null;
}

const state: OverlayState = { active: false, root: null };

/** Classify a wrapper into one of the three "registered" tiers. The blue
 * tier doesn't have wrappers — it comes from the scanner's
 * enumerateAlmostHintable. Pure function; tested directly. */
export function classifyWrapper(w: ElementWrapper): 'green' | 'yellow' | 'orange' {
  if (!w.isInViewport) return 'orange';
  if (w.scanned.codeword) return 'green';
  return 'yellow';
}

/** Convert a viewport-relative DOMRect to absolute page coordinates so
 * the overlay box stays anchored to its element across scroll. Pure
 * helper; tested directly. */
export function pageRect(
  rect: { top: number; left: number; width: number; height: number },
  scrollX: number,
  scrollY: number,
): { top: number; left: number; width: number; height: number } {
  return {
    top: rect.top + scrollY,
    left: rect.left + scrollX,
    width: rect.width,
    height: rect.height,
  };
}

function buildBox(
  pr: { top: number; left: number; width: number; height: number },
  color: OverlayColor,
  label: string,
): HTMLDivElement {
  const c = COLORS[color];
  const box = document.createElement('div');
  Object.assign(box.style, {
    position: 'absolute',
    top: `${pr.top}px`,
    left: `${pr.left}px`,
    width: `${pr.width}px`,
    height: `${pr.height}px`,
    border: `2px solid ${c.border}`,
    background: c.bg,
    pointerEvents: 'none',
    boxSizing: 'border-box',
  } as CSSStyleDeclaration);

  const labelEl = document.createElement('div');
  Object.assign(labelEl.style, {
    position: 'absolute',
    top: '-18px',
    left: '0',
    background: c.label,
    color: '#0d1117',
    fontSize: '11px',
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
    fontWeight: '600',
    padding: '1px 4px',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
    lineHeight: '14px',
  } as CSSStyleDeclaration);
  labelEl.textContent = label;
  box.appendChild(labelEl);

  return box;
}

function buildOverlay(store: WrapperStore): HTMLDivElement {
  const root = document.createElement('div');
  Object.assign(root.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '0',
    height: '0',
    pointerEvents: 'none',
    zIndex: String(Z_INDEX),
  } as CSSStyleDeclaration);
  root.setAttribute(ROOT_DATA_ATTR, '');

  const sx = window.scrollX;
  const sy = window.scrollY;

  // Green / yellow / orange — wrappers from the live store.
  for (const w of store.all) {
    const r = w.element.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue; // detached / collapsed
    const color = classifyWrapper(w);
    const codeword = w.scanned.codeword || '(no codeword)';
    root.appendChild(
      buildBox(pageRect(r, sx, sy), color, `id=${w.scanned.id} ${codeword}`),
    );
  }

  // Blue — matched HINTABLE_SELECTOR but filtered by isHintable.
  for (const ah of enumerateAlmostHintable()) {
    const r = ah.el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    root.appendChild(
      buildBox(pageRect(r, sx, sy), 'blue', `rejected: ${ah.reason}`),
    );
  }

  return root;
}

/** Toggle the overlay on/off. Reads from the live store + scans the DOM
 * at toggle-on time; doesn't react to subsequent changes. Call this
 * alongside the Phase 2 snapshot trigger — same press fires both. */
export function toggleOverlay(store: WrapperStore): void {
  if (state.active && state.root) {
    state.root.remove();
    state.root = null;
    state.active = false;
    return;
  }
  const root = buildOverlay(store);
  document.documentElement.appendChild(root);
  state.root = root;
  state.active = true;
}

/** Test/inspection accessor — is the overlay currently displayed? */
export function isOverlayActive(): boolean {
  return state.active;
}

/** Test-only reset. Clears the state and any attached root without
 * waiting on the public toggle path. */
export function _resetOverlayForTesting(): void {
  if (state.root) state.root.remove();
  state.root = null;
  state.active = false;
}

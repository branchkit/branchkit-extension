/**
 * BranchKit Browser — keyboard mode indicator chip.
 *
 * A small persistent badge showing the active keyboard mode. Because hints
 * stay always-VISIBLE for voice, the user can't tell from the page whether a
 * letter fires a keybind (Normal) or filters a hint (Hint) — so the mode is
 * shown. See notes/DESIGN_KEYBOARD_MODES.md.
 *
 * Phase 1 shows the chip only in HINT mode ("HINT — type a codeword"); Normal
 * is the quiet default (no chip). Shadow-DOM isolated, same pattern as the
 * find bar / help overlay. Top frame only.
 */

import type { KeyMode } from '../activate/keyboard';

const HOST_ATTR = 'data-branchkit-mode-chip';
const Z_INDEX = 2_147_483_645; // just below the help/palette tier

let host: HTMLElement | null = null;

const STYLE = `
:host { all: initial; }
.chip {
  position: fixed; bottom: 14px; right: 14px; z-index: ${Z_INDEX};
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
  color: #f2cc60; background: #1c2128;
  border: 1px solid #3d444d; border-radius: 6px;
  padding: 4px 9px; box-shadow: 0 4px 14px rgba(1, 4, 9, 0.5);
  display: flex; gap: 8px; align-items: baseline;
}
.chip .sub { color: #8b949e; font-weight: 500; letter-spacing: 0; }
`;

// Per-mode chip copy. Normal has no chip (the quiet default).
const CHIP_TEXT: Record<'hint' | 'insert', { label: string; sub: string }> = {
  hint: { label: 'HINT', sub: 'type a codeword · Esc' },
  insert: { label: 'PASS-THROUGH', sub: 'keys go to the page · Esc' },
};

function build(mode: 'hint' | 'insert'): HTMLElement {
  const el = document.createElement('div');
  el.setAttribute(HOST_ATTR, '');
  // Tag as BranchKit's own UI so the page MutationObserver skips it.
  el.setAttribute('data-branchkit-hint', '');
  const shadow = el.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = STYLE;
  shadow.appendChild(style);
  const chip = document.createElement('div');
  chip.className = 'chip';
  const label = document.createElement('span');
  label.textContent = CHIP_TEXT[mode].label;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = CHIP_TEXT[mode].sub;
  chip.append(label, sub);
  shadow.appendChild(chip);
  return el;
}

/** Reflect the current keyboard mode. Only the top frame shows the chip; Normal
 * is chip-less. Rebuilds when the shown mode changes (hint ↔ pass-through). */
export function setModeChip(mode: KeyMode): void {
  if (typeof document === 'undefined' || window !== window.top) return;
  const shown: 'hint' | 'insert' | null =
    mode === 'hint' ? 'hint' : mode === 'insert' ? 'insert' : null;
  host?.remove();
  host = null;
  if (shown) {
    host = build(shown);
    document.documentElement.appendChild(host);
  }
}

/** Test-only reset. */
export function _resetModeChipForTesting(): void {
  host?.remove();
  host = null;
}

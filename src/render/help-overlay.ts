/**
 * BranchKit Browser — keyboard help overlay (the `?` cheat-sheet).
 *
 * An in-page, shadow-DOM-isolated modal listing every bound keyboard command,
 * grouped by the command catalog's groups, built from the SAME source of truth
 * the keymap editor reads (COMMAND_CATALOG + the effective keymap). So a user's
 * custom binds show here automatically. Toggled by the `toggle_help` command
 * (default `?`), Escape, or a backdrop click.
 *
 * Standalone: works whether or not BranchKit is connected — it's purely the
 * extension's own keyboard reference. Mirrors render/debug-overlay.ts's
 * toggle/state shape; shadow DOM (not inline styles) because this is reading
 * content the page's CSS must not distort.
 */

import { COMMAND_CATALOG, type CommandMeta, type KeymapEntry } from '../command-catalog';
import { comboDisplay } from '../activate/key-combo';

export interface HelpRow {
  /** Display strings for every binding of this command (e.g. ["Shift+J"]). */
  keys: string[];
  label: string;
  description: string;
}
export interface HelpGroup {
  group: string;
  rows: HelpRow[];
}

/** Format one keymap `keys` token for display. A multi-key sequence is space-
 * joined ("KeyC KeyS"), so format each combo and rejoin. */
function formatKeysToken(token: string): string {
  return token.split(' ').map(comboDisplay).join(' ');
}

/**
 * Build the grouped help model: every catalog command that has at least one
 * binding in `keymap`, grouped by catalog group, preserving catalog order.
 * Pure — unit-tested directly.
 */
export function buildHelpModel(
  catalog: readonly CommandMeta[],
  keymap: readonly KeymapEntry[],
): HelpGroup[] {
  const keysByCommand = new Map<string, string[]>();
  for (const e of keymap) {
    const arr = keysByCommand.get(e.command) ?? [];
    arr.push(formatKeysToken(e.keys));
    keysByCommand.set(e.command, arr);
  }
  const groups: HelpGroup[] = [];
  const indexByGroup = new Map<string, number>();
  for (const c of catalog) {
    const keys = keysByCommand.get(c.id);
    if (!keys || keys.length === 0) continue; // keyboard help: only bound commands
    let gi = indexByGroup.get(c.group);
    if (gi === undefined) {
      gi = groups.length;
      groups.push({ group: c.group, rows: [] });
      indexByGroup.set(c.group, gi);
    }
    groups[gi].rows.push({ keys, label: c.label, description: c.description });
  }
  return groups;
}

const HOST_DATA_ATTR = 'data-branchkit-help';
// One below max signed int — above page content; same tier as the debug overlay.
const Z_INDEX = 2_147_483_646;

const STYLE = `
:host { all: initial; }
.backdrop {
  position: fixed; inset: 0; z-index: ${Z_INDEX};
  background: rgba(1, 4, 9, 0.55);
  display: flex; align-items: center; justify-content: center;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.panel {
  width: min(760px, 92vw); max-height: 82vh; overflow: auto;
  background: #0d1117; color: #c9d1d9;
  border: 1px solid #30363d; border-radius: 10px;
  box-shadow: 0 16px 48px rgba(1, 4, 9, 0.6);
  padding: 18px 20px;
}
.head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 12px; }
.title { font-size: 15px; font-weight: 650; color: #f0f6fc; }
.hint { font-size: 12px; color: #8b949e; }
.groups { columns: 2; column-gap: 26px; }
@media (max-width: 560px) { .groups { columns: 1; } }
.group { break-inside: avoid; margin-bottom: 14px; }
.group-name {
  font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: #58a6ff; margin-bottom: 6px;
}
.row { display: flex; gap: 8px; align-items: baseline; margin-bottom: 6px; }
.keys { flex: 0 0 auto; display: flex; gap: 4px; flex-wrap: wrap; }
kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px;
  background: #21262d; color: #e6edf3; border: 1px solid #30363d;
  border-bottom-width: 2px; border-radius: 4px; padding: 1px 6px; white-space: nowrap;
}
.text { min-width: 0; }
.label { font-size: 13px; color: #e6edf3; }
.desc { font-size: 11px; color: #8b949e; line-height: 1.35; }
.usage { margin-bottom: 14px; font-size: 12px; color: #8b949e; line-height: 1.5; }
.usage b { color: #c9d1d9; font-weight: 600; }
`;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Build the shadow-isolated host element for the given model. Backdrop click
 * closes via the supplied callback. */
function buildHelpOverlay(model: HelpGroup[], onClose: () => void): HTMLElement {
  const host = document.createElement('div');
  host.setAttribute(HOST_DATA_ATTR, '');
  // Tag as BranchKit's own UI so the page MutationObserver skips it (isOwnMutation).
  host.setAttribute('data-branchkit-hint', '');
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = STYLE;
  shadow.appendChild(style);

  const backdrop = el('div', 'backdrop');
  backdrop.addEventListener('click', (ev) => { if (ev.target === backdrop) onClose(); });

  const panel = el('div', 'panel');

  const head = el('div', 'head');
  head.appendChild(el('div', 'title', 'BranchKit — Keyboard help'));
  head.appendChild(el('div', 'hint', 'Esc or ? to close'));
  panel.appendChild(head);

  const usage = el('div', 'usage');
  usage.innerHTML =
    'With hints showing, <b>type a badge’s letters</b> to activate it. ' +
    'A <b>capital</b> letter opens it in a new tab. Press <b>/</b> to filter by visible text, ' +
    '<b>Esc</b> to clear what you’ve typed.';
  panel.appendChild(usage);

  const groupsEl = el('div', 'groups');
  for (const g of model) {
    const groupEl = el('div', 'group');
    groupEl.appendChild(el('div', 'group-name', g.group));
    for (const r of g.rows) {
      const row = el('div', 'row');
      const keys = el('div', 'keys');
      for (const k of r.keys) keys.appendChild(el('kbd', undefined, k));
      row.appendChild(keys);
      const text = el('div', 'text');
      text.appendChild(el('div', 'label', r.label));
      text.appendChild(el('div', 'desc', r.description));
      row.appendChild(text);
      groupEl.appendChild(row);
    }
    groupsEl.appendChild(groupEl);
  }
  panel.appendChild(groupsEl);

  backdrop.appendChild(panel);
  shadow.appendChild(backdrop);
  return host;
}

interface HelpState {
  active: boolean;
  host: HTMLElement | null;
  esc: ((e: KeyboardEvent) => void) | null;
}
const state: HelpState = { active: false, host: null, esc: null };

function close(): void {
  if (state.esc) document.removeEventListener('keydown', state.esc, true);
  state.host?.remove();
  state.host = null;
  state.esc = null;
  state.active = false;
}

/** Toggle the help overlay. Reads the effective keymap each open so custom
 * binds are reflected. */
export function toggleHelpOverlay(keymap: readonly KeymapEntry[]): void {
  if (state.active) { close(); return; }
  const host = buildHelpOverlay(buildHelpModel(COMMAND_CATALOG, keymap), close);
  document.documentElement.appendChild(host);
  // Capture-phase Escape so we close before the page (or the key handler) can
  // act on it; other keys (including `?`, which toggles us off via the registry)
  // pass through untouched.
  const esc = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
  };
  document.addEventListener('keydown', esc, true);
  state.host = host;
  state.esc = esc;
  state.active = true;
}

export function isHelpOverlayActive(): boolean {
  return state.active;
}

/** Test-only reset. */
export function _resetHelpForTesting(): void {
  close();
}

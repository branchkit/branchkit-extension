/**
 * BranchKit Browser — help overlay (the `?` cheat-sheet).
 *
 * An in-page, shadow-DOM-isolated modal showing, top-to-bottom: the spoken
 * alphabet (letter → word, from the live voice overlay — most visible, no scroll
 * needed) and every bound keyboard command, grouped by the command catalog and
 * built from the SAME source of truth the keymap editor reads (COMMAND_CATALOG +
 * the effective keymap), so custom binds show here automatically. Toggled by the
 * `toggle_help` command (default `?`), Escape, or a backdrop click.
 *
 * Standalone: works whether or not BranchKit is connected — it's purely the
 * extension's own keyboard reference. Mirrors render/debug-overlay.ts's
 * toggle/state shape; shadow DOM (not inline styles) because this is reading
 * content the page's CSS must not distort.
 */

import { COMMAND_CATALOG, type CommandMeta, type KeymapEntry } from '../command-catalog';
import { comboDisplay } from '../activate/key-combo';
import { letterToSpokenWord, isVoiceAlphabetLoaded } from '../labels/words';

export interface HelpRow {
  /** Display strings for every binding of this command (e.g. ["Shift+J"]). */
  keys: string[];
  /** Spoken phrases for this command (e.g. ["scroll down", "scroll down {number}"]). */
  voice: string[];
  label: string;
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
 * Build the grouped help model: every catalog command that has a key binding OR
 * a spoken phrase, grouped by catalog group, preserving catalog order. Each row
 * carries its keys and voice phrases (either may be empty). Pure — unit-tested.
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
    const keys = keysByCommand.get(c.id) ?? [];
    const voice = (c.voice ?? []).map((v) => v.pattern);
    if (keys.length === 0 && voice.length === 0) continue; // not reachable → skip
    let gi = indexByGroup.get(c.group);
    if (gi === undefined) {
      gi = groups.length;
      groups.push({ group: c.group, rows: [] });
      indexByGroup.set(c.group, gi);
    }
    groups[gi].rows.push({ keys, voice, label: c.label });
  }
  return groups;
}

export interface AlphabetEntry { letter: string; word: string; }

// Alphabetical (a–z) for a lookup table — not LETTERS_26's typing-reachability
// order, which is for hint-codeword assignment.
const AZ = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * The current spoken alphabet (letter → word) in a–z order, from the live voice
 * overlay. `loaded` is false until BranchKit voice connects — when false the
 * words equal the letters, so callers should show a hint instead of the table.
 */
export function buildAlphabetModel(): { loaded: boolean; entries: AlphabetEntry[] } {
  return {
    loaded: isVoiceAlphabetLoaded(),
    entries: AZ.map((letter) => ({ letter, word: letterToSpokenWord(letter) })),
  };
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
  width: min(880px, 94vw); max-height: 90vh; overflow: auto;
  background: #0d1117; color: #c9d1d9;
  border: 1px solid #30363d; border-radius: 10px;
  box-shadow: 0 16px 48px rgba(1, 4, 9, 0.6);
  padding: 14px 16px;
}
.head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.title { font-size: 14px; font-weight: 650; color: #f0f6fc; }
.hint { font-size: 11px; color: #8b949e; }
.sec { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em;
  color: #58a6ff; margin: 0 0 6px; }
/* Spoken alphabet — compact grid, no scroll needed. */
.alpha { display: grid; grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 2px 12px; margin-bottom: 12px; }
.alpha .a { display: flex; gap: 6px; align-items: baseline; font-size: 12px; min-width: 0; }
.alpha .l { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700;
  color: #e6edf3; width: 1.1em; flex: 0 0 auto; }
.alpha .w { color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alpha-empty { font-size: 12px; color: #8b949e; margin-bottom: 12px; }
/* Commands — one line each (key + label + spoken phrase), multi-column. */
.cmds { columns: 2; column-gap: 22px; }
@media (max-width: 560px) { .cmds { columns: 1; } }
.group { break-inside: avoid; margin-bottom: 9px; }
.group-name { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
  color: #8b949e; margin-bottom: 3px; }
.row { display: flex; gap: 6px; align-items: baseline; flex-wrap: wrap; margin-bottom: 3px; font-size: 12px; }
.keys { flex: 0 0 auto; display: flex; gap: 3px; flex-wrap: wrap; }
kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px;
  background: #21262d; color: #e6edf3; border: 1px solid #30363d;
  border-bottom-width: 2px; border-radius: 3px; padding: 0 4px; white-space: nowrap;
}
.label { color: #e6edf3; }
.say { color: #8b949e; font-style: italic; }
.usage { margin-top: 10px; font-size: 11px; color: #8b949e; line-height: 1.45; }
.usage b { color: #c9d1d9; font-weight: 600; }
`;

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Build the shadow-isolated host element. Alphabet first (most visible), then
 * compact one-line commands. Backdrop click closes via the supplied callback. */
function buildHelpOverlay(
  model: HelpGroup[],
  alphabet: { loaded: boolean; entries: AlphabetEntry[] },
  onClose: () => void,
): HTMLElement {
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
  head.appendChild(el('div', 'title', 'BranchKit — Help'));
  head.appendChild(el('div', 'hint', 'Esc or ? to close'));
  panel.appendChild(head);

  // Spoken alphabet — top, so it's visible without scrolling.
  panel.appendChild(el('div', 'sec', 'Spoken alphabet'));
  if (alphabet.loaded) {
    const grid = el('div', 'alpha');
    for (const { letter, word } of alphabet.entries) {
      const a = el('div', 'a');
      a.appendChild(el('span', 'l', letter));
      a.appendChild(el('span', 'w', word));
      grid.appendChild(a);
    }
    panel.appendChild(grid);
  } else {
    panel.appendChild(el('div', 'alpha-empty', 'Connect BranchKit voice to see the spoken alphabet.'));
  }

  // Commands — compact, one line each.
  panel.appendChild(el('div', 'sec', 'Commands'));
  const cmds = el('div', 'cmds');
  for (const g of model) {
    const groupEl = el('div', 'group');
    groupEl.appendChild(el('div', 'group-name', g.group));
    for (const r of g.rows) {
      const row = el('div', 'row');
      if (r.keys.length) {
        const keys = el('div', 'keys');
        for (const k of r.keys) keys.appendChild(el('kbd', undefined, k));
        row.appendChild(keys);
      }
      row.appendChild(el('span', 'label', r.label));
      if (r.voice.length) {
        row.appendChild(el('span', 'say', r.voice.map((v) => `“${v}”`).join(' / ')));
      }
      groupEl.appendChild(row);
    }
    cmds.appendChild(groupEl);
  }
  panel.appendChild(cmds);

  const usage = el('div', 'usage');
  usage.innerHTML =
    'Press <b>f</b> to type hints, then <b>a badge’s letters</b> to activate it ' +
    '(the “HINT” chip shows you’re in hint mode). A <b>capital</b> opens it in a new tab. ' +
    '<b>Enter</b> activates the first visible hint; <b>/</b> opens find-in-page; <b>Esc</b> exits. ' +
    'Otherwise bare keys are normal-mode shortcuts.';
  panel.appendChild(usage);

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
  const host = buildHelpOverlay(buildHelpModel(COMMAND_CATALOG, keymap), buildAlphabetModel(), close);
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

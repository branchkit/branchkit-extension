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
  voiceConnected = true,
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
    // With voice disconnected the spoken phrases are unusable, so drop them —
    // and any command reachable ONLY by voice falls out via the skip below.
    const voice = voiceConnected ? (c.voice ?? []).map((v) => v.pattern) : [];
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
  width: min(1060px, 94vw); max-height: 90vh; overflow: auto;
  background: #0d1117; color: #c9d1d9;
  border: 1px solid #30363d; border-radius: 10px;
  box-shadow: 0 16px 48px rgba(1, 4, 9, 0.6);
  padding: 14px 16px;
  /* Thin, near-black scrollbar so it recedes into the dark panel instead of
     showing the OS default light track. */
  scrollbar-width: thin;
  scrollbar-color: #010409 transparent;
}
.panel::-webkit-scrollbar { width: 8px; height: 8px; }
.panel::-webkit-scrollbar-track { background: transparent; }
.panel::-webkit-scrollbar-thumb { background: #010409; border-radius: 4px; }
.panel::-webkit-scrollbar-thumb:hover { background: #161b22; }
.head { display: flex; align-items: baseline; justify-content: space-between; margin-bottom: 10px; }
.title { font-size: 14px; font-weight: 650; color: #f0f6fc; }
.hint { font-size: 11px; color: #8b949e; }
/* Commands (left) beside the spoken alphabet (right) on wide screens. */
.body { display: flex; gap: 30px; align-items: flex-start; }
.commands-area { flex: 1 1 auto; min-width: 0; }
.alpha-area { flex: 0 0 auto; order: 2; } /* right of the commands */
/* Alphabet — a single a–z line when there's room; a second line only when the
   screen is too short to show one without scrolling. Read DOWN (column-major). */
.alpha { column-count: 1; column-gap: 20px; }
.alpha .a { display: flex; gap: 6px; align-items: baseline; font-size: 12px;
  min-width: 0; break-inside: avoid; margin-bottom: 3px; }
@media (max-height: 680px) { .alpha { column-count: 2; } }
@media (max-height: 460px) { .alpha { column-count: 3; } }
/* Not enough width for side-by-side (e.g. large font): stack, with the
   alphabet on TOP (not pushed below the commands), spread full-width. */
@media (max-width: 780px) {
  .body { flex-direction: column; }
  .alpha-area { order: -1; }
  .alpha { column-count: 4; }
}
.alpha .l { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 700;
  color: #e6edf3; width: 1.1em; flex: 0 0 auto; }
.alpha .w { color: #c9d1d9; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.alpha-empty { font-size: 12px; color: #8b949e; margin-bottom: 12px; }
/* Commands — an aligned three-column mini-table per group:
     name | keys | spoken phrase
   Columns line up within each group (the row is display:contents, promoting
   its three cells into the group's grid) so the eye scans straight down
   instead of parsing a squished inline run. */
.cmds { columns: 2; column-gap: 26px; }
@media (max-width: 560px) { .cmds { columns: 1; } }
.group {
  break-inside: avoid;
  margin-bottom: 13px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  column-gap: 12px;
  row-gap: 5px;
  align-items: baseline;
}
/* Voice disconnected: no spoken-phrase column, so the mini-table is name | keys. */
.cmds.no-voice .group { grid-template-columns: minmax(0, 1fr) auto; }
/* Shared section header — command groups (Scroll, Hints, …) AND the spoken
   alphabet, so every labeled block reads the same. grid-column only applies
   inside a .group grid; it's a harmless no-op on the alphabet header. */
.sec-head {
  grid-column: 1 / -1;
  font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em;
  color: #58a6ff; margin: 0 0 6px;
  padding-bottom: 4px; border-bottom: 1px solid #21262d;
}
.row { display: contents; }
.label {
  color: #e6edf3; font-size: 12px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.keys { display: inline-flex; gap: 3px; flex-wrap: wrap; }
kbd {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10px;
  background: #21262d; color: #e6edf3; border: 1px solid #30363d;
  border-bottom-width: 2px; border-radius: 4px; padding: 1px 5px; white-space: nowrap;
}
/* Spoken phrase — mic glyph + italic text, set apart from the key chips so
   "say this" reads distinctly from "press this". Empty cell when a command
   has no voice form, which keeps the three columns aligned. */
.voice {
  display: inline-flex; align-items: baseline; gap: 4px;
  color: #7d8590; font-size: 11px; font-style: italic; white-space: nowrap;
}
.voice svg { width: 11px; height: 11px; flex: 0 0 auto; align-self: center;
  color: #58a6ff; opacity: 0.85; }
.usage { margin-top: 10px; font-size: 11px; color: #8b949e; line-height: 1.45; }
.usage b { color: #c9d1d9; font-weight: 600; }
`;

// Small mic glyph that precedes a spoken phrase, so voice rows are instantly
// distinguishable from key rows. Inline SVG (static, no page input) — matches
// the innerHTML already used for the usage note below.
const MIC_SVG =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect x="9" y="2" width="6" height="12" rx="3"/>' +
  '<path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="22"/></svg>';

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/** Build the shadow-isolated host element: commands (left) beside the spoken
 * alphabet (right, a single a–z column when it fits) on wide screens; when
 * there isn't room it stacks with the alphabet on top. Backdrop click closes
 * via the supplied callback. */
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

  // Body: commands (left, the bulk) beside the spoken alphabet (right, a
  // narrow reference column). On wide screens they sit side by side; a media
  // query stacks them when there isn't room.
  const body = el('div', 'body');

  // With voice disconnected the spoken-phrase column is dropped (the model
  // already excluded the phrases + any voice-only command).
  const voiceConnected = alphabet.loaded;

  // Commands — compact, one line each, two internal columns. No "Commands"
  // super-label: each group's header carries the section styling, matching the
  // spoken-alphabet header, so both sides read as peer labeled blocks.
  const cmdArea = el('div', 'commands-area');
  const cmds = el('div', voiceConnected ? 'cmds' : 'cmds no-voice');
  for (const g of model) {
    const groupEl = el('div', 'group');
    groupEl.appendChild(el('div', 'sec-head', g.group));
    for (const r of g.rows) {
      // `.row` is display:contents, so these cells become the group grid's
      // columns. Always append the same set (keys/voice may be empty) so rows
      // stay column-aligned.
      const row = el('div', 'row');

      // 1 — what it does: the anchor you scan by.
      row.appendChild(el('span', 'label', r.label));

      // 2 — how to type it: aligned key chips.
      const keys = el('div', 'keys');
      for (const k of r.keys) keys.appendChild(el('kbd', undefined, k));
      row.appendChild(keys);

      // 3 — how to say it: mic glyph + phrase(s), set apart from the keys.
      // Omitted entirely when voice is disconnected (two-column table).
      if (voiceConnected) {
        const voice = el('div', 'voice');
        if (r.voice.length) {
          voice.innerHTML = MIC_SVG;
          voice.appendChild(el('span', undefined, r.voice.join('  /  ')));
        }
        row.appendChild(voice);
      }

      groupEl.appendChild(row);
    }
    cmds.appendChild(groupEl);
  }
  cmdArea.appendChild(cmds);
  body.appendChild(cmdArea);

  // Spoken alphabet — the right-hand reference column (single a–z line when it
  // fits; CSS adds lines only to avoid a scroll, and moves it on top when
  // the layout has to stack).
  const alphaArea = el('div', 'alpha-area');
  alphaArea.appendChild(el('div', 'sec-head', 'Spoken alphabet'));
  if (alphabet.loaded) {
    const grid = el('div', 'alpha');
    for (const { letter, word } of alphabet.entries) {
      const a = el('div', 'a');
      a.appendChild(el('span', 'l', letter));
      a.appendChild(el('span', 'w', word));
      grid.appendChild(a);
    }
    alphaArea.appendChild(grid);
  } else {
    alphaArea.appendChild(el('div', 'alpha-empty', 'Connect BranchKit voice to see the spoken alphabet.'));
  }
  body.appendChild(alphaArea);

  panel.appendChild(body);

  const usage = el('div', 'usage');
  usage.innerHTML =
    'Press <b>f</b>, then a badge’s letters to click it — or a <b>capital</b> to open it ' +
    'in a new tab (<b>Esc</b> exits). Every other bare key is a Normal-mode shortcut, listed above.';
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
  // One connection signal drives both surfaces: disconnected → no spoken
  // phrases in the command table and the alphabet shows a connect prompt.
  const alphabet = buildAlphabetModel();
  const model = buildHelpModel(COMMAND_CATALOG, keymap, alphabet.loaded);
  const host = buildHelpOverlay(model, alphabet, close);
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

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
import { isBranchKitConnected } from '../plugin/connection-mirror';
import { micGlyph } from './mic-glyph';
import { effectiveVoice, type OverrideMap } from '../command-override';

export interface HelpRow {
  /** Display strings for every binding of this command (e.g. ["Shift+J"]). */
  keys: string[];
  /** Space-split tokens of the command's mode-owned keyboard hint (caret-mode
   *  `o`/`y`/`aw`…) — shown as key chips even though the command isn't bindable. */
  keyHint: string[];
  /** Spoken phrases for this command (e.g. ["scroll down", "scroll down {number}"]). */
  voice: string[];
  label: string;
  /** Hover-tooltip text for the ⓘ affordance: the mode a command needs to be in
   *  (from voiceContext) plus its description. Empty for commands that work in
   *  Normal mode (no ⓘ shown). */
  info: string;
}

/** The "you must be in this mode" note for a voice-context, or '' for none.
 *  Leads with the mode-entry key (v / w) — the "special mode" commands — since
 *  that's the actionable part ("how do I make this work?"). */
function modeNote(voiceContext: CommandMeta['voiceContext']): string {
  switch (voiceContext) {
    case 'caret': return 'Caret/visual mode — press v to enter (or “select” a badge), then this works.';
    case 'video': return 'Video mode — press w for the keyboard layer. By voice, works whenever a video is on the page.';
    case 'palette': return 'Command palette — open it with Ctrl+K (or say “palette”) first.';
    default: return '';
  }
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
  overrides?: OverrideMap,
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
    // Overrides are applied so the overlay shows what actually works.
    const voice = voiceConnected
      ? effectiveVoice(c.id, (c.voice ?? []).map((v) => v.pattern), overrides)
      : [];
    const keyHint = c.keyHint ? c.keyHint.split(/\s+/).filter(Boolean) : [];
    if (keys.length === 0 && voice.length === 0 && keyHint.length === 0) continue; // not reachable → skip
    let gi = indexByGroup.get(c.group);
    if (gi === undefined) {
      gi = groups.length;
      groups.push({ group: c.group, rows: [] });
      indexByGroup.set(c.group, gi);
    }
    // Surface the mode requirement (+ description) via a hover ⓘ, but only for
    // mode-gated commands — Normal-mode commands need no explanation.
    const note = modeNote(c.voiceContext);
    const info = note ? `${note}\n\n${c.description}` : '';
    groups[gi].rows.push({ keys, keyHint, voice, label: c.label, info });
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

// Keys owned by a mode's own handler, NOT the command registry — so they never
// appear in the command table above (which is built from COMMAND_CATALOG). This
// static legend documents them. Entry keys shown are the shipping defaults.
const MODAL_KEYS: readonly { mode: string; keys: string }[] = [
  { mode: 'Caret / visual — v, V',
    keys: 'hjkl move · w/b/e word · ( ) sentence · { } paragraph · 0 $ line ends · gg G document · '
      + 'o swap ends · aw as ap select word/sentence/paragraph (iw is ip trims space) · '
      + 'y copy · Y copy line · / then n N find-in-selection · c caret · Esc steps back / exits' },
  { mode: 'Badges — f',
    keys: "type a badge's letters to click it · a Capital letter opens it in a new tab · Esc exits" },
  { mode: 'Marks — m, `',
    keys: 'then a letter to set or jump (Shift+letter = global, works in any tab) · '
      + '` twice returns to where you were before the last jump' },
  { mode: 'Video — w',
    keys: 'k / Space play-pause · j l seek 10s · ← → 5s · m mute · < > speed · 0 restart · w / Esc / q exits' },
];

const STYLE = `
:host { all: initial; }
.backdrop {
  position: fixed; inset: 0; z-index: ${Z_INDEX};
  background: rgba(1, 4, 9, 0.55);
  display: flex; align-items: center; justify-content: center;
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
.panel {
  width: min(1200px, 95vw); max-height: 90vh; overflow: auto;
  /* Query container: the body/commands/alphabet reflow by the PANEL's width, not
     the viewport — so the layout responds to its own space (and to large system
     fonts), no viewport breakpoints. */
  container-type: inline-size;
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
/* Commands (the bulk) beside the spoken alphabet (a reference sidebar). */
.body { display: flex; gap: 28px; align-items: flex-start; }
.commands-area { flex: 1 1 auto; min-width: 0; }
.alpha-area { flex: 0 0 200px; }
/* Alphabet packs into as many ~88px columns as its area allows — read DOWN. */
.alpha { columns: 88px; column-gap: 14px; }
.alpha .a { display: flex; gap: 6px; align-items: baseline; font-size: 12px;
  min-width: 0; break-inside: avoid; margin-bottom: 3px; }
/* Narrow PANEL (small window or large font): stack, alphabet on top, full-width.
   A container query, so it tracks the panel's real width — not the viewport. */
@container (max-width: 820px) {
  .body { flex-direction: column; }
  .alpha-area { flex-basis: auto; order: -1; }
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
/* As many ~320px group-columns as fit — reflows with the panel, no breakpoints. */
.cmds { columns: 320px; column-gap: 28px; }
.group {
  break-inside: avoid;
  margin-bottom: 13px;
  display: grid;
  /* name | keys | voice. The voice column is bounded (minmax with a shrinkable
     min) and wraps — a command with many spoken phrases (e.g. every extend
     variant) must NOT expand it to full width and collapse the name column. */
  grid-template-columns: minmax(0, 1fr) auto minmax(0, 1.4fr);
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
.label { display: flex; align-items: baseline; gap: 5px; min-width: 0; }
.name {
  color: #e6edf3; font-size: 12px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* ⓘ hover affordance — the tooltip carries the mode requirement + description
   for a mode-gated command. Opens to the RIGHT (the name column is on the left,
   so there's horizontal room) to dodge the scroll panel's vertical clipping. */
.info {
  flex: 0 0 auto; cursor: help; position: relative;
  color: #6e7681; font-size: 10.5px; font-style: normal; line-height: 1;
}
.info:hover { color: #58a6ff; }
.info:hover::after {
  content: attr(data-tip);
  position: absolute; left: calc(100% + 8px); top: 50%; transform: translateY(-50%);
  width: max-content; max-width: 240px;
  background: #1c2128; color: #c9d1d9; border: 1px solid #30363d; border-radius: 6px;
  padding: 6px 9px; font-size: 11px; font-style: normal; line-height: 1.45;
  white-space: pre-line; box-shadow: 0 6px 20px rgba(1, 4, 9, 0.6);
  z-index: 20; pointer-events: none;
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
/* Mode-owned key hint (caret-mode o/y/aw…): a key chip, dimmed + dashed so it
   reads as "only inside the mode", distinct from a real global binding. */
kbd.hint { opacity: 0.7; border-style: dashed; }
/* A flex row: [mic] [phrases]. The phrases span wraps, and because it's its own
   flex item its continuation lines stay aligned under the first line (not under
   the mic). The mic is a fixed item pinned top-left, so it's always visible. */
.voice { display: flex; align-items: baseline; gap: 5px; }
.voice > span {
  min-width: 0; overflow-wrap: anywhere;
  color: #7d8590; font-size: 11px; font-style: italic; line-height: 1.5;
}
.voice svg {
  flex: 0 0 auto; align-self: flex-start; margin-top: 3px;
  width: 12px; height: 12px; color: #58a6ff; opacity: 0.95;
}
/* Modal keys — a full-width legend below the command table for the keys a mode
   owns (caret/hints/marks/video). name | keys, the keys wrapping freely. */
.modal { margin-top: 4px; }
.mrow {
  display: grid;
  grid-template-columns: minmax(120px, 0.8fr) minmax(0, 2.6fr);
  column-gap: 12px; row-gap: 3px; margin-bottom: 6px; align-items: baseline;
  break-inside: avoid;
}
.mmode { color: #e6edf3; font-size: 11px; font-weight: 600; }
.mkeys { color: #8b949e; font-size: 11px; line-height: 1.55; }
.usage { margin-top: 10px; font-size: 11px; color: #8b949e; line-height: 1.45; }
.usage b { color: #c9d1d9; font-weight: 600; }
`;

// Small mic glyph that precedes a spoken phrase, so voice rows are instantly
// distinguishable from key rows. Inline SVG (static, no page input) — matches
// the innerHTML already used for the usage note below.
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
  voiceAvailable: boolean,
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

  // With voice unavailable the spoken-phrase column is dropped (the model
  // already excluded the phrases + any voice-only command).

  // Commands — compact, one line each, two internal columns. No "Commands"
  // super-label: each group's header carries the section styling, matching the
  // spoken-alphabet header, so both sides read as peer labeled blocks.
  const cmdArea = el('div', 'commands-area');
  const cmds = el('div', voiceAvailable ? 'cmds' : 'cmds no-voice');
  for (const g of model) {
    const groupEl = el('div', 'group');
    groupEl.appendChild(el('div', 'sec-head', g.group));
    for (const r of g.rows) {
      // `.row` is display:contents, so these cells become the group grid's
      // columns. Always append the same set (keys/voice may be empty) so rows
      // stay column-aligned.
      const row = el('div', 'row');

      // 1 — what it does: the anchor you scan by, plus a hover ⓘ carrying the
      // mode requirement for mode-gated commands.
      const labelCell = el('div', 'label');
      labelCell.appendChild(el('span', 'name', r.label));
      if (r.info) {
        const info = el('span', 'info', 'ⓘ');
        info.setAttribute('data-tip', r.info);
        labelCell.appendChild(info);
      }
      row.appendChild(labelCell);

      // 2 — how to type it: aligned key chips. Real registry binds first, then
      // any mode-owned hint keys (dimmed — they only work inside the mode).
      const keys = el('div', 'keys');
      for (const k of r.keys) keys.appendChild(el('kbd', undefined, k));
      for (const k of r.keyHint) keys.appendChild(el('kbd', 'hint', k));
      row.appendChild(keys);

      // 3 — how to say it: mic glyph + phrase(s), set apart from the keys.
      // Omitted entirely when voice is unavailable (two-column table).
      if (voiceAvailable) {
        const voice = el('div', 'voice');
        if (r.voice.length) {
          voice.appendChild(micGlyph());
          voice.appendChild(el('span', undefined, r.voice.join('  /  ')));
        }
        row.appendChild(voice);
      }

      groupEl.appendChild(row);
    }
    cmds.appendChild(groupEl);
  }
  cmdArea.appendChild(cmds);

  // Modal keys — the mode-owned keys (caret/hints/marks/video) that aren't
  // registry commands, so they're absent from the table above. Always shown
  // (they're keyboard, standalone-relevant), full-width below the commands.
  const modal = el('div', 'modal');
  modal.appendChild(el('div', 'sec-head', 'Inside a mode (typed keys)'));
  for (const mk of MODAL_KEYS) {
    const row = el('div', 'mrow');
    row.appendChild(el('div', 'mmode', mk.mode));
    row.appendChild(el('div', 'mkeys', mk.keys));
    modal.appendChild(row);
  }
  cmdArea.appendChild(modal);

  body.appendChild(cmdArea);

  // Spoken alphabet — the right-hand reference column (single a–z line when it
  // fits; CSS adds lines only to avoid a scroll, and moves it on top when
  // the layout has to stack).
  const alphaArea = el('div', 'alpha-area');
  alphaArea.appendChild(el('div', 'sec-head', 'Spoken alphabet'));
  // Gated on availability, not alphabet.loaded: with the host disconnected
  // the cached alphabet still decodes to words, but showing the table would
  // suggest speaking works right now — the connect prompt is the truth.
  if (voiceAvailable) {
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
  usage.append(
    'Press ', el('b', undefined, 'f'), ', then a badge’s letters to click it — or a ',
    el('b', undefined, 'capital'), ' to open it in a new tab (', el('b', undefined, 'Esc'),
    ' exits). Every other bare key is a Normal-mode shortcut, listed above.',
  );
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

/** Toggle the help overlay. Reads the effective keymap + phrase overrides each
 * open so custom binds and custom spoken phrases are reflected. */
export function toggleHelpOverlay(keymap: readonly KeymapEntry[], overrides?: OverrideMap): void {
  if (state.active) { close(); return; }
  // One availability signal drives both surfaces: no spoken phrases in the
  // command table and a connect prompt in the alphabet column unless voice is
  // usable RIGHT NOW. That's alphabet-loaded AND host-connected — the alphabet
  // persists across BranchKit sessions and is never cleared, so alone it only
  // says voice was seen once, not that speaking works today.
  const alphabet = buildAlphabetModel();
  const voiceAvailable = alphabet.loaded && isBranchKitConnected();
  const model = buildHelpModel(COMMAND_CATALOG, keymap, voiceAvailable, overrides);
  const host = buildHelpOverlay(model, alphabet, voiceAvailable, close);
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

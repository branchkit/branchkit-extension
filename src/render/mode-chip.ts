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
import { isBranchKitConnected } from '../plugin/connection-mirror';

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
  display: flex; flex-direction: column; gap: 2px;
}
.chip .row { display: flex; gap: 8px; align-items: baseline; }
.chip .sub { color: #8b949e; font-weight: 500; letter-spacing: 0; }
.chip .voice { color: #7d8590; font-weight: 500; letter-spacing: 0; font-style: italic; }
.chip .voice .say { color: #58a6ff; font-style: normal; }
`;

type ChipMode = 'hint' | 'insert' | 'mark-set' | 'mark-jump' | 'caret' | 'visual' | 'video';

// Per-mode chip copy. Normal has no chip (the quiet default). The two mark
// states are transient prompts (the next key names the mark). The video sub
// is the layer's in-mode key reference (layer keys aren't keymap entries, so
// the ? overlay can't list them — the chip is where they're taught).
// `voice` is the mode's spoken-phrase reference, rendered as a second "say:"
// line only while BranchKit voice is connected — the modes with spoken forms
// teach them at the moment they're usable (the words aren't hints, so no
// badge ever spells them out).
const CHIP_TEXT: Record<ChipMode, { label: string; sub: string; voice?: string }> = {
  hint: { label: 'BADGE', sub: 'type a letter · Esc' },
  insert: { label: 'PASS-THROUGH', sub: 'keys go to the page · Esc' },
  'mark-set': { label: 'SET MARK', sub: 'press a letter (⇧ = global) · Esc' },
  'mark-jump': { label: 'JUMP TO MARK', sub: 'press a letter · Esc' },
  caret: { label: 'CARET', sub: 'hjkl move · v select · y copy · Esc',
    voice: 'select word · select line · copy that · stop selecting' },
  visual: { label: 'VISUAL', sub: 'hjkl extend · y copy · o swap · Esc',
    voice: 'select word · select line · copy that · stop selecting' },
  video: { label: 'VIDEO', sub: 'k play · j/l seek · m mute · < > speed · 0 restart · Esc',
    voice: 'pause · play · faster · slower · skip back 30 · mute · restart video' },
};

function build(mode: ChipMode, voiceConnected: boolean): HTMLElement {
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
  const row = document.createElement('div');
  row.className = 'row';
  const label = document.createElement('span');
  label.textContent = CHIP_TEXT[mode].label;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = CHIP_TEXT[mode].sub;
  row.append(label, sub);
  chip.appendChild(row);
  const voicePhrases = CHIP_TEXT[mode].voice;
  if (voicePhrases && voiceConnected) {
    const voice = document.createElement('div');
    voice.className = 'voice';
    const say = document.createElement('span');
    say.className = 'say';
    say.textContent = 'say: ';
    voice.appendChild(say);
    voice.appendChild(document.createTextNode(voicePhrases));
    chip.appendChild(voice);
  }
  shadow.appendChild(chip);
  return el;
}

/** Reflect the current keyboard mode. Only the top frame shows the chip; Normal
 * is chip-less. Rebuilds when the shown mode changes (hint ↔ pass-through). */
export function setModeChip(mode: KeyMode): void {
  if (typeof document === 'undefined' || window !== window.top) return;
  const shown: ChipMode | null =
    mode === 'hint' || mode === 'insert' || mode === 'mark-set' || mode === 'mark-jump'
      || mode === 'caret' || mode === 'visual' || mode === 'video'
      ? mode
      : null;
  host?.remove();
  host = null;
  if (shown) {
    // Connection is sampled at build time; the chip rebuilds on every mode
    // change, so a connect/disconnect is reflected at the next mode entry.
    host = build(shown, isBranchKitConnected());
    document.documentElement.appendChild(host);
  }
}

/** Test-only reset. */
export function _resetModeChipForTesting(): void {
  host?.remove();
  host = null;
}

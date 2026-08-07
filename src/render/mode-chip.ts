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
import { mountInStack, reapStackIfEmpty } from './overlay-stack';

const HOST_ATTR = 'data-branchkit-mode-chip';

let host: HTMLElement | null = null;

// Position and z-index are the shared overlay stack's job now (the chip mounts
// into the bottom-right column); this styles only the chip's own appearance.
const STYLE = `
:host { all: initial; }
.chip {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
  color: #c9d1d9; background: #1c2128;
  border: 1px solid #3d444d; border-radius: 6px;
  padding: 4px 9px; box-shadow: 0 4px 14px rgba(1, 4, 9, 0.5);
  display: flex; flex-direction: column; gap: 2px;
}
/* The mode name: a filled pill, not a hue — shape is the separator between
   "which mode" and "what to do", matching the product's pill vocabulary
   (palette codeword chips, HUD tags, keycaps). */
.name {
  color: #f0f6fc; background: rgba(255, 255, 255, 0.14);
  padding: 1px 6px; border-radius: 4px;
}
.chip .row { display: flex; gap: 8px; align-items: baseline; }
.chip .sub { color: #8b949e; font-weight: 500; letter-spacing: 0; }
.chip .voice { color: #7d8590; font-weight: 500; letter-spacing: 0; font-style: italic; }
.chip .voice .say { color: #58a6ff; font-style: normal; }
/* A refused keystroke: no codeword starts with that letter, so the filter
   deliberately does NOT take it (keyboard.ts handleHintKey — accepting it
   would blank every hint). Silent refusal is what made that reasonable
   behaviour read as a fault: the letter vanished, and the Escape aimed at
   undoing it found no prefix to peel and left the mode instead (field,
   2026-07-27). One pulse on the mode indicator, where "type a letter" is
   already written — loud enough to say "not that one", quiet enough to sit
   under a fast typist. */
.chip.refused { animation: bk-chip-refused 260ms ease-out; }
@keyframes bk-chip-refused {
  0%   { border-color: #3d444d; }
  25%  { border-color: #f0f6fc; background: #2d333b; }
  100% { border-color: #3d444d; }
}
@media (prefers-reduced-motion: reduce) {
  .chip.refused { animation: none; border-color: #f0f6fc; }
}
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
  label.className = 'name';
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
    mountInStack(host, 'mode');
  } else {
    reapStackIfEmpty();
  }
}

/**
 * Pulse the chip to say a keystroke was refused.
 *
 * No-op when no chip is up — a refusal outside a chip-showing mode has nothing
 * to report against, and the caller should not have to know which modes those
 * are. Restarting the animation needs the class off, a reflow read, then on:
 * re-adding it while it is already applied does nothing, which would swallow
 * the second of two quick refusals — exactly the case (typing several wrong
 * letters in a row) where the feedback matters most.
 */
export function flashModeChipRefusal(): void {
  const chip = host?.shadowRoot?.querySelector('.chip');
  if (!(chip instanceof HTMLElement)) return;
  chip.classList.remove('refused');
  void chip.offsetWidth; // reflow: lets the same animation play twice
  chip.classList.add('refused');
}

/** Test-only reset. */
export function _resetModeChipForTesting(): void {
  host?.remove();
  host = null;
  reapStackIfEmpty();
}

/**
 * Arms every badge (custom props inherit through the badge shadow). The
 * per-badge color and the border rule live in the badge shadow CSS.
 *
 * Lives beside the chip because both are the same signal — "keyboard typing is
 * live" — rendered in two places, and render/ owns what that looks like.
 */
export function setKeyboardArmed(on: boolean): void {
  const root = document.documentElement.style;
  if (on) root.setProperty('--bk-kbd-b-alpha', '1');
  else root.removeProperty('--bk-kbd-b-alpha');
}

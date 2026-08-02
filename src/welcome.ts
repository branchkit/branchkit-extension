/**
 * BranchKit Browser — welcome page hydration.
 *
 * The page's `<kbd>` keys ship as static text (the defaults) and are
 * rewritten here from the LIVE keymap at open, so a rebound command shows
 * the user's key, not the shipped one — the welcome page was found teaching
 * `H` for back after the user had moved it (2026-08-02). Every element
 * carrying `data-cmd` names the command it displays; unbound or unknown
 * commands keep the shipped text (teaching the default beats a blank).
 *
 * Same display grammar as everywhere else (comboDisplay): bare letters
 * lowercase, Shift+letter as the capital alone, named modifiers explicit.
 */

import { loadKeymap } from './keymap/keymap-storage';
import { comboDisplay } from './activate/key-combo';

async function hydrate(): Promise<void> {
  const keymap = await loadKeymap().catch(() => null);
  if (!keymap || keymap.length === 0) return;
  for (const el of document.querySelectorAll<HTMLElement>('[data-cmd]')) {
    const entry = keymap.find((e) => e.command === el.dataset.cmd);
    if (!entry) continue;
    // One <kbd> per visual cap: sequence tokens ("KeyY KeyY" → y y) and the
    // parts of a modifier chord ("ctrl+KeyK" → Ctrl, K) each get a cap.
    // Shifted-letter and shifted-symbol displays are single caps by the
    // grammar (J, ?), so they never split.
    const caps = entry.keys.split(' ').flatMap((tok) => comboDisplay(tok).split('+'));
    if (el.tagName === 'KBD' && caps.length === 1) {
      el.textContent = caps[0];
      continue;
    }
    const frag = document.createDocumentFragment();
    caps.forEach((cap, i) => {
      if (i > 0 && entry.keys.includes(' ')) frag.append('');
      const kbd = document.createElement('kbd');
      kbd.textContent = cap;
      frag.append(kbd);
    });
    if (el.tagName === 'KBD') el.replaceWith(frag);
    else el.replaceChildren(frag);
  }
}

void hydrate();

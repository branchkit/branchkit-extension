/**
 * The keyboard-armed border cue must fire on TINTED badges too (field,
 * 2026-07-27).
 *
 * Pressing `f` takes every badge's own border from a resting alpha to fully
 * opaque — the one signal that says "the extension is listening", and the only
 * one in always-visible mode, where nothing else about the badges changes.
 * Search badges never made that move: being tinted, they pinned the alpha to 1
 * inline at paint time, and an inline declaration beats the inherited write
 * that arms everything else. Solid at rest, solid when armed, no delta.
 *
 * Measured on the PAINTED element through the bkOpenShadow affordance rather
 * than asserted against the CSS source, because the mechanism is a nested
 * `var()` fallback inside an `rgb()` alpha slot — whether that resolves is an
 * engine question, and this harness runs on both engines.
 */

import { freshPage, settle, pillPresent } from '../driver.mjs';

const BANANA_MATCHES = 3;
/** Page-filled badges rest here, tinted ones higher; both arm to 1. */
const ARMED = 1;

/** Alpha of the painted border on every shown badge (shadow must be open). */
function borderAlphas(page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('[data-branchkit-hint]')]
      .filter((h) => h.shadowRoot && h.hasAttribute('data-bk-shown'))
      .map((h) => h.shadowRoot.querySelector('.bk-inner'))
      .filter((inner) => inner && getComputedStyle(inner).display !== 'none')
      .map((inner) => {
        const c = getComputedStyle(inner).borderTopColor;
        const m = c.match(/rgba?\(([^)]+)\)/);
        if (!m) return null;
        const parts = m[1].split(/[,/]/).map((s) => parseFloat(s.trim()));
        return parts.length > 3 ? parts[3] : 1; // rgb() with no alpha slot = opaque
      })
      .filter((a) => a !== null));
}

const spread = (xs) => `${Math.min(...xs)}..${Math.max(...xs)}`;

export async function run({ page, base }) {
  // Shadow roots are closed in production; the flag is read once at module
  // load, so it must be set before a FRESH content script boots.
  await freshPage(page, base);
  await page.evaluate(() => localStorage.setItem('bkOpenShadow', '1'));
  try {
    await freshPage(page, base);

    const hintsRest = await borderAlphas(page);
    if (hintsRest.length === 0) {
      throw new Error('no badge shadow root opened — the bkOpenShadow affordance did not apply');
    }
    if (Math.max(...hintsRest) >= ARMED) {
      throw new Error(
        `link hints must rest BELOW full alpha or there is no cue to give; saw ${spread(hintsRest)}`,
      );
    }

    // Commit a search: find borrows the screen, so every shown badge from here
    // on is a tinted search badge.
    await page.keyboard.press('/');
    await settle(400);
    await page.keyboard.type('banana');
    await settle(400);
    await page.keyboard.press('Enter');
    await settle(800);
    if (!(await pillPresent(page))) throw new Error('the search never committed (no pill)');

    const searchRest = await borderAlphas(page);
    if (searchRest.length !== BANANA_MATCHES) {
      throw new Error(
        `expected exactly ${BANANA_MATCHES} search badges shown; saw ${searchRest.length}`,
      );
    }
    if (Math.max(...searchRest) >= ARMED) {
      throw new Error(
        `search badges rest at ${spread(searchRest)} — pinned at full alpha, so \`f\` has ` +
        'nothing to raise and the armed cue is invisible on them (the reported bug)',
      );
    }

    await page.keyboard.press('f');
    await settle(600);

    const searchArmed = await borderAlphas(page);
    if (searchArmed.length !== BANANA_MATCHES) {
      throw new Error(
        `\`f\` changed the shown set: ${searchArmed.length} badges, expected ${BANANA_MATCHES}`,
      );
    }
    if (Math.min(...searchArmed) < ARMED) {
      throw new Error(
        `after \`f\` search badges must be fully opaque; saw ${spread(searchArmed)} ` +
        '(the armed write is not reaching tinted badges)',
      );
    }

    return `tinted search badges moved ${spread(searchRest)} → ${spread(searchArmed)} on \`f\` ` +
      `(link hints rest at ${spread(hintsRest)})`;
  } finally {
    // Every later scenario probes badges by CLOSED shadow root — leaving this
    // on would silently blind them.
    await page.evaluate(() => localStorage.removeItem('bkOpenShadow'));
  }
}

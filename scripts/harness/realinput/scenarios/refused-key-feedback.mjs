/**
 * A refused keystroke says so, and changes nothing else (field, 2026-07-27).
 *
 * In hint mode a letter no codeword starts with is deliberately dropped —
 * taking it would leave the filter matching nothing and every hint hidden. But
 * it was dropped SILENTLY, and that is what made a correct behaviour read as a
 * fault: the user typed 'l', saw nothing happen, pressed Escape to unsay it,
 * and the Escape found no prefix to peel and left hint mode instead. From the
 * outside, a stray key had ejected them.
 *
 * So: the chip pulses, the badges do not move, and the mode stays. The letter
 * is still swallowed — the fix is the signal, not the swallowing.
 */

import { freshPage, shownBadges, chipLabel, settle } from '../driver.mjs';

/** Does the mode chip currently carry the refusal marker? Its shadow root is
 *  open by design (the chip is BranchKit's own UI, not a badge). */
function chipRefused(page) {
  return page.evaluate(() => {
    const host = document.querySelector('[data-branchkit-mode-chip]');
    const chip = host?.shadowRoot?.querySelector('.chip');
    return chip ? chip.classList.contains('refused') : null;
  });
}

/** A letter the fixture's codeword pool cannot produce. The pool draws from a
 *  home-row alphabet (observed: aa/as/sd/df…), so 'z' is safe — but assert the
 *  refusal rather than trusting it, or this scenario silently tests nothing. */
const NO_SUCH_PREFIX = 'z';

export async function run({ page, base }) {
  await freshPage(page, base);

  await page.keyboard.press('f');
  await settle(500);
  if ((await chipLabel(page)) === null) throw new Error('`f` did not enter hint mode');
  const shownBefore = await shownBadges(page);
  if (shownBefore === 0) throw new Error('no hints painted — nothing to refuse against');
  if ((await chipRefused(page)) !== false) {
    throw new Error('the chip was already marked refused before any key was typed');
  }

  await page.keyboard.press(NO_SUCH_PREFIX);
  await settle(400);

  // The refusal must be REAL: if the pool happened to mint a 'z' codeword the
  // key would be accepted and this scenario would prove nothing.
  const shownAfter = await shownBadges(page);
  if (shownAfter !== shownBefore) {
    throw new Error(
      `'${NO_SUCH_PREFIX}' was accepted as a prefix (${shownBefore} → ${shownAfter} hints) — ` +
      'the pool minted a codeword starting with it, so this run cannot test refusal',
    );
  }
  if ((await chipRefused(page)) !== true) {
    throw new Error(
      `'${NO_SUCH_PREFIX}' was swallowed with no signal — the silent drop is the bug: ` +
      'the next Escape unsays nothing and leaves the mode, reading as a stray-key eject',
    );
  }
  if ((await chipLabel(page)) === null) {
    throw new Error('a refused key dropped hint mode — it must change nothing but the signal');
  }

  // And the mode is still usable afterwards: Escape leaves it exactly once,
  // with the hints still painted (always-mode keeps them for voice).
  await page.keyboard.press('Escape');
  await settle(600);
  if ((await chipLabel(page)) !== null) {
    throw new Error('Escape after a refused key did not leave hint mode');
  }
  if ((await shownBadges(page)) !== shownBefore) {
    throw new Error('leaving hint mode disturbed the painted hints');
  }

  return `'${NO_SUCH_PREFIX}' refused with a chip pulse, ${shownBefore} hints unmoved, ` +
    'mode intact until Escape';
}

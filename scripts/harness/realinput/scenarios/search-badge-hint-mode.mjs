/**
 * `f` over a committed search must not repaint the page (field, 2026-07-26).
 *
 * The reported chain, exactly: `/` opens the bar, a query commits with Enter,
 * the matches take codeword badges — and then `f`, the keyboard's way of
 * saying "let me type one of those", swept the whole document and painted
 * every link hint on top of the three results the user had just asked for.
 *
 * The two halves are separable and both are asserted, because a fix that got
 * only one of them looks fine from the other side: the SCREEN stays the
 * search set's (no ambient repaint), and the KEYBOARD still enters hint mode
 * (the chip is up, so the codewords are typeable). Skipping the ambient sweep
 * by not entering hint mode at all would pass a count-only check.
 */

import { freshPage, shownBadges, chipLabel, pillPresent, settle } from '../driver.mjs';

/** The fixture says "banana" three times (driver.mjs FIXTURE). */
const BANANA_MATCHES = 3;

export async function run({ page, base }) {
  await freshPage(page, base);

  const baseline = await shownBadges(page);
  if (baseline <= BANANA_MATCHES) {
    throw new Error(
      `fixture too sparse: baseline ${baseline} badges must exceed ${BANANA_MATCHES} ` +
      'search badges for the repaint assertion to discriminate',
    );
  }

  // `/` → query → Enter: find borrows the screen, then commit arms the badges.
  await page.keyboard.press('/');
  await settle(400);
  await page.keyboard.type('banana');
  await settle(400);
  await page.keyboard.press('Enter');
  await settle(800);

  if (!(await pillPresent(page))) {
    throw new Error('the search never committed (no pill) — nothing to badge');
  }
  const atCommit = await shownBadges(page);
  if (atCommit !== BANANA_MATCHES) {
    throw new Error(
      `commit should leave exactly the ${BANANA_MATCHES} search badges up; saw ${atCommit} ` +
      `(> means find's badge borrow did not hide the page's link hints)`,
    );
  }

  // The regression: `f` asks for the keyboard, not for a fresh page sweep.
  await page.keyboard.press('f');
  await settle(800);

  const afterF = await shownBadges(page);
  if (afterF !== BANANA_MATCHES) {
    throw new Error(
      `after \`f\` exactly the ${BANANA_MATCHES} search badges may show; saw ${afterF} ` +
      `(≈${baseline + BANANA_MATCHES} means the ambient sweep repainted every link hint ` +
      'over the results — the overlayCodewordsLive gate is not holding)',
    );
  }

  const chip = await chipLabel(page);
  if (chip === null) {
    throw new Error(
      '`f` left Normal mode — the badge count held only because hint mode never ' +
      'started, so the search codewords are not typeable',
    );
  }

  // Now TYPE. A letter the search badges cannot finish used to be accepted
  // anyway — the hidden link hints could finish it, so the store answered
  // "mine" and revealed itself, putting the whole page over the three results
  // (field, 2026-07-27). The store is not typeable while its paint is behind
  // an overlay, so the key is refused and nothing moves.
  //
  // Every letter is swept, because which ones this draw's badges can finish is
  // not knowable from here (their shadow roots are closed). Backspace — not
  // Escape — resets between letters: it clears the prefix without touching the
  // mode stack, so the sweep cannot quietly unwind the session it is testing.
  let typed = 0;
  for (const ch of 'abcdefghijklmnopqrstuvwxyz') {
    await page.keyboard.press(ch);
    await settle(110);
    const shown = await shownBadges(page);
    if (shown > BANANA_MATCHES) {
      throw new Error(
        `typing '${ch}' put ${shown} badges on screen (expected at most ${BANANA_MATCHES}) — ` +
        'the ambient store revealed its hidden hints over the live find session',
      );
    }
    typed += 1;
    await page.keyboard.press('Backspace');
    await settle(110);
    // A letter the badges COULD finish may have resolved and jumped to that
    // match, which exits hint mode. Re-arm and keep sweeping.
    if ((await chipLabel(page)) === null) {
      await page.keyboard.press('f');
      await settle(200);
    }
  }

  // Escape unwinds hint mode without taking the search set with it: the user
  // mistypes a letter, backs out, and the results are still there to try again.
  await page.keyboard.press('Escape');
  await settle(600);
  const afterEscape = await shownBadges(page);
  if (afterEscape !== BANANA_MATCHES) {
    throw new Error(
      `escaping hint mode should leave the ${BANANA_MATCHES} search badges alone; saw ${afterEscape}`,
    );
  }
  if (typed !== 26) throw new Error(`swept only ${typed}/26 letters`);

  return `\`f\` over a committed search kept the screen at ${BANANA_MATCHES} search badges ` +
    `(${baseline} page hints stayed borrowed) and entered ${chip} mode`;
}

/**
 * A pick takes the SCREEN, not the keyboard (field, 2026-07-27).
 *
 * Arming used to enter hint mode for you, so chips were instantly typable —
 * and the entire Normal keymap went away for as long as they were up. j/k
 * stopped scrolling at exactly the moment it mattered most: a pick's matches
 * are routinely spread past the fold, and reaching them is the reason to
 * scroll. `f` is the one gesture that hands the keyboard over, for chips the
 * same as for link hints.
 *
 * Two halves, both asserted, because either alone is satisfiable the wrong
 * way: bare keys still run COMMANDS while chips are up, and `f` still makes
 * the chips typable afterwards.
 */

import { freshPage, shownBadges, chipLabel, dictateNative, boxPlaceholder, settle } from '../driver.mjs';

const scrollY = (page) => page.evaluate(() => Math.round(window.scrollY));

export async function run({ page, base }) {
  // A viewport short enough that the fixture actually scrolls; restored at the
  // end so later scenarios see the standard one.
  const original = page.viewportSize();
  await page.setViewportSize({ width: 500, height: 200 });
  try {
    await freshPage(page, base);
    await page.evaluate(() => window.scrollTo(0, 0));
    await settle(300);

    await page.keyboard.press('g');
    await page.keyboard.press('s');
    await settle(400);
    await dictateNative(page, 'signal');
    await settle(1300);
    if ((await boxPlaceholder(page)) !== null) {
      throw new Error('the highlight phrase never committed — no pick armed');
    }

    const chips = await shownBadges(page);
    if (chips < 2) throw new Error(`expected a multi-candidate pick; saw ${chips} chip(s)`);
    if ((await chipLabel(page)) !== null) {
      throw new Error(
        'arming the pick entered hint mode on the user\'s behalf — that swallows the whole ' +
        'Normal keymap while chips are up',
      );
    }

    // Half one: bare keys are still commands.
    //
    // Direction is chosen from where the page actually sits: committing the
    // phrase scrolls to the first match, which on a short viewport is often
    // the BOTTOM of the document — and a 'j' with nowhere to go proves
    // nothing. Pick the axis that has room.
    const before = await scrollY(page);
    const key = before > 0 ? 'k' : 'j';
    await page.keyboard.press(key);
    await settle(400);
    const after = await scrollY(page);
    const moved = key === 'j' ? after > before : after < before;
    if (!moved) {
      throw new Error(
        `'${key}' did not scroll while chips were up (${before} → ${after}) — the pick is ` +
        'capturing bare keys, so the page cannot be moved to reach its own off-screen matches',
      );
    }
    if ((await shownBadges(page)) !== chips) {
      throw new Error('scrolling disturbed the pick — the chips must ride it out');
    }

    // Half two: `f` still hands the keyboard over.
    await page.keyboard.press('f');
    await settle(500);
    if ((await chipLabel(page)) === null) {
      throw new Error('`f` did not enter hint mode over the pick — the chips are unreachable');
    }
    if ((await shownBadges(page)) !== chips) {
      throw new Error('`f` disturbed the chip set');
    }

    return `chips up with the keymap intact ('${key}' scrolled ${before} → ${after}, ` +
      `${chips} chips held), and \`f\` still armed them`;
  } finally {
    if (original) await page.setViewportSize(original);
  }
}

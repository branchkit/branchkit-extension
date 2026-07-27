/**
 * The badge-visibility borrow across the find → pick handoff (field
 * regression #4, ext 394ca6a): find borrows the screen at activate (page
 * badges hide), a phrase COMMIT hands the borrow to the pick along with the
 * paint — page badges must NOT re-show around the chips (chips own the
 * screen, ratified 2026-07-25) — and every consumer exit returns the borrow
 * (badges restored). The plain-close path (Escape with no commit) returns it
 * at deactivate.
 */

import {
  freshPage, shownBadges, boxPlaceholder, dictateNative, ALBUM_MATCHES, settle,
} from '../driver.mjs';

export async function run({ page, base }) {
  await freshPage(page, base);

  const baseline = await shownBadges(page);
  if (baseline <= ALBUM_MATCHES) {
    throw new Error(`fixture too sparse: baseline ${baseline} badges must exceed ${ALBUM_MATCHES} chips for the borrow assertions to discriminate`);
  }

  // Plain close: gs → Escape returns the borrow at deactivate.
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await settle(400);
  if ((await shownBadges(page)) !== 0) {
    throw new Error('opening the phrase box did not borrow the screen (badges still shown)');
  }
  await page.keyboard.press('Escape');
  await settle(700);
  const afterCancel = await shownBadges(page);
  if (afterCancel !== baseline) {
    throw new Error(`plain close restored ${afterCancel}/${baseline} badges`);
  }

  // Handoff: commit passes the borrow to the pick; chips own the screen.
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await settle(400);
  await dictateNative(page, 'album');
  await settle(1000);
  if (await boxPlaceholder(page) !== null) {
    throw new Error('dictated phrase did not commit');
  }
  const atPick = await shownBadges(page);
  if (atPick !== ALBUM_MATCHES) {
    throw new Error(
      `while the pick is armed exactly the ${ALBUM_MATCHES} chips may show; saw ${atPick} ` +
      `(> means page badges re-showed around the chips — the deactivate-restore firing at the handoff)`,
    );
  }

  // Consumer exit returns the borrow through onPaintCleared.
  await page.keyboard.press('Escape');
  await settle(800);
  const afterEscape = await shownBadges(page);
  if (afterEscape !== baseline) {
    throw new Error(`escaping the pick restored ${afterEscape}/${baseline} badges`);
  }
  return `borrow held through handoff (${ALBUM_MATCHES} chips over ${baseline} hidden badges), restored on both exits`;
}

/**
 * The announced-injection dictation delivery (the real Firefox field shape,
 * captured 2026-07-26; ext e54eb33): ONE keydown whose `.key` is the whole
 * transcript, then one insertText input event per character. The collector
 * must arm on the keydown, count the per-char inserts as one utterance, and
 * commit once at the boundary — NOT read the per-char inserts as keystrokes
 * (which cancels the commit; the pre-fix failure).
 *
 * Replayed synthetically on BOTH engines: the event shape, not the OS, is
 * what the collector discriminates on, and the replay walks the production
 * listeners (no isTrusted gate).
 */

import {
  freshPage, boxPlaceholder, shownBadges, painted, dictateAnnounced,
  ALBUM_MATCHES, settle,
} from '../driver.mjs';

export async function run({ page, base }) {
  await freshPage(page, base);

  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await settle(400);
  if (await boxPlaceholder(page) !== 'Highlight phrase...') {
    throw new Error('gs did not open the phrase box');
  }

  await dictateAnnounced(page, 'album');
  // Live feedback should paint DURING collection, before any commit.
  await settle(150);
  const during = await painted(page);
  if (!during.phrase) {
    throw new Error('announced injection produced no live phrase paint while collecting');
  }
  if (await boxPlaceholder(page) === null) {
    throw new Error('box closed before the utterance boundary — per-char inserts must not commit early');
  }

  await settle(900);
  if (await boxPlaceholder(page) !== null) {
    throw new Error('announced injection did not auto-commit — the per-char inserts were read as keystrokes');
  }
  const chips = await shownBadges(page);
  if (chips !== ALBUM_MATCHES) {
    throw new Error(`commit should raise exactly ${ALBUM_MATCHES} chips, saw ${chips}`);
  }

  // Escape cancels the pick and takes its paint with it.
  await page.keyboard.press('Escape');
  await settle(700);
  const after = await painted(page);
  if ((await shownBadges(page)) === chips || after.phrase) {
    throw new Error('Escape did not cancel the pick / clear its paint');
  }
  return `announced delivery committed once; ${chips} chips; escape cancelled clean`;
}

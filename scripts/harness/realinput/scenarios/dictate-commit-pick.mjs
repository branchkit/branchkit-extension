/**
 * Dictated phrase → utterance-boundary commit → chip pick → typed answer.
 *
 * The chain field regression #3 broke (Firefox highlight-dictation never
 * committed — ext fea5bee): the phrase box must read an injected multi-char
 * insert as dictation, auto-commit at the 400 ms utterance boundary, raise
 * chips for the multi-match, and the pick must be answerable by keyboard.
 * Uses the ENGINE-NATIVE injected shape (page.keyboard.insertText):
 * Chromium = one multi-char insertText, Gecko = one-shot
 * insertCompositionText with isComposing:false.
 */

import {
  freshPage, boxPlaceholder, shownBadges, painted, dictateNative,
  answerPickByTyping, ALBUM_MATCHES, settle,
} from '../driver.mjs';

export async function run({ page, base }) {
  await freshPage(page, base);

  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await settle(400);
  const ph = await boxPlaceholder(page);
  if (ph !== 'Highlight phrase...') {
    throw new Error(`gs did not open the phrase box (placeholder=${JSON.stringify(ph)})`);
  }

  await dictateNative(page, 'album');
  // The 400 ms utterance boundary is the commit; wait past it.
  await settle(1000);

  if (await boxPlaceholder(page) !== null) {
    throw new Error('dictated phrase did not auto-commit — box still open past the utterance boundary');
  }
  const chips = await shownBadges(page);
  if (chips !== ALBUM_MATCHES) {
    throw new Error(`commit should raise exactly ${ALBUM_MATCHES} chips, saw ${chips} shown badges`);
  }
  const paint = await painted(page);
  if (!paint.phrase) {
    throw new Error('phrase paint did not survive the commit — chips have nothing to point at');
  }

  const sel = await answerPickByTyping(page);
  if (!sel.toLowerCase().includes('album')) {
    throw new Error(`typing a chip codeword did not answer the pick (selection=${JSON.stringify(sel.slice(0, 40))})`);
  }
  await settle(500);
  const after = await painted(page);
  if (after.phrase || after.find) {
    throw new Error('answering the pick left ghost paint');
  }
  return `dictated commit raised ${chips} chips; typed answer selected ${JSON.stringify(sel.slice(0, 20))}`;
}

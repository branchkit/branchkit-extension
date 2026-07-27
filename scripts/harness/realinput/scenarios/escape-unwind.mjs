/**
 * Escape unwind through STACKED modes, on the real key path — the class the
 * whole arc exists for: temporal order (last pushed, first peeled) observed
 * through what the production code paints (the mode chip, the committed-find
 * pill), not through module calls.
 *
 *   A. committed find + hint mode: Escape peels hint first, find survives;
 *      the second Escape closes find. (The Wave 1 divergence: the key used to
 *      peel find ahead of hint mode.)
 *   B. committed find + caret (`v`): `y` copies and exits caret; the find it
 *      was entered over survives (Wave 1 A3 — caret exit used to tear down a
 *      find it did not create).
 *   C. video layer over a committed find: Escape peels video, then find —
 *      the reachable find-then-video stacking the C2/C3 tests pinned.
 */

import { freshPage, pressSeq, pillPresent, chipLabel, settle } from '../driver.mjs';

async function commitFind(page) {
  await page.keyboard.press('/');
  await settle(300);
  await page.keyboard.type('banana', { delay: 40 });
  await settle(300);
  await page.keyboard.press('Enter');
  await settle(500);
  if (!(await pillPresent(page))) throw new Error('Enter did not commit find to a pill');
}

export async function run({ page, base }) {
  // A: find below, hint mode above.
  await freshPage(page, base);
  await commitFind(page);
  await pressSeq(page, 'f');
  if (await chipLabel(page) !== 'BADGE') {
    throw new Error(`f over a committed find did not enter hint mode (chip=${await chipLabel(page)})`);
  }
  await pressSeq(page, 'Escape');
  if (await chipLabel(page) !== null) throw new Error('first Escape did not exit hint mode');
  if (!(await pillPresent(page))) {
    throw new Error('first Escape peeled FIND under hint mode — the newest layer must peel first');
  }
  await pressSeq(page, 'Escape');
  await settle(300);
  if (await pillPresent(page)) throw new Error('second Escape did not close the committed find');

  // B: caret entered over a committed find; caret's exit leaves find alone.
  await freshPage(page, base);
  await commitFind(page);
  await pressSeq(page, 'v');
  const caretChip = await chipLabel(page);
  if (caretChip !== 'CARET' && caretChip !== 'VISUAL') {
    throw new Error(`v over a committed find did not enter caret (chip=${caretChip})`);
  }
  await pressSeq(page, 'y');
  await settle(300);
  if (await chipLabel(page) !== null) throw new Error('y did not exit caret mode');
  if (!(await pillPresent(page))) {
    throw new Error('caret exit tore down the find session it was entered over (A3 regression)');
  }
  await pressSeq(page, 'Escape');
  await settle(300);
  if (await pillPresent(page)) throw new Error('Escape after caret exit did not close find');

  // C: video layer over a committed find.
  await freshPage(page, base);
  await commitFind(page);
  await pressSeq(page, 'w');
  if (await chipLabel(page) !== 'VIDEO') {
    throw new Error(`w did not enter the video layer (chip=${await chipLabel(page)})`);
  }
  await pressSeq(page, 'Escape');
  if (await chipLabel(page) !== null) throw new Error('Escape did not exit the video layer');
  if (!(await pillPresent(page))) {
    throw new Error('Escape peeled FIND under the video layer — temporal order violated');
  }
  await pressSeq(page, 'Escape');
  await settle(300);
  if (await pillPresent(page)) throw new Error('final Escape did not close find');

  return 'hint, caret and video each peeled above a committed find; find survived every inner exit';
}

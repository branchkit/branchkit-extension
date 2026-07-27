/**
 * A committed find stops counting matches that no longer exist.
 *
 * Sibling of `search-survives-rerender`, and the half that one does not cover.
 * That scenario kills EVERY range, which empties the badge set and re-finds.
 * This kills only SOME — the ordinary case on a filtering list — where the set
 * stays alive and never re-finds, so nothing used to sweep `find.ts`'s own
 * match list. The badges vanished correctly while the session kept walking
 * corpses: the pill counted text that was gone, and `n` stepped onto it to
 * scroll nowhere.
 *
 * Read through the PILL rather than internals: "2 of 3" is exactly the lie a
 * user sees, and it is the thing that must not survive a partial death.
 *
 * The control leg walks the same three matches with nothing removed. Without
 * it, a regression that broke `n` outright — or one where the injected matches
 * never committed at all — would satisfy the test leg's "count went down"
 * assertion for entirely the wrong reason.
 */

import { freshPage, settle, pillPresent } from '../driver.mjs';

/** A word the fixture does not contain, so the matches are exactly ours. */
const WORD = 'kumquat';

/** Three matches, each in its OWN node — partial death needs them separable.
 *  (The fixture's three 'banana's share one paragraph and die together.) */
const injectMatches = (page, word) => page.evaluate((w) => {
  const host = document.createElement('div');
  host.id = 'bk-reap-fixture';
  for (let i = 0; i < 3; i++) {
    const p = document.createElement('p');
    p.className = 'bk-reap';
    p.textContent = `${w} number ${i}`;
    host.appendChild(p);
  }
  document.body.insertBefore(host, document.body.firstChild);
}, word);

const killMatch = (page, nth) => page.evaluate((n) => {
  const ps = [...document.querySelectorAll('p.bk-reap')];
  if (!ps[n]) throw new Error(`no match #${n} to remove`);
  ps[n].remove();
}, nth);

/** The pill's own words: { index, count }, or null. */
const pillCount = (page) => page.evaluate(() => {
  const el = document.getElementById('branchkit-find-count');
  if (!el) return null;
  const m = /^(\d+) of (\d+)$/.exec((el.textContent || '').trim());
  return m ? { index: Number(m[1]), count: Number(m[2]) } : null;
});

async function commit(page, base, word) {
  await freshPage(page, base);
  await injectMatches(page, word);
  await page.keyboard.press('/');
  await settle(300);
  await page.keyboard.type(word);
  await settle(300);
  await page.keyboard.press('Enter');
  await settle(900);
  if (!(await pillPresent(page))) throw new Error('the search never committed');
  const c = await pillCount(page);
  if (!c || c.count !== 3) {
    throw new Error(`expected 3 injected matches, pill says ${c ? c.count : 'nothing'}`);
  }
  return c;
}

export async function run({ page, base }) {
  // Control: three live matches, and `n` walks all three. Proves the probe
  // reads a real count and that navigation works before anything is removed.
  await commit(page, base, WORD);
  const walked = [];
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('n');
    await settle(250);
    walked.push((await pillCount(page)).index);
  }
  if (walked.join(',') !== '2,3,1') {
    throw new Error(
      `control leg failed: n over three live matches reported ${walked.join(',')}, ` +
      'expected 2,3,1 — navigation is broken independently, so this cannot discriminate',
    );
  }

  // Test: remove the middle match's node. Its Range collapses onto a parent
  // that is still connected, which is why connectivity alone never saw it.
  await commit(page, base, WORD);
  await killMatch(page, 1);
  await settle(400);

  await page.keyboard.press('n');
  await settle(300);
  const after = await pillCount(page);
  if (!after) throw new Error('the pill stopped reporting a count after the removal');
  if (after.count === 3) {
    throw new Error(
      'the pill still counts 3 matches after one was removed from the DOM — the ' +
      'session is walking a corpse; `n` will step onto it and scroll nowhere',
    );
  }
  if (after.count !== 2) {
    throw new Error(`expected 2 surviving matches, pill says ${after.count}`);
  }
  if (after.index > after.count) {
    throw new Error(`pill reports match ${after.index} of ${after.count} — index outran the list`);
  }

  // And `n` keeps cycling the survivors rather than stalling on the gap.
  await page.keyboard.press('n');
  await settle(300);
  const next = await pillCount(page);
  if (next.count !== 2 || next.index > 2) {
    throw new Error(`after a second n: ${next.index} of ${next.count}, expected an index within 2`);
  }
  return `partial death reaped: 3 → ${after.count} matches, n stayed within the survivors ` +
    '(control walked 2,3,1)';
}

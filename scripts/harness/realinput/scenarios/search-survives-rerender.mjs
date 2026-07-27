/**
 * A find session outlives the DOM it was run against (field, 2026-07-27).
 *
 * On any app that re-renders — a filter, a live update, infinite scroll — the
 * matched subtree is replaced by identical text in new nodes. Every Range the
 * session holds then COLLAPSES onto its old parent, because the DOM spec
 * relocates boundary points when a node is removed. It does not orphan them.
 *
 * That is why this went unnoticed: `isRangeDead` asked whether the range's
 * ancestor was still connected, and after the fixup it is — so the reap never
 * ran, the badges stayed painted at their old coordinates, and a codeword
 * scrolled you to text that was no longer there. Not "badges vanish"; "badges
 * lie", which is the quieter failure.
 *
 * The discriminator has to move the text WITHOUT scrolling: on a scroll every
 * badge translates with the page whether its range is alive or not, so a
 * stranded badge looks perfectly healthy. Inserting a block above the match
 * moves the text and nothing else, and only a live range follows.
 *
 * The control leg proves the discriminator itself works — without it, a fix
 * that broke tracking outright would still "pass" the test leg.
 */

import { freshPage, settle, pillPresent } from '../driver.mjs';

const PUSH_PX = 150;

function firstBadge(page) {
  return page.evaluate(() => {
    const hosts = [...document.querySelectorAll('[data-branchkit-hint]')]
      .filter((h) => h.shadowRoot && h.hasAttribute('data-bk-shown'));
    for (const h of hosts) {
      const el = h.shadowRoot.querySelector('.bk-inner');
      if (!el || getComputedStyle(el).display === 'none') continue;
      return { word: (el.textContent || '').replace(/\s+/g, ''), y: Math.round(el.getBoundingClientRect().y) };
    }
    return null;
  });
}

/** Where the matched word actually is, per the LIVE dom. */
function textY(page) {
  return page.evaluate(() => {
    const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
      if (n.parentElement?.closest('[data-branchkit-hint],[data-branchkit-find]')) continue;
      const i = n.data.indexOf('banana');
      if (i === -1) continue;
      const r = document.createRange();
      r.setStart(n, i); r.setEnd(n, i + 6);
      return Math.round(r.getBoundingClientRect().y);
    }
    return null;
  });
}

async function commitFind(page, base) {
  await freshPage(page, base);
  await page.evaluate(() => localStorage.setItem('bkOpenShadow', '1'));
  await freshPage(page, base);
  await page.keyboard.press('/');
  await settle(300);
  await page.keyboard.type('banana');
  await settle(300);
  await page.keyboard.press('Enter');
  await settle(900);
  if (!(await pillPresent(page))) throw new Error('the search never committed');
}

/** Move the matched text down the page without scrolling. */
const pushTextDown = (page, px) => page.evaluate((h) => {
  const p = [...document.querySelectorAll('p')].find((e) => e.textContent.includes('banana'));
  const d = document.createElement('div');
  d.style.height = `${h}px`;
  d.textContent = 'inserted';
  p.parentNode.insertBefore(d, p);
}, px);

/** Replace the matched subtree with an identical clone — what React does. */
const reRender = (page) => page.evaluate(() => {
  const p = [...document.querySelectorAll('p')].find((e) => e.textContent.includes('banana'));
  p.replaceWith(p.cloneNode(true));
});

async function leg(page, base, { rerender }) {
  await commitFind(page, base);
  if (rerender) { await reRender(page); await settle(1200); }
  const b0 = await firstBadge(page);
  const t0 = await textY(page);
  if (!b0 || t0 === null) throw new Error('no badge or no matched text before the push');
  await pushTextDown(page, PUSH_PX);
  await settle(1800);
  const b1 = await firstBadge(page);
  const t1 = await textY(page);
  if (t1 === null) throw new Error('the matched text vanished from the page');
  if (!b1) return { moved: null, text: t1 - t0 };
  return { moved: b1.y - b0.y, text: t1 - t0 };
}

export async function run({ page, base }) {
  try {
    // Control: tracking works at all. Without this a fix that simply broke
    // following would sail through the test leg.
    const ctl = await leg(page, base, { rerender: false });
    if (ctl.moved === null || Math.abs(ctl.moved - ctl.text) > 4) {
      throw new Error(
        `control leg failed: text moved ${ctl.text}px but badge moved ${ctl.moved}px — ` +
        'badges do not track their text even without a re-render, so this scenario ' +
        'cannot discriminate anything',
      );
    }

    const test = await leg(page, base, { rerender: true });
    if (test.moved === null) {
      throw new Error(
        'badges disappeared after the re-render — better than lying, but the session ' +
        'should re-find its own retained query (scan/find.ts refindCommitted)',
      );
    }
    if (Math.abs(test.moved - test.text) > 4) {
      throw new Error(
        `STRANDED: text moved ${test.text}px, badge moved ${test.moved}px. The badge is ` +
        'pinned to nodes the re-render detached — its codeword now scrolls to nothing',
      );
    }
    return `badge followed its text ${test.text}px after a re-render (control ${ctl.text}px)`;
  } finally {
    await page.evaluate(() => localStorage.removeItem('bkOpenShadow'));
  }
}
